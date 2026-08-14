import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const container = 'supabase_db_cheonmu-narrative';
const ownerId = randomUUID();
const periodId = randomUUID();

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
insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values (
  '00000000-0000-0000-0000-000000000000', '${ownerId}', 'authenticated', 'authenticated',
  'access-concurrency-${ownerId}@local.invalid', '$2a$10$testfixturesonlynotarealcredential0000000000000000000000000',
  current_timestamp, '{"provider":"email","providers":["email"]}'::jsonb, '{}', current_timestamp, current_timestamp
);
insert into public.budget_periods (id, owner_id, currency, period_start, period_end, limit_micros, daily_limit_micros)
values ('${periodId}', '${ownerId}', 'USD', '2026-08-01', '2026-08-31', 100, 100);
`);
if (setup.code !== 0) throw new Error(`access concurrency setup failed\n${setup.stdout}\n${setup.stderr}`);

const call = `select (public.queue_narrative_access_job('${ownerId}', '2026-08-14T16:30:00Z')).id;`;
let releaseSecond;
const firstQueued = new Promise((resolve) => { releaseSecond = resolve; });
const first = runPsql(`
begin;
select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;
${call}
\\echo FIRST_QUEUED
select pg_sleep(2);
commit;
`, (stdout) => { if (stdout.includes('FIRST_QUEUED')) releaseSecond(); });

await Promise.race([
  firstQueued,
  first.then((result) => {
    if (result.code !== 0) throw new Error(`first access call failed before holding its owner lock\n${result.stdout}\n${result.stderr}`);
    throw new Error('first access call exited before reporting its queued row');
  }),
]);

const second = runPsql(`
begin;
select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;
${call}
commit;
`);
const [firstResult, secondResult] = await Promise.all([first, second]);
if (firstResult.code !== 0) throw new Error(`first access transaction failed\n${firstResult.stdout}\n${firstResult.stderr}`);
if (secondResult.code !== 0) throw new Error(`second access transaction failed\n${secondResult.stdout}\n${secondResult.stderr}`);

const uuidPattern = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const firstJobId = firstResult.stdout.match(uuidPattern)?.[0];
const secondJobId = secondResult.stdout.match(uuidPattern)?.[0];
if (!firstJobId || firstJobId !== secondJobId) {
  throw new Error(`concurrent access calls did not return the same persisted row\nfirst:\n${firstResult.stdout}\nsecond:\n${secondResult.stdout}`);
}

const verification = await runPsql(`
select count(*) from public.generation_jobs
where owner_id = '${ownerId}' and schedule_key = 'access:${ownerId}';
`);
if (verification.code !== 0 || !/^\s*1\s*$/m.test(verification.stdout)) {
  throw new Error(`concurrent access created more than one row\n${verification.stdout}\n${verification.stderr}`);
}
console.log('PASS: concurrent authenticated access calls serialize by owner and return one persisted job.');
