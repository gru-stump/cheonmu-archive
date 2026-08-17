import { z } from 'zod';
import type { GenerationCommand, GenerationResponse } from '../generate-draft/index.ts';
import {
  createLocalFixtureProvider,
  createRuntimeGenerationProviderResolver,
  createSupabaseGenerationDependencies,
  runGeneration,
} from '../generate-draft/index.ts';

const postgresUuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
const claimedGenerationSchema = z.object({
  outcome: z.literal('claimed'),
  jobId: postgresUuid,
  ownerId: postgresUuid,
  draftId: postgresUuid,
  providerSettingId: postgresUuid,
  idempotencyKey: z.string().trim().min(1).max(200),
  mode: z.enum(['new', 'revise_selection', 'major_event_scene_plan', 'major_event_draft']),
  kind: z.enum(['short_dialogue', 'daily_event', 'major_event_proposal']),
  source: z.enum(['manual', 'schedule', 'access']),
  policyClass: z.enum(['manual', 'schedule']),
  seed: z.string().max(2_000).optional(),
  tags: z.array(z.string().trim().min(1).max(64)).max(10).optional(),
  revision: z.object({ selectedText: z.string().trim().min(1).max(4_000), instruction: z.string().trim().min(1).max(1_000) }).strict().optional(),
  requestedMaxOutputTokens: z.number().int().positive().max(2_147_483_647).optional(),
}).strict().superRefine((value, context) => {
  if ((value.source === 'manual') !== (value.policyClass === 'manual')) {
    context.addIssue({ code: 'custom', message: 'source/policy mismatch' });
  }
  if (value.source !== 'manual' && (value.mode !== 'new' || value.revision !== undefined || value.requestedMaxOutputTokens !== undefined)) {
    context.addIssue({ code: 'custom', message: 'automatic command mismatch' });
  }
  if (value.mode === 'revise_selection' && (!value.revision || value.requestedMaxOutputTokens === undefined)) {
    context.addIssue({ code: 'custom', message: 'revision command incomplete' });
  }
  if (value.mode !== 'revise_selection' && (value.revision !== undefined || value.requestedMaxOutputTokens !== undefined)) {
    context.addIssue({ code: 'custom', message: 'revision command forbidden' });
  }
});

const nonClaimSchema = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('idle') }).strict(),
  z.object({ outcome: z.literal('retry_wait'), jobId: postgresUuid.optional(), retryAt: z.string().optional() }).strict(),
  z.object({ outcome: z.literal('dead_lettered'), jobId: postgresUuid.optional(), failureCode: z.string().optional() }).strict(),
]);
const workerMutationSchema = z.object({
  outcome: z.enum(['completed', 'retry_wait', 'dead_lettered', 'stale']),
  jobId: postgresUuid.optional(), retryAt: z.string().optional(), failureCode: z.string().optional(),
}).strict();

export type ClaimedGenerationJob = z.infer<typeof claimedGenerationSchema>;
export type GenerationWorkerClaim = ClaimedGenerationJob | z.infer<typeof nonClaimSchema>;
export type GenerationWorkerOutcome = { outcome: 'idle' | 'retry_wait' | 'dead_lettered' | 'stale' | 'completed'; jobId?: string };

export interface GenerationWorkerDependencies {
  createWorkerAttemptToken(): string;
  claim(workerAttemptToken: string, signal?: AbortSignal): Promise<GenerationWorkerClaim>;
  generate(command: GenerationCommand, workerAttemptToken: string, claim: ClaimedGenerationJob, signal?: AbortSignal): Promise<GenerationResponse>;
  complete(jobId: string, workerAttemptToken: string, signal?: AbortSignal): Promise<z.infer<typeof workerMutationSchema>>;
  fail(jobId: string, workerAttemptToken: string, failureCode: string, signal?: AbortSignal): Promise<z.infer<typeof workerMutationSchema>>;
}

export interface GenerationWorkerRestConfig {
  url: string;
  serviceRoleKey: string;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}

export class GenerationWorkerError extends Error {
  constructor(public readonly code: string) { super(code); this.name = 'GenerationWorkerError'; }
}

const generationFailureCodes = new Set([
  'freeze_failed', 'frozen_validation_failed', 'reservation_failed', 'budget_blocked', 'provider_dispatch_uncertain',
  'provider_generation_failed', 'provider_response_invalid', 'provider_result_kind_mismatch', 'provider_usage_exceeds_reservation',
  'continuity_check_failed', 'finalization_failed', 'manual_generation_disabled', 'schedule_automation_disabled',
  'active_provider_setting_required', 'stale_provider_pricing', 'invalid_provider_pricing', 'manual_call_limit_reached',
  'generation_worker_attempt_mismatch', 'generation_binding_changed',
  'provider_timeout', 'provider_output_limit', 'provider_connection_failed',
]);

function failureCode(error: unknown): string {
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
  return generationFailureCodes.has(code) ? code : 'generation_failed';
}

