import { describe, expect, it, vi } from 'vitest';
import { createCorsPolicy } from '../_shared/cors.ts';
import { GitHubPublisherError, type CreateFileResult } from '../_shared/github-publisher.ts';
import {
  PublicationError,
  applyPublication,
  createPublishDraftHandler,
  createSupabasePublicationDependencies,
  type ClaimedPublication,
  type PublicationDependencies,
} from './index.ts';

const ownerId = '10000000-0000-0000-0000-000000000001';
const draftId = '20000000-0000-0000-0000-000000000001';
const versionId = '30000000-0000-0000-0000-000000000001';
const approvalId = '40000000-0000-0000-0000-000000000001';
const publishJobId = '50000000-0000-0000-0000-000000000001';
const attemptToken = '60000000-0000-4000-8000-000000000001';
const idempotencyKey = 'publish-rainy-return-08';
const commitSha = '1111111111111111111111111111111111111111';

const publicationDetails = {
  id: 'rainy-return', recordNumber: '08', relationshipStage: 7, date: '2026-08-15',
  summary: '비가 그친 뒤, 두 사람은 처마 아래에서 잠시 머문다.',
  characters: ['cheonryeong', 'muyeong'], tags: ['비', '귀환'], related: ['witnessing'],
  quote: '이번에는 물러서지 않았다.',
  archiveSnapshot: { recordIds: ['witnessing'], recordNumbers: ['CM-07'] },
};

const claimed: ClaimedPublication = {
  outcome: 'claimed', attemptToken, publishJobId, ownerId, draftId, versionId, versionNumber: 8,
  latestVersionId: versionId,
  approval: { id: approvalId, draftId, versionId, action: 'approve_public', resultingState: 'approved' },
  content: {
    title: '비가 그친 뒤', body: '비가 멎은 처마 아래에서, 천령과 무영은 잠시 머물렀다.',
    canonChangeCandidates: ['candidate-rainy-return'], unresolvedCallbacks: [],
    prompt: 'private prompt', rawProviderResponse: 'private provider response', privateMemory: 'private memory', costMicros: 42,
  },
  publicationDetails,
  repository: { owner: 'cheonmu-owner', name: 'cheonmu-archive', branch: 'main', credential: 'fixture-github-token' },
};

const command = { authToken: 'owner-token', publishJobId, expectedVersionId: versionId, idempotencyKey };

function harness(overrides: Partial<PublicationDependencies> = {}) {
  const events: string[] = [];
  const createInputs: unknown[] = [];
  const completed: unknown[] = [];
  const failed: unknown[] = [];
  const deps: PublicationDependencies = {
    createAttemptToken: () => attemptToken,
    authenticate: async () => { events.push('authenticate'); return { ownerId }; },
    claimPublication: async () => { events.push('claim'); return structuredClone(claimed); },
    createPublisher: () => ({
      createFile: async (input) => {
        events.push('create'); createInputs.push(input);
        return { outcome: 'created', commitSha } satisfies CreateFileResult;
      },
    }),
    completePublication: async (input) => {
      events.push('complete'); completed.push(input);
      return { publishJobId: input.publishJobId, versionId, status: 'published', commitSha: input.commitSha, path: input.path };
    },
    failPublication: async (input) => { events.push('fail'); failed.push(input); return { status: 'publish_failed' }; },
    ...overrides,
  };
  return { deps, events, createInputs, completed, failed };
}

