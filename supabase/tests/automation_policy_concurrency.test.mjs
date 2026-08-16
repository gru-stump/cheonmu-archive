import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const container = 'supabase_db_cheonmu-narrative';
const ownerId = '10000000-0000-0000-0000-000000000001';
const providerId = '12000000-0000-0000-0000-000000000001';
const policyDraft = randomUUID();
const policyJob = randomUUID();
const policyToken = randomUUID();
const quotaDraftA = randomUUID();
const quotaDraftB = randomUUID();
const quotaJobA = randomUUID();
const quotaJobB = randomUUID();
const quotaTokenA = randomUUID();
const quotaTokenB = randomUUID();

function runPsql(sql, onStdout) {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', ['exec', '-i', container, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1'], { stdio: ['pipe', 'pipe', 'pipe'] });
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

function failure(label, result) {
  return new Error(`${label} (exit ${String(result.code)})\n${result.stdout}\n${result.stderr}`);
}

const setup = await runPsql(`
update public.provider_settings
set enabled = true, pricing_verified_at = public.narrative_business_date(now()), fixed_cost_micros = 1
where id = '${providerId}';
update public.narrative_admin_settings
set manual_generation_enabled = true, schedule_automation_enabled = false,
    manual_call_limit = 1, pricing_valid_days = 30
where owner_id = '${ownerId}';
update public.budget_periods
set period_start = public.narrative_business_date(now()) - 1,
    period_end = public.narrative_business_date(now()) + 30,
    limit_micros = 100000000, daily_limit_micros = 100000000
where owner_id = '${ownerId}';
insert into public.drafts (id, owner_id, kind, title) values
  ('${policyDraft}', '${ownerId}', 'daily_event', 'policy race'),
  ('${quotaDraftA}', '${ownerId}', 'daily_event', 'quota race A'),
  ('${quotaDraftB}', '${ownerId}', 'daily_event', 'quota race B');
insert into public.generation_jobs (
  id, owner_id, draft_id, schedule_key, scheduled_for, payload, idempotency_key,
  provider_setting_id, worst_case_cost_micros, attempt_token
) values
  ('${policyJob}', '${ownerId}', '${policyDraft}', 'policy-race', now(), '{"source":"manual"}', '${policyJob}', '${providerId}', 1, '${policyToken}'),
  ('${quotaJobA}', '${ownerId}', '${quotaDraftA}', 'quota-race-a', now(), '{"source":"manual"}', '${quotaJobA}', '${providerId}', 1, '${quotaTokenA}'),
  ('${quotaJobB}', '${ownerId}', '${quotaDraftB}', 'quota-race-b', now(), '{"source":"manual"}', '${quotaJobB}', '${providerId}', 1, '${quotaTokenB}');
`);
if (setup.code !== 0) throw failure('automation policy race setup failed', setup);

let signalSettingsLocked;
const settingsLocked = new Promise((resolve) => { signalSettingsLocked = resolve; });
const save = runPsql(`
begin;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', '${ownerId}', true);
set local role authenticated;
select public.save_narrative_settings(false, false, 'fake-local-provider', '[]', 100000000, 100000000, 1, 80, 95, 1350, 30);
\\echo SETTINGS_LOCKED
select pg_sleep(2);
commit;
`, (stdout) => { if (stdout.includes('SETTINGS_LOCKED')) signalSettingsLocked(); });

await Promise.race([
  settingsLocked,
  save.then((result) => { throw failure('settings save exited before holding its locks', result); }),
]);
const reserveAgainstDisabledPolicy = runPsql(`
begin;
select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;
select public.reserve_and_start_generation('${policyJob}', '${policyToken}', 1);
commit;
`);
const [saveResult, disabledResult] = await Promise.all([save, reserveAgainstDisabledPolicy]);
if (saveResult.code !== 0) throw failure('settings-save side of policy race failed', saveResult);
if (disabledResult.code === 0 || !`${disabledResult.stdout}\n${disabledResult.stderr}`.includes('manual_generation_disabled')) {
  throw failure('reservation did not observe the committed manual-off policy', disabledResult);
}
const policyState = await runPsql(`select concat(
  (select manual_generation_enabled from public.narrative_admin_settings where owner_id = '${ownerId}'), '|',
  (select enabled from public.provider_settings where id = '${providerId}'), '|',
  (select status from public.generation_jobs where id = '${policyJob}'), '|',
  (select count(*) from public.budget_entries where generation_job_id = '${policyJob}')
);`);
if (policyState.code !== 0 || policyState.stdout.trim() !== 'f|t|queued|0') {
  throw failure('manual-off race did not preserve provider selection and reject atomically', policyState);
}

const enableManual = await runPsql(`
update public.narrative_admin_settings
set manual_generation_enabled = true, schedule_automation_enabled = false, manual_call_limit = 1
where owner_id = '${ownerId}';
`);
if (enableManual.code !== 0) throw failure('manual quota race setup failed', enableManual);

let signalFirstReserved;
const firstReserved = new Promise((resolve) => { signalFirstReserved = resolve; });
const first = runPsql(`
begin;
select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;
select public.reserve_and_start_generation('${quotaJobA}', '${quotaTokenA}', 1);
\\echo FIRST_RESERVED
select pg_sleep(2);
commit;
`, (stdout) => { if (stdout.includes('FIRST_RESERVED')) signalFirstReserved(); });

await Promise.race([
  firstReserved,
  first.then((result) => { throw failure('first quota reservation exited before holding its budget lock', result); }),
]);
const second = runPsql(`
begin;
select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;
select public.reserve_and_start_generation('${quotaJobB}', '${quotaTokenB}', 1);
commit;
`);
const [firstResult, secondResult] = await Promise.all([first, second]);
if (firstResult.code !== 0 || !firstResult.stdout.includes('"status": "reserved"')) throw failure('first quota reservation failed', firstResult);
if (secondResult.code === 0 || !`${secondResult.stdout}\n${secondResult.stderr}`.includes('manual_call_limit_reached')) {
  throw failure('second concurrent manual reservation exceeded the daily quota', secondResult);
}
const quotaState = await runPsql(`select concat(
  (select count(*) from public.budget_entries where generation_job_id in ('${quotaJobA}', '${quotaJobB}') and entry_type = 'reservation'), '|',
  (select count(*) from public.generation_jobs where id in ('${quotaJobA}', '${quotaJobB}') and status = 'running'), '|',
  (select count(*) from public.generation_jobs where id in ('${quotaJobA}', '${quotaJobB}') and status = 'queued')
);`);
if (quotaState.code !== 0 || quotaState.stdout.trim() !== '1|1|1') {
  throw failure('manual quota race was not serialized atomically', quotaState);
}

const cleanup = await runPsql(`
delete from public.budget_entries where generation_job_id in ('${policyJob}', '${quotaJobA}', '${quotaJobB}');
delete from public.generation_jobs where id in ('${policyJob}', '${quotaJobA}', '${quotaJobB}');
delete from public.drafts where id in ('${policyDraft}', '${quotaDraftA}', '${quotaDraftB}');
update public.narrative_admin_settings
set manual_generation_enabled = true, schedule_automation_enabled = false, manual_call_limit = 3
where owner_id = '${ownerId}';
`);
if (cleanup.code !== 0) throw failure('automation policy race cleanup failed', cleanup);
console.log('PASS: settings-save/manual-reservation and two-connection manual-quota races serialize; provider selection stays independent and only one quota reservation commits.');
