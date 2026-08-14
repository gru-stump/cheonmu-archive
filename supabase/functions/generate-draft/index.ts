import { z } from 'zod';
import { draftKinds, type DraftKind, type DraftStatus, type GenerationRequest, type GenerationResult, type Usage } from '../../../shared/narrative/contracts.ts';
import { selectNarrativeContext, type ContextSelection, type NarrativeMemory } from '../_shared/context.ts';
import { checkContinuity, type ContinuityCheck, type ContinuityContext } from '../_shared/continuity.ts';
import { FakeNarrativeProvider } from '../_shared/fake-provider.ts';
import { parseNarrativeProviderResponse, type NarrativeProvider, type NarrativeProviderResponse } from '../_shared/provider.ts';

export type GenerationMode = 'new' | 'revise_selection' | 'major_event_scene_plan' | 'major_event_draft';

export interface GenerationCommand {
  authToken: string;
  jobId: string;
  draftId: string;
  idempotencyKey: string;
  mode: GenerationMode;
  kind: DraftKind;
  seed?: string;
  maxInputTokens: number;
  maxOutputTokens: number;
  worstCaseCostMicros: number;
  tags?: string[];
}

export interface GenerationResponse {
  draftId: string;
  versionId: string;
  status: 'generated';
  continuityLevel: ContinuityCheck['level'];
}

export interface GenerationDependencies {
  authenticate(token: string): Promise<{ ownerId: string }>;
  authorize(ownerId: string, command: GenerationCommand): Promise<{ draftStatus: DraftStatus; workflowPhase: string | null }>;
  findIdempotent(ownerId: string, idempotencyKey: string): Promise<GenerationResponse | null>;
  selectContext(ownerId: string, command: GenerationCommand): Promise<{ selection: ContextSelection; continuityContext: ContinuityContext }>;
  freezeContext(input: { ownerId: string; jobId: string; draftId: string; idempotencyKey: string; mode: GenerationMode; contextVersionIds: string[] }): Promise<void>;
  reserveBudget(jobId: string, amountMicros: number): Promise<
    | { status: 'reserved'; remainingMicros: number }
    | { status: 'blocked'; budgetStatus: string; remainingMicros: number }
  >;
  transitionDraft(draftId: string, expected: DraftStatus, next: DraftStatus): Promise<void>;
  provider: NarrativeProvider;
  parseProviderResponse(value: unknown): NarrativeProviderResponse;
  checkContinuity(result: GenerationResult, context: ContinuityContext): ContinuityCheck;
  reconcileBudget(jobId: string, actualMicros: number, usage: Usage): Promise<void>;
  failBudget(jobId: string, chargedMicros: number): Promise<void>;
  storeVersion(input: {
    ownerId: string;
    jobId: string;
    draftId: string;
    result: GenerationResult;
    contextVersionIds: string[];
    continuityLevel: ContinuityCheck['level'];
    findings: ContinuityCheck['findings'];
    providerResponseId: string;
    visibility: 'private';
  }): Promise<{ draftId: string; versionId: string; status: 'generated' }>;
}

export interface SupabaseRestConfig {
  url: string;
  anonKey: string;
  fetch?: typeof globalThis.fetch;
}

export class GenerationError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(code);
    this.name = 'GenerationError';
  }
}

const generationCommandBodySchema = z.object({
  jobId: z.string().trim().min(1),
  draftId: z.string().trim().min(1),
  idempotencyKey: z.string().trim().min(1),
  mode: z.enum(['new', 'revise_selection', 'major_event_scene_plan', 'major_event_draft']),
  kind: z.enum(draftKinds),
  seed: z.string().optional(),
  maxInputTokens: z.number().int().positive(),
  maxOutputTokens: z.number().int().positive(),
  worstCaseCostMicros: z.number().int().nonnegative(),
  tags: z.array(z.string()).optional(),
});

function previousPhaseIsApproved(mode: GenerationMode, phase: string | null): boolean {
  if (mode === 'major_event_scene_plan') return phase === 'proposal_approved';
  if (mode === 'major_event_draft') return phase === 'scene_plan_approved';
  return true;
}

function conflictCode(error: unknown, fallback: string): GenerationError {
  const message = error instanceof Error ? error.message : fallback;
  const code = message.includes('duplicate') ? 'duplicate_generation' : fallback;
  return new GenerationError(409, code);
}

