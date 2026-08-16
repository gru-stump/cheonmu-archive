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

  it('queues a confirmed revision and forwards only the canonical RPC request fields', async () => {
    const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
    const fetch: typeof globalThis.fetch = vi.fn(async (input, init) => {
      const path = new URL(String(input)).pathname;
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      calls.push({ path, body });
      if (path === '/auth/v1/user') return Response.json({ id: 'owner-1' });
      if (path === '/rest/v1/owner_profiles') return Response.json([{ owner_id: 'owner-1' }]);
      if (path.endsWith('/queue_draft_revision')) return Response.json({
        job_id: 'job-3', idempotency_key: 'revision-key', draft_id: 'draft-1', mode: 'revise_selection', kind: 'short_dialogue',
        revision: { selectedText: 'database selection', instruction: 'database instruction' }, requested_max_output_tokens: 80,
      });
      return Response.json({ draftId: 'draft-1', versionId: 'version-3', status: 'generated', continuityLevel: 'review' });
    });
    const handler = createNarrativeHandler({ supabaseUrl: 'https://db.example.test', supabaseAnonKey: 'anon', fetch });
    const command = {
      draftId: 'draft-1', expectedVersionId: 'version-2', mode: 'revise_selection', kind: 'short_dialogue',
      revision: { selectedText: '선택 구절', instruction: '말투 수정' }, requestedMaxOutputTokens: 128,
      maximumCostConfirmed: true, confirmedMaximumCostMicros: 321,
      jobId: 'browser-job', idempotencyKey: 'browser-key', seed: 'browser seed', tags: ['browser-tag'],
    };
    const response = await handler(new Request('https://admin.example.test/api/narrative/generate', {
      method: 'POST', headers: { authorization: 'Bearer owner-token', 'content-type': 'application/json' }, body: JSON.stringify(command),
    }));

    expect(response.status).toBe(200);
    expect(calls[2]?.body).toMatchObject({ p_expected_version_id: 'version-2', p_selected_text: '선택 구절', p_instruction: '말투 수정', p_requested_max_output_tokens: 128, p_confirmed_maximum_cost_micros: 321 });
    expect(calls[3]).toEqual({ path: '/functions/v1/generate-draft', body: {
      jobId: 'job-3', idempotencyKey: 'revision-key', draftId: 'draft-1', mode: 'revise_selection', kind: 'short_dialogue',
      revision: { selectedText: 'database selection', instruction: 'database instruction' }, requestedMaxOutputTokens: 80,
    } });
  });

  it('fails closed when the revision queue RPC omits canonical request content', async () => {
    const calls: string[] = [];
    const fetch: typeof globalThis.fetch = vi.fn(async (input) => {
      const path = new URL(String(input)).pathname;
      calls.push(path);
      if (path === '/auth/v1/user') return Response.json({ id: 'owner-1' });
      if (path === '/rest/v1/owner_profiles') return Response.json([{ owner_id: 'owner-1' }]);
      if (path.endsWith('/queue_draft_revision')) return Response.json({
        job_id: 'job-3', idempotency_key: 'revision-key', draft_id: 'draft-1', mode: 'revise_selection', kind: 'short_dialogue',
      });
      return Response.json({ unexpected: true });
    });
    const handler = createNarrativeHandler({ supabaseUrl: 'https://db.example.test', supabaseAnonKey: 'anon', fetch });
    const response = await handler(new Request('https://admin.example.test/api/narrative/generate', {
      method: 'POST', headers: { authorization: 'Bearer owner-token', 'content-type': 'application/json' },
      body: JSON.stringify({
        draftId: 'draft-1', expectedVersionId: 'version-2', mode: 'revise_selection', kind: 'short_dialogue',
        revision: { selectedText: 'browser selection', instruction: 'browser instruction' }, requestedMaxOutputTokens: 128,
        maximumCostConfirmed: true, confirmedMaximumCostMicros: 321,
      }),
    }));

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: 'request_failed' });
    expect(calls).toEqual(['/auth/v1/user', '/rest/v1/owner_profiles', '/rest/v1/rpc/queue_draft_revision']);
  });

  it.each(['new', 'major_event_scene_plan', 'major_event_draft'] as const)('queues owner manual %s through the authoritative RPC and forwards only returned bindings', async (mode) => {
    const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
    const fetch: typeof globalThis.fetch = vi.fn(async (input, init) => {
      const path = new URL(String(input)).pathname;
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      calls.push({ path, body });
      if (path === '/auth/v1/user') return Response.json({ id: 'owner-1' });
      if (path === '/rest/v1/owner_profiles') return Response.json([{ owner_id: 'owner-1' }]);
      if (path.endsWith('/queue_manual_generation')) return Response.json({
        job_id: 'server-job', draft_id: 'server-draft', idempotency_key: 'server-key',
        mode, kind: mode === 'new' ? 'short_dialogue' : 'major_event_proposal', seed: 'server-seed', tags: ['server-tag'],
      });
      return Response.json({ draftId: 'server-draft', versionId: 'version-1', status: 'generated', continuityLevel: 'review' });
    });
    const handler = createNarrativeHandler({ supabaseUrl: 'https://db.example.test', supabaseAnonKey: 'anon', fetch });
    const input = mode === 'new'
      ? { mode, kind: 'short_dialogue', title: '새 대화', seed: 'owner-seed', tags: ['owner-tag'] }
      : { mode, draftId: 'major-1' };
    const response = await handler(new Request('https://admin.example.test/api/narrative/generate', {
      method: 'POST', headers: { authorization: 'Bearer owner-token', 'content-type': 'application/json' },
      body: JSON.stringify(input),
    }));

    expect(response.status).toBe(200);
    expect(calls[2]).toEqual({ path: '/rest/v1/rpc/queue_manual_generation', body: {
      p_draft_id: mode === 'new' ? null : 'major-1', p_requested_mode: mode,
      p_kind: mode === 'new' ? 'short_dialogue' : null, p_title: mode === 'new' ? '새 대화' : null,
      p_seed: mode === 'new' ? 'owner-seed' : null, p_tags: mode === 'new' ? ['owner-tag'] : null,
    } });
    expect(calls[3]).toEqual({ path: '/functions/v1/generate-draft', body: {
      jobId: 'server-job', draftId: 'server-draft', idempotencyKey: 'server-key', mode,
      kind: mode === 'new' ? 'short_dialogue' : 'major_event_proposal', seed: 'server-seed', tags: ['server-tag'],
    } });
  });

  it('rejects browser attempts to smuggle server-owned manual generation fields', async () => {
    const fetch: typeof globalThis.fetch = vi.fn(async (input) => {
      const path = new URL(String(input)).pathname;
      if (path === '/auth/v1/user') return Response.json({ id: 'owner-1' });
      if (path === '/rest/v1/owner_profiles') return Response.json([{ owner_id: 'owner-1' }]);
      return Response.json({ unexpected: true });
    });
    const handler = createNarrativeHandler({ supabaseUrl: 'https://db.example.test', supabaseAnonKey: 'anon', fetch });
    const response = await handler(new Request('https://admin.example.test/api/narrative/generate', {
      method: 'POST', headers: { authorization: 'Bearer owner-token', 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'new', kind: 'short_dialogue', title: '위조', source: 'schedule', jobId: 'browser-job', providerSettingId: 'browser-provider' }),
    }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: 'server_owned_generation_field' });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each(['manual_generation_disabled', 'stale_provider_pricing', 'invalid_provider_pricing', 'workflow_phase_not_approved'])('preserves the owner manual queue conflict %s as a stable 409', async (code) => {
    const fetch: typeof globalThis.fetch = vi.fn(async (input) => {
      const path = new URL(String(input)).pathname;
      if (path === '/auth/v1/user') return Response.json({ id: 'owner-1' });
      if (path === '/rest/v1/owner_profiles') return Response.json([{ owner_id: 'owner-1' }]);
      return Response.json({ code: 'P0001', message: code }, { status: 400 });
    });
    const handler = createNarrativeHandler({ supabaseUrl: 'https://db.example.test', supabaseAnonKey: 'anon', fetch });
    const response = await handler(new Request('https://admin.example.test/api/narrative/generate', {
      method: 'POST', headers: { authorization: 'Bearer owner-token', 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'new', kind: 'daily_event', title: '정책 확인' }),
    }));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: code });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('preserves an exact generation replay binding conflict from Edge as stable 409', async () => {
    const fetch: typeof globalThis.fetch = vi.fn(async (input) => {
      const path = new URL(String(input)).pathname;
      if (path === '/auth/v1/user') return Response.json({ id: 'owner-1' });
      if (path === '/rest/v1/owner_profiles') return Response.json([{ owner_id: 'owner-1' }]);
      if (path.endsWith('/queue_draft_revision')) return Response.json({
        job_id: 'job-1', draft_id: 'draft-1', idempotency_key: 'revision-key', mode: 'revise_selection', kind: 'short_dialogue',
        revision: { selectedText: 'database selection', instruction: 'database instruction' }, requested_max_output_tokens: 64,
      });
      return Response.json({ error: 'generation_replay_mismatch' }, { status: 409 });
    });
    const handler = createNarrativeHandler({ supabaseUrl: 'https://db.example.test', supabaseAnonKey: 'anon', fetch });
    const response = await handler(new Request('https://admin.example.test/api/narrative/generate', {
      method: 'POST', headers: { authorization: 'Bearer owner-token', 'content-type': 'application/json' },
      body: JSON.stringify({
        draftId: 'draft-1', expectedVersionId: 'version-1', expectedState: 'reviewing', mode: 'revise_selection', kind: 'short_dialogue',
        revision: { selectedText: '문장', instruction: '수정' }, requestedMaxOutputTokens: 64,
        maximumCostConfirmed: true, confirmedMaximumCostMicros: 100,
      }),
    }));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: 'generation_replay_mismatch' });
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

  it('resolves the failed server-owned publish job and retries through publish-draft with its stable key', async () => {
    // Calling the removed browser RPC or accepting a browser job/key would bypass the migrated Edge boundary.
    const draftId = '91000000-0000-0000-0000-000000000001';
    const versionId = '92000000-0000-0000-0000-000000000001';
    const publishJobId = '94000000-0000-0000-0000-000000000001';
    const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
    const fetch: typeof globalThis.fetch = vi.fn(async (input, init) => {
      const url = new URL(String(input));
      calls.push({ path: `${url.pathname}${url.search}`, body: init?.body ? JSON.parse(String(init.body)) : {} });
      if (url.pathname === '/auth/v1/user') return Response.json({ id: 'owner-1' });
      if (url.pathname === '/rest/v1/owner_profiles') return Response.json([{ owner_id: 'owner-1' }]);
      if (url.pathname === '/rest/v1/publish_jobs') return Response.json([{
        id: publishJobId, draft_id: draftId, draft_version_id: versionId,
        idempotency_key: 'stable-publication-key', status: 'failed',
      }]);
      return Response.json({ publishJobId, versionId, status: 'published', commitSha: '1'.repeat(40), path: 'src/content/records/08-rainy-return.md' });
    });
    const handler = createNarrativeHandler({ supabaseUrl: 'https://db.example.test', supabaseAnonKey: 'anon', fetch });
    const response = await handler(new Request(`https://admin.example.test/api/narrative/drafts/${draftId}/retry-publish`, {
      method: 'POST', headers: { authorization: 'Bearer owner-token', 'content-type': 'application/json' },
      body: JSON.stringify({
        draftId, expectedVersionId: versionId, expectedState: 'publish_failed',
        publishJobId: 'browser-supplied-job-must-be-ignored', idempotencyKey: 'browser-supplied-key-must-be-ignored',
      }),
    }));

    expect(response.status).toBe(200);
    expect(calls.map(({ path }) => path)).toEqual([
      '/auth/v1/user',
      '/rest/v1/owner_profiles?select=owner_id&owner_id=eq.owner-1',
      `/rest/v1/publish_jobs?select=id%2Cdraft_id%2Cdraft_version_id%2Cidempotency_key%2Cstatus&draft_id=eq.${draftId}&draft_version_id=eq.${versionId}&status=eq.failed&limit=2`,
      '/functions/v1/publish-draft',
    ]);
    expect(calls[3]?.body).toEqual({ publishJobId, expectedVersionId: versionId, idempotencyKey: 'stable-publication-key' });
    expect(calls.some(({ path }) => path.includes('retry_narrative_publish'))).toBe(false);
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

  it('maps the exact draft publication row into separate commit, workflow, and Pages status with constructed safe URLs', async () => {
    const sha = '1'.repeat(40);
    const fetch: typeof globalThis.fetch = vi.fn(async (input) => {
      const url = new URL(String(input));
      if (url.pathname === '/auth/v1/user') return Response.json({ id: 'owner-1' });
      if (url.pathname === '/rest/v1/owner_profiles') return Response.json([{ owner_id: 'owner-1' }]);
      if (url.pathname === '/rest/v1/drafts') return Response.json([{ id: 'draft-1', kind: 'daily_event', status: 'published', title: 'published' }]);
      if (url.pathname === '/rest/v1/draft_versions') return Response.json([{
        id: 'version-1', version_number: 1, created_at: '2026-08-16T00:00:00Z',
        content: { title: 'published', body: 'body', canonChangeCandidates: [] }, context_version_ids: [], continuity_findings: [],
      }]);
      if (url.pathname === '/rest/v1/provider_settings') return Response.json([]);
      if (url.pathname === '/rest/v1/publish_jobs') return Response.json([{
        id: 'job-1', draft_id: 'draft-1', draft_version_id: 'version-1', status: 'published',
        repository_owner: 'cheonmu-owner', repository_name: 'cheonmu-archive', commit_sha: sha,
        publication_phase: 'deployed', tracking_status: 'completed', workflow_status: 'success', workflow_run_id: 42,
        pages_status: 'success', pages_deployment_id: 314, pages_url: 'https://cheonmu-owner.github.io/cheonmu-archive/',
      }]);
      return Response.json({ error: 'unexpected' }, { status: 500 });
    });
    const handler = createNarrativeHandler({ supabaseUrl: 'https://db.example.test', supabaseAnonKey: 'anon', fetch });
    const response = await handler(new Request('https://admin.example.test/api/narrative/drafts/draft-1', { headers: { authorization: 'Bearer owner-token' } }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.publication).toEqual({
      phase: 'deployed', trackingStatus: 'completed', repositoryOwner: 'cheonmu-owner', repositoryName: 'cheonmu-archive',
      commit: { status: 'created', sha, url: `https://github.com/cheonmu-owner/cheonmu-archive/commit/${sha}` },
      workflow: { status: 'success', runId: 42, url: 'https://github.com/cheonmu-owner/cheonmu-archive/actions/runs/42' },
      pages: { status: 'success', deploymentId: 314, url: 'https://cheonmu-owner.github.io/cheonmu-archive/' },
    });
  });

  it('reads settings through a secret-free owner RPC response', async () => {
    const fetch: typeof globalThis.fetch = vi.fn(async (input) => {
      const path = new URL(String(input)).pathname;
      if (path === '/auth/v1/user') return Response.json({ id: 'owner-1' });
      if (path === '/rest/v1/owner_profiles') return Response.json([{ owner_id: 'owner-1' }]);
      return Response.json({ manualGenerationEnabled: true, scheduleAutomationEnabled: false, providers: [], budget: {}, secrets: { openai: false, anthropic: false, github: false } });
    });
    const handler = createNarrativeHandler({ supabaseUrl: 'https://db.example.test', supabaseAnonKey: 'anon', fetch });
    const response = await handler(new Request('https://admin.example.test/api/narrative/settings', { headers: { authorization: 'Bearer owner-token' } }));
    const value = await response.json();

    expect(response.status).toBe(200);
    expect(JSON.stringify(value)).not.toMatch(/api.?key|token|secret.?value/i);
  });

  it('maps split policy settings to the owner RPC without deriving provider selection from schedule state', async () => {
    const calls: Array<{ path: string; body: unknown }> = [];
    const fetch: typeof globalThis.fetch = vi.fn(async (input, init) => {
      const path = new URL(String(input)).pathname;
      calls.push({ path, body: init?.body ? JSON.parse(String(init.body)) : null });
      if (path === '/auth/v1/user') return Response.json({ id: 'owner-1' });
      if (path === '/rest/v1/owner_profiles') return Response.json([{ owner_id: 'owner-1' }]);
      return Response.json({ saved: true });
    });
    const handler = createNarrativeHandler({ supabaseUrl: 'https://db.example.test', supabaseAnonKey: 'anon', fetch });
    const response = await handler(new Request('https://admin.example.test/api/narrative/settings', {
      method: 'POST', headers: { authorization: 'Bearer owner-token', 'content-type': 'application/json' },
      body: JSON.stringify({
        manualGenerationEnabled: true, scheduleAutomationEnabled: false, activeProviderKey: 'openai', providers: [],
        monthlyLimitMicros: 10, dailyLimitMicros: 10, manualCallLimit: 1,
        warningThresholdPercent: 80, riskThresholdPercent: 95, krwPerUsd: 1380, pricingValidDays: 30,
      }),
    }));

    expect(response.status).toBe(200);
    expect(calls[2]).toEqual({ path: '/rest/v1/rpc/save_narrative_settings', body: {
      p_manual_generation_enabled: true, p_schedule_automation_enabled: false, p_active_provider_key: 'openai',
      p_provider_updates: [], p_monthly_limit_micros: 10, p_daily_limit_micros: 10, p_manual_call_limit: 1,
      p_warning_threshold_percent: 80, p_risk_threshold_percent: 95, p_krw_per_usd: 1380, p_pricing_valid_days: 30,
    } });
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
