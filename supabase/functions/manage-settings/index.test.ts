import { describe, expect, it, vi } from 'vitest';
import { applySecretWrite, createManageSettingsHandler, createSupabaseManageSettingsDependencies, ManageSettingsError, type ManageSettingsDependencies } from './index.ts';

function harness(overrides: Partial<ManageSettingsDependencies> = {}) {
  const stored: unknown[] = [];
  const deps = {
    authenticateOwner: async () => ({ ownerId: 'owner-1' }),
    storeSecret: async (input) => { stored.push(input); return true; },
    listModels: async () => ({ providerKey: 'openai', configured: false, live: false, models: [] }),
    deleteSecret: async () => ({ configured: false, generationPaused: true }),
    ...overrides,
  } as unknown as ManageSettingsDependencies;
  return { deps, stored };
}

describe('manage-settings secret boundary', () => {
  it('authenticates the owner, writes through the secret store, and returns only configured', async () => {
    const h = harness();
    const result = await applySecretWrite(h.deps, { authToken: 'owner-token', kind: 'openai', value: 'write-only-value' });

    expect(result).toEqual({ configured: true });
    expect(h.stored).toEqual([{ ownerId: 'owner-1', kind: 'openai', value: 'write-only-value' }]);
    expect(JSON.stringify(result)).not.toContain('write-only-value');
  });

  it('rejects missing bearer credentials before parsing or storing a secret', async () => {
    const h = harness();
    const response = await createManageSettingsHandler(h.deps)(new Request('http://local/manage-settings', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'write-secret', kind: 'github', value: 'must-not-be-read' }),
    }));
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: 'authentication_required' });
    expect(h.stored).toEqual([]);
  });

  it('rejects policy fields smuggled through the secret-only boundary', async () => {
    const h = harness();
    const response = await createManageSettingsHandler(h.deps)(new Request('http://local/manage-settings', {
      method: 'POST', headers: { authorization: 'Bearer owner-token', 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'write-secret', kind: 'openai', value: 'write-only-value', manualGenerationEnabled: true, scheduleAutomationEnabled: true }),
    }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: 'invalid_command' });
    expect(h.stored).toEqual([]);
  });

  it('uses the user credential for identity/owner membership and service role only for the Vault RPC', async () => {
    const calls: Array<{ path: string; authorization: string | null; body: unknown }> = [];
    const fetch: typeof globalThis.fetch = vi.fn(async (input, init) => {
      const path = new URL(String(input)).pathname;
      calls.push({ path, authorization: new Headers(init?.headers).get('authorization'), body: init?.body ? JSON.parse(String(init.body)) : null });
      if (path === '/auth/v1/user') return Response.json({ id: 'owner-1' });
      if (path === '/rest/v1/owner_profiles') return Response.json([{ owner_id: 'owner-1' }]);
      return Response.json(true);
    });
    const deps = createSupabaseManageSettingsDependencies({ url: 'http://supabase', anonKey: 'anon', serviceRoleKey: 'service-role-value', fetch }, 'owner-token');

    await expect(applySecretWrite(deps, { authToken: 'owner-token', kind: 'anthropic', value: 'write-only-value' })).resolves.toEqual({ configured: true });
    expect(calls).toEqual([
      { path: '/auth/v1/user', authorization: 'Bearer owner-token', body: null },
      { path: '/rest/v1/owner_profiles', authorization: 'Bearer owner-token', body: null },
      { path: '/rest/v1/rpc/store_narrative_secret', authorization: 'Bearer service-role-value', body: { p_owner_id: 'owner-1', p_secret_kind: 'anthropic', p_secret_value: 'write-only-value' } },
    ]);
  });

  it('sanitizes storage failures without returning secret values or persistence details', async () => {
    const h = harness({ storeSecret: async () => { throw new Error('write-only-value database detail'); } });
    const response = await createManageSettingsHandler(h.deps)(new Request('http://local/manage-settings', {
      method: 'POST', headers: { authorization: 'Bearer owner-token', 'content-type': 'application/json' }, body: JSON.stringify({ action: 'write-secret', kind: 'github', value: 'write-only-value' }),
    }));
    expect(response.status).toBe(500);
    expect(JSON.stringify(await response.json())).toBe('{"error":"internal_error"}');
  });
});

