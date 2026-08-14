import { z } from 'zod';
import type { DraftStatus } from '../../../shared/narrative/contracts.ts';

export type ReviewAction = 'reject' | 'approve_private' | 'approve_public';

export interface ReviewCommand {
  authToken: string;
  draftId: string;
  expectedVersionId: string;
  expectedState: 'reviewing';
  idempotencyKey: string;
  action: ReviewAction;
  reason?: string;
}

export type MemoryWrite =
  | { kind: 'feedback'; text: string }
  | { kind: 'continuity'; sourceVersionId: string; status: 'approved' };

export interface ReviewTransaction {
  ownerId: string;
  draftId: string;
  expectedVersionId: string;
  expectedState: 'reviewing';
  idempotencyKey: string;
  action: ReviewAction;
  nextState: Extract<DraftStatus, 'rejected' | 'approved_private' | 'approved'>;
  memoryWrites: MemoryWrite[];
  enqueuePublish: boolean;
  publishStatus?: 'queued';
}

export interface ReviewResponse {
  draftId: string;
  versionId: string;
  status: ReviewTransaction['nextState'];
}

export interface ReviewDependencies {
  authenticate(token: string): Promise<{ ownerId: string }>;
  hasReviewAction(ownerId: string, idempotencyKey: string): Promise<boolean>;
  authorize(ownerId: string, draftId: string): Promise<{ draftStatus: string; latestVersionId: string }>;
  commitAtomic(transaction: ReviewTransaction): Promise<ReviewResponse>;
}

export interface SupabaseReviewConfig {
  url: string;
  anonKey: string;
  fetch?: typeof globalThis.fetch;
}

export class ReviewError extends Error {
  constructor(public readonly status: number, public readonly code: string) {
    super(code);
    this.name = 'ReviewError';
  }
}

const reviewCommandBodySchema = z.object({
  draftId: z.string().trim().min(1),
  expectedVersionId: z.string().trim().min(1),
  expectedState: z.literal('reviewing'),
  idempotencyKey: z.string().trim().min(1),
  action: z.enum(['reject', 'approve_private', 'approve_public']),
  reason: z.string().optional(),
});

function reviewEffects(command: ReviewCommand): Pick<ReviewTransaction, 'nextState' | 'memoryWrites' | 'enqueuePublish' | 'publishStatus'> {
  if (command.action === 'reject') {
    const reason = command.reason?.trim();
    if (!reason) throw new ReviewError(400, 'reject_reason_required');
    return { nextState: 'rejected', memoryWrites: [{ kind: 'feedback', text: reason }], enqueuePublish: false };
  }

  const effects = {
    nextState: command.action === 'approve_public' ? 'approved' as const : 'approved_private' as const,
    memoryWrites: [{ kind: 'continuity' as const, sourceVersionId: command.expectedVersionId, status: 'approved' as const }],
    enqueuePublish: command.action === 'approve_public',
  };
  return command.action === 'approve_public' ? { ...effects, publishStatus: 'queued' } : effects;
}

