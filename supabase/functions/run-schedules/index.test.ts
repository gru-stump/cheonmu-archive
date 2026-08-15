import { describe, expect, it } from 'vitest';
import { createScheduleHandler, createSupabaseScheduleDependencies, evaluateAccessTrigger, runSchedules, type ScheduleDependencies } from './index.ts';
import { createCorsPolicy } from '../_shared/cors.ts';

function harness(overrides: Partial<ScheduleDependencies> = {}) {
  const inserted: Array<Record<string, unknown>> = [];
  const events: string[] = [];
  const byIdempotencyKey = new Map<string, Record<string, unknown>>();
  const deps: ScheduleDependencies = {
    now: () => new Date('2026-08-14T00:00:00Z'),
    authenticate: async (token) => { events.push('authenticate'); return token === 'token' ? { ownerId: 'owner-1' } : null; },
    listSchedules: async () => [{ ownerId: 'owner-1', scheduleKey: 'daily', scheduleType: 'automatic', cronExpression: '0 9 * * *', enabled: true, payload: { kind: 'daily_event' } }, { ownerId: 'owner-1', scheduleKey: 'weekly', scheduleType: 'automatic', cronExpression: '0 9 * * 1', enabled: true, payload: { kind: 'daily_event' } }, { ownerId: 'owner-1', scheduleKey: 'manual', scheduleType: 'manual', cronExpression: null, enabled: true, payload: { kind: 'short_dialogue' } }],
    budgetState: async () => 'normal',
    insertQueuedJob: async (job) => {
      const key = `${job.scheduleKey}:${job.scheduledFor}`;
      const existing = byIdempotencyKey.get(key); if (existing) return existing as Awaited<ReturnType<ScheduleDependencies['insertQueuedJob']>>;
      const created = { id: `job-${inserted.length + 1}`, ...job }; byIdempotencyKey.set(key, created); inserted.push(created); return created;
    },
    queueAccessJob: async (ownerId, now) => {
      events.push('queue-access');
      return deps.insertQueuedJob({ ownerId, scheduleKey: `access:${ownerId}`, scheduledFor: new Date(Math.floor(now.getTime() / 60_000) * 60_000).toISOString(), payload: { kind: 'short_dialogue', source: 'access' } });
    },
    ...overrides,
  };
  return { deps, inserted, events };
}

describe('runSchedules', () => {
  it.each([0, 1, 4, 5, 59])('can dispatch every accepted minute value, including minute %i', async (minute) => {
    const now = new Date(`2026-08-14T00:${String(minute).padStart(2, '0')}:00Z`);
    const h = harness({
      now: () => now,
      listSchedules: async () => [{ ownerId: 'owner-1', scheduleKey: `minute-${minute}`, scheduleType: 'automatic', cronExpression: `${minute} 9 * * *`, enabled: true, payload: { kind: 'daily_event' } }],
    });
    await runSchedules(h.deps);
    await runSchedules(h.deps);
    expect(h.inserted).toHaveLength(1);
    expect(h.inserted[0].scheduledFor).toBe(`2026-08-14T00:${String(minute).padStart(2, '0')}:00.000Z`);
  });

  it('uses the Seoul calendar date and only queues one daily job across duplicate invocations', async () => {
    const h = harness();
    await runSchedules(h.deps); await runSchedules(h.deps);
    expect(h.inserted).toEqual([{ id: 'job-1', ownerId: 'owner-1', scheduleKey: 'owner-1:daily:2026-08-14', scheduledFor: '2026-08-14T00:00:00.000Z', payload: { kind: 'daily_event', source: 'schedule' } }]);
  });

  it('skips weekly at warning and every automatic job at risk, never creating manual jobs', async () => {
    const warning = harness({ budgetState: async () => 'warning' });
    await runSchedules(warning.deps);
    expect(warning.inserted.map((job) => job.scheduleKey)).toEqual(['owner-1:daily:2026-08-14']);
    const risk = harness({ budgetState: async () => 'risk' });
    await runSchedules(risk.deps);
    expect(risk.inserted).toEqual([]);
  });

  it('queues an actual weekly cron only at its Seoul Monday instant', async () => {
    const h = harness({ now: () => new Date('2026-08-17T00:00:00Z') });
    await runSchedules(h.deps);
    expect(h.inserted.map((job) => job.scheduleKey)).toEqual(['owner-1:daily:2026-08-17', 'owner-1:weekly:2026-08-17']);
    expect(h.inserted.map((job) => job.scheduledFor)).toEqual(['2026-08-17T00:00:00.000Z', '2026-08-17T00:00:00.000Z']);
  });

  it.each([
    ['day-of-month', '0 9 1 * *'],
    ['month', '0 9 * 8 *'],
    ['range', '0-5 9 * * *'],
    ['step', '*/5 9 * * *'],
    ['comma', '0,5 9 * * *'],
    ['minute range', '60 9 * * *'],
    ['hour range', '0 24 * * *'],
    ['weekday range', '0 9 * * 7'],
  ])('rejects unsupported %s cron syntax instead of skipping or partially executing it', async (_case, cronExpression) => {
    const h = harness({ listSchedules: async () => [{ ownerId: 'owner-1', scheduleKey: 'invalid', scheduleType: 'automatic', cronExpression, enabled: true, payload: { kind: 'daily_event' } }] });
    await expect(runSchedules(h.deps)).rejects.toMatchObject({ code: 'invalid_schedule_configuration' });
    expect(h.inserted).toEqual([]);
  });

  it('excludes a manual schedule by schedule type without interpreting a fake cron keyword', async () => {
    const h = harness({ listSchedules: async () => [{ ownerId: 'owner-1', scheduleKey: 'manual', scheduleType: 'manual', cronExpression: null, enabled: true, payload: { kind: 'short_dialogue' } }] });
    await expect(runSchedules(h.deps)).resolves.toEqual([]);
    expect(h.inserted).toEqual([]);
  });

  it('queues a special date only at its exact Seoul calendar minute', async () => {
    const special = { ownerId: 'owner-1', scheduleKey: 'anniversary', scheduleType: 'special' as const, cronExpression: null, enabled: true, payload: { kind: 'short_dialogue' as const }, specialDate: '2026-09-07', seoulTime: '21:30', minimumIntervalMinutes: 1440 };
    const due = harness({ now: () => new Date('2026-09-07T12:30:00Z'), listSchedules: async () => [special] });
    await runSchedules(due.deps);
    expect(due.inserted).toMatchObject([{ scheduleKey: 'owner-1:anniversary:2026-09-07', scheduledFor: '2026-09-07T12:30:00.000Z' }]);

    const early = harness({ now: () => new Date('2026-09-07T12:29:00Z'), listSchedules: async () => [special] });
    await runSchedules(early.deps);
    expect(early.inserted).toEqual([]);
  });

  it('does not consume a quarantined disabled legacy expression', async () => {
    const h = harness({ listSchedules: async () => [
      { ownerId: 'owner-1', scheduleKey: 'legacy-disabled', scheduleType: 'automatic', cronExpression: '*/15 9 * * *', enabled: false, payload: { kind: 'daily_event' } },
      { ownerId: 'owner-1', scheduleKey: 'daily', scheduleType: 'automatic', cronExpression: '0 9 * * *', enabled: true, payload: { kind: 'daily_event' } },
    ] });
    await expect(runSchedules(h.deps)).resolves.toHaveLength(1);
    expect(h.inserted.map((job) => job.scheduleKey)).toEqual(['owner-1:daily:2026-08-14']);
  });
});