describe('manage-settings model and deletion boundary', () => {
  it('returns only the allowlisted model projection after owner authentication', async () => {
    const h = harness({
      listModels: async () => ({
        providerKey: 'openai', configured: true, live: true,
        models: [{ id: 'gpt-5-mini', label: 'GPT-5 mini' }],
      }),
    } as never);
    const response = await createManageSettingsHandler(h.deps)(new Request('http://local/manage-settings', {
      method: 'POST', headers: { authorization: 'Bearer owner-token', 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'list-models', providerKey: 'openai' }),
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      providerKey: 'openai', configured: true, live: true,
      models: [{ id: 'gpt-5-mini', label: 'GPT-5 mini' }],
    });
  });

  it('rejects an invalid owner token before revealing command validation', async () => {
    const h = harness({ authenticateOwner: async () => { throw new ManageSettingsError(401, 'authentication_required'); } });
    const response = await createManageSettingsHandler(h.deps)(new Request('http://local/manage-settings', {
      method: 'POST', headers: { authorization: 'Bearer x', 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'github', value: 'x' }),
    }));
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: 'authentication_required' });
  });

  it('deletes only an allowlisted secret kind and returns safe state', async () => {
    const deleted: unknown[] = [];
    const h = harness({
      deleteSecret: async (input: unknown) => { deleted.push(input); return { configured: false, generationPaused: true }; },
    } as never);
    const response = await createManageSettingsHandler(h.deps)(new Request('http://local/manage-settings', {
      method: 'POST', headers: { authorization: 'Bearer owner-token', 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'delete-secret', kind: 'openai' }),
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ configured: false, generationPaused: true });
    expect(deleted).toEqual([{ ownerId: 'owner-1', kind: 'openai' }]);
  });

  it('rejects unknown providers and fields before any secret or provider access', async () => {
    const h = harness();
    const response = await createManageSettingsHandler(h.deps)(new Request('http://local/manage-settings', {
      method: 'POST', headers: { authorization: 'Bearer owner-token', 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'list-models', providerKey: 'whisper', apiKey: 'must-not-be-read' }),
    }));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: 'invalid_command' });
  });

  it('reads the OpenAI key server-side and filters the live response through the story catalog', async () => {
    const calls: Array<{ url: string; authorization: string | null }> = [];
    const fetch: typeof globalThis.fetch = vi.fn(async (input, init) => {
      const url = String(input);
      calls.push({ url, authorization: new Headers(init?.headers).get('authorization') });
      const path = new URL(url).pathname;
      if (path === '/auth/v1/user') return Response.json({ id: 'owner-1' });
      if (path === '/rest/v1/owner_profiles') return Response.json([{ owner_id: 'owner-1' }]);
      if (path === '/rest/v1/rpc/read_narrative_secret') return Response.json('fixture-openai-key');
      return Response.json({ data: [{ id: 'gpt-5-mini' }, { id: 'whisper-1' }] });
    });
    const deps = createSupabaseManageSettingsDependencies({
      url: 'http://supabase', anonKey: 'anon', serviceRoleKey: 'service-role-value', fetch,
    }, 'owner-token');
    const response = await createManageSettingsHandler(deps)(new Request('http://local/manage-settings', {
      method: 'POST', headers: { authorization: 'Bearer owner-token', 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'list-models', providerKey: 'openai' }),
    }));
    const value = await response.json();

    expect(response.status).toBe(200);
    expect(value.models.map((model: { id: string }) => model.id)).toEqual(['gpt-5-mini']);
    expect(JSON.stringify(value)).not.toContain('fixture-openai-key');
    expect(calls.at(-1)).toEqual({ url: 'https://api.openai.com/v1/models', authorization: 'Bearer fixture-openai-key' });
  });

  it('uses Anthropic model-list headers without returning the key', async () => {
    let providerHeaders = new Headers();
    const fetch: typeof globalThis.fetch = vi.fn(async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path === '/auth/v1/user') return Response.json({ id: 'owner-1' });
      if (path === '/rest/v1/owner_profiles') return Response.json([{ owner_id: 'owner-1' }]);
      if (path === '/rest/v1/rpc/read_narrative_secret') return Response.json('server-only-anthropic-key');
      providerHeaders = new Headers(init?.headers);
      return Response.json({ data: [{ id: 'claude-haiku-4-5-20251001' }] });
    });
    const deps = createSupabaseManageSettingsDependencies({ url: 'http://supabase', anonKey: 'anon', serviceRoleKey: 'service', fetch }, 'owner-token');
    const response = await createManageSettingsHandler(deps)(new Request('http://local/manage-settings', {
      method: 'POST', headers: { authorization: 'Bearer owner-token', 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'list-models', providerKey: 'anthropic' }),
    }));

    expect(response.status).toBe(200);
    expect(providerHeaders.get('x-api-key')).toBe('server-only-anthropic-key');
    expect(providerHeaders.get('anthropic-version')).toBe('2023-06-01');
    expect(JSON.stringify(await response.json())).not.toContain('server-only-anthropic-key');
  });

  it('maps a rejected key to sanitized connection guidance and fallback models', async () => {
    const fetch: typeof globalThis.fetch = vi.fn(async (input) => {
      const path = new URL(String(input)).pathname;
      if (path === '/auth/v1/user') return Response.json({ id: 'owner-1' });
      if (path === '/rest/v1/owner_profiles') return Response.json([{ owner_id: 'owner-1' }]);
      if (path === '/rest/v1/rpc/read_narrative_secret') return Response.json('rejected-key');
      return Response.json({ error: { message: 'raw provider auth detail' } }, { status: 401 });
    });
    const deps = createSupabaseManageSettingsDependencies({ url: 'http://supabase', anonKey: 'anon', serviceRoleKey: 'service', fetch }, 'owner-token');
    const response = await createManageSettingsHandler(deps)(new Request('http://local/manage-settings', {
      method: 'POST', headers: { authorization: 'Bearer owner-token', 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'list-models', providerKey: 'openai' }),
    }));
    const value = await response.json();

    expect(response.status).toBe(200);
    expect(value).toMatchObject({ configured: true, live: false, connectionIssue: 'invalid_key' });
    expect(value.models.length).toBeGreaterThan(0);
    expect(JSON.stringify(value)).not.toMatch(/raw provider auth detail|rejected-key/);
  });

  it('bounds a stalled provider response body and returns sanitized fallback state', async () => {
    const fetch: typeof globalThis.fetch = vi.fn(async (input) => {
      const path = new URL(String(input)).pathname;
      if (path === '/auth/v1/user') return Response.json({ id: 'owner-1' });
      if (path === '/rest/v1/owner_profiles') return Response.json([{ owner_id: 'owner-1' }]);
      if (path === '/rest/v1/rpc/read_narrative_secret') return Response.json('server-only-key');
      return { ok: true, status: 200, json: () => new Promise(() => undefined) } as Response;
    });
    const deps = createSupabaseManageSettingsDependencies({
      url: 'http://supabase', anonKey: 'anon', serviceRoleKey: 'service', fetch, timeoutMs: 5,
    } as never, 'owner-token');
    const response = await createManageSettingsHandler(deps)(new Request('http://local/manage-settings', {
      method: 'POST', headers: { authorization: 'Bearer owner-token', 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'list-models', providerKey: 'openai' }),
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ configured: true, live: false, connectionIssue: 'temporarily_unavailable' });
  });
});
