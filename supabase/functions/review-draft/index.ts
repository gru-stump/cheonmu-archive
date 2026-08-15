import { z } from 'zod';
import type { DraftStatus } from '../../../shared/narrative/contracts.ts';
import { corsGate, corsPolicyFromEnvironment, createCorsPolicy, withCorsHeaders, type CorsPolicy } from '../_shared/cors.ts';

export const CONTINUITY_POLICY_VERSION = 'cheonmu-continuity-v1';
export type ReviewAction = 'reject' | 'approve_private' | 'approve_public';
export interface ReviewCommand { authToken: string; draftId: string; expectedVersionId: string; expectedState: 'reviewing'; idempotencyKey: string; action: ReviewAction; reason?: string }
export type MemoryWrite = { kind: 'feedback'; text: string } | { kind: 'continuity'; sourceVersionId: string; status: 'approved' };
export interface ReviewTransaction {
  ownerId: string; draftId: string; expectedVersionId: string; expectedState: 'reviewing'; idempotencyKey: string;
  action: ReviewAction; nextState: Extract<DraftStatus, 'rejected' | 'approved_private' | 'approved'>;
  memoryWrites: MemoryWrite[]; enqueuePublish: boolean; publishStatus?: 'queued'; policyVersion: typeof CONTINUITY_POLICY_VERSION;
}
export interface ReviewResponse { draftId: string; versionId: string; status: ReviewTransaction['nextState'] }
export interface ReviewDependencies {
  authenticate(token: string): Promise<{ ownerId: string }>;
  hasReviewAction(ownerId: string, idempotencyKey: string): Promise<boolean>;
  authorize(ownerId: string, draftId: string): Promise<{ draftStatus: string; latestVersionId: string; continuityLevel: 'review' | 'block' | 'pass' | null; continuityPolicyVersion: string | null }>;
  commitAtomic(transaction: ReviewTransaction): Promise<ReviewResponse>;
}
export interface SupabaseReviewConfig { url: string; anonKey: string; fetch?: typeof globalThis.fetch }
export class ReviewError extends Error { constructor(public readonly status: number, public readonly code: string) { super(code); this.name = 'ReviewError'; } }
export class PersistenceError extends Error { constructor(public readonly code: string) { super(code); this.name = 'PersistenceError'; } }

const bodySchema = z.object({
  draftId: z.string().trim().min(1), expectedVersionId: z.string().trim().min(1), expectedState: z.literal('reviewing'),
  idempotencyKey: z.string().trim().min(1), action: z.enum(['reject', 'approve_private', 'approve_public']), reason: z.string().max(4_000).optional(),
}).strict();

function effects(command: ReviewCommand): Pick<ReviewTransaction, 'nextState' | 'memoryWrites' | 'enqueuePublish' | 'publishStatus'> {
  if (command.action === 'reject') {
    const reason = command.reason?.trim();
    if (!reason) throw new ReviewError(400, 'reject_reason_required');
    return { nextState: 'rejected', memoryWrites: [{ kind: 'feedback', text: reason }], enqueuePublish: false };
  }
  const value = { nextState: command.action === 'approve_public' ? 'approved' as const : 'approved_private' as const, memoryWrites: [{ kind: 'continuity' as const, sourceVersionId: command.expectedVersionId, status: 'approved' as const }], enqueuePublish: command.action === 'approve_public' };
  return command.action === 'approve_public' ? { ...value, publishStatus: 'queued' } : value;
}

function mapPersistence(error: unknown): ReviewError {
  if (error instanceof ReviewError) return error;
  if (error instanceof PersistenceError && ['duplicate_review', 'stale_review', 'version_not_approvable'].includes(error.code)) return new ReviewError(409, error.code);
  return new ReviewError(500, 'internal_error');
}

export async function applyReview(deps: ReviewDependencies, command: ReviewCommand): Promise<ReviewResponse> {
  const { ownerId } = await deps.authenticate(command.authToken);
  if (await deps.hasReviewAction(ownerId, command.idempotencyKey)) throw new ReviewError(409, 'duplicate_review');
  const current = await deps.authorize(ownerId, command.draftId);
  if (current.draftStatus !== command.expectedState || current.latestVersionId !== command.expectedVersionId) throw new ReviewError(409, 'stale_review');
  if (command.action !== 'reject' && (current.continuityLevel !== 'review' || current.continuityPolicyVersion !== CONTINUITY_POLICY_VERSION)) throw new ReviewError(409, 'version_not_approvable');
  try {
    return await deps.commitAtomic({ ownerId, draftId: command.draftId, expectedVersionId: command.expectedVersionId, expectedState: command.expectedState, idempotencyKey: command.idempotencyKey, action: command.action, policyVersion: CONTINUITY_POLICY_VERSION, ...effects(command) });
  } catch (error) { throw mapPersistence(error); }
}

function jsonError(error: unknown): Response {
  const known = error instanceof ReviewError ? error : new ReviewError(500, 'internal_error');
  return Response.json({ error: known.code }, { status: known.status });
}

const noCorsPolicy = createCorsPolicy([]);