/** Runs one generation attempt. It never retries and never promotes narrative memory. */
export async function runGeneration(deps: GenerationDependencies, command: GenerationCommand): Promise<GenerationResponse> {
  const { ownerId } = await deps.authenticate(command.authToken);
  const authorization = await deps.authorize(ownerId, command);
  const existing = await deps.findIdempotent(ownerId, command.idempotencyKey);
  if (existing) return existing;

  if (!previousPhaseIsApproved(command.mode, authorization.workflowPhase)) {
    throw new GenerationError(409, 'workflow_phase_not_approved', { workflowPhase: authorization.workflowPhase });
  }
  if (authorization.draftStatus !== 'queued') throw new GenerationError(409, 'stale_transition');

  const frozen = await deps.selectContext(ownerId, command);
  try {
    await deps.freezeContext({
      ownerId,
      jobId: command.jobId,
      draftId: command.draftId,
      idempotencyKey: command.idempotencyKey,
      mode: command.mode,
      contextVersionIds: frozen.selection.versionIds,
    });
  } catch (error) {
    throw conflictCode(error, 'duplicate_generation');
  }

  const reservation = await deps.reserveBudget(command.jobId, command.worstCaseCostMicros);
  if (reservation.status === 'blocked') {
    throw new GenerationError(402, 'budget_blocked', {
      budgetStatus: reservation.budgetStatus,
      remainingMicros: reservation.remainingMicros,
    });
  }

  try {
    await deps.transitionDraft(command.draftId, 'queued', 'generating');
  } catch (error) {
    await deps.failBudget(command.jobId, 0);
    throw conflictCode(error, 'stale_transition');
  }

  const request: GenerationRequest = {
    kind: command.kind,
    ...(command.seed === undefined ? {} : { seed: command.seed }),
    maxInputTokens: command.maxInputTokens,
    maxOutputTokens: command.maxOutputTokens,
    contextVersionIds: frozen.selection.versionIds,
  };

  let providerResponse: NarrativeProviderResponse;
  try {
    providerResponse = deps.parseProviderResponse(await deps.provider.generate(request));
  } catch (error) {
    await deps.failBudget(command.jobId, command.worstCaseCostMicros);
    await deps.transitionDraft(command.draftId, 'generating', 'queued');
    throw new GenerationError(502, 'provider_generation_failed', {
      reason: error instanceof Error ? error.message : 'unknown_provider_error',
    });
  }

  const continuity = deps.checkContinuity(providerResponse.result, frozen.continuityContext);
  const actualMicros = providerResponse.usage.costMicros ?? command.worstCaseCostMicros;
  await deps.reconcileBudget(command.jobId, actualMicros, providerResponse.usage);
  const stored = await deps.storeVersion({
    ownerId,
    jobId: command.jobId,
    draftId: command.draftId,
    result: providerResponse.result,
    contextVersionIds: frozen.selection.versionIds,
    continuityLevel: continuity.level,
    findings: continuity.findings,
    providerResponseId: providerResponse.rawId,
    visibility: 'private',
  });

  return { ...stored, continuityLevel: continuity.level };
}

export function jsonError(error: unknown): Response {
  if (!(error instanceof GenerationError)) console.error('generate-draft failed', error);
  const known = error instanceof GenerationError ? error : new GenerationError(500, 'internal_error');
  return Response.json({ error: known.code, ...(known.details ? { details: known.details } : {}) }, { status: known.status });
}

/** Thin HTTP boundary; deployments inject the Supabase-backed dependencies. */
export function createGenerateDraftHandler(deps: GenerationDependencies): (request: Request) => Promise<Response> {
  return async (request) => {
    if (request.method !== 'POST') return Response.json({ error: 'method_not_allowed' }, { status: 405 });
    try {
      const authorization = request.headers.get('authorization');
      if (!authorization?.startsWith('Bearer ')) throw new GenerationError(401, 'authentication_required');
      const parsed = generationCommandBodySchema.safeParse(await request.json());
      if (!parsed.success) throw new GenerationError(400, 'invalid_command');
      const body = parsed.data;
      const response = await runGeneration(deps, { ...body, authToken: authorization.slice(7) });
      return Response.json(response, { status: 200 });
    } catch (error) {
      return jsonError(error);
    }
  };
}

