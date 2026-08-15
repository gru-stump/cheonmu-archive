import { describe, expect, it, vi } from 'vitest';
import { createNarrativeHandler } from './narrativeHandler';

describe('same-origin narrative server boundary', () => {
  it('rejects missing bearer credentials before any upstream request', async () => {
    const fetch = vi.fn();
    const handler = createNarrativeHandler({ supabaseUrl: 'https://db.example.test', supabaseAnonKey: 'anon', fetch });
    const response = await handler(new Request('https://admin.example.test/api/narrative/drafts'));
    expect(response.status).toBe(401);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('fails closed when the authenticated user is not the registered owner', async () => {
    const fetch: typeof globalThis.fetch = vi.fn(async (input) => {
      const path = new URL(String(input)).pathname;
      if (path === '/auth/v1/user') return Response.json({ id: 'visitor-1' });
      if (path === '/rest/v1/owner_profiles') return Response.json([]);
      return Response.json([{ id: 'private-draft' }]);
    });
    const handler = createNarrativeHandler({ supabaseUrl: 'https://db.example.test', supabaseAnonKey: 'anon', fetch });
    const response = await handler(new Request('https://admin.example.test/api/narrative/drafts', { headers: { authorization: 'Bearer visitor-token' } }));
    expect(response.status).toBe(403);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('submits generated latest version before invoking guarded review', async () => {
    const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
    const fetch: typeof globalThis.fetch = vi.fn(async (input, init) => {
      const path = new URL(String(input)).pathname;
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      calls.push({ path, body });
      if (path === '/auth/v1/user') return Response.json({ id: 'owner-1' });
      if (path === '/rest/v1/owner_profiles') return Response.json([{ owner_id: 'owner-1' }]);
      if (path.endsWith('/submit_draft_for_review')) return Response.json({ id: 'draft-1', status: 'reviewing' });
      return Response.json({ draftId: 'draft-1', versionId: 'version-2', status: 'approved_private' });
    });
    const handler = createNarrativeHandler({ supabaseUrl: 'https://db.example.test', supabaseAnonKey: 'anon', fetch });
    const response = await handler(new Request('https://admin.example.test/api/narrative/drafts/draft-1/review', {
      method: 'POST', headers: { authorization: 'Bearer owner-token', 'content-type': 'application/json' },
      body: JSON.stringify({ draftId: 'draft-1', expectedVersionId: 'version-2', expectedState: 'generated', action: 'approve_private' }),
    }));

    expect(response.status).toBe(200);
    expect(calls.map(({ path }) => path)).toEqual(['/auth/v1/user', '/rest/v1/owner_profiles', '/rest/v1/rpc/submit_draft_for_review', '/functions/v1/review-draft']);
    expect(calls[2]?.body).toMatchObject({ p_expected_version_id: 'version-2', p_expected_state: 'generated' });
    expect(calls[3]?.body).toMatchObject({ expectedVersionId: 'version-2', expectedState: 'reviewing', action: 'approve_private' });
  });

  it('submits a freshly generated blocked version before guarded rejection', async () => {
    const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
    const fetch: typeof globalThis.fetch = vi.fn(async (input, init) => {
      const path = new URL(String(input)).pathname;
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      calls.push({ path, body });
      if (path === '/auth/v1/user') return Response.json({ id: 'owner-1' });
      if (path === '/rest/v1/owner_profiles') return Response.json([{ owner_id: 'owner-1' }]);
      if (path.endsWith('/submit_draft_for_review')) return Response.json({ id: 'draft-1', status: 'reviewing' });
      return Response.json({ draftId: 'draft-1', versionId: 'version-blocked', status: 'rejected' });
    });
    const handler = createNarrativeHandler({ supabaseUrl: 'https://db.example.test', supabaseAnonKey: 'anon', fetch });
    const response = await handler(new Request('https://admin.example.test/api/narrative/drafts/draft-1/review', {
      method: 'POST', headers: { authorization: 'Bearer owner-token', 'content-type': 'application/json' },
      body: JSON.stringify({ draftId: 'draft-1', expectedVersionId: 'version-blocked', expectedState: 'generated', action: 'reject', reason: 'continuity block' }),
    }));

    expect(response.status).toBe(200);
    expect(calls.map(({ path }) => path)).toEqual(['/auth/v1/user', '/rest/v1/owner_profiles', '/rest/v1/rpc/submit_draft_for_review', '/functions/v1/review-draft']);
    expect(calls[3]?.body).toMatchObject({ expectedVersionId: 'version-blocked', expectedState: 'reviewing', action: 'reject', reason: 'continuity block' });
  });

  it('queues a confirmed revision and retains all bounded request fields for immutable generation', async () => {
    const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
    const fetch: typeof globalThis.fetch = vi.fn(async (input, init) => {
      const path = new URL(String(input)).pathname;
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      calls.push({ path, body });
      if (path === '/auth/v1/user') return Response.json({ id: 'owner-1' });
      if (path === '/rest/v1/owner_profiles') return Response.json([{ owner_id: 'owner-1' }]);
      if (path.endsWith('/queue_draft_revision')) return Response.json({ job_id: 'job-3', idempotency_key: 'revision-key', draft_id: 'draft-1', kind: 'short_dialogue' });
      return Response.json({ draftId: 'draft-1', versionId: 'version-3', status: 'generated', continuityLevel: 'review' });
    });
    const handler = createNarrativeHandler({ supabaseUrl: 'https://db.example.test', supabaseAnonKey: 'anon', fetch });
    const command = {
      draftId: 'draft-1', expectedVersionId: 'version-2', mode: 'revise_selection', kind: 'short_dialogue',
      revision: { selectedText: '선택 구절', instruction: '말투 수정' }, requestedMaxOutputTokens: 128,
      maximumCostConfirmed: true, confirmedMaximumCostMicros: 321,
    };
    const response = await handler(new Request('https://admin.example.test/api/narrative/generate', {
      method: 'POST', headers: { authorization: 'Bearer owner-token', 'content-type': 'application/json' }, body: JSON.stringify(command),
    }));

    expect(response.status).toBe(200);
    expect(calls[2]?.body).toMatchObject({ p_expected_version_id: 'version-2', p_selected_text: '선택 구절', p_instruction: '말투 수정', p_requested_max_output_tokens: 128, p_confirmed_maximum_cost_micros: 321 });
    expect(calls[3]?.body).toMatchObject({ jobId: 'job-3', idempotencyKey: 'revision-key', revision: command.revision, requestedMaxOutputTokens: 128 });
  });

  it('rejects unsupported public generation modes before queueing or invoking generation', async () => {
    const fetch: typeof globalThis.fetch = vi.fn(async (input) => {
      const path = new URL(String(input)).pathname;
      if (path === '/auth/v1/user') return Response.json({ id: 'owner-1' });
      if (path === '/rest/v1/owner_profiles') return Response.json([{ owner_id: 'owner-1' }]);
      return Response.json({ draftId: 'unexpected' });
    });
    const handler = createNarrativeHandler({ supabaseUrl: 'https://db.example.test', supabaseAnonKey: 'anon', fetch });
    const response = await handler(new Request('https://admin.example.test/api/narrative/generate', {
      method: 'POST', headers: { authorization: 'Bearer owner-token', 'content-type': 'application/json' },
      body: JSON.stringify({ draftId: 'draft-1', mode: 'new', kind: 'short_dialogue', seed: 'seed' }),
    }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: 'unsupported_generation_mode' });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('rejects unsafe archive source states before invoking the database command', async () => {
    const fetch: typeof globalThis.fetch = vi.fn(async (input) => {
      const path = new URL(String(input)).pathname;
      if (path === '/auth/v1/user') return Response.json({ id: 'owner-1' });
      if (path === '/rest/v1/owner_profiles') return Response.json([{ owner_id: 'owner-1' }]);
      return Response.json({ status: 'archived' });
    });
    const handler = createNarrativeHandler({ supabaseUrl: 'https://db.example.test', supabaseAnonKey: 'anon', fetch });
    const response = await handler(new Request('https://admin.example.test/api/narrative/drafts/draft-1/archive', {
      method: 'POST', headers: { authorization: 'Bearer owner-token', 'content-type': 'application/json' },
      body: JSON.stringify({ draftId: 'draft-1', expectedVersionId: 'version-2', expectedState: 'published' }),
    }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: 'invalid_archive_state' });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('restores only through the narrow audited database command', async () => {
    const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
    const fetch: typeof globalThis.fetch = vi.fn(async (input, init) => {
      const path = new URL(String(input)).pathname;
      calls.push({ path, body: init?.body ? JSON.parse(String(init.body)) : {} });
      if (path === '/auth/v1/user') return Response.json({ id: 'owner-1' });
      if (path === '/rest/v1/owner_profiles') return Response.json([{ owner_id: 'owner-1' }]);
      return Response.json({ status: 'approved_private' });
    });
    const handler = createNarrativeHandler({ supabaseUrl: 'https://db.example.test', supabaseAnonKey: 'anon', fetch });
    const response = await handler(new Request('https://admin.example.test/api/narrative/drafts/draft-1/restore', {
      method: 'POST', headers: { authorization: 'Bearer owner-token', 'content-type': 'application/json' },
      body: JSON.stringify({ draftId: 'draft-1', expectedVersionId: 'version-2' }),
    }));

    expect(response.status).toBe(200);
    expect(calls[2]).toEqual({
      path: '/rest/v1/rpc/restore_narrative_draft',
      body: { p_draft_id: 'draft-1', p_expected_version_id: 'version-2' },
    });
  });

  it('maps only stable expected-state database conflicts to 409', async () => {
    const fetch: typeof globalThis.fetch = vi.fn(async (input) => {
      const path = new URL(String(input)).pathname;
      if (path === '/auth/v1/user') return Response.json({ id: 'owner-1' });
      if (path === '/rest/v1/owner_profiles') return Response.json([{ owner_id: 'owner-1' }]);
      return Response.json({ code: 'P0001', message: 'stale_manual_version' }, { status: 400 });
    });
    const handler = createNarrativeHandler({ supabaseUrl: 'https://db.example.test', supabaseAnonKey: 'anon', fetch });
    const response = await handler(new Request('https://admin.example.test/api/narrative/drafts/draft-1/manual-version', {
      method: 'POST', headers: { authorization: 'Bearer owner-token', 'content-type': 'application/json' },
      body: JSON.stringify({ draftId: 'draft-1', expectedVersionId: 'version-2', expectedState: 'reviewing', content: { title: 't', body: 'b', canonChangeCandidates: [] } }),
    }));
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: 'stale_manual_version' });
  });

  it('preserves a sanitized stale 409 returned by the guarded review Edge function', async () => {
    const fetch: typeof globalThis.fetch = vi.fn(async (input) => {
      const path = new URL(String(input)).pathname;
      if (path === '/auth/v1/user') return Response.json({ id: 'owner-1' });
      if (path === '/rest/v1/owner_profiles') return Response.json([{ owner_id: 'owner-1' }]);
      return Response.json({ error: 'stale_review' }, { status: 409 });
    });
    const handler = createNarrativeHandler({ supabaseUrl: 'https://db.example.test', supabaseAnonKey: 'anon', fetch });
    const response = await handler(new Request('https://admin.example.test/api/narrative/drafts/draft-1/review', {
      method: 'POST', headers: { authorization: 'Bearer owner-token', 'content-type': 'application/json' },
      body: JSON.stringify({ draftId: 'draft-1', expectedVersionId: 'version-2', expectedState: 'reviewing', action: 'approve_private' }),
    }));
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: 'stale_review' });
  });

  it('reads settings through a secret-free owner RPC response', async () => {
    const fetch: typeof globalThis.fetch = vi.fn(async (input) => {
      const path = new URL(String(input)).pathname;
      if (path === '/auth/v1/user') return Response.json({ id: 'owner-1' });
      if (path === '/rest/v1/owner_profiles') return Response.json([{ owner_id: 'owner-1' }]);
      return Response.json({ automationEnabled: false, providers: [], budget: {}, secrets: { openai: false, anthropic: false, github: false } });
    });
    const handler = createNarrativeHandler({ supabaseUrl: 'https://db.example.test', supabaseAnonKey: 'anon', fetch });
    const response = await handler(new Request('https://admin.example.test/api/narrative/settings', { headers: { authorization: 'Bearer owner-token' } }));
    const value = await response.json();

    expect(response.status).toBe(200);
    expect(JSON.stringify(value)).not.toMatch(/api.?key|token|secret.?value/i);
  });

  it('forwards secret writes only to manage-settings and returns only configured state', async () => {
    const calls: Array<{ path: string; authorization: string | null; body: unknown }> = [];
    const fetch: typeof globalThis.fetch = vi.fn(async (input, init) => {
      const path = new URL(String(input)).pathname;
      calls.push({ path, authorization: new Headers(init?.headers).get('authorization'), body: init?.body ? JSON.parse(String(init.body)) : null });
      if (path === '/auth/v1/user') return Response.json({ id: 'owner-1' });
      if (path === '/rest/v1/owner_profiles') return Response.json([{ owner_id: 'owner-1' }]);
      return Response.json({ configured: true, ignoredUpstreamField: 'must-not-pass-through' });
    });
    const handler = createNarrativeHandler({ supabaseUrl: 'https://db.example.test', supabaseAnonKey: 'anon', fetch });
    const response = await handler(new Request('https://admin.example.test/api/narrative/settings/secret', {
      method: 'POST', headers: { authorization: 'Bearer owner-token', 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'openai', value: 'write-only-value' }),
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ configured: true });
    expect(calls.map(({ path }) => path)).toEqual(['/auth/v1/user', '/rest/v1/owner_profiles', '/functions/v1/manage-settings']);
    expect(calls[2]).toMatchObject({ authorization: 'Bearer owner-token', body: { kind: 'openai', value: 'write-only-value' } });
  });
});
