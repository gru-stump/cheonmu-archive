import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const container = 'supabase_db_cheonmu-narrative';
const ownerId = randomUUID();
const profileId = randomUUID();
const providerId = randomUUID();
const periodId = randomUUID();
const deleteRaceJobId = randomUUID();
const cancelRaceJobId = randomUUID();
const claimToken = randomUUID();

function runPsql(sql, onStdout) {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', ['exec', '-i', container, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1'], {
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    });
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

function assertSuccess(result, label) {
  if (result.code !== 0) throw new Error(`${label}\n${result.stdout}\n${result.stderr}`);
}

const setup = await runPsql(`
insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values (
  '00000000-0000-0000-0000-000000000000', '${ownerId}', 'authenticated', 'authenticated',
  'plain-language-${ownerId}@local.invalid', '$2a$10$testfixturesonlynotarealcredential0000000000000000000000000',
  current_timestamp, '{"provider":"email","providers":["email"]}'::jsonb, '{}', current_timestamp, current_timestamp
);
insert into public.owner_profiles (id, owner_id, display_name)
values ('${profileId}', '${ownerId}', 'Plain language race fixture');
insert into public.provider_settings (
  id, owner_id, provider_key, enabled, configuration, model_key,
  max_input_tokens, max_output_tokens, max_revision_output_tokens,
  input_cost_micros_per_million, output_cost_micros_per_million, fixed_cost_micros,
  pricing_verified_at
) values (
  '${providerId}', '${ownerId}', 'openai', true,
  '{"vaultSecretName":"narrative_${ownerId}_openai"}', 'gpt-5-mini',
  4000, 4000, 2000, 250000, 2000000, 0, public.narrative_business_date(current_timestamp)
);
insert into public.budget_periods (
  id, owner_id, currency, period_start, period_end, limit_micros, daily_limit_micros
) values (
  '${periodId}', '${ownerId}', 'USD',
  date_trunc('month', public.narrative_business_date(current_timestamp))::date,
  (date_trunc('month', public.narrative_business_date(current_timestamp)) + interval '1 month - 1 day')::date,
  100000000, 100000000
);
insert into public.narrative_admin_settings (
  owner_id, manual_generation_enabled, schedule_automation_enabled
) values ('${ownerId}', true, true);
select vault.create_secret('fixture-value', 'narrative_${ownerId}_openai', 'plain language race fixture');
insert into public.generation_jobs (id, owner_id, schedule_key, scheduled_for, payload)
values ('${deleteRaceJobId}', '${ownerId}', 'plain-language-delete-race', clock_timestamp() - interval '1 minute',
  '{"source":"schedule","kind":"daily_event","budgetPolicy":"block_at_risk"}');
`);
assertSuccess(setup, 'plain-language race setup failed');

let releaseClaim;
const deletionApplied = new Promise((resolve) => { releaseClaim = resolve; });
const deletion = runPsql(`
begin;
set local statement_timeout = '10s';
select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;
select public.delete_narrative_secret('${ownerId}', 'openai');
\\echo SECRET_DELETED_UNCOMMITTED
select pg_sleep(2);
commit;
`, (stdout) => { if (stdout.includes('SECRET_DELETED_UNCOMMITTED')) releaseClaim(); });

await Promise.race([
  deletionApplied,
  deletion.then((result) => {
    assertSuccess(result, 'secret deletion exited before holding its locks');
    throw new Error('secret deletion did not report its transaction barrier');
  }),
]);

const competingClaim = runPsql(`
begin;
set local statement_timeout = '10s';
select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;
select public.claim_generation_worker_job('${claimToken}');
commit;
`);
const [deleteResult, claimResult] = await Promise.all([deletion, competingClaim]);
assertSuccess(deleteResult, 'secret deletion deadlocked or failed');
assertSuccess(claimResult, 'worker claim deadlocked or failed');

const deleteVerification = await runPsql(`
select concat_ws('|', provider.enabled, settings.manual_generation_enabled,
  settings.schedule_automation_enabled, job.status, coalesce(job.worker_failure_code, 'none'))
from public.provider_settings as provider
join public.narrative_admin_settings as settings on settings.owner_id = provider.owner_id
join public.generation_jobs as job on job.owner_id = provider.owner_id and job.id = '${deleteRaceJobId}'
where provider.id = '${providerId}';
`);
assertSuccess(deleteVerification, 'secret deletion race verification failed');
if (deleteVerification.stdout.trim() !== 'f|f|f|failed|worker_provider_changed') {
  throw new Error(`delete/claim race did not fail closed after deletion\n${deleteVerification.stdout}`);
}

const resetForCancel = await runPsql(`
update public.provider_settings set enabled = true where id = '${providerId}';
update public.narrative_admin_settings set manual_generation_enabled = true, schedule_automation_enabled = true
where owner_id = '${ownerId}';
insert into public.generation_jobs (id, owner_id, schedule_key, scheduled_for, payload)
values ('${cancelRaceJobId}', '${ownerId}', 'plain-language-cancel-race', clock_timestamp() - interval '1 minute',
  '{"source":"schedule","kind":"daily_event","budgetPolicy":"block_at_risk"}');
`);
assertSuccess(resetForCancel, 'cancel race setup failed');

let releaseSecondClaim;
const cancellationApplied = new Promise((resolve) => { releaseSecondClaim = resolve; });
const cancellation = runPsql(`
begin;
set local statement_timeout = '10s';
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', '${ownerId}', true);
set local role authenticated;
select public.cancel_queued_generation_job('${cancelRaceJobId}');
\\echo CANCELLATION_UNCOMMITTED
select pg_sleep(2);
commit;
`, (stdout) => { if (stdout.includes('CANCELLATION_UNCOMMITTED')) releaseSecondClaim(); });

await Promise.race([
  cancellationApplied,
  cancellation.then((result) => {
    assertSuccess(result, 'cancellation exited before holding its job lock');
    throw new Error('cancellation did not report its transaction barrier');
  }),
]);
const claimAfterCancel = runPsql(`
begin;
set local statement_timeout = '10s';
select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;
select public.claim_generation_worker_job('${randomUUID()}');
commit;
`);
const [cancelResult, secondClaimResult] = await Promise.all([cancellation, claimAfterCancel]);
assertSuccess(cancelResult, 'cancellation deadlocked or failed');
assertSuccess(secondClaimResult, 'claim competing with cancellation deadlocked or failed');

const cancelVerification = await runPsql(`
select concat_ws('|', status, worker_attempt_count, worker_attempt_token is null)
from public.generation_jobs where id = '${cancelRaceJobId}';
delete from auth.users where id = '${ownerId}';
`);
assertSuccess(cancelVerification, 'cancel race verification or cleanup failed');
if (cancelVerification.stdout.trim() !== 'cancelled|0|t') {
  throw new Error(`cancel/claim race did not preserve exactly one winner\n${cancelVerification.stdout}`);
}

console.log('PASS: secret deletion and cancellation share safe database locks with worker claim; both races terminate and exactly one safe outcome persists.');