/** Converts a review decision into one optimistic, atomic persistence command. */
export async function applyReview(deps: ReviewDependencies, command: ReviewCommand): Promise<ReviewResponse> {
  const { ownerId } = await deps.authenticate(command.authToken);
  if (await deps.hasReviewAction(ownerId, command.idempotencyKey)) throw new ReviewError(409, 'duplicate_review');
  const current = await deps.authorize(ownerId, command.draftId);
  if (current.draftStatus !== command.expectedState || current.latestVersionId !== command.expectedVersionId) {
    throw new ReviewError(409, 'stale_review');
  }

  const effects = reviewEffects(command);
  try {
    return await deps.commitAtomic({
      ownerId,
      draftId: command.draftId,
      expectedVersionId: command.expectedVersionId,
      expectedState: command.expectedState,
      idempotencyKey: command.idempotencyKey,
      action: command.action,
      ...effects,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (message.includes('duplicate')) throw new ReviewError(409, 'duplicate_review');
    if (message.includes('stale')) throw new ReviewError(409, 'stale_review');
    throw error;
  }
}

function reviewJsonError(error: unknown): Response {
  if (!(error instanceof ReviewError)) console.error('review-draft failed', error);
  const known = error instanceof ReviewError ? error : new ReviewError(500, 'internal_error');
  return Response.json({ error: known.code }, { status: known.status });
}

/** Thin HTTP boundary; deployments inject the Supabase-backed dependencies. */
export function createReviewDraftHandler(deps: ReviewDependencies): (request: Request) => Promise<Response> {
  return async (request) => {
    if (request.method !== 'POST') return Response.json({ error: 'method_not_allowed' }, { status: 405 });
    try {
      const authorization = request.headers.get('authorization');
      if (!authorization?.startsWith('Bearer ')) throw new ReviewError(401, 'authentication_required');
      const parsed = reviewCommandBodySchema.safeParse(await request.json());
      if (!parsed.success) throw new ReviewError(400, 'invalid_command');
      const body = parsed.data;
      return Response.json(await applyReview(deps, { ...body, authToken: authorization.slice(7) }), { status: 200 });
    } catch (error) {
      return reviewJsonError(error);
    }
  };
}

function firstRow<T>(value: unknown): T | null {
  if (Array.isArray(value)) return (value[0] as T | undefined) ?? null;
  return value && typeof value === 'object' ? value as T : null;
}

/** Authenticated PostgREST adapter; the atomic review RPC derives ownership from its locked draft. */
export function createSupabaseReviewDependencies(config: SupabaseReviewConfig, authToken: string): ReviewDependencies {
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

  return {
    authenticate: async () => {
      const user = firstRow<{ id: string }>(await call('/auth/v1/user'));
      if (!user?.id) throw new ReviewError(401, 'authentication_required');
      return { ownerId: user.id };
    },
    hasReviewAction: async (_ownerId, idempotencyKey) => {
      const actions = await call(`/rest/v1/draft_review_actions?select=id&idempotency_key=eq.${encodeURIComponent(idempotencyKey)}`);
      return Array.isArray(actions) && actions.length > 0;
    },
    authorize: async (_ownerId, draftId) => {
      const drafts = await call(`/rest/v1/drafts?select=status&id=eq.${encodeURIComponent(draftId)}`);
      const draft = firstRow<{ status: string }>(drafts);
      if (!draft) throw new ReviewError(404, 'draft_not_found');
      const versions = await call(`/rest/v1/draft_versions?select=id&draft_id=eq.${encodeURIComponent(draftId)}&order=version_number.desc&limit=1`);
      const version = firstRow<{ id: string }>(versions);
      if (!version) throw new ReviewError(404, 'draft_version_not_found');
      return { draftStatus: draft.status, latestVersionId: version.id };
    },
    commitAtomic: async (transaction) => {
      const value = await call('/rest/v1/rpc/review_draft_atomic', {
        method: 'POST',
        body: JSON.stringify({
          p_draft_id: transaction.draftId,
          p_expected_version_id: transaction.expectedVersionId,
          p_expected_state: transaction.expectedState,
          p_action: transaction.action,
          p_reason: transaction.action === 'reject' ? transaction.memoryWrites[0]?.kind === 'feedback' ? transaction.memoryWrites[0].text : null : null,
          p_idempotency_key: transaction.idempotencyKey,
        }),
      });
      const draft = firstRow<{ id: string; status: ReviewResponse['status'] }>(value);
      if (!draft?.id) throw new Error('review_not_committed');
      return { draftId: draft.id, versionId: transaction.expectedVersionId, status: draft.status };
    },
  };
}

interface DenoRuntime {
  env: { get(name: string): string | undefined };
  serve(handler: (request: Request) => Response | Promise<Response>): void;
}

declare const Deno: DenoRuntime;

if (typeof Deno !== 'undefined' && (import.meta as ImportMeta & { main?: boolean }).main) {
  const url = Deno.env.get('SUPABASE_URL');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
  if (!url || !anonKey) throw new Error('SUPABASE_URL and SUPABASE_ANON_KEY are required');
  Deno.serve((request) => {
    const token = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
    return createReviewDraftHandler(createSupabaseReviewDependencies({ url, anonKey }, token))(request);
  });
}
