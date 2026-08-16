import { z } from 'zod';
import { toPublishedRecord, type LockedApprovedNarrativeVersion, type PublicationDetails } from '../../../shared/narrative/publish-record.ts';
import { bearerToken } from '../_shared/auth.ts';
import { corsGate, corsPolicyFromEnvironment, createCorsPolicy, withCorsHeaders, type CorsPolicy } from '../_shared/cors.ts';
import { GitHubPublisher, GitHubPublisherError, type CreateFileInput, type CreateFileResult } from '../_shared/github-publisher.ts';

export interface ClaimedPublication {
  outcome: 'claimed';
  attemptToken: string;
  publishJobId: string;
  ownerId: string;
  draftId: string;
  versionId: string;
  versionNumber: number;
  latestVersionId: string;
  approval: {
    id: string;
    draftId: string;
    versionId: string;
    action: 'approve_public' | 'approve_private' | 'reject';
    resultingState: string;
  };
  content: {
    title: string;
    body: string;
    canonChangeCandidates: unknown[];
    unresolvedCallbacks: unknown[];
    [key: string]: unknown;
  };
  publicationDetails: PublicationDetails;
  repository: { owner: string; name: string; branch: string; credential: string };
}

export interface AlreadyPublishedPublication {
  outcome: 'already_published';
  publishJobId: string;
  versionId: string;
  commitSha: string;
  path: string;
}

export type PublicationClaim = ClaimedPublication | AlreadyPublishedPublication;

export interface PublicationCommand {
  authToken: string;
  publishJobId: string;
  expectedVersionId: string;
  idempotencyKey: string;
}

export interface PublicationResponse {
  publishJobId: string;
  versionId: string;
  status: 'published';
  commitSha: string;
  path: string;
}

interface PublisherPort { createFile(input: CreateFileInput): Promise<CreateFileResult> }

export interface PublicationDependencies {
  createAttemptToken(): string;
  authenticate(token: string): Promise<{ ownerId: string }>;
  claimPublication(input: {
    ownerId: string; publishJobId: string; expectedVersionId: string; idempotencyKey: string; attemptToken: string;
  }): Promise<PublicationClaim>;
  renewPublication(input: { publishJobId: string; attemptToken: string }): Promise<void>;
  createPublisher(config: { owner: string; repository: string; token: string }): PublisherPort;
  completePublication(input: { publishJobId: string; attemptToken: string; commitSha: string; path: string }): Promise<PublicationResponse>;
  failPublication(input: { publishJobId: string; attemptToken: string; failureCode: PublicationFailureCode }): Promise<{ status: 'publish_failed' }>;
}

export interface SupabasePublicationConfig {
  url: string;
  anonKey: string;
  serviceRoleKey: string;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}

export type PublicationFailureCode =
  | 'record_validation_failed'
  | 'github_path_conflict'
  | 'github_conflict'
  | 'github_validation_failed'
  | 'github_credentials_rejected'
  | 'github_timeout'
  | 'github_network_failure'
  | 'github_response_invalid'
  | 'publication_claim_uncertain'
  | 'publication_claim_expired'
  | 'publication_completion_failed';

export class PublicationError extends Error {
  constructor(public readonly status: number, public readonly code: string) {
    super(code);
    this.name = 'PublicationError';
  }
}

const postgresUuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);

const commandSchema = z.object({
  publishJobId: postgresUuid,
  expectedVersionId: postgresUuid,
  idempotencyKey: z.string().trim().min(1).max(200),
}).strict();

const claimedRowSchema = z.object({
  outcome: z.literal('claimed'),
  attempt_token: postgresUuid,
  publish_job_id: postgresUuid,
  owner_id: postgresUuid,
  draft_id: postgresUuid,
  version_id: postgresUuid,
  version_number: z.coerce.number().int().positive(),
  latest_version_id: postgresUuid,
  approval_id: postgresUuid,
  approval_action: z.enum(['approve_public', 'approve_private', 'reject']),
  approval_resulting_state: z.string().min(1),
  content: z.object({
    title: z.string(), body: z.string(), canonChangeCandidates: z.array(z.unknown()), unresolvedCallbacks: z.array(z.unknown()),
  }).passthrough(),
  publication_details: z.unknown(),
  repository_owner: z.string().min(1),
  repository_name: z.string().min(1),
  repository_branch: z.string().min(1),
  credential: z.string().min(1),
}).strict();

