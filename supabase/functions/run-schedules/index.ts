import { corsGate, corsPolicyFromEnvironment, createCorsPolicy, withCorsHeaders, type CorsPolicy } from '../_shared/cors.ts';

export type BudgetState = 'normal' | 'warning' | 'risk';
export interface QueuedJob { id?: string; ownerId: string; scheduleKey: string; scheduledFor: string; payload: { kind: 'short_dialogue' | 'daily_event'; source: 'schedule' | 'access' } }
export interface ScheduleRecord { ownerId: string; scheduleKey: string; scheduleType: 'automatic' | 'manual'; cronExpression: string | null; enabled: boolean; payload: { kind: 'short_dialogue' | 'daily_event' } }
export interface ScheduleDependencies {
  now(): Date; authenticate(token: string): Promise<{ ownerId: string } | null>; listSchedules(): Promise<ScheduleRecord[]>; budgetState(ownerId: string): Promise<BudgetState>;
  insertQueuedJob(job: Omit<QueuedJob, 'id'>): Promise<QueuedJob>; queueAccessJob(ownerId: string, now: Date): Promise<QueuedJob>;
}
export class ScheduleError extends Error { constructor(public readonly code: string) { super(code); this.name = 'ScheduleError'; } }

function seoulDate(now: Date): string { return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now); }
function localParts(now: Date): Record<string, number> { return Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Seoul', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now).filter(({ type }) => type !== 'literal').map(({ type, value }) => [type, type === 'weekday' ? ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].indexOf(value) : Number(value)])); }
interface AutomaticScheduleTime { minute: number; hour: number; weekday: number | null }
function automaticScheduleTime(schedule: ScheduleRecord): AutomaticScheduleTime | null {
  if (schedule.scheduleType === 'manual') {
    if (schedule.cronExpression !== null) throw new ScheduleError('invalid_schedule_configuration');
    return null;
  }
  if (schedule.scheduleType !== 'automatic' || typeof schedule.cronExpression !== 'string') throw new ScheduleError('invalid_schedule_configuration');
  const match = /^([0-9]|[1-5][0-9]) ([0-9]|1[0-9]|2[0-3]) \* \* (\*|[0-6])$/.exec(schedule.cronExpression);
  if (!match) throw new ScheduleError('invalid_schedule_configuration');
  return { minute: Number(match[1]), hour: Number(match[2]), weekday: match[3] === '*' ? null : Number(match[3]) };
}
function scheduleDue(schedule: ScheduleRecord, time: AutomaticScheduleTime, now: Date): boolean { const p = localParts(now); return schedule.enabled && time.minute === p.minute && time.hour === p.hour && (time.weekday === null || time.weekday === p.weekday); }
function scheduledInstant(now: Date): string { return new Date(Math.floor(now.getTime() / 60_000) * 60_000).toISOString(); }

/** Dispatcher only queues work; provider selection and generation are deliberately absent. */
export async function runSchedules(deps: ScheduleDependencies): Promise<QueuedJob[]> {
  const now = deps.now(); const jobs: QueuedJob[] = [];
  for (const schedule of await deps.listSchedules()) {
    if (!schedule.enabled) continue;
    const time = automaticScheduleTime(schedule);
    if (!time || !scheduleDue(schedule, time, now)) continue;
    const budget = await deps.budgetState(schedule.ownerId);
    if (budget === 'risk' || (budget === 'warning' && time.weekday !== null)) continue;
    jobs.push(await deps.insertQueuedJob({ ownerId: schedule.ownerId, scheduleKey: `${schedule.ownerId}:${schedule.scheduleKey}:${seoulDate(now)}`, scheduledFor: scheduledInstant(now), payload: { kind: schedule.payload.kind, source: 'schedule' } }));
  }
  return jobs;
}

export async function evaluateAccessTrigger(deps: ScheduleDependencies, authToken: string): Promise<QueuedJob> {
  const owner = await deps.authenticate(authToken); if (!owner) throw new ScheduleError('authentication_required');
  return deps.queueAccessJob(owner.ownerId, deps.now());
}

const noCorsPolicy = createCorsPolicy([]);

export function createScheduleHandler(deps: ScheduleDependencies, dispatchToken?: string, cors: CorsPolicy = noCorsPolicy): (request: Request) => Promise<Response> {
  return async (request) => {
    const gated = corsGate(request, cors);
    if (gated) return gated;
    const respond = (response: Response) => withCorsHeaders(request, response, cors);
    if (request.method !== 'POST') return respond(Response.json({ error: 'method_not_allowed' }, { status: 405 }));
    let body: { action?: unknown }; try { body = await request.json(); } catch { return respond(Response.json({ error: 'invalid_command' }, { status: 400 })); }
    if (body.action === 'dispatch') {
      if (!dispatchToken || request.headers.get('x-schedule-dispatch-token') !== dispatchToken) return respond(Response.json({ error: 'dispatch_not_authorized' }, { status: 401 }));
      try {
        const jobs = await runSchedules(deps); return respond(Response.json({ jobs }, { status: 202 }));
      } catch {
        return respond(Response.json({ error: 'internal_error' }, { status: 500 }));
      }
    }
    if (body.action !== 'access') return respond(Response.json({ error: 'invalid_command' }, { status: 400 }));
    const token = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
    try { return respond(Response.json(await evaluateAccessTrigger(deps, token), { status: 202 })); }
    catch (error) {
      const code = error instanceof ScheduleError ? error.code : 'internal_error';
      const status = code === 'authentication_required' ? 401 : ['access_interval_not_elapsed', 'daily_access_limit', 'budget_risk'].includes(code) ? 409 : 500;
      return respond(Response.json({ error: code }, { status }));
    }
  };
}

export interface SupabaseScheduleConfig { url: string; anonKey: string; serviceRoleKey: string; fetch?: typeof globalThis.fetch }
export function createSupabaseScheduleDependencies(config: SupabaseScheduleConfig, authToken: string): ScheduleDependencies {
  const request = config.fetch ?? globalThis.fetch;
  const userHeaders = { apikey: config.anonKey, authorization: `Bearer ${authToken}`, 'content-type': 'application/json' };
  const serviceHeaders = { apikey: config.serviceRoleKey, authorization: `Bearer ${config.serviceRoleKey}`, 'content-type': 'application/json' };
  const call = async (headers: Record<string, string>, path: string, init: RequestInit = {}): Promise<unknown> => {
    const response = await request(`${config.url}${path}`, { ...init, headers: { ...headers, ...init.headers } });
    const value = response.status === 204 ? null : await response.json();
    if (!response.ok) {
      if (path === '/auth/v1/user' && (response.status === 401 || response.status === 403)) throw new ScheduleError('authentication_required');
      const databaseCode = value && typeof value === 'object' && 'code' in value ? String((value as { code: unknown }).code) : '';
      const message = value && typeof value === 'object' && 'message' in value ? String((value as { message: unknown }).message) : '';
      if (databaseCode === 'P0001' && ['access_interval_not_elapsed', 'daily_access_limit', 'budget_risk'].includes(message)) throw new ScheduleError(message);
      throw new ScheduleError('persistence_failed');
    }
    return value;
  };
  const rpc = (name: string, body: Record<string, unknown>) => call(serviceHeaders, `/rest/v1/rpc/${name}`, { method: 'POST', body: JSON.stringify(body) });
  const queuedJob = (value: unknown, expectedOwnerId?: string): QueuedJob => {
    if (!value || typeof value !== 'object') throw new ScheduleError('invalid_queue_response');
    const record = value as Record<string, unknown>;
    if (typeof record.id !== 'string' || typeof record.owner_id !== 'string' || typeof record.schedule_key !== 'string' || typeof record.scheduled_for !== 'string' || !record.payload || typeof record.payload !== 'object') throw new ScheduleError('invalid_queue_response');
    const payload = record.payload as Record<string, unknown>;
    if ((payload.kind !== 'short_dialogue' && payload.kind !== 'daily_event') || (payload.source !== 'schedule' && payload.source !== 'access')
      || (expectedOwnerId && (record.owner_id !== expectedOwnerId || record.schedule_key !== `access:${expectedOwnerId}` || payload.kind !== 'short_dialogue' || payload.source !== 'access'))) throw new ScheduleError('invalid_queue_response');
    return { id: record.id, ownerId: record.owner_id, scheduleKey: record.schedule_key, scheduledFor: record.scheduled_for, payload: { kind: payload.kind, source: payload.source } };
  };
  return {
    now: () => new Date(),
    authenticate: async () => { const value = await call(userHeaders, '/auth/v1/user') as { id?: unknown }; return typeof value.id === 'string' ? { ownerId: value.id } : null; },
    listSchedules: async () => {
      const rows = await call(serviceHeaders, '/rest/v1/schedules?select=owner_id,schedule_key,schedule_type,cron_expression,enabled,payload') as unknown[];
      return rows.map((row) => {
        const value = row as Record<string, unknown>;
        if ((value.schedule_type !== 'automatic' && value.schedule_type !== 'manual') || (typeof value.cron_expression !== 'string' && value.cron_expression !== null)) throw new ScheduleError('invalid_schedule_configuration');
        return { ownerId: String(value.owner_id), scheduleKey: String(value.schedule_key), scheduleType: value.schedule_type, cronExpression: value.cron_expression, enabled: value.enabled === true, payload: value.payload as ScheduleRecord['payload'] };
      });
    },
    budgetState: async (ownerId) => String(await rpc('narrative_schedule_budget_state', { p_owner_id: ownerId })) as BudgetState,
    insertQueuedJob: async (job) => queuedJob(await rpc('queue_narrative_schedule_job', { p_owner_id: job.ownerId, p_schedule_key: job.scheduleKey, p_scheduled_for: job.scheduledFor, p_payload: job.payload })),
    queueAccessJob: async (ownerId, now) => queuedJob(await rpc('queue_narrative_access_job', { p_owner_id: ownerId, p_now: now.toISOString() }), ownerId),
  };
}

interface DenoRuntime { env: { get(name: string): string | undefined }; serve(handler: (request: Request) => Response | Promise<Response>): void }
declare const Deno: DenoRuntime;
if (typeof Deno !== 'undefined' && (import.meta as ImportMeta & { main?: boolean }).main) {
  const url = Deno.env.get('SUPABASE_URL'); const anonKey = Deno.env.get('SUPABASE_ANON_KEY'); const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'); const dispatchToken = Deno.env.get('NARRATIVE_SCHEDULE_DISPATCH_TOKEN');
  if (!url || !anonKey || !serviceRoleKey || !dispatchToken) throw new Error('schedule runtime settings are required');
  const cors = corsPolicyFromEnvironment(Deno.env.get('NARRATIVE_ADMIN_ORIGINS'));
  Deno.serve((request) => {
    const token = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
    return createScheduleHandler(createSupabaseScheduleDependencies({ url, anonKey, serviceRoleKey }, token), dispatchToken, cors)(request);
  });
}
