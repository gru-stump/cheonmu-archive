import { describe, expect, it } from 'vitest';
import { applyReview, createReviewDraftHandler, createSupabaseReviewDependencies, ReviewError, type ReviewDependencies, type ReviewTransaction } from './index';

function reviewHarness() {
  const transactions: ReviewTransaction[] = [];
  const events: string[] = [];
  let currentState = 'reviewing';
  let currentVersionId = 'version-1';
  const deps: ReviewDependencies = {
    authenticate: async () => { events.push('authenticate'); return { ownerId: 'owner-1' }; },
    hasReviewAction: async (_ownerId, idempotencyKey) => { events.push('idempotency'); return transactions.some((transaction) => transaction.idempotencyKey === idempotencyKey); },
    authorize: async () => { events.push('authorize'); return { draftStatus: currentState, latestVersionId: currentVersionId }; },
    commitAtomic: async (transaction) => {
      events.push('commit');
      if (transaction.expectedState !== currentState || transaction.expectedVersionId !== currentVersionId) throw new Error('stale_review');
      if (transactions.some(({ idempotencyKey }) => idempotencyKey === transaction.idempotencyKey)) throw new Error('duplicate_review');
      transactions.push(transaction);
      currentState = transaction.nextState;
      return { draftId: transaction.draftId, versionId: transaction.expectedVersionId, status: transaction.nextState };
    },
  };
  return { deps, events, transactions };
}

const baseCommand = {
  authToken: 'valid-token',
  draftId: 'draft-1',
  expectedVersionId: 'version-1',
  expectedState: 'reviewing' as const,
  idempotencyKey: 'review-1',
};

describe('applyReview', () => {
  it('reject writes feedback only and never event memory or a publish job', async () => {
    const harness = reviewHarness();

    await applyReview(harness.deps, { ...baseCommand, action: 'reject', reason: '인물이 맞지 않음' });

    expect(harness.transactions).toEqual([{
      ownerId: 'owner-1', draftId: 'draft-1', expectedVersionId: 'version-1', expectedState: 'reviewing',
      idempotencyKey: 'review-1', action: 'reject', nextState: 'rejected',
      memoryWrites: [{ kind: 'feedback', text: '인물이 맞지 않음' }], enqueuePublish: false,
    }]);
  });

  it('approve_private writes approved continuity without a publish job', async () => {
    const harness = reviewHarness();

    await applyReview(harness.deps, { ...baseCommand, action: 'approve_private' });

    expect(harness.transactions[0]).toMatchObject({
      nextState: 'approved_private',
      memoryWrites: [{ kind: 'continuity', sourceVersionId: 'version-1', status: 'approved' }],
      enqueuePublish: false,
    });
  });

  it('approve_public atomically writes continuity and exactly one queued publish job', async () => {
    const harness = reviewHarness();

    await applyReview(harness.deps, { ...baseCommand, action: 'approve_public' });

    expect(harness.events).toEqual(['authenticate', 'idempotency', 'authorize', 'commit']);
    expect(harness.transactions).toHaveLength(1);
    expect(harness.transactions[0]).toMatchObject({
      nextState: 'approved',
      memoryWrites: [{ kind: 'continuity', sourceVersionId: 'version-1', status: 'approved' }],
      enqueuePublish: true,
      publishStatus: 'queued',
    });
  });

  it('returns 409 for stale optimistic state without partial effects', async () => {
    const harness = reviewHarness();

    await expect(applyReview(harness.deps, { ...baseCommand, expectedVersionId: 'stale-version', action: 'approve_private' }))
      .rejects.toMatchObject<ReviewError>({ status: 409, code: 'stale_review' });
    expect(harness.transactions).toEqual([]);
  });

  it('returns 409 for a duplicate review idempotency key', async () => {
    const harness = reviewHarness();
    await applyReview(harness.deps, { ...baseCommand, action: 'reject', reason: '첫 거절' });

    await expect(applyReview(harness.deps, { ...baseCommand, action: 'reject', reason: '다른 거절' }))
      .rejects.toMatchObject({ status: 409, code: 'duplicate_review' });
    expect(harness.transactions).toHaveLength(1);
  });

  it('reject requires a non-empty reason before committing', async () => {
    const harness = reviewHarness();

    await expect(applyReview(harness.deps, { ...baseCommand, action: 'reject', reason: '  ' }))
      .rejects.toMatchObject({ status: 400, code: 'reject_reason_required' });
    expect(harness.transactions).toEqual([]);
  });
});

describe('review-draft HTTP boundary', () => {
  it('returns 409 for stale optimistic input', async () => {
    const harness = reviewHarness();
    const response = await createReviewDraftHandler(harness.deps)(new Request('http://local/review-draft', {
      method: 'POST',
      headers: { authorization: 'Bearer valid-token', 'content-type': 'application/json' },
      body: JSON.stringify({ ...baseCommand, expectedVersionId: 'stale-version', action: 'approve_private' }),
    }));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: 'stale_review' });
  });

  it('rejects malformed commands before authentication', async () => {
    const harness = reviewHarness();
    const response = await createReviewDraftHandler(harness.deps)(new Request('http://local/review-draft', {
      method: 'POST',
      headers: { authorization: 'Bearer valid-token', 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'approve_private' }),
    }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: 'invalid_command' });
    expect(harness.events).toEqual([]);
  });
});

describe('Supabase review adapter', () => {
  it('commits the optimistic review through one atomic RPC', async () => {
    const calls: string[] = [];
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const path = new URL(String(input)).pathname + new URL(String(input)).search;
      calls.push(`${init?.method ?? 'GET'} ${path}`);
      if (path === '/auth/v1/user') return Response.json({ id: 'owner-1' });
      if (path.startsWith('/rest/v1/draft_review_actions?')) return Response.json([]);
      if (path.startsWith('/rest/v1/drafts?')) return Response.json([{ status: 'reviewing' }]);
      if (path.startsWith('/rest/v1/draft_versions?')) return Response.json([{ id: 'version-1' }]);
      if (path.endsWith('/rpc/review_draft_atomic')) return Response.json({ id: 'draft-1', status: 'approved_private' });
      throw new Error(`unexpected request ${path}`);
    };
    const deps = createSupabaseReviewDependencies({ url: 'http://supabase.local', anonKey: 'anon', fetch }, 'valid-token');

    await expect(applyReview(deps, { ...baseCommand, action: 'approve_private' })).resolves.toEqual({
      draftId: 'draft-1', versionId: 'version-1', status: 'approved_private',
    });
    expect(calls.filter((call) => call.endsWith('/rpc/review_draft_atomic'))).toHaveLength(1);
  });
});
