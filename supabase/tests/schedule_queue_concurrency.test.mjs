import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const container = 'supabase_db_cheonmu-narrative';
const scheduleKey = `schedule-race-${randomUUID()}`;
const scheduleId = randomUUID();
const scheduledFor = '2026-08-14T17:00:00Z';
const persistedScheduleKey = `10000000-0000-0000-0000-000000000001:${scheduleKey}:2026-08-15`;

function runPsql(sql, onStdout) {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', ['exec', '-i', container, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-v', 'ON_ERROR_STOP=1'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; onStdout?.(stdout); });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(sql);
  });
}

const setup = await runPsql(`
insert into public.schedules (
  id, owner_id, schedule_key, schedule_type, cron_expression, enabled, payload,
  seoul_time, minimum_interval_minutes
) values (
  '${scheduleId}', '10000000-0000-0000-0000-000000000001', '${scheduleKey}',
  'automatic', '0 2 * * *', true, '{"kind":"daily_event"}'::jsonb, '02:00', 60
);
`);
if (setup.code !== 0) throw new Error(`schedule race fixture setup failed\n${setup.stdout}\n${setup.stderr}`);

const queueCall = `select (public.queue_due_narrative_schedule_job(
  '10000000-0000-0000-0000-000000000001', '${scheduleId}', '${scheduledFor}'
)).id;`;

let releaseSecond;
const firstQueued = new Promise((resolve) => { releaseSecond = resolve; });
const first = runPsql(`
begin;
select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;
${queueCall}
\\echo FIRST_SCHEDULE_QUEUED
select pg_sleep(2);
commit;
`, (stdout) => { if (stdout.includes('FIRST_SCHEDULE_QUEUED')) releaseSecond(); });

await Promise.race([
  firstQueued,
  first.then((result) => {
    if (result.code !== 0) throw new Error(`first schedule queue failed before holding its unique-key transaction\n${result.stdout}\n${result.stderr}`);
    throw new Error('first schedule queue exited before reporting its row');
  }),
]);

const second = runPsql(`
begin;
select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;
${queueCall}
commit;
`);
const [firstResult, secondResult] = await Promise.all([first, second]);
if (firstResult.code !== 0) throw new Error(`first schedule transaction failed\n${firstResult.stdout}\n${firstResult.stderr}`);
if (secondResult.code !== 0) throw new Error(`second schedule transaction failed\n${secondResult.stdout}\n${secondResult.stderr}`);

const uuidPattern = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const firstJobId = firstResult.stdout.match(uuidPattern)?.[0];
const secondJobId = secondResult.stdout.match(uuidPattern)?.[0];
if (!firstJobId || firstJobId !== secondJobId) {
  throw new Error(`schedule race did not return the same persisted row\nfirst:\n${firstResult.stdout}\nsecond:\n${secondResult.stdout}`);
}

const verification = await runPsql(`
select concat(count(*), ',', min(id::text), ',', max(id::text))
from public.generation_jobs
where schedule_key = '${persistedScheduleKey}' and scheduled_for = '${scheduledFor}';
`);
if (verification.code !== 0 || !verification.stdout.includes(`1,${firstJobId},${firstJobId}`)) {
  throw new Error(`schedule race persisted an invalid result\n${verification.stdout}\n${verification.stderr}`);
}
const cleanup = await runPsql(`
delete from public.generation_jobs
where schedule_key = '${persistedScheduleKey}' and scheduled_for = '${scheduledFor}';
delete from public.schedules where id = '${scheduleId}';
`);
if (cleanup.code !== 0) throw new Error(`schedule race fixture cleanup failed\n${cleanup.stdout}\n${cleanup.stderr}`);
console.log('PASS: atomic due-schedule queue race returns one identical persisted row from both connections.');