const alreadyPublishedRowSchema = z.object({
  outcome: z.literal('already_published'),
  publish_job_id: postgresUuid,
  version_id: postgresUuid,
  commit_sha: z.string().regex(/^[0-9a-f]{40}$/i),
  published_path: z.string().min(1),
}).strict();

const stableConflicts = new Set([
  'publication_in_progress', 'publication_queue_busy', 'publication_idempotency_mismatch',
  'publication_not_approved', 'publication_attempt_mismatch', 'publication_already_finalized',
]);
const stableNotFound = new Set(['publication_target_not_found']);
const stableConfiguration = new Set(['publication_not_configured']);

function lockedVersion(
  claim: ClaimedPublication,
  expected: { ownerId: string; publishJobId: string; versionId: string; attemptToken: string },
): LockedApprovedNarrativeVersion {
  if (
    claim.ownerId !== expected.ownerId
    || claim.publishJobId !== expected.publishJobId
    || claim.versionId !== expected.versionId
    || claim.attemptToken !== expected.attemptToken
    || claim.approval.action !== 'approve_public'
    || claim.approval.resultingState !== 'approved'
    || claim.approval.draftId !== claim.draftId
    || claim.approval.versionId !== claim.versionId
    || !Array.isArray(claim.content.canonChangeCandidates)
    || claim.content.canonChangeCandidates.some((candidate) => typeof candidate !== 'string' || !candidate.trim())
    || !Array.isArray(claim.content.unresolvedCallbacks)
    || claim.content.unresolvedCallbacks.some((callback) => typeof callback !== 'string')
  ) throw new PublicationError(500, 'record_validation_failed');

  return {
    version: { id: claim.versionId, draftId: claim.draftId, versionNumber: claim.versionNumber, immutable: true },
    approval: {
      id: claim.approval.id, draftId: claim.approval.draftId, versionId: claim.approval.versionId,
      status: 'approved_for_publication',
    },
    publicationBinding: {
      id: claim.publishJobId, draftId: claim.draftId, approvalId: claim.approval.id,
      versionId: claim.versionId, latestVersionId: claim.latestVersionId,
    },
    content: {
      title: claim.content.title,
      body: claim.content.body,
      canonChangeCandidates: claim.content.canonChangeCandidates.map((candidate) => ({ id: candidate as string, resolution: 'resolved' as const })),
      unresolvedCallbacks: claim.content.unresolvedCallbacks as string[],
    },
  };
}

function githubError(error: GitHubPublisherError): PublicationError {
  if (error.code === 'github_path_conflict' || error.code === 'github_conflict' || error.code === 'github_validation_failed') {
    return new PublicationError(409, error.code);
  }
  if (error.code === 'github_timeout') return new PublicationError(504, error.code);
  return new PublicationError(502, error.code);
}

function failureCode(error: unknown): PublicationFailureCode {
  if (error instanceof GitHubPublisherError) return error.code;
  if (error instanceof PublicationError && error.code === 'record_validation_failed') return 'record_validation_failed';
  return 'publication_completion_failed';
}

function publicError(error: unknown): PublicationError {
  if (error instanceof PublicationError) return error;
  if (error instanceof GitHubPublisherError) return githubError(error);
  return new PublicationError(500, 'internal_error');
}

export async function applyPublication(deps: PublicationDependencies, command: PublicationCommand): Promise<PublicationResponse> {
  const { ownerId } = await deps.authenticate(command.authToken);
  const attemptToken = deps.createAttemptToken();
  let claim: PublicationClaim;
  try {
    claim = await deps.claimPublication({
      ownerId, publishJobId: command.publishJobId, expectedVersionId: command.expectedVersionId,
      idempotencyKey: command.idempotencyKey, attemptToken,
    });
  } catch (error) {
    try {
      await deps.failPublication({ publishJobId: command.publishJobId, attemptToken, failureCode: 'publication_claim_uncertain' });
    } catch { /* If the claim did not commit or recovery is also lost, the durable lease remains authoritative. */ }
    throw publicError(error);
  }
  if (claim.outcome === 'already_published') {
    return { publishJobId: claim.publishJobId, versionId: claim.versionId, status: 'published', commitSha: claim.commitSha, path: claim.path };
  }

  try {
    let record;
    try {
      record = toPublishedRecord(lockedVersion(claim, {
        ownerId, publishJobId: command.publishJobId, versionId: command.expectedVersionId, attemptToken,
      }), claim.publicationDetails);
    }
    catch { throw new PublicationError(500, 'record_validation_failed'); }
    await deps.renewPublication({ publishJobId: claim.publishJobId, attemptToken: claim.attemptToken });
    const publisher = deps.createPublisher({
      owner: claim.repository.owner, repository: claim.repository.name, token: claim.repository.credential,
    });
    const created = await publisher.createFile({
      path: record.path, content: record.source,
      message: `content: publish narrative ${claim.publicationDetails.id}`, branch: claim.repository.branch,
    });
    return await deps.completePublication({ publishJobId: claim.publishJobId, attemptToken: claim.attemptToken, commitSha: created.commitSha, path: record.path });
  } catch (error) {
    try {
      await deps.failPublication({ publishJobId: claim.publishJobId, attemptToken: claim.attemptToken, failureCode: failureCode(error) });
    } catch { /* A lost failure response must not expose or replace the original safe error. */ }
    throw publicError(error);
  }
}

