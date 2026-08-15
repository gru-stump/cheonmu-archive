import { describe, expect, it } from 'vitest';
import { CONTINUITY_POLICY_VERSION, PersistenceError, applyReview, createReviewDraftHandler, createSupabaseReviewDependencies, type ReviewDependencies, type ReviewTransaction } from './index';
import { createCorsPolicy } from '../_shared/cors.ts';

function harness(level: 'review' | 'block' | null = 'review', storedPolicy: string | null = CONTINUITY_POLICY_VERSION) {
  const transactions: ReviewTransaction[] = [];
  const events: string[] = [];
  const deps: ReviewDependencies = {
    authenticate: async () => { events.push('authenticate'); return { ownerId: 'owner-1' }; },
    hasReviewAction: async () => { events.push('idempotency'); return false; },
    authorize: async () => { events.push('authorize'); return { draftStatus: 'reviewing', latestVersionId: 'version-1', continuityLevel: level, continuityPolicyVersion: storedPolicy }; },
    commitAtomic: async (transaction) => { events.push('commit'); transactions.push(transaction); return { draftId: transaction.draftId, versionId: transaction.expectedVersionId, status: transaction.nextState }; },
  };
  return { deps, transactions, events };
}

const base = { authToken: 'token', draftId: 'draft-1', expectedVersionId: 'version-1', expectedState: 'reviewing' as const, idempotencyKey: 'review-1' };

describe('applyReview', () => {
  it.each([
    ['block', CONTINUITY_POLICY_VERSION], [null, CONTINUITY_POLICY_VERSION], ['review', null], ['review', 'old-policy'],
  ] as const)('refuses approval for level=%s policy=%s before commit', async (level, storedPolicy) => {
    const h = harness(level, storedPolicy);
    await expect(applyReview(h.deps, { ...base, action: 'approve_private' })).rejects.toMatchObject({ status: 409, code: 'version_not_approvable' });
    expect(h.transactions).toEqual([]);
  });

  it('supplies the server policy constant for private continuity approval', async () => {
    const h = harness();
    await applyReview(h.deps, { ...base, action: 'approve_private' });
    expect(h.transactions).toMatchObject([{ policyVersion: CONTINUITY_POLICY_VERSION, nextState: 'approved_private', memoryWrites: [{ kind: 'continuity' }], enqueuePublish: false }]);
  });

  it('public approval writes continuity and one queued publish command atomically', async () => {
    const h = harness();
    await applyReview(h.deps, { ...base, action: 'approve_public' });
    expect(h.transactions).toMatchObject([{ policyVersion: CONTINUITY_POLICY_VERSION, nextState: 'approved', enqueuePublish: true, publishStatus: 'queued' }]);
  });

  it('reject remains available for blocked drafts and writes feedback only', async () => {
    const h = harness('block');
    await applyReview(h.deps, { ...base, action: 'reject', reason: '비밀 공개 오류' });
    expect(h.transactions).toMatchObject([{ action: 'reject', memoryWrites: [{ kind: 'feedback', text: '비밀 공개 오류' }], enqueuePublish: false }]);
  });

  it('maps only confirmed persistence conflicts to 409', async () => {
    const h = harness();
    h.deps.commitAtomic = async () => { throw new PersistenceError('stale_review'); };
    await expect(applyReview(h.deps, { ...base, action: 'approve_private' })).rejects.toMatchObject({ status: 409, code: 'stale_review' });
    h.deps.commitAtomic = async () => { throw new Error('network'); };
    await expect(applyReview(h.deps, { ...base, action: 'approve_private' })).rejects.toMatchObject({ status: 500, code: 'internal_error' });
  });
});

describe('review-draft HTTP boundary', () => {
  it('handles allowlisted browser preflight and adds exact-origin CORS headers to errors', async () => {
    const h = harness();
    const cors = createCorsPolicy(['https://admin.example.test']);
    const handler = createReviewDraftHandler(h.deps, cors);
    const preflight = await handler(new Request('http://local/review', { method: 'OPTIONS', headers: { origin: 'https://admin.example.test', 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization, content-type' } }));
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-origin')).toBe('https://admin.example.test');
    expect(preflight.headers.get('access-control-allow-credentials')).toBeNull();
    const error = await handler(new Request('http://local/review', { method: 'GET', headers: { origin: 'https://admin.example.test' } }));
    expect(error.status).toBe(405);
    expect(error.headers.get('access-control-allow-origin')).toBe('https://admin.example.test');
    const denied = await handler(new Request('http://local/review', { method: 'OPTIONS', headers: { origin: 'https://evil.example.test' } }));
    expect(denied.status).toBe(403);
    expect(denied.headers.get('access-control-allow-origin')).toBeNull();
    expect(h.events).toEqual([]);
  });

  it('maps an expired or invalid bearer response to 401 with CORS headers', async () => {
    const cors = createCorsPolicy(['https://admin.example.test']);
    const deps = createSupabaseReviewDependencies({ url: 'http://supabase', anonKey: 'anon', fetch: async () => Response.json({ message: 'invalid JWT' }, { status: 401 }) }, 'expired-token');
    const response = await createReviewDraftHandler(deps, cors)(new Request('http://local/review', {
      method: 'POST', headers: { origin: 'https://admin.example.test', authorization: 'Bearer expired-token', 'content-type': 'application/json' },
      body: JSON.stringify({ draftId: base.draftId, expectedVersionId: base.expectedVersionId, expectedState: base.expectedState, idempotencyKey: base.idempotencyKey, action: 'approve_private' }),
    }));
    expect(response.status).toBe(401);
    expect(response.headers.get('access-control-allow-origin')).toBe('https://admin.example.test');
    await expect(response.json()).resolves.toEqual({ error: 'authentication_required' });
  });

  it('rejects a caller-supplied policy version before authentication', async () => {
    const h = harness();
    const response = await createReviewDraftHandler(h.deps)(new Request('http://local/review', {
      method: 'POST', headers: { authorization: 'Bearer token', 'content-type': 'application/json' },
      body: JSON.stringify({ ...base, action: 'approve_private', policyVersion: 'attacker-policy' }),
    }));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: 'invalid_command' });
    expect(h.events).toEqual([]);
  });

  it('recognizes only exact P0001 review conflict codes', async () => {
    const transaction: ReviewTransaction = {
      ownerId: 'owner-1', draftId: 'draft-1', expectedVersionId: 'version-1', expectedState: 'reviewing', idempotencyKey: 'key',
      action: 'approve_private', nextState: 'approved_private', memoryWrites: [{ kind: 'continuity', sourceVersionId: 'version-1', status: 'approved' }],
      enqueuePublish: false, policyVersion: CONTINUITY_POLICY_VERSION,
    };
    const exact = createSupabaseReviewDependencies({ url: 'http://supabase', anonKey: 'anon', fetch: async () => Response.json({ code: 'P0001', message: 'stale_review' }, { status: 400 }) }, 'token');
    await expect(exact.commitAtomic(transaction)).rejects.toMatchObject({ code: 'stale_review' });
    const misleading = createSupabaseReviewDependencies({ url: 'http://supabase', anonKey: 'anon', fetch: async () => Response.json({ code: 'XX000', message: 'proxy mentioned stale_review' }, { status: 500 }) }, 'token');
    await expect(misleading.commitAtomic(transaction)).rejects.not.toBeInstanceOf(PersistenceError);
  });
});