describe('applyPublication', () => {
  it('publishes only the locked public approval snapshot and records commit success without deployment claims', async () => {
    // Copying browser content, skipping Task 1 validation, or equating a commit with deployment breaks these assertions.
    const h = harness();
    const result = await applyPublication(h.deps, command);

    expect(h.events).toEqual(['authenticate', 'claim', 'create', 'complete']);
    expect(h.createInputs).toEqual([{
      path: 'src/content/records/08-rainy-return.md',
      content: expect.stringContaining('recordNumber: "CM-08"'),
      message: 'content: publish narrative rainy-return', branch: 'main',
    }]);
    expect(String((h.createInputs[0] as { content: string }).content)).not.toMatch(/private prompt|private provider response|private memory|costMicros/i);
    expect(h.completed).toEqual([{
      publishJobId, attemptToken, commitSha, path: 'src/content/records/08-rainy-return.md',
    }]);
    expect(result).toEqual({ publishJobId, versionId, status: 'published', commitSha, path: 'src/content/records/08-rainy-return.md' });
    expect(result).not.toHaveProperty('deploymentStatus');
  });

  it('normalizes persisted canon-candidate strings only from the exact public approval decision', async () => {
    // Trusting a browser-supplied resolved flag or a non-public action would bypass the continuity decision.
    const notPublic = harness({
      claimPublication: async () => ({ ...structuredClone(claimed), approval: { ...claimed.approval, action: 'approve_private', resultingState: 'approved_private' } }),
    });
    await expect(applyPublication(notPublic.deps, command)).rejects.toMatchObject({ code: 'record_validation_failed' });
    expect(notPublic.createInputs).toEqual([]);
    expect(notPublic.failed).toEqual([{ publishJobId, attemptToken, failureCode: 'record_validation_failed' }]);

    const malformedCandidate = harness({
      claimPublication: async () => ({
        ...structuredClone(claimed),
        content: { ...structuredClone(claimed.content), canonChangeCandidates: [{ id: 'candidate', resolution: 'resolved' }] as never },
      }),
    });
    await expect(applyPublication(malformedCandidate.deps, command)).rejects.toMatchObject({ code: 'record_validation_failed' });
    expect(malformedCandidate.createInputs).toEqual([]);
  });

  it('rejects a claimed row whose owner, job, version, or attempt identity differs from the authenticated command', async () => {
    // Trusting a malformed RPC result could publish a different owner's or stale version's immutable content.
    const h = harness({
      claimPublication: async () => ({ ...structuredClone(claimed), ownerId: '10000000-0000-0000-0000-000000000099' }),
    });
    await expect(applyPublication(h.deps, command)).rejects.toMatchObject({ code: 'record_validation_failed' });
    expect(h.createInputs).toEqual([]);
    expect(h.failed).toEqual([{ publishJobId, attemptToken, failureCode: 'record_validation_failed' }]);
  });

  it('marks a sanitized publish failure while preserving the approved version when GitHub rejects the write', async () => {
    // Returning provider details or omitting the durable failure transition would make retries unsafe.
    const h = harness({
      createPublisher: () => ({ createFile: async () => { throw new GitHubPublisherError('github_path_conflict'); } }),
    });
    const error = await applyPublication(h.deps, command).catch((value) => value);

    expect(error).toMatchObject({ status: 409, code: 'github_path_conflict' });
    expect(h.failed).toEqual([{ publishJobId, attemptToken, failureCode: 'github_path_conflict' }]);
    expect(h.completed).toEqual([]);
    expect(JSON.stringify(error)).not.toMatch(/fixture-github-token|private provider response|비가 멎은/);
  });

  it('retries a failed locked job through publishing and completes the same idempotency key once', async () => {
    // Changing the key or version on retry must not create a second logical publication.
    const h = harness({
      claimPublication: async (input) => {
        expect(input).toMatchObject({ publishJobId, expectedVersionId: versionId, idempotencyKey, attemptToken });
        return structuredClone(claimed);
      },
    });
    await expect(applyPublication(h.deps, command)).resolves.toMatchObject({ status: 'published', commitSha });
    expect(h.createInputs).toHaveLength(1);
    expect(h.completed).toHaveLength(1);
  });

  it('returns an already-published same-key result without creating another GitHub commit', async () => {
    // Replaying a completed owner request must be read-only.
    const h = harness({
      claimPublication: async () => ({
        outcome: 'already_published', publishJobId, versionId, commitSha,
        path: 'src/content/records/08-rainy-return.md',
      }),
    });
    await expect(applyPublication(h.deps, command)).resolves.toEqual({
      publishJobId, versionId, status: 'published', commitSha, path: 'src/content/records/08-rainy-return.md',
    });
    expect(h.createInputs).toEqual([]);
    expect(h.completed).toEqual([]);
  });

  it('lets only one of two same-key concurrent callers reach the publisher', async () => {
    // Removing the atomic claim guard would let both calls issue create requests.
    let state: 'approved' | 'publishing' | 'published' = 'approved';
    let createCount = 0;
    let releaseCreate!: () => void;
    const createStarted = new Promise<void>((resolve) => { releaseCreate = resolve; });
    const h = harness({
      createAttemptToken: () => crypto.randomUUID(),
      claimPublication: async (input) => {
        if (state !== 'approved') throw new PublicationError(409, 'publication_in_progress');
        state = 'publishing';
        return { ...structuredClone(claimed), attemptToken: input.attemptToken };
      },
      createPublisher: () => ({ createFile: async () => {
        createCount += 1;
        await createStarted;
        return { outcome: 'created', commitSha };
      } }),
      completePublication: async (input) => {
        state = 'published';
        return { publishJobId, versionId, status: 'published', commitSha: input.commitSha, path: input.path };
      },
    });

    const first = applyPublication(h.deps, command);
    await vi.waitFor(() => expect(state).toBe('publishing'));
    const second = applyPublication(h.deps, command);
    await expect(second).rejects.toMatchObject({ code: 'publication_in_progress' });
    releaseCreate();
    await expect(first).resolves.toMatchObject({ status: 'published' });
    expect(createCount).toBe(1);
  });
});

