export type BudgetState = 'normal' | 'warning' | 'risk';
export interface QueuedJob { id?: string; ownerId: string; scheduleKey: string; scheduledFor: string; payload: { kind: 'short_dialogue' | 'daily_event'; source: 'schedule' | 'access' } }
export interface ScheduleRecord { ownerId: string; scheduleKey: string; cronExpression: string; enabled: boolean; payload: { kind: 'short_dialogue' | 'daily_event' } }
export interface AccessEligibility { lastSuccessAt: string | null; nextAllowedAt: string | null; dailyCallCount: number; budgetState: BudgetState }
export interface ScheduleDependencies {
  now(): Date; authenticate(token: string): Promise<{ ownerId: string } | null>; listSchedules(): Promise<ScheduleRecord[]>; budgetState(ownerId: string): Promise<BudgetState>;
  insertQueuedJob(job: Omit<QueuedJob, 'id'>): Promise<QueuedJob>; recentAccessJob(ownerId: string): Promise<QueuedJob | null>; accessEligibility(ownerId: string): Promise<AccessEligibility>; accessDailyCallLimit?: number;
}
export class ScheduleError extends Error { constructor(public readonly code: string) { super(code); this.name = 'ScheduleError'; } }

function seoulDate(now: Date): string { return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now); }
function seoulDayStart(now: Date): string { const [month, day, year] = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now).filter(({ type }) => type !== 'literal').map(({ value }) => value); return new Date(`${year}-${month}-${day}T00:00:00+09:00`).toISOString(); }
function scheduleDue(schedule: ScheduleRecord): boolean { return schedule.enabled && schedule.cronExpression !== 'manual'; }

/** Dispatcher only queues work; provider selection and generation are deliberately absent. */
export async function runSchedules(deps: ScheduleDependencies): Promise<QueuedJob[]> {
  const now = deps.now(); const jobs: QueuedJob[] = [];
  for (const schedule of await deps.listSchedules()) {
    if (!scheduleDue(schedule)) continue;
    const budget = await deps.budgetState(schedule.ownerId);
    if (budget === 'risk' || (budget === 'warning' && schedule.cronExpression === 'weekly')) continue;
    jobs.push(await deps.insertQueuedJob({ ownerId: schedule.ownerId, scheduleKey: `${schedule.ownerId}:${schedule.scheduleKey}:${seoulDate(now)}`, scheduledFor: seoulDayStart(now), payload: { kind: schedule.payload.kind, source: 'schedule' } }));
  }
  return jobs;
}

export async function evaluateAccessTrigger(deps: ScheduleDependencies, authToken: string): Promise<QueuedJob> {
  const owner = await deps.authenticate(authToken); if (!owner) throw new ScheduleError('authentication_required');
  const recent = await deps.recentAccessJob(owner.ownerId); if (recent) return recent;
  const eligibility = await deps.accessEligibility(owner.ownerId); const now = deps.now();
  if (eligibility.budgetState === 'risk') throw new ScheduleError('budget_risk');
  if (eligibility.dailyCallCount >= (deps.accessDailyCallLimit ?? 1)) throw new ScheduleError('daily_access_limit');
  if (eligibility.nextAllowedAt && new Date(eligibility.nextAllowedAt).getTime() > now.getTime()) throw new ScheduleError('access_interval_not_elapsed');
  const scheduledFor = eligibility.nextAllowedAt ?? seoulDayStart(now);
  return deps.insertQueuedJob({ ownerId: owner.ownerId, scheduleKey: `access:${owner.ownerId}`, scheduledFor, payload: { kind: 'short_dialogue', source: 'access' } });
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
      return Response.json({ error: code }, { status: code === 'authentication_required' ? 401 : 409 });
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
    if (!response.ok) throw new ScheduleError('persistence_failed');
    return response.status === 204 ? null : response.json();
  };
  const rpc = (name: string, body: Record<string, unknown>) => call(serviceHeaders, `/rest/v1/rpc/${name}`, { method: 'POST', body: JSON.stringify(body) });
  return {
    now: () => new Date(),
    authenticate: async () => { const value = await call(userHeaders, '/auth/v1/user') as { id?: unknown }; return typeof value.id === 'string' ? { ownerId: value.id } : null; },
    listSchedules: async () => {
      const rows = await call(serviceHeaders, '/rest/v1/schedules?select=owner_id,schedule_key,cron_expression,enabled,payload') as unknown[];
      return rows.map((row) => { const value = row as Record<string, unknown>; return { ownerId: String(value.owner_id), scheduleKey: String(value.schedule_key), cronExpression: String(value.cron_expression), enabled: value.enabled === true, payload: value.payload as ScheduleRecord['payload'] }; });
    },
    budgetState: async (ownerId) => String(await rpc('narrative_schedule_budget_state', { p_owner_id: ownerId })) as BudgetState,
    insertQueuedJob: async (job) => {
      const value = await rpc('queue_narrative_schedule_job', { p_owner_id: job.ownerId, p_schedule_key: job.scheduleKey, p_scheduled_for: job.scheduledFor, p_payload: job.payload }) as Record<string, unknown>;
      return { ...job, id: typeof value.id === 'string' ? value.id : undefined };
    },
    recentAccessJob: async (ownerId) => {
      const value = await rpc('recent_narrative_access_job', { p_owner_id: ownerId }) as Record<string, unknown> | null;
      return value?.id ? { id: String(value.id), ownerId, scheduleKey: String(value.schedule_key), scheduledFor: String(value.scheduled_for), payload: value.payload as QueuedJob['payload'] } : null;
    },
    accessEligibility: async (ownerId) => {
      const value = await rpc('narrative_access_eligibility', { p_owner_id: ownerId }) as Record<string, unknown>;
      return { lastSuccessAt: typeof value.last_success_at === 'string' ? value.last_success_at : null, nextAllowedAt: typeof value.next_allowed_at === 'string' ? value.next_allowed_at : null, dailyCallCount: Number(value.daily_call_count ?? 0), budgetState: String(value.budget_state ?? 'risk') as BudgetState };
    },
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