describe('evaluateAccessTrigger', () => {
  it.each([undefined, 'Basic token', 'Bearer ', 'Bearer token extra'])('rejects malformed bearer authorization %s before calling dependencies', async (authorization) => {
    const h = harness();
    const headers = new Headers({ origin: 'https://admin.example.test', 'content-type': 'application/json' });
    if (authorization !== undefined) headers.set('authorization', authorization);
    const response = await createScheduleHandler(h.deps, undefined, createCorsPolicy(['https://admin.example.test']))(new Request('http://local/run-schedules', {
      method: 'POST', headers, body: JSON.stringify({ action: 'access' }),
    }));
    expect(response.status).toBe(401);
    expect(response.headers.get('access-control-allow-origin')).toBe('https://admin.example.test');
    expect(h.events).toEqual([]);
  });

  it('handles allowlisted browser preflight and adds exact-origin CORS headers to errors', async () => {
    const h = harness();
    const cors = createCorsPolicy(['https://admin.example.test']);
    const handler = createScheduleHandler(h.deps, undefined, cors);
    const preflight = await handler(new Request('http://local/run-schedules', { method: 'OPTIONS', headers: { origin: 'https://admin.example.test', 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization, apikey, x-client-info, content-type' } }));
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-origin')).toBe('https://admin.example.test');
    expect(preflight.headers.get('access-control-allow-headers')).toBe('authorization, apikey, x-client-info, content-type');
    expect(preflight.headers.get('access-control-allow-credentials')).toBeNull();
    const error = await handler(new Request('http://local/run-schedules', { method: 'GET', headers: { origin: 'https://admin.example.test' } }));
    expect(error.status).toBe(405);
    expect(error.headers.get('access-control-allow-origin')).toBe('https://admin.example.test');
    const denied = await handler(new Request('http://local/run-schedules', { method: 'OPTIONS', headers: { origin: 'https://evil.example.test' } }));
    expect(denied.status).toBe(403);
    expect(denied.headers.get('access-control-allow-origin')).toBeNull();
    expect(h.events).toEqual([]);
  });

  it('adds CORS headers to an internal dispatch error response', async () => {
    const cors = createCorsPolicy(['https://admin.example.test']);
    const h = harness({ listSchedules: async () => { throw new Error('private database detail'); } });
    const response = await createScheduleHandler(h.deps, 'dispatch-secret', cors)(new Request('http://local/run-schedules', {
      method: 'POST', headers: { origin: 'https://admin.example.test', 'x-schedule-dispatch-token': 'dispatch-secret', 'content-type': 'application/json' }, body: JSON.stringify({ action: 'dispatch' }),
    }));
    expect(response.status).toBe(500);
    expect(response.headers.get('access-control-allow-origin')).toBe('https://admin.example.test');
    await expect(response.json()).resolves.toEqual({ error: 'internal_error' });
  });

  it('maps an expired or invalid bearer response to 401 with CORS headers', async () => {
    const cors = createCorsPolicy(['https://admin.example.test']);
    const deps = createSupabaseScheduleDependencies({ url: 'http://supabase', anonKey: 'anon', serviceRoleKey: 'service-secret', fetch: async () => Response.json({ message: 'invalid JWT' }, { status: 401 }) }, 'expired-token');
    const response = await createScheduleHandler(deps, undefined, cors)(new Request('http://local/run-schedules', {
      method: 'POST', headers: { origin: 'https://admin.example.test', authorization: 'Bearer expired-token', 'content-type': 'application/json' }, body: JSON.stringify({ action: 'access' }),
    }));
    expect(response.status).toBe(401);
    expect(response.headers.get('access-control-allow-origin')).toBe('https://admin.example.test');
    await expect(response.json()).resolves.toEqual({ error: 'authentication_required' });
  });

  it('authenticates once, then delegates repeated access loads to one atomic queue operation', async () => {
    const h = harness();
    await expect(evaluateAccessTrigger(h.deps, 'token')).resolves.toMatchObject({ scheduleKey: 'access:owner-1', payload: { kind: 'short_dialogue', source: 'access' } });
    await expect(evaluateAccessTrigger(h.deps, 'token')).resolves.toMatchObject({ scheduleKey: 'access:owner-1' });
    expect(h.inserted).toHaveLength(1);
    expect(h.events).toEqual(['authenticate', 'queue-access', 'authenticate', 'queue-access']);
    await expect(evaluateAccessTrigger(h.deps, 'nope')).rejects.toMatchObject({ code: 'authentication_required' });
  });

  it('exposes access triggering only through an authenticated HTTP command', async () => {
    const h = harness();
    const handler = createScheduleHandler(h.deps);
    const unauthorized = await handler(new Request('http://local/run-schedules', { method: 'POST', body: JSON.stringify({ action: 'access' }) }));
    expect(unauthorized.status).toBe(401);
    const access = await handler(new Request('http://local/run-schedules', { method: 'POST', headers: { authorization: 'Bearer token', 'content-type': 'application/json' }, body: JSON.stringify({ action: 'access' }) }));
    expect(access.status).toBe(202);
    await expect(access.json()).resolves.toMatchObject({ scheduleKey: 'access:owner-1' });
  });

  it('uses the user token only for identity and the service role only for the atomic access RPC', async () => {
    const seen: Array<{ path: string; authorization: string | null; body: unknown }> = [];
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const path = new URL(String(input)).pathname;
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      seen.push({ path, authorization: new Headers(init?.headers).get('authorization'), body });
      if (path === '/auth/v1/user') return Response.json({ id: 'owner-1' });
      if (path === '/rest/v1/rpc/queue_narrative_access_job') return Response.json({ id: 'persisted-job', owner_id: 'owner-1', schedule_key: 'access:owner-1', scheduled_for: '2026-08-14T00:00:00+00:00', payload: { kind: 'short_dialogue', source: 'access' } });
      return Response.json({ message: 'unexpected split access RPC' }, { status: 500 });
    };
    const deps = createSupabaseScheduleDependencies({ url: 'http://supabase', anonKey: 'anon', serviceRoleKey: 'service-secret', fetch }, 'user-token');
    await expect(evaluateAccessTrigger(deps, 'user-token')).resolves.toEqual({ id: 'persisted-job', ownerId: 'owner-1', scheduleKey: 'access:owner-1', scheduledFor: '2026-08-14T00:00:00+00:00', payload: { kind: 'short_dialogue', source: 'access' } });
    expect(seen).toEqual([
      { path: '/auth/v1/user', authorization: 'Bearer user-token', body: null },
      { path: '/rest/v1/rpc/queue_narrative_access_job', authorization: 'Bearer service-secret', body: { p_owner_id: 'owner-1', p_now: expect.any(String) } },
    ]);
  });

  it.each(['access_interval_not_elapsed', 'daily_access_limit', 'budget_risk'])('preserves the atomic RPC conflict %s without exposing persistence details', async (code) => {
    const fetch: typeof globalThis.fetch = async (input) => new URL(String(input)).pathname === '/auth/v1/user'
      ? Response.json({ id: 'owner-1' })
      : Response.json({ code: 'P0001', message: code, details: 'private database detail' }, { status: 409 });
    const handler = createScheduleHandler(createSupabaseScheduleDependencies({ url: 'http://supabase', anonKey: 'anon', serviceRoleKey: 'service-secret', fetch }, 'user-token'));
    const response = await handler(new Request('http://local/run-schedules', { method: 'POST', headers: { authorization: 'Bearer user-token', 'content-type': 'application/json' }, body: JSON.stringify({ action: 'access', ownerId: 'other-owner', dailyLimit: 999 }) }));
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: code });
  });
});