function commandFromClaim(claim: ClaimedGenerationJob): GenerationCommand {
  return {
    authToken: '', jobId: claim.jobId, draftId: claim.draftId, idempotencyKey: claim.idempotencyKey,
    mode: claim.mode, kind: claim.kind,
    ...(claim.seed === undefined ? {} : { seed: claim.seed }),
    ...(claim.tags === undefined ? {} : { tags: [...claim.tags] }),
    ...(claim.revision === undefined ? {} : { revision: { ...claim.revision } }),
    ...(claim.requestedMaxOutputTokens === undefined ? {} : { requestedMaxOutputTokens: claim.requestedMaxOutputTokens }),
  };
}

export async function dispatchGenerationWorker(deps: GenerationWorkerDependencies, signal?: AbortSignal): Promise<GenerationWorkerOutcome> {
  const workerAttemptToken = deps.createWorkerAttemptToken();
  if (signal?.aborted) throw new GenerationWorkerError('generation_worker_cancelled');
  const claim = await deps.claim(workerAttemptToken, signal);
  if (claim.outcome !== 'claimed') return { outcome: claim.outcome, ...('jobId' in claim && claim.jobId ? { jobId: claim.jobId } : {}) };
  try {
    await deps.generate(commandFromClaim(claim), workerAttemptToken, claim, signal);
  } catch (error) {
    if (signal?.aborted) throw new GenerationWorkerError('generation_worker_cancelled');
    const failed = await deps.fail(claim.jobId, workerAttemptToken, failureCode(error), signal);
    return { outcome: failed.outcome, jobId: claim.jobId };
  }
  if (signal?.aborted) throw new GenerationWorkerError('generation_worker_cancelled');
  let completed: Awaited<ReturnType<GenerationWorkerDependencies['complete']>>;
  try { completed = await deps.complete(claim.jobId, workerAttemptToken, signal); }
  catch (error) {
    if (signal?.aborted) throw new GenerationWorkerError('generation_worker_cancelled');
    completed = await deps.complete(claim.jobId, workerAttemptToken, signal);
  }
  return { outcome: completed.outcome, jobId: claim.jobId };
}

async function boundedBody(request: Request, maximumBytes: number, signal: AbortSignal): Promise<unknown> {
  const contentLength = request.headers.get('content-length');
  if (contentLength !== null && Number(contentLength) > maximumBytes) throw new GenerationWorkerError('dispatch_body_too_large');
  if (!request.body) throw new GenerationWorkerError('invalid_command');
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let rejectAbort: ((error: GenerationWorkerError) => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
  const abort = () => {
    void reader.cancel().catch(() => undefined);
    rejectAbort?.(new GenerationWorkerError('generation_worker_cancelled'));
  };
  if (signal.aborted) abort();
  else signal.addEventListener('abort', abort, { once: true });
  try {
    while (true) {
      const { done, value } = await Promise.race([reader.read(), aborted]);
      if (done) break;
      size += value.byteLength;
      if (size > maximumBytes) {
        await reader.cancel();
        throw new GenerationWorkerError('dispatch_body_too_large');
      }
      chunks.push(value);
    }
    const merged = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(merged));
  } catch (error) {
    if (error instanceof GenerationWorkerError) throw error;
    throw new GenerationWorkerError('invalid_command');
  } finally { signal.removeEventListener('abort', abort); }
}

export function createGenerationWorkerHandler(
  deps: GenerationWorkerDependencies,
  dispatchToken: string,
  options: { dispatchTimeoutMs?: number } = {},
): (request: Request) => Promise<Response> {
  const dispatchTimeoutMs = typeof options.dispatchTimeoutMs === 'number' && options.dispatchTimeoutMs > 0
    ? Math.min(options.dispatchTimeoutMs, 299_000)
    : 240_000;
  return async (request) => {
    if (request.method !== 'POST') return Response.json({ error: 'method_not_allowed' }, { status: 405 });
    if (!dispatchToken || request.headers.get('x-schedule-dispatch-token') !== dispatchToken) {
      return Response.json({ error: 'dispatch_not_authorized' }, { status: 401 });
    }
    const controller = new AbortController();
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => {
        controller.abort();
        reject(new GenerationWorkerError('generation_worker_timeout'));
      }, dispatchTimeoutMs);
    });
    try {
      const operation = (async () => {
        const body = await boundedBody(request, 1_024, controller.signal);
        const parsed = z.object({ action: z.literal('dispatch') }).strict().safeParse(body);
        if (!parsed.success) throw new GenerationWorkerError('invalid_command');
        return dispatchGenerationWorker(deps, controller.signal);
      })();
      const outcome = await Promise.race([operation, timeout]);
      return Response.json(outcome, { status: 202 });
    } catch (error) {
      const code = error instanceof GenerationWorkerError ? error.code : 'internal_error';
      const status = code === 'generation_worker_timeout' ? 504
        : code === 'dispatch_body_too_large' ? 413
        : code === 'invalid_command' ? 400
        : 500;
      return Response.json({ error: code }, { status });
    } finally {
      if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
    }
  };
}

