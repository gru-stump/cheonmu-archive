import { describe, expect, it } from 'vitest';
import { createScheduleHandler, createSupabaseScheduleDependencies, evaluateAccessTrigger, runSchedules, ScheduleError, type QueuedJob, type ScheduleDependencies } from './index.ts';
import { createCorsPolicy } from '../_shared/cors.ts';

function harness(overrides: Partial<ScheduleDependencies> = {}) {
  const inserted: Array<Record<string, unknown>> = [];
  const events: string[] = [];
  const byIdempotencyKey = new Map<string, Record<string, unknown>>();
  const store = async (job: Omit<QueuedJob, 'id'>) => {
    const key = `${job.scheduleKey}:${job.scheduledFor}`;
    const existing = byIdempotencyKey.get(key); if (existing) return existing as QueuedJob;
    const created = { id: `job-${inserted.length + 1}`, ...job }; byIdempotencyKey.set(key, created); inserted.push(created); return created;
  };
  const deps: ScheduleDependencies = {
    now: () => new Date('2026-08-14T00:00:00Z'),
    authenticate: async (token) => { events.push('authenticate'); return token === 'token' ? { ownerId: 'owner-1' } : null; },
    listSchedules: async () => [{ ownerId: 'owner-1', scheduleKey: 'daily', scheduleType: 'automatic', cronExpression: '0 9 * * *', enabled: true, payload: { kind: 'daily_event' } }, { ownerId: 'owner-1', scheduleKey: 'weekly', scheduleType: 'automatic', cronExpression: '0 9 * * 1', enabled: true, payload: { kind: 'daily_event' } }, { ownerId: 'owner-1', scheduleKey: 'manual', scheduleType: 'manual', cronExpression: null, enabled: true, payload: { kind: 'short_dialogue' } }],
    budgetState: async () => 'normal',
    queueScheduleJob: async (schedule, scheduledFor) => store({ ownerId: schedule.ownerId, scheduleKey: `${schedule.ownerId}:${schedule.scheduleKey}:${new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(new Date(scheduledFor))}`, scheduledFor, payload: { kind: schedule.payload.kind, source: 'schedule' } }),
    queueAccessJob: async (ownerId, now) => {
      events.push('queue-access');
      return store({ ownerId, scheduleKey: `access:${ownerId}`, scheduledFor: new Date(Math.floor(now.getTime() / 60_000) * 60_000).toISOString(), payload: { kind: 'short_dialogue', source: 'access' } });
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

  it('uses the stored last queue time and minimum interval at blocked and exact eligible boundaries', async () => {
    const schedule = {
      ownerId: 'owner-1', scheduleKey: 'two-day', scheduleType: 'automatic' as const,
      cronExpression: '0 9 * * *', enabled: true, payload: { kind: 'daily_event' as const },
      minimumIntervalMinutes: 2880, lastQueuedAt: '2026-08-14T00:00:00Z',
    };
    const blocked = harness({ now: () => new Date('2026-08-15T00:00:00Z'), listSchedules: async () => [schedule] });
    await expect(runSchedules(blocked.deps)).resolves.toEqual([]);
    expect(blocked.inserted).toEqual([]);

    const eligible = harness({ now: () => new Date('2026-08-16T00:00:00Z'), listSchedules: async () => [schedule] });
    await expect(runSchedules(eligible.deps)).resolves.toHaveLength(1);
  });

  it('does not consume a quarantined disabled legacy expression', async () => {
    const h = harness({ listSchedules: async () => [
      { ownerId: 'owner-1', scheduleKey: 'legacy-disabled', scheduleType: 'automatic', cronExpression: '*/15 9 * * *', enabled: false, payload: { kind: 'daily_event' } },
      { ownerId: 'owner-1', scheduleKey: 'daily', scheduleType: 'automatic', cronExpression: '0 9 * * *', enabled: true, payload: { kind: 'daily_event' } },
    ] });
    await expect(runSchedules(h.deps)).resolves.toHaveLength(1);
    expect(h.inserted.map((job) => job.scheduleKey)).toEqual(['owner-1:daily:2026-08-14']);
  });

  it('continues the dispatch batch when automation is disabled atomically while one schedule queues', async () => {
    const h = harness({
      listSchedules: async () => [
        { ownerId: 'owner-1', scheduleKey: 'racing-off', scheduleType: 'automatic', cronExpression: '0 9 * * *', enabled: true, payload: { kind: 'daily_event' } },
        { ownerId: 'owner-2', scheduleKey: 'still-on', scheduleType: 'automatic', cronExpression: '0 9 * * *', enabled: true, payload: { kind: 'short_dialogue' } },
      ],
      queueScheduleJob: async (schedule, scheduledFor) => {
        if (schedule.scheduleKey === 'racing-off') throw new ScheduleError('schedule_automation_disabled');
        return { id: 'job-owner-2', ownerId: schedule.ownerId, scheduleKey: schedule.scheduleKey, scheduledFor, payload: { kind: schedule.payload.kind, source: 'schedule' } };
      },
    });
    const response = await createScheduleHandler(h.deps, 'dispatch-secret')(new Request('http://local/run-schedules', {
      method: 'POST', headers: { 'x-schedule-dispatch-token': 'dispatch-secret', 'content-type': 'application/json' }, body: JSON.stringify({ action: 'dispatch' }),
    }));

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({ jobs: [{
      id: 'job-owner-2', ownerId: 'owner-2', scheduleKey: 'still-on', scheduledFor: '2026-08-14T00:00:00.000Z',
      payload: { kind: 'short_dialogue', source: 'schedule' },
    }] });
  });
});

describe('evaluateAccessTrigger', () => {
  it.each([undefined, 'Basic token', 'Bearer ', 'Bearer token extra'])('rejects malformed bearer authorization %s before calling dependencies', async (authorization) => {
    const h = harness();
    const headers = new Headers({ origin: 'https://admin.example.test', 'content-type': 'application/json' });
    if (authorization !== undefined) headers.set('authorization', authorization);
    const response = await createScheduleHandler(h.deps, undefined, createCorsPolicy(['https://admin.example.test']))(new Request('http://local/run-schedules', {
      method: 'POST', headers, body: JSON.stringify({ action: 'access', maximumCostConfirmed: true, confirmedMaximumCostMicros: 4200 }),
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
      method: 'POST', headers: { origin: 'https://admin.example.test', authorization: 'Bearer expired-token', 'content-type': 'application/json' }, body: JSON.stringify({ action: 'access', maximumCostConfirmed: true, confirmedMaximumCostMicros: 4200 }),
    }));
    expect(response.status).toBe(401);
    expect(response.headers.get('access-control-allow-origin')).toBe('https://admin.example.test');
    await expect(response.json()).resolves.toEqual({ error: 'authentication_required' });
  });

  it('authenticates once, then delegates repeated access loads to one atomic queue operation', async () => {
    const h = harness();
    await expect(evaluateAccessTrigger(h.deps, 'token', 4200)).resolves.toMatchObject({ scheduleKey: 'access:owner-1', payload: { kind: 'short_dialogue', source: 'access' } });
    await expect(evaluateAccessTrigger(h.deps, 'token', 4200)).resolves.toMatchObject({ scheduleKey: 'access:owner-1' });
    expect(h.inserted).toHaveLength(1);
    expect(h.events).toEqual(['authenticate', 'queue-access', 'authenticate', 'queue-access']);
    await expect(evaluateAccessTrigger(h.deps, 'nope', 4200)).rejects.toMatchObject({ code: 'authentication_required' });
  });

  it('exposes access triggering only through an authenticated HTTP command', async () => {
    const h = harness();
    const handler = createScheduleHandler(h.deps);
    const unauthorized = await handler(new Request('http://local/run-schedules', { method: 'POST', body: JSON.stringify({ action: 'access', maximumCostConfirmed: true, confirmedMaximumCostMicros: 4200 }) }));
    expect(unauthorized.status).toBe(401);
    const access = await handler(new Request('http://local/run-schedules', { method: 'POST', headers: { authorization: 'Bearer token', 'content-type': 'application/json' }, body: JSON.stringify({ action: 'access', maximumCostConfirmed: true, confirmedMaximumCostMicros: 4200 }) }));
    expect(access.status).toBe(202);
    await expect(access.json()).resolves.toMatchObject({ scheduleKey: 'access:owner-1' });
  });

  it('queues the exact confirmed access cost once and wakes the worker without exposing its token', async () => {
    const events: unknown[] = [];
    const deps: ScheduleDependencies = {
      now: () => new Date('2026-08-16T00:00:00Z'), authenticate: async () => ({ ownerId: 'owner-1' }),
      listSchedules: async () => [], budgetState: async () => 'normal',
      queueScheduleJob: async () => { throw new Error('not used'); },
      queueAccessJob: async (ownerId, now, confirmedMaximumCostMicros) => {
        events.push(['queue', ownerId, now.toISOString(), confirmedMaximumCostMicros]);
        return { id: 'job-1', ownerId, scheduleKey: `access:${ownerId}`, scheduledFor: now.toISOString(), payload: { kind: 'short_dialogue', source: 'access' } };
      },
      wakeGenerationWorker: async (job) => { events.push(['wake', job.id]); return true; },
    };
    const response = await createScheduleHandler(deps)(new Request('http://local/run-schedules', {
      method: 'POST', headers: { authorization: 'Bearer owner-token', 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'access', maximumCostConfirmed: true, confirmedMaximumCostMicros: 4200 }),
    }));

    expect(response.status).toBe(202);
    const payload = await response.json();
    expect(payload).toMatchObject({ id: 'job-1', dispatchState: 'started' });
    expect(events).toEqual([['queue', 'owner-1', '2026-08-16T00:00:00.000Z', 4200], ['wake', 'job-1']]);
    expect(JSON.stringify(payload)).not.toContain('token');
  });

  it('keeps the same queued job when the worker wake is delayed', async () => {
    let queueCalls = 0;
    const deps: ScheduleDependencies = {
      now: () => new Date('2026-08-16T00:00:00Z'), authenticate: async () => ({ ownerId: 'owner-1' }),
      listSchedules: async () => [], budgetState: async () => 'normal', queueScheduleJob: async () => { throw new Error('not used'); },
      queueAccessJob: async (ownerId, now) => { queueCalls += 1; return { id: 'same-job', ownerId, scheduleKey: `access:${ownerId}`, scheduledFor: now.toISOString(), payload: { kind: 'short_dialogue', source: 'access' } }; },
      wakeGenerationWorker: async () => false,
    };
    const response = await createScheduleHandler(deps)(new Request('http://local/run-schedules', {
      method: 'POST', headers: { authorization: 'Bearer owner-token', 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'access', maximumCostConfirmed: true, confirmedMaximumCostMicros: 4200 }),
    }));
    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({ id: 'same-job', dispatchState: 'delayed' });
    expect(queueCalls).toBe(1);
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
    await expect(evaluateAccessTrigger(deps, 'user-token', 4200)).resolves.toEqual({ id: 'persisted-job', ownerId: 'owner-1', scheduleKey: 'access:owner-1', scheduledFor: '2026-08-14T00:00:00+00:00', payload: { kind: 'short_dialogue', source: 'access' }, dispatchState: 'delayed' });
    expect(seen).toEqual([
      { path: '/auth/v1/user', authorization: 'Bearer user-token', body: null },
      { path: '/rest/v1/rpc/queue_narrative_access_job', authorization: 'Bearer service-secret', body: { p_owner_id: 'owner-1', p_now: expect.any(String), p_confirmed_maximum_cost_micros: 4200 } },
    ]);
  });

  it('dispatches through the atomic due-schedule RPC with the persisted schedule id', async () => {
    const seen: Array<{ path: string; body: unknown }> = [];
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const path = new URL(String(input)).pathname;
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      seen.push({ path, body });
      if (path === '/rest/v1/schedules') return Response.json([{ id: 'schedule-1', owner_id: 'owner-1', schedule_key: 'daily', schedule_type: 'automatic', cron_expression: '0 9 * * *', enabled: true, payload: { kind: 'daily_event' }, special_date: null, seoul_time: '09:00:00', minimum_interval_minutes: 60, last_queued_at: null }]);
      if (path === '/rest/v1/rpc/narrative_schedule_budget_state') return Response.json('normal');
      if (path === '/rest/v1/rpc/queue_due_narrative_schedule_job') return Response.json({ id: 'job-1', owner_id: 'owner-1', schedule_key: 'owner-1:daily:2026-08-14', scheduled_for: '2026-08-14T00:00:00+00:00', payload: { kind: 'daily_event', source: 'schedule' } });
      return Response.json({ code: 'P0001', message: 'unexpected_non_atomic_queue_path' }, { status: 409 });
    };
    const deps = createSupabaseScheduleDependencies({ url: 'http://supabase', anonKey: 'anon', serviceRoleKey: 'service-secret', fetch }, '');
    deps.now = () => new Date('2026-08-14T00:00:00Z');

    await expect(runSchedules(deps)).resolves.toHaveLength(1);
    expect(seen.find(({ path }) => path === '/rest/v1/rpc/queue_due_narrative_schedule_job')?.body).toEqual({
      p_owner_id: 'owner-1', p_schedule_id: 'schedule-1', p_scheduled_for: '2026-08-14T00:00:00.000Z',
    });
    expect(seen.some(({ path }) => path === '/rest/v1/rpc/queue_narrative_schedule_job')).toBe(false);
  });

  it.each(['access_interval_not_elapsed', 'daily_access_limit', 'budget_risk', 'schedule_automation_disabled'])('preserves the atomic RPC conflict %s without exposing persistence details', async (code) => {
    const fetch: typeof globalThis.fetch = async (input) => new URL(String(input)).pathname === '/auth/v1/user'
      ? Response.json({ id: 'owner-1' })
      : Response.json({ code: 'P0001', message: code, details: 'private database detail' }, { status: 409 });
    const handler = createScheduleHandler(createSupabaseScheduleDependencies({ url: 'http://supabase', anonKey: 'anon', serviceRoleKey: 'service-secret', fetch }, 'user-token'));
    const response = await handler(new Request('http://local/run-schedules', { method: 'POST', headers: { authorization: 'Bearer user-token', 'content-type': 'application/json' }, body: JSON.stringify({ action: 'access', maximumCostConfirmed: true, confirmedMaximumCostMicros: 4200 }) }));
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: code });
  });
});
