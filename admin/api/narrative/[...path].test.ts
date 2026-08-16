import { afterEach, describe, expect, it, vi } from 'vitest';
import handler from './[...path]';

describe('deployed narrative API adapter', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('preserves the confirmed access cost body at the deployed boundary', async () => {
    vi.stubEnv('SUPABASE_URL', 'https://db.example.test');
    vi.stubEnv('SUPABASE_ANON_KEY', 'anon');
    let forwardedBody: unknown;
    const upstream: typeof globalThis.fetch = vi.fn(async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path === '/auth/v1/user') return Response.json({ id: 'owner-1' });
      if (path === '/rest/v1/owner_profiles') return Response.json([{ owner_id: 'owner-1' }]);
      forwardedBody = JSON.parse(String(init?.body ?? '{}'));
      return Response.json({
        id: 'persisted-job', ownerId: 'owner-1', scheduleKey: 'access:owner-1', scheduledFor: '2026-08-16T09:00:00Z',
        payload: { kind: 'short_dialogue', source: 'access' }, dispatchState: 'started',
      }, { status: 202 });
    });
    vi.stubGlobal('fetch', upstream);
    const sent: { status?: number; body?: string } = {};
    const response = {
      status(value: number) { sent.status = value; return this; },
      setHeader: vi.fn(),
      send(value: string) { sent.body = value; return this; },
    };

    await handler({
      method: 'POST', url: '/api/narrative/access', body: { maximumCostConfirmed: true, confirmedMaximumCostMicros: 4200 },
      headers: { host: 'admin.example.test', authorization: 'Bearer owner-token' },
    }, response);

    expect(sent).toEqual({ status: 202, body: JSON.stringify({ id: 'persisted-job', scheduledFor: '2026-08-16T09:00:00Z', dispatchState: 'started' }) });
    expect(forwardedBody).toEqual({ action: 'access', maximumCostConfirmed: true, confirmedMaximumCostMicros: 4200 });
    expect(upstream).toHaveBeenCalledTimes(3);
  });
});