function singleRow<T>(value: unknown): T | null {
  if (Array.isArray(value)) return (value[0] as T | undefined) ?? null;
  return value && typeof value === 'object' ? value as T : null;
}

/** Authenticated PostgREST adapter used by the Edge Function; owner IDs are never accepted from request JSON. */
export function createSupabaseGenerationDependencies(
  config: SupabaseRestConfig,
  authToken: string,
  provider: NarrativeProvider,
): GenerationDependencies {
  const request = config.fetch ?? globalThis.fetch;
  const headers = {
    apikey: config.anonKey,
    authorization: `Bearer ${authToken}`,
    'content-type': 'application/json',
  };
  const call = async (path: string, init: RequestInit = {}): Promise<unknown> => {
    const response = await request(`${config.url}${path}`, { ...init, headers: { ...headers, ...init.headers } });
    const value = response.status === 204 ? null : await response.json();
    if (!response.ok) {
      const message = value && typeof value === 'object'
        ? String(('message' in value && value.message) || ('msg' in value && value.msg) || ('error_description' in value && value.error_description) || `supabase_${response.status}`)
        : `supabase_${response.status}`;
      throw new Error(message);
    }
    return value;
  };
  const rpc = (name: string, body: Record<string, unknown>) => call(`/rest/v1/rpc/${name}`, { method: 'POST', body: JSON.stringify(body) });

  return {
    authenticate: async () => {
      const user = singleRow<{ id: string }>(await call('/auth/v1/user'));
      if (!user?.id) throw new GenerationError(401, 'authentication_required');
      return { ownerId: user.id };
    },
    authorize: async (_ownerId, command) => {
      const drafts = await call(`/rest/v1/drafts?select=status,kind&id=eq.${encodeURIComponent(command.draftId)}`);
      const draft = singleRow<{ status: DraftStatus; kind: DraftKind }>(drafts);
      if (!draft) throw new GenerationError(404, 'draft_not_found');
      let workflowPhase: string | null = null;
      if (command.mode.startsWith('major_event_')) {
        const workflows = await call(`/rest/v1/major_event_workflows?select=phase&draft_id=eq.${encodeURIComponent(command.draftId)}`);
        workflowPhase = singleRow<{ phase: string }>(workflows)?.phase ?? null;
      }
      return { draftStatus: draft.status, workflowPhase };
    },
    findIdempotent: async (_ownerId, idempotencyKey) => {
      const jobs = await call(`/rest/v1/generation_jobs?select=id,draft_id,status&idempotency_key=eq.${encodeURIComponent(idempotencyKey)}`);
      const job = singleRow<{ id: string; draft_id: string; status: string }>(jobs);
      if (!job) return null;
      if (job.status !== 'completed') throw new GenerationError(409, 'duplicate_generation');
      const versions = await call(`/rest/v1/draft_versions?select=id,continuity_level&generation_job_id=eq.${encodeURIComponent(job.id)}`);
      const version = singleRow<{ id: string; continuity_level: ContinuityCheck['level'] }>(versions);
      return version ? { draftId: job.draft_id, versionId: version.id, status: 'generated', continuityLevel: version.continuity_level } : null;
    },
    selectContext: async (_ownerId, command) => {
      const rows = await call('/rest/v1/memory_items?select=id,memory_type,content,status,blocking,metadata,updated_at&status=in.(active,approved)');
      const memories = (Array.isArray(rows) ? rows : []).map((row) => {
        const item = row as { id: string; memory_type: NarrativeMemory['memoryType']; content: string; status: string; blocking: boolean; metadata?: Record<string, unknown>; updated_at?: string };
        return {
          versionId: item.id,
          memoryType: item.memory_type,
          content: item.content,
          status: item.status,
          blocking: item.blocking,
          tokenCount: typeof item.metadata?.tokenCount === 'number' ? item.metadata.tokenCount : Math.ceil(item.content.length / 4),
          tags: Array.isArray(item.metadata?.tags) ? item.metadata.tags.filter((tag): tag is string => typeof tag === 'string') : undefined,
          updatedAt: item.updated_at,
        } satisfies NarrativeMemory;
      });
      const selection = selectNarrativeContext({ memories, tokenBudget: command.maxInputTokens, tags: command.tags });
      const relationshipSourceId = selection.fixedCanon[0]?.versionId ?? selection.versionIds[0];
      if (!relationshipSourceId) throw new GenerationError(409, 'generation_context_unavailable');
      const source = memories.find(({ versionId }) => versionId === relationshipSourceId);
      const sourceRow = (Array.isArray(rows) ? rows : []).find((row) => (row as { id?: string }).id === source?.versionId) as { metadata?: Record<string, unknown> } | undefined;
      const stage = sourceRow?.metadata?.currentRelationshipStage;
      return {
        selection,
        continuityContext: {
          selectedSourceIds: selection.versionIds,
          relationshipSourceId,
          currentRelationshipStage: typeof stage === 'number' ? stage : 0,
        },
      };
    },
    freezeContext: async (input) => {
      await rpc('freeze_generation_context', {
        p_job_id: input.jobId,
        p_draft_id: input.draftId,
        p_generation_mode: input.mode,
        p_idempotency_key: input.idempotencyKey,
        p_context_version_ids: input.contextVersionIds,
      });
    },
    reserveBudget: async (jobId, amountMicros) => {
      try {
        await rpc('reserve_generation_budget', { job_id: jobId, amount_micros: amountMicros });
        return { status: 'reserved', remainingMicros: 0 };
      } catch (error) {
        if (error instanceof Error && (error.message.includes('budget_limit_exceeded') || error.message.includes('active budget period not found'))) {
          return { status: 'blocked', budgetStatus: 'limit_reached', remainingMicros: 0 };
        }
        throw error;
      }
    },
    transitionDraft: async (draftId, expected, next) => {
      await rpc('transition_draft', { p_draft_id: draftId, p_expected: expected, p_next: next });
    },
    provider,
    parseProviderResponse: parseNarrativeProviderResponse,
    checkContinuity,
    reconcileBudget: async (jobId, actualMicros, usage) => {
      await rpc('reconcile_generation_budget', { job_id: jobId, actual_micros: actualMicros, usage_json: usage });
    },
    failBudget: async (jobId, chargedMicros) => {
      await rpc('fail_generation_budget', { job_id: jobId, charged_micros: chargedMicros });
    },
    storeVersion: async (input) => {
      const value = await rpc('store_generation_result', {
        p_job_id: input.jobId,
        p_content: input.result,
        p_continuity_level: input.continuityLevel,
        p_continuity_findings: input.findings,
        p_provider_response_id: input.providerResponseId,
      });
      const version = singleRow<{ id: string; draft_id?: string }>(value);
      if (!version?.id) throw new Error('generation_version_not_stored');
      return { draftId: version.draft_id ?? input.draftId, versionId: version.id, status: 'generated' };
    },
  };
}

