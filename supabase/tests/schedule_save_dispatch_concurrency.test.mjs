import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const container = 'supabase_db_cheonmu-narrative';
const ownerId = '10000000-0000-0000-0000-000000000001';
const scheduleId = randomUUID();
const scheduleKey = `save-dispatch-${randomUUID()}`;
const dispatchApplication = `dispatch-${randomUUID()}`;
const saveApplication = `save-${randomUUID()}`;
const target = new Date(Date.now() + 60_000);
target.setUTCSeconds(0, 0);
const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
}).formatToParts(target).map((part) => [part.type, part.value]));
const specialDate = `${parts.year}-${parts.month}-${parts.day}`;
const seoulTime = `${parts.hour}:${parts.minute}`;
const scheduledFor = target.toISOString();

function runPsql(sql, onStdout) {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', ['exec', '-i', container, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; onStdout?.(stdout); });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(sql);
  });
}

async function waitForLock(applicationName) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const result = await runPsql(`select count(*) from pg_stat_activity where application_name = '${applicationName}' and wait_event_type = 'Lock';`);
    if (result.code === 0 && result.stdout.trim() === '1') return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`${applicationName} did not reach its expected lock wait`);
}

let primaryError;
try {
  const setup = await runPsql(`
update public.narrative_admin_settings set schedule_automation_enabled = true where owner_id = '${ownerId}';
insert into public.schedules (id, owner_id, schedule_key, schedule_type, cron_expression, enabled, payload, special_date, seoul_time, minimum_interval_minutes)
values ('${scheduleId}', '${ownerId}', '${scheduleKey}', 'special', null, true, '{"kind":"short_dialogue"}', '${specialDate}', '${seoulTime}', 60);
`);
  if (setup.code !== 0) throw new Error(`schedule save/dispatch setup failed\n${setup.stdout}\n${setup.stderr}`);

  let providerLockedResolve;
  const providerLocked = new Promise((resolve) => { providerLockedResolve = resolve; });
  const blocker = runPsql(`
begin;
select 1 from public.provider_settings where owner_id = '${ownerId}' and enabled for update;
\\echo PROVIDER_LOCKED
select pg_sleep(5);
commit;
`, (stdout) => { if (stdout.includes('PROVIDER_LOCKED')) providerLockedResolve(); });
  await Promise.race([
    providerLocked,
    blocker.then((result) => { throw new Error(`provider blocker exited before announcing its lock\n${result.stdout}\n${result.stderr}`); }),
  ]);

  const dispatch = runPsql(`
set application_name = '${dispatchApplication}';
set statement_timeout = '10s';
begin;
select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;
select id from public.queue_due_narrative_schedule_job('${ownerId}', '${scheduleId}', '${scheduledFor}');
commit;
`);
  await waitForLock(dispatchApplication);

  const save = runPsql(`
set application_name = '${saveApplication}';
set statement_timeout = '10s';
begin;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', '${ownerId}', true);
set local role authenticated;
select public.save_narrative_schedule('${scheduleId}', '${scheduleKey}', 'special', true, '${seoulTime}', null, '${specialDate}', 60, 'short_dialogue');
commit;
`);
  await waitForLock(saveApplication);

  const [blockerResult, dispatchResult, saveResult] = await Promise.all([blocker, dispatch, save]);
  if (blockerResult.code !== 0) throw new Error(`provider blocker failed\n${blockerResult.stdout}\n${blockerResult.stderr}`);
  if (dispatchResult.code !== 0) throw new Error(`dispatch deadlocked or failed\n${dispatchResult.stdout}\n${dispatchResult.stderr}`);
  if (saveResult.code !== 0) throw new Error(`schedule save deadlocked or failed\n${saveResult.stdout}\n${saveResult.stderr}`);

  const verification = await runPsql(`
select concat(schedule.enabled, '|', schedule.special_date, '|', to_char(schedule.seoul_time, 'HH24:MI'), '|', count(job.id))
from public.schedules as schedule
left join public.generation_jobs as job on job.owner_id = schedule.owner_id and split_part(job.schedule_key, ':', 2) = schedule.schedule_key
where schedule.id = '${scheduleId}'
group by schedule.enabled, schedule.special_date, schedule.seoul_time;
`);
  if (verification.code !== 0 || !verification.stdout.includes(`t|${specialDate}|${seoulTime}|1`)) {
    throw new Error(`schedule save/dispatch committed an invalid result\n${verification.stdout}\n${verification.stderr}`);
  }
} catch (error) {
  primaryError = error;
} finally {
  const cleanup = await runPsql(`
delete from public.generation_jobs where owner_id = '${ownerId}' and split_part(schedule_key, ':', 2) = '${scheduleKey}';
delete from public.schedules where id = '${scheduleId}';
update public.narrative_admin_settings set schedule_automation_enabled = false where owner_id = '${ownerId}';
`);
  if (cleanup.code !== 0) primaryError = new AggregateError([primaryError, new Error(`schedule save/dispatch cleanup failed\n${cleanup.stdout}\n${cleanup.stderr}`)].filter(Boolean));
}

if (primaryError) throw primaryError;
console.log('PASS: schedule save waits behind dispatch schedule ownership; both commit without deadlock and persist one queued job.');
