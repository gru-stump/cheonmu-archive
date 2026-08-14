export type BudgetState = 'normal' | 'warning' | 'risk';
export interface QueuedJob { id?: string; ownerId: string; scheduleKey: string; scheduledFor: string; payload: { kind: 'short_dialogue' | 'daily_event'; source: 'schedule' | 'access' } }
export interface ScheduleRecord { ownerId: string; scheduleKey: string; cronExpression: string; enabled: boolean; payload: { kind: 'short_dialogue' | 'daily_event' } }
export interface ScheduleDependencies {
  now(): Date; authenticate(token: string): Promise<{ ownerId: string } | null>; listSchedules(): Promise<ScheduleRecord[]>; budgetState(ownerId: string): Promise<BudgetState>;
  insertQueuedJob(job: Omit<QueuedJob, 'id'>): Promise<QueuedJob>; queueAccessJob(ownerId: string, now: Date): Promise<QueuedJob>;
}
export class ScheduleError extends Error { constructor(public readonly code: string) { super(code); this.name = 'ScheduleError'; } }

function seoulDate(now: Date): string { return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now); }
function localParts(now: Date): Record<string, number> { return Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Seoul', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now).filter(({ type }) => type !== 'literal').map(({ type, value }) => [type, type === 'weekday' ? ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].indexOf(value) : Number(value)])); }
function cronField(field: string, value: number): boolean { return field === '*' || field.split(',').some((part) => part === String(value)); }
function cronParts(expression: string): string[] | null { const parts = expression.trim().split(/\s+/); return parts.length === 5 ? parts : null; }
function scheduleDue(schedule: ScheduleRecord, now: Date): boolean { const parts = cronParts(schedule.cronExpression); if (!schedule.enabled || !parts) return false; const p = localParts(now); return cronField(parts[0], p.minute) && cronField(parts[1], p.hour) && cronField(parts[4], p.weekday); }
function weekly(schedule: ScheduleRecord): boolean { const parts = cronParts(schedule.cronExpression); return Boolean(parts && parts[4] !== '*'); }
function scheduledInstant(now: Date): string { return new Date(Math.floor(now.getTime() / 60_000) * 60_000).toISOString(); }

/** Dispatcher only queues work; provider selection and generation are deliberately absent. */
export async function runSchedules(deps: ScheduleDependencies): Promise<QueuedJob[]> {
  const now = deps.now(); const jobs: QueuedJob[] = [];
  for (const schedule of await deps.listSchedules()) {
    if (!scheduleDue(schedule, now)) continue;
    const budget = await deps.budgetState(schedule.ownerId);
    if (budget === 'risk' || (budget === 'warning' && weekly(schedule))) continue;
    jobs.push(await deps.insertQueuedJob({ ownerId: schedule.ownerId, scheduleKey: `${schedule.ownerId}:${schedule.scheduleKey}:${seoulDate(now)}`, scheduledFor: scheduledInstant(now), payload: { kind: schedule.payload.kind, source: 'schedule' } }));
  }
  return jobs;
}

export async function evaluateAccessTrigger(deps: ScheduleDependencies, authToken: string): Promise<QueuedJob> {
  const owner = await deps.authenticate(authToken); if (!owner) throw new ScheduleError('authentication_required');
  return deps.queueAccessJob(owner.ownerId, deps.now());
}

export function createScheduleHandler(deps: ScheduleDependencies, dispatchToken?: string): (request: Request) => Promise<Response> {
  return async (request) => {
    if (request.method !== 'POST') return Response.json({ error: 'method_not_allowed' }, { status: 405 });
    let body: { action?: unknown }; try { body = await request.json(); } catch { return Response.json({ error: 'invalid_command' }, { status: 400 }); }
    if (body.action === 'dispatch') {
      if (!dispatchToken || request.headers.get('x-schedule-dispatch-token') !== dispatchToken) return Response.json({ error: 'dispatch_not_authorized' }, { status: 401 });
      const jobs = await runSchedules(deps); return Response.json({ jobs }, { status: 202 });
    }
    if (body.action !== 'access') return Response.json({ error: 'invalid_command' }, { status: 400 });
    const token = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
    try { return Response.json(await evaluateAccessTrigger(deps, token), { status: 202 }); }
    catch (error) {
      const code = error instanceof ScheduleError ? error.code : 'internal_error';
      const status = code === 'authentication_required' ? 401 : ['access_interval_not_elapsed', 'daily_access_limit', 'budget_risk'].includes(code) ? 409 : 500;
      return Response.json({ error: code }, { status });
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
      const rows = await call(serviceHeaders, '/rest/v1/schedules?select=owner_id,schedule_key,cron_expression,enabled,payload') as unknown[];
      return rows.map((row) => { const value = row as Record<string, unknown>; return { ownerId: String(value.owner_id), scheduleKey: String(value.schedule_key), cronExpression: String(value.cron_expression), enabled: value.enabled === true, payload: value.payload as ScheduleRecord['payload'] }; });
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
  Deno.serve((request) => {
    const token = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
    return createScheduleHandler(createSupabaseScheduleDependencies({ url, anonKey, serviceRoleKey }, token), dispatchToken)(request);
  });
}