export function createReviewDraftHandler(deps: ReviewDependencies, cors: CorsPolicy = noCorsPolicy): (request: Request) => Promise<Response> {
  return async (request) => {
    const gated = corsGate(request, cors);
    if (gated) return gated;
    const respond = (response: Response) => withCorsHeaders(request, response, cors);
    if (request.method !== 'POST') return respond(Response.json({ error: 'method_not_allowed' }, { status: 405 }));
    try {
      const authorization = request.headers.get('authorization');
      if (!authorization?.startsWith('Bearer ')) throw new ReviewError(401, 'authentication_required');
      let json: unknown; try { json = await request.json(); } catch { throw new ReviewError(400, 'invalid_command'); }
      const parsed = bodySchema.safeParse(json); if (!parsed.success) throw new ReviewError(400, 'invalid_command');
      return respond(Response.json(await applyReview(deps, { ...parsed.data, authToken: authorization.slice(7) })));
    } catch (error) { return respond(jsonError(error)); }
  };
}

function row<T>(value: unknown): T | null { return Array.isArray(value) ? (value[0] as T | undefined) ?? null : value && typeof value === 'object' ? value as T : null }
const stableCodes = new Set(['duplicate_review', 'stale_review', 'version_not_approvable']);

export function createSupabaseReviewDependencies(config: SupabaseReviewConfig, authToken: string): ReviewDependencies {
  const request = config.fetch ?? globalThis.fetch;
  const headers = { apikey: config.anonKey, authorization: `Bearer ${authToken}`, 'content-type': 'application/json' };
  const call = async (path: string, init: RequestInit = {}): Promise<unknown> => {
    const response = await request(`${config.url}${path}`, { ...init, headers: { ...headers, ...init.headers } });
    const value = response.status === 204 ? null : await response.json();
    if (!response.ok) {
      if (path === '/auth/v1/user' && (response.status === 401 || response.status === 403)) throw new ReviewError(401, 'authentication_required');
      const databaseCode = value && typeof value === 'object' && 'code' in value ? String(value.code) : '';
      const message = value && typeof value === 'object' ? String(('message' in value && value.message) || ('msg' in value && value.msg) || `supabase_${response.status}`) : `supabase_${response.status}`;
      if (databaseCode === 'P0001' && stableCodes.has(message)) throw new PersistenceError(message);
      throw new Error(`supabase_request_failed_${response.status}`);
    }
    return value;
  };
  return {
    authenticate: async () => {
      const user = row<{ id: string }>(await call('/auth/v1/user')); if (!user?.id) throw new ReviewError(401, 'authentication_required'); return { ownerId: user.id };
    },
    hasReviewAction: async (_ownerId, key) => {
      const actions = await call(`/rest/v1/draft_review_actions?select=id&idempotency_key=eq.${encodeURIComponent(key)}`); return Array.isArray(actions) && actions.length > 0;
    },
    authorize: async (_ownerId, draftId) => {
      const draft = row<{ status: string }>(await call(`/rest/v1/drafts?select=status&id=eq.${encodeURIComponent(draftId)}`)); if (!draft) throw new ReviewError(404, 'draft_not_found');
      const version = row<{ id: string; continuity_level: 'review' | 'block' | 'pass' | null; continuity_policy_version: string | null }>(await call(`/rest/v1/draft_versions?select=id,continuity_level,continuity_policy_version&draft_id=eq.${encodeURIComponent(draftId)}&order=version_number.desc&limit=1`));
      if (!version) throw new ReviewError(404, 'draft_version_not_found');
      return { draftStatus: draft.status, latestVersionId: version.id, continuityLevel: version.continuity_level, continuityPolicyVersion: version.continuity_policy_version };
    },
    commitAtomic: async (transaction) => {
      const value = await call('/rest/v1/rpc/review_draft_atomic', { method: 'POST', body: JSON.stringify({ p_draft_id: transaction.draftId, p_expected_version_id: transaction.expectedVersionId, p_expected_state: transaction.expectedState, p_action: transaction.action, p_reason: transaction.action === 'reject' && transaction.memoryWrites[0]?.kind === 'feedback' ? transaction.memoryWrites[0].text : null, p_idempotency_key: transaction.idempotencyKey, p_policy_version: transaction.policyVersion }) });
      const draft = row<{ id: string; status: ReviewResponse['status'] }>(value); if (!draft?.id) throw new Error('review_not_committed');
      return { draftId: draft.id, versionId: transaction.expectedVersionId, status: draft.status };
    },
  };
}

interface DenoRuntime { env: { get(name: string): string | undefined }; serve(handler: (request: Request) => Response | Promise<Response>): void }
declare const Deno: DenoRuntime;
if (typeof Deno !== 'undefined' && (import.meta as ImportMeta & { main?: boolean }).main) {
  const url = Deno.env.get('SUPABASE_URL'); const anonKey = Deno.env.get('SUPABASE_ANON_KEY'); if (!url || !anonKey) throw new Error('SUPABASE_URL and SUPABASE_ANON_KEY are required');
  const cors = corsPolicyFromEnvironment(Deno.env.get('NARRATIVE_ADMIN_ORIGINS'));
  Deno.serve((request) => { const token = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? ''; return createReviewDraftHandler(createSupabaseReviewDependencies({ url, anonKey }, token), cors)(request); });
}
