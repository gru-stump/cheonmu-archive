import { describe, expect, it } from 'vitest';
import { createScheduleHandler, evaluateAccessTrigger, runSchedules, type ScheduleDependencies } from './index.ts';

function harness(overrides: Partial<ScheduleDependencies> = {}) {
  const inserted: Array<Record<string, unknown>> = [];
  const byIdempotencyKey = new Map<string, Record<string, unknown>>();
  const deps: ScheduleDependencies = {
    now: () => new Date('2026-08-14T00:00:00Z'),
    authenticate: async (token) => token === 'token' ? { ownerId: 'owner-1' } : null,
    listSchedules: async () => [{ ownerId: 'owner-1', scheduleKey: 'daily', cronExpression: '0 9 * * *', enabled: true, payload: { kind: 'daily_event' } }, { ownerId: 'owner-1', scheduleKey: 'weekly', cronExpression: '0 9 * * 1', enabled: true, payload: { kind: 'daily_event' } }, { ownerId: 'owner-1', scheduleKey: 'manual', cronExpression: 'manual', enabled: true, payload: { kind: 'short_dialogue' } }],
    budgetState: async () => 'normal',
    insertQueuedJob: async (job) => {
      const key = `${job.scheduleKey}:${job.scheduledFor}`;
      const existing = byIdempotencyKey.get(key); if (existing) return existing as Awaited<ReturnType<ScheduleDependencies['insertQueuedJob']>>;
      const created = { id: `job-${inserted.length + 1}`, ...job }; byIdempotencyKey.set(key, created); inserted.push(created); return created;
    },
    recentAccessJob: async () => null,
    accessEligibility: async () => ({ lastSuccessAt: null, nextAllowedAt: null, dailyCallCount: 0, budgetState: 'normal' }),
    ...overrides,
  };
  return { deps, inserted };
}

describe('runSchedules', () => {
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
});

describe('evaluateAccessTrigger', () => {
  it('requires authentication, returns a recent job, then queues one idempotent short dialogue after the interval', async () => {
    const h = harness({ recentAccessJob: async () => ({ id: 'recent' }) });
    await expect(evaluateAccessTrigger(h.deps, 'token')).resolves.toEqual({ id: 'recent' });
    expect(h.inserted).toEqual([]);
    h.deps.recentAccessJob = async () => null;
    h.deps.accessEligibility = async () => ({ lastSuccessAt: '2026-08-13T00:00:00Z', nextAllowedAt: '2026-08-13T01:00:00Z', dailyCallCount: 0, budgetState: 'normal' });
    await expect(evaluateAccessTrigger(h.deps, 'token')).resolves.toMatchObject({ scheduleKey: 'access:owner-1', payload: { kind: 'short_dialogue', source: 'access' } });
    await expect(evaluateAccessTrigger(h.deps, 'token')).resolves.toMatchObject({ scheduleKey: 'access:owner-1' });
    expect(h.inserted).toHaveLength(1);
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
});
