import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const container = 'supabase_db_cheonmu-narrative';
const ownerId = '10000000-0000-0000-0000-000000000001';
const providerId = '12000000-0000-0000-0000-000000000001';
const draftId = randomUUID();
const jobId = randomUUID();
const workerToken = randomUUID();

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
update public.generation_jobs set scheduled_for = clock_timestamp() + interval '1 day'
where status = 'queued' and worker_attempt_token is null;
update public.provider_settings set enabled = true,
  pricing_verified_at = public.narrative_business_date(current_timestamp)
where id = '${providerId}';
update public.narrative_admin_settings set manual_generation_enabled = true,
  schedule_automation_enabled = true where owner_id = '${ownerId}';
insert into public.drafts (id, owner_id, kind, status, title)
values ('${draftId}', '${ownerId}', 'daily_event', 'queued', 'settings worker lock order');
insert into public.generation_jobs (id, owner_id, draft_id, schedule_key, scheduled_for, payload, provider_setting_id)
values ('${jobId}', '${ownerId}', '${draftId}', 'settings-worker:${jobId}', clock_timestamp() - interval '1 minute',
  '{"source":"schedule","kind":"daily_event","budgetPolicy":"block_at_risk"}', '${providerId}');
`);
assertSuccess(setup, 'settings/worker setup failed');

let releaseClaim;
const providerLocked = new Promise((resolve) => { releaseClaim = resolve; });
const save = runPsql(`
begin;
set local statement_timeout = '10s';
select 1 from public.provider_settings where owner_id = '${ownerId}' for update;
\\echo SETTINGS_PROVIDER_LOCKED
select pg_sleep(2);
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', '${ownerId}', true);
set local role authenticated;
select public.save_narrative_settings(true, true, 'fake-local-provider', '[]',
  100000000, 100000000, 7, 70, 90, 1400, 31);
commit;
`, (stdout) => { if (stdout.includes('SETTINGS_PROVIDER_LOCKED')) releaseClaim(); });

await Promise.race([
  providerLocked,
  save.then((result) => {
    assertSuccess(result, 'settings transaction exited before holding the provider barrier');
    throw new Error('settings transaction did not report the provider barrier');
  }),
]);

const claim = runPsql(`
begin;
set local statement_timeout = '10s';
select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;
select public.claim_generation_worker_job('${workerToken}') ->> 'outcome';
commit;
`);

const [saveResult, claimResult] = await Promise.all([save, claim]);
assertSuccess(saveResult, 'settings RPC deadlocked or failed');
assertSuccess(claimResult, 'worker claim deadlocked or failed');
if (!claimResult.stdout.includes('claimed')) {
  throw new Error(`worker did not commit the one expected claim\n${claimResult.stdout}\n${claimResult.stderr}`);
}

const verification = await runPsql(`
select concat_ws('|', job.worker_attempt_count, job.worker_attempt_token = '${workerToken}',
  job.worker_policy_class, job.worker_source, settings.manual_generation_enabled,
  settings.schedule_automation_enabled, settings.manual_call_limit,
  settings.warning_threshold_percent, settings.risk_threshold_percent,
  settings.pricing_valid_days)
from public.generation_jobs as job
join public.narrative_admin_settings as settings on settings.owner_id = job.owner_id
where job.id = '${jobId}';
begin;
select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;
select public.claim_generation_worker_job('${randomUUID()}') ->> 'outcome';
commit;
`);
assertSuccess(verification, 'settings/worker verification failed');
const lines = verification.stdout.trim().split(/\r?\n/).filter(Boolean);
if (lines[0] !== '1|t|schedule|schedule|t|t|7|70|90|31' || lines.at(-1) !== 'idle') {
  throw new Error(`settings/worker race did not preserve one claim and the committed policy snapshot\n${verification.stdout}`);
}

console.log('PASS: settings save and worker claim share provider-before-settings order; both commit, exactly one claim wins, and the claim observes the committed policy snapshot.');