describe('publish-draft HTTP boundary', () => {
  it.each([undefined, 'Basic token', 'Bearer ', 'Bearer token extra'])('rejects malformed authorization %s before dependencies run', async (authorization) => {
    // Parsing unauthenticated publication commands could expose existence or consume a queue row.
    const h = harness();
    const headers = new Headers({ 'content-type': 'application/json' });
    if (authorization !== undefined) headers.set('authorization', authorization);
    const response = await createPublishDraftHandler(h.deps)(new Request('http://local/publish-draft', {
      method: 'POST', headers, body: JSON.stringify({ publishJobId, expectedVersionId: versionId, idempotencyKey }),
    }));
    expect(response.status).toBe(401);
    expect(h.events).toEqual([]);
  });

  it.each(['content', 'path', 'repositoryOwner', 'repositoryName', 'branch', 'token', 'secret'] as const)('rejects browser-supplied %s before authentication', async (field) => {
    // Expanding the browser command beyond server-owned selectors would bypass the locked join.
    const h = harness();
    const response = await createPublishDraftHandler(h.deps)(new Request('http://local/publish-draft', {
      method: 'POST', headers: { authorization: 'Bearer owner-token', 'content-type': 'application/json' },
      body: JSON.stringify({ publishJobId, expectedVersionId: versionId, idempotencyKey, [field]: 'attacker-value' }),
    }));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: 'invalid_command' });
    expect(h.events).toEqual([]);
  });

  it('returns only safe commit metadata and never logs or returns credential, source, or raw provider data', async () => {
    // Serializing the trusted claim would leak the Vault credential and private immutable source.
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const h = harness();
    const response = await createPublishDraftHandler(h.deps, createCorsPolicy(['https://admin.example.test']))(new Request('http://local/publish-draft', {
      method: 'POST', headers: { origin: 'https://admin.example.test', authorization: 'Bearer owner-token', 'content-type': 'application/json' },
      body: JSON.stringify({ publishJobId, expectedVersionId: versionId, idempotencyKey }),
    }));
    const body = JSON.stringify(await response.json());
    expect(response.status).toBe(200);
    expect(response.headers.get('access-control-allow-origin')).toBe('https://admin.example.test');
    expect(body).toContain(commitSha);
    expect(body).not.toMatch(/fixture-github-token|private prompt|private provider response|private memory|costMicros|비가 멎은/);
    expect(log).not.toHaveBeenCalled();
  });
});