function errorResponse(error: unknown): Response {
  const known = publicError(error);
  return Response.json({ error: known.code }, { status: known.status });
}

const noCors = createCorsPolicy([]);

export function createPublishDraftHandler(deps: PublicationDependencies, cors: CorsPolicy = noCors): (request: Request) => Promise<Response> {
  return async (request) => {
    const gated = corsGate(request, cors);
    if (gated) return gated;
    const respond = (response: Response) => withCorsHeaders(request, response, cors);
    if (request.method !== 'POST') return respond(Response.json({ error: 'method_not_allowed' }, { status: 405 }));
    const token = bearerToken(request);
    if (!token) return respond(Response.json({ error: 'authentication_required' }, { status: 401 }));
    let raw: unknown;
    try { raw = await request.json(); }
    catch { return respond(Response.json({ error: 'invalid_command' }, { status: 400 })); }
    const parsed = commandSchema.safeParse(raw);
    if (!parsed.success) return respond(Response.json({ error: 'invalid_command' }, { status: 400 }));
    try { return respond(Response.json(await applyPublication(deps, { authToken: token, ...parsed.data }))); }
    catch (error) { return respond(errorResponse(error)); }
  };
}

function databaseError(value: unknown, status: number): PublicationError {
  const code = value && typeof value === 'object' && 'code' in value ? String(value.code) : '';
  const message = value && typeof value === 'object'
    ? String(('message' in value && value.message) || ('msg' in value && value.msg) || '')
    : '';
  if (code === 'P0001' && stableConflicts.has(message)) return new PublicationError(409, message);
  if (code === 'P0002' && stableNotFound.has(message)) return new PublicationError(404, message);
  if (code === 'P0001' && stableConfiguration.has(message)) return new PublicationError(409, message);
  return new PublicationError(status === 401 || status === 403 ? 401 : 500, status === 401 || status === 403 ? 'authentication_required' : 'internal_error');
}

function parseClaim(value: unknown): PublicationClaim {
  const already = alreadyPublishedRowSchema.safeParse(value);
  if (already.success) return {
    outcome: 'already_published', publishJobId: already.data.publish_job_id, versionId: already.data.version_id,
    commitSha: already.data.commit_sha, path: already.data.published_path,
  };
  const parsed = claimedRowSchema.safeParse(value);
  if (!parsed.success) throw new PublicationError(500, 'internal_error');
  return {
    outcome: 'claimed', attemptToken: parsed.data.attempt_token, publishJobId: parsed.data.publish_job_id,
    ownerId: parsed.data.owner_id, draftId: parsed.data.draft_id, versionId: parsed.data.version_id,
    versionNumber: parsed.data.version_number, latestVersionId: parsed.data.latest_version_id,
    approval: {
      id: parsed.data.approval_id, draftId: parsed.data.draft_id, versionId: parsed.data.version_id,
      action: parsed.data.approval_action, resultingState: parsed.data.approval_resulting_state,
    },
    content: parsed.data.content as ClaimedPublication['content'],
    publicationDetails: parsed.data.publication_details as PublicationDetails,
    repository: {
      owner: parsed.data.repository_owner, name: parsed.data.repository_name,
      branch: parsed.data.repository_branch, credential: parsed.data.credential,
    },
  };
}