export function createSupabaseGenerationWorkerDependencies(
  config: GenerationWorkerRestConfig,
  generate: GenerationWorkerDependencies['generate'],
): GenerationWorkerDependencies {
  const request = config.fetch ?? globalThis.fetch;
  const timeoutMs = typeof config.timeoutMs === 'number' && Number.isFinite(config.timeoutMs) && config.timeoutMs > 0
    ? Math.min(config.timeoutMs, 10_000)
    : 10_000;
  const headers = { apikey: config.serviceRoleKey, authorization: `Bearer ${config.serviceRoleKey}`, 'content-type': 'application/json' };
  const rpc = async (name: string, body: Record<string, unknown>, outerSignal?: AbortSignal): Promise<unknown> => {
    const controller = new AbortController();
    let rejectOuter: ((error: GenerationWorkerError) => void) | undefined;
    const cancelled = new Promise<never>((_resolve, reject) => { rejectOuter = reject; });
    const abortOuter = () => { controller.abort(outerSignal?.reason); rejectOuter?.(new GenerationWorkerError('generation_worker_cancelled')); };
    if (outerSignal?.aborted) abortOuter();
    else outerSignal?.addEventListener('abort', abortOuter, { once: true });
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => { controller.abort(); reject(new GenerationWorkerError('generation_worker_rpc_uncertain')); }, timeoutMs);
    });
    try {
      const response = await Promise.race([
        request(`${config.url}/rest/v1/rpc/${name}`, { method: 'POST', headers, signal: controller.signal, body: JSON.stringify(body) }),
        timeout, cancelled,
      ]);
      const value = response.status === 204 ? null : await Promise.race([response.json(), timeout, cancelled]);
      if (!response.ok) throw new GenerationWorkerError('generation_worker_rpc_failed');
      return value;
    } catch (error) {
      if (error instanceof GenerationWorkerError) throw error;
      throw new GenerationWorkerError('generation_worker_rpc_uncertain');
    } finally {
      if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
      outerSignal?.removeEventListener('abort', abortOuter);
    }
  };
  return {
    createWorkerAttemptToken: () => crypto.randomUUID(),
    claim: async (workerAttemptToken, signal) => {
      const value = await rpc('claim_generation_worker_job', { p_worker_attempt_token: workerAttemptToken }, signal);
      const claimed = claimedGenerationSchema.safeParse(value);
      if (claimed.success) return claimed.data;
      const nonClaim = nonClaimSchema.safeParse(value);
      if (nonClaim.success) return nonClaim.data;
      throw new GenerationWorkerError('generation_worker_claim_invalid');
    },
    generate,
    complete: async (jobId, workerAttemptToken, signal) => workerMutationSchema.parse(await rpc('complete_generation_worker_attempt', {
      p_job_id: jobId, p_worker_attempt_token: workerAttemptToken,
    }, signal)),
    fail: async (jobId, workerAttemptToken, code, signal) => workerMutationSchema.parse(await rpc('fail_generation_worker_attempt', {
      p_job_id: jobId, p_worker_attempt_token: workerAttemptToken, p_failure_code: code,
    }, signal)),
  };
}

interface DenoRuntime { env: { get(name: string): string | undefined }; serve(handler: (request: Request) => Response | Promise<Response>): void }
declare const Deno: DenoRuntime;
if (typeof Deno !== 'undefined' && (import.meta as ImportMeta & { main?: boolean }).main) {
  const url = Deno.env.get('SUPABASE_URL');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const dispatchToken = Deno.env.get('NARRATIVE_SCHEDULE_DISPATCH_TOKEN');
  if (!url || !anonKey || !serviceRoleKey || !dispatchToken) throw new Error('generation worker runtime settings are required');
  const generationConfig = { url, anonKey, serviceRoleKey };
  const traceFakeContext = Deno.env.get('NARRATIVE_FAKE_LOCAL_CONTEXT_TRACE') === 'true';
  const fakeProvider = Deno.env.get('NARRATIVE_FAKE_LOCAL_FIXTURE') === 'true'
    ? createLocalFixtureProvider(undefined, (kind, request) => {
      console.log(`FAKE_LOCAL_PROVIDER_INVOKED:${kind}`);
      if (traceFakeContext) console.log(`FAKE_LOCAL_PROVIDER_CONTEXT:${kind}:${JSON.stringify(request)}`);
    })
    : undefined;
  const resolveProvider = createRuntimeGenerationProviderResolver(generationConfig, (name) => Deno.env.get(name), fakeProvider);
  const deps = createSupabaseGenerationWorkerDependencies({ url, serviceRoleKey }, async (command, workerAttemptToken, claim, signal) => {
    return runGeneration(
      createSupabaseGenerationDependencies({ ...generationConfig, signal }, '', resolveProvider, { workerAttemptToken, claim }),
      command,
      signal,
    );
  });
  Deno.serve(createGenerationWorkerHandler(deps, dispatchToken));
}