describe('Supabase publication adapter privilege boundary', () => {
  it('uses the owner token only for authentication and service role only for publication mutation RPCs', async () => {
    // Calling claim/complete through the user token would violate the service-only mutation boundary.
    const calls: Array<{ path: string; authorization: string | null; body: unknown }> = [];
    const claimRow = {
      outcome: 'claimed', attempt_token: attemptToken, publish_job_id: publishJobId, owner_id: ownerId,
      draft_id: draftId, version_id: versionId, version_number: 8, latest_version_id: versionId,
      approval_id: approvalId, approval_action: 'approve_public', approval_resulting_state: 'approved',
      content: claimed.content, publication_details: publicationDetails,
      repository_owner: 'cheonmu-owner', repository_name: 'cheonmu-archive', repository_branch: 'main',
      credential: 'fixture-github-token',
    };
    const fetch: typeof globalThis.fetch = vi.fn(async (input, init) => {
      const path = new URL(String(input)).pathname;
      calls.push({ path, authorization: new Headers(init?.headers).get('authorization'), body: init?.body ? JSON.parse(String(init.body)) : null });
      if (path === '/auth/v1/user') return Response.json({ id: ownerId });
      if (path.endsWith('/claim_narrative_publication')) return Response.json(claimRow);
      if (path.endsWith('/complete_narrative_publication')) return Response.json({ publishJobId, versionId, status: 'published', commitSha, path: 'src/content/records/08-rainy-return.md' });
      return Response.json({ status: 'publish_failed' });
    });
    const deps = createSupabasePublicationDependencies({
      url: 'http://supabase', anonKey: 'anon', serviceRoleKey: 'service-role-value', fetch,
    }, 'owner-token');

    await expect(deps.authenticate('owner-token')).resolves.toEqual({ ownerId });
    await expect(deps.claimPublication({ ownerId, publishJobId, expectedVersionId: versionId, idempotencyKey, attemptToken })).resolves.toEqual(claimed);
    await deps.completePublication({ publishJobId, attemptToken, commitSha, path: 'src/content/records/08-rainy-return.md' });
    await deps.failPublication({ publishJobId, attemptToken, failureCode: 'github_timeout' });

    expect(calls.map(({ path, authorization }) => ({ path, authorization }))).toEqual([
      { path: '/auth/v1/user', authorization: 'Bearer owner-token' },
      { path: '/rest/v1/rpc/claim_narrative_publication', authorization: 'Bearer service-role-value' },
      { path: '/rest/v1/rpc/complete_narrative_publication', authorization: 'Bearer service-role-value' },
      { path: '/rest/v1/rpc/fail_narrative_publication', authorization: 'Bearer service-role-value' },
    ]);
    expect(JSON.stringify(calls.slice(2))).not.toMatch(/fixture-github-token|private prompt|private provider response|비가 멎은/);
  });

  it('maps only exact stable database codes and never returns a raw RPC response', async () => {
    // Matching arbitrary message substrings would let infrastructure details become public conflict codes.
    const exact = createSupabasePublicationDependencies({
      url: 'http://supabase', anonKey: 'anon', serviceRoleKey: 'service',
      fetch: async () => Response.json({ code: 'P0001', message: 'publication_in_progress', details: 'fixture-github-token raw row' }, { status: 400 }),
    }, 'owner-token');
    await expect(exact.claimPublication({ ownerId, publishJobId, expectedVersionId: versionId, idempotencyKey, attemptToken })).rejects.toMatchObject({ code: 'publication_in_progress' });

    const misleading = createSupabasePublicationDependencies({
      url: 'http://supabase', anonKey: 'anon', serviceRoleKey: 'service',
      fetch: async () => Response.json({ code: 'XX000', message: 'proxy mentioned publication_in_progress and fixture-github-token' }, { status: 500 }),
    }, 'owner-token');
    const error = await misleading.claimPublication({ ownerId, publishJobId, expectedVersionId: versionId, idempotencyKey, attemptToken }).catch((value) => value);
    expect(error).toBeInstanceOf(PublicationError);
    expect(error).toMatchObject({ code: 'internal_error' });
    expect(JSON.stringify(error)).not.toContain('fixture-github-token');
  });
});