export function createSupabasePublicationDependencies(config: SupabasePublicationConfig, authToken: string): PublicationDependencies {
  const request = config.fetch ?? globalThis.fetch;
  const timeoutMs = typeof config.timeoutMs === 'number' && Number.isFinite(config.timeoutMs) && config.timeoutMs > 0
    ? Math.min(config.timeoutMs, 10_000)
    : 10_000;
  const userHeaders = { apikey: config.anonKey, authorization: `Bearer ${authToken}`, 'content-type': 'application/json' };
  const serviceHeaders = { apikey: config.serviceRoleKey, authorization: `Bearer ${config.serviceRoleKey}`, 'content-type': 'application/json' };
  const call = async (path: string, headers: Record<string, string>, init: RequestInit = {}): Promise<unknown> => {
    const controller = new AbortController();
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => {
        controller.abort();
        reject(new PublicationError(500, 'internal_error'));
      }, timeoutMs);
    });
    try {
      let response: Response;
      try {
        response = await Promise.race([
          request(`${config.url}${path}`, {
            ...init, signal: controller.signal, headers: { ...headers, ...init.headers },
          }),
          timeout,
        ]);
      }
      catch { throw new PublicationError(500, 'internal_error'); }
      let value: unknown = null;
      if (response.status !== 204) {
        try { value = await Promise.race([response.json(), timeout]); }
        catch { throw new PublicationError(500, 'internal_error'); }
      }
      if (!response.ok) throw databaseError(value, response.status);
      return value;
    } finally {
      if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
    }
  };
  const rpc = (name: string, body: Record<string, unknown>) => call(`/rest/v1/rpc/${name}`, serviceHeaders, { method: 'POST', body: JSON.stringify(body) });
  return {
    createAttemptToken: () => crypto.randomUUID(),
    authenticate: async () => {
      const value = await call('/auth/v1/user', userHeaders);
      const user = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
      if (typeof user.id !== 'string' || !user.id) throw new PublicationError(401, 'authentication_required');
      return { ownerId: user.id };
    },
    claimPublication: async (input) => parseClaim(await rpc('claim_narrative_publication', {
      p_owner_id: input.ownerId, p_publish_job_id: input.publishJobId, p_expected_version_id: input.expectedVersionId,
      p_idempotency_key: input.idempotencyKey, p_attempt_token: input.attemptToken,
    })),
    renewPublication: async (input) => {
      const value = await rpc('renew_narrative_publication_claim', {
        p_publish_job_id: input.publishJobId, p_attempt_token: input.attemptToken,
      });
      const parsed = z.object({
        publishJobId: postgresUuid, attemptToken: postgresUuid, status: z.literal('renewed'),
      }).strict().safeParse(value);
      if (!parsed.success || parsed.data.publishJobId !== input.publishJobId || parsed.data.attemptToken !== input.attemptToken) {
        throw new PublicationError(500, 'internal_error');
      }
    },
    createPublisher: (input) => new GitHubPublisher({ owner: input.owner, repository: input.repository, token: input.token }),
    completePublication: async (input) => {
      const value = await rpc('complete_narrative_publication', {
        p_publish_job_id: input.publishJobId, p_attempt_token: input.attemptToken,
        p_commit_sha: input.commitSha, p_published_path: input.path,
      });
      const parsed = z.object({
        publishJobId: postgresUuid, versionId: postgresUuid, status: z.literal('published'),
        commitSha: z.string(), path: z.string(),
      }).safeParse(value);
      if (!parsed.success) throw new PublicationError(500, 'internal_error');
      return parsed.data;
    },
    failPublication: async (input) => {
      const value = await rpc('fail_narrative_publication', {
        p_publish_job_id: input.publishJobId, p_attempt_token: input.attemptToken, p_failure_code: input.failureCode,
      });
      if (!value || typeof value !== 'object' || !('status' in value) || value.status !== 'publish_failed') throw new PublicationError(500, 'internal_error');
      return { status: 'publish_failed' };
    },
  };
}

interface DenoRuntime { env: { get(name: string): string | undefined }; serve(handler: (request: Request) => Response | Promise<Response>): void }
declare const Deno: DenoRuntime;
if (typeof Deno !== 'undefined' && (import.meta as ImportMeta & { main?: boolean }).main) {
  const url = Deno.env.get('SUPABASE_URL');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !anonKey || !serviceRoleKey) throw new Error('publish-draft runtime settings are required');
  const cors = corsPolicyFromEnvironment(Deno.env.get('NARRATIVE_ADMIN_ORIGINS'));
  Deno.serve((request) => {
    const token = bearerToken(request) ?? '';
    return createPublishDraftHandler(createSupabasePublicationDependencies({ url, anonKey, serviceRoleKey }, token), cors)(request);
  });
}