interface DenoRuntime {
  env: { get(name: string): string | undefined };
  serve(handler: (request: Request) => Response | Promise<Response>): void;
}

declare const Deno: DenoRuntime;

const defaultFakeResult: GenerationResult = {
  title: '로컬 생성 초안',
  kind: 'short_dialogue',
  setting: { time: '저녁', place: '처마 아래' },
  body: '천령과 무영은 빗소리 사이에서 잠시 말을 멈추었다.',
  emotionalStart: '고요함',
  emotionalEnd: '잔잔한 안도',
  continuityUsed: [],
  continuityCandidates: [],
  canonChangeCandidates: [],
  unresolvedCallbacks: [],
  riskFlags: [],
};

if (typeof Deno !== 'undefined' && (import.meta as ImportMeta & { main?: boolean }).main) {
  const url = Deno.env.get('SUPABASE_URL');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
  if (!url || !anonKey) throw new Error('SUPABASE_URL and SUPABASE_ANON_KEY are required');
  const fixtureText = Deno.env.get('FAKE_NARRATIVE_FIXTURE');
  const provider = new FakeNarrativeProvider(fixtureText ? JSON.parse(fixtureText) as GenerationResult : defaultFakeResult);
  Deno.serve((request) => {
    const token = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
    return createGenerateDraftHandler(createSupabaseGenerationDependencies({ url, anonKey }, token, provider))(request);
  });
}
