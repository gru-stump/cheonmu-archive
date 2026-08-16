import { spawn } from 'node:child_process';

const container = 'supabase_db_cheonmu-narrative';

function runPsql(sql, onStdout) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'docker',
      ['exec', '-i', container, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-v', 'ON_ERROR_STOP=1'],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );
    let stdout = '';
    let stderr = '';

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      onStdout?.(stdout);
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(sql);
  });
}

const setup = await runPsql(`
delete from auth.users where id = '70000000-0000-0000-0000-000000000001';
insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values (
  '00000000-0000-0000-0000-000000000000',
  '70000000-0000-0000-0000-000000000001',
  'authenticated', 'authenticated', 'budget-concurrency@local.invalid',
  '$2a$10$testfixturesonlynotarealcredential0000000000000000000000000',
  current_timestamp, '{"provider":"email","providers":["email"]}'::jsonb,
  '{}'::jsonb, current_timestamp, current_timestamp
);
insert into public.budget_periods (
  id, owner_id, currency, period_start, period_end, limit_micros, daily_limit_micros
) values (
  '71000000-0000-0000-0000-000000000001',
  '70000000-0000-0000-0000-000000000001',
  'USD',
  (current_timestamp at time zone 'Asia/Seoul')::date,
  (current_timestamp at time zone 'Asia/Seoul')::date,
  100,
  100
);
insert into public.generation_jobs (id, owner_id, schedule_key, scheduled_for)
values
  (
    '72000000-0000-0000-0000-000000000001',
    '70000000-0000-0000-0000-000000000001',
    'concurrency-first', current_timestamp
  ),
  (
    '72000000-0000-0000-0000-000000000002',
    '70000000-0000-0000-0000-000000000001',
    'concurrency-second', current_timestamp + interval '1 second'
  );
`);

if (setup.code !== 0) {
  throw new Error(`concurrency setup failed\n${setup.stdout}\n${setup.stderr}`);
}

let launchSecond;
const firstReserved = new Promise((resolve) => {
  launchSecond = resolve;
});

const first = runPsql(
  `
begin;
select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;
select public.reserve_generation_budget('72000000-0000-0000-0000-000000000001', 60);
\\echo FIRST_RESERVED
select pg_sleep(2);
commit;
`,
  (stdout) => {
    if (stdout.includes('FIRST_RESERVED')) {
      launchSecond();
    }
  },
);

await Promise.race([
  firstReserved,
  first.then((result) => {
    if (result.code !== 0) {
      throw new Error(`first reservation failed before acquiring the period lock\n${result.stdout}\n${result.stderr}`);
    }
    throw new Error('first reservation exited before reporting that it acquired the period lock');
  }),
]);

const second = runPsql(`
begin;
select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;
select public.reserve_generation_budget('72000000-0000-0000-0000-000000000002', 50);
commit;
`);

const [firstResult, secondResult] = await Promise.all([first, second]);

if (firstResult.code !== 0) {
  throw new Error(`first reservation failed\n${firstResult.stdout}\n${firstResult.stderr}`);
}
if (secondResult.code === 0 || !secondResult.stderr.includes('budget_limit_exceeded')) {
  throw new Error(`second reservation did not fail at the shared cap\n${secondResult.stdout}\n${secondResult.stderr}`);
}

const verification = await runPsql(`
select concat(
  count(*) filter (where generation_job_id = '72000000-0000-0000-0000-000000000001'),
  ',',
  count(*) filter (where generation_job_id = '72000000-0000-0000-0000-000000000002'),
  ',',
  sum(amount_micros)
)
from public.budget_entries
where budget_period_id = '71000000-0000-0000-0000-000000000001';
`);

if (verification.code !== 0 || !verification.stdout.includes('1,0,60')) {
  throw new Error(`unexpected concurrent ledger state\n${verification.stdout}\n${verification.stderr}`);
}

console.log('PASS: concurrent reservations serialize on the shared period row; 60 succeeds and 50 is rejected.');
