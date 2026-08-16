import { describe, expect, it, vi } from 'vitest';
import { applySecretWrite, createManageSettingsHandler, createSupabaseManageSettingsDependencies, type ManageSettingsDependencies } from './index.ts';

function harness(overrides: Partial<ManageSettingsDependencies> = {}) {
  const stored: unknown[] = [];
  const deps: ManageSettingsDependencies = {
    authenticateOwner: async () => ({ ownerId: 'owner-1' }),
    storeSecret: async (input) => { stored.push(input); return true; },
    ...overrides,
  };
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
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'github', value: 'must-not-be-read' }),
    }));
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: 'authentication_required' });
    expect(h.stored).toEqual([]);
  });

  it('rejects policy fields smuggled through the secret-only boundary', async () => {
    const h = harness();
    const response = await createManageSettingsHandler(h.deps)(new Request('http://local/manage-settings', {
      method: 'POST', headers: { authorization: 'Bearer owner-token', 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'openai', value: 'write-only-value', manualGenerationEnabled: true, scheduleAutomationEnabled: true }),
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
      method: 'POST', headers: { authorization: 'Bearer owner-token', 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'github', value: 'write-only-value' }),
    }));
    expect(response.status).toBe(500);
    expect(JSON.stringify(await response.json())).toBe('{"error":"internal_error"}');
  });
});
