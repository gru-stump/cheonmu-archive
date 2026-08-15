import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const container = 'supabase_db_cheonmu-narrative';
const ownerId = '10000000-0000-0000-0000-000000000001';
const providerId = '12000000-0000-0000-0000-000000000001';
const draftId = randomUUID();
const jobId = randomUUID();
const attemptToken = randomUUID();
const entryDescription = `settings-reservation-${randomUUID()}`;

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
update public.provider_settings
set enabled = true, pricing_verified_at = public.narrative_business_date(now())
where id = '${providerId}';
update public.narrative_admin_settings
set automation_enabled = true, warning_threshold_percent = 80, risk_threshold_percent = 95
where owner_id = '${ownerId}';
update public.budget_periods
set period_start = public.narrative_business_date(now()) - 1,
    period_end = public.narrative_business_date(now()) + 30,
    limit_micros = 1000, daily_limit_micros = 1000
where owner_id = '${ownerId}';
insert into public.budget_entries (owner_id, budget_period_id, amount_micros, entry_type, daily_bucket_date, description)
select '${ownerId}', id, 900, 'reservation', public.narrative_business_date(now()), '${entryDescription}'
from public.budget_periods where owner_id = '${ownerId}';
insert into public.drafts (id, owner_id, kind, title)
values ('${draftId}', '${ownerId}', 'daily_event', 'settings reservation race');
insert into public.generation_jobs (
  id, owner_id, draft_id, schedule_key, scheduled_for, payload, idempotency_key,
  provider_setting_id, worst_case_cost_micros, attempt_token
) values (
  '${jobId}', '${ownerId}', '${draftId}', 'settings-reservation-race', now(),
  '{"kind":"daily_event","source":"schedule","budgetPolicy":"block_at_risk"}', '${jobId}',
  '${providerId}', 10, '${attemptToken}'
);
`);
if (setup.code !== 0) throw new Error(`settings/reservation setup failed\n${setup.stdout}\n${setup.stderr}`);

let releaseReserve;
const settingsLocked = new Promise((resolve) => { releaseReserve = resolve; });
const save = runPsql(`
begin;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', '${ownerId}', true);
set local role authenticated;
select public.save_narrative_settings(true, 'fake-local-provider', '[]', 1000, 1000, 3, 80, 90, 1350, 30);
\\echo SETTINGS_LOCKED
select pg_sleep(2);
commit;
`, (stdout) => { if (stdout.includes('SETTINGS_LOCKED')) releaseReserve(); });

await Promise.race([
  settingsLocked,
  save.then((result) => {
    if (result.code !== 0) throw new Error(`settings save failed before lock hold\n${result.stdout}\n${result.stderr}`);
    throw new Error('settings save exited before reporting its lock');
  }),
]);

const reserve = runPsql(`
begin;
select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;
select public.reserve_and_start_generation('${jobId}', '${attemptToken}', 10);
commit;
`);
const [saveResult, reserveResult] = await Promise.all([save, reserve]);
if (saveResult.code !== 0) throw new Error(`settings save transaction failed\n${saveResult.stdout}\n${saveResult.stderr}`);
if (reserveResult.code !== 0) throw new Error(`reservation transaction failed\n${reserveResult.stdout}\n${reserveResult.stderr}`);
if (!reserveResult.stdout.includes('"status": "blocked"') || !reserveResult.stdout.includes('"budgetStatus": "risk"')) {
  throw new Error(`reservation did not observe the committed risk policy\n${reserveResult.stdout}\n${reserveResult.stderr}`);
}

const cleanup = await runPsql(`
delete from public.budget_entries where description = '${entryDescription}';
delete from public.generation_jobs where id = '${jobId}';
delete from public.drafts where id = '${draftId}';
update public.budget_periods set limit_micros = 100000000, daily_limit_micros = 100000000 where owner_id = '${ownerId}';
update public.narrative_admin_settings set warning_threshold_percent = 80, risk_threshold_percent = 95 where owner_id = '${ownerId}';
`);
if (cleanup.code !== 0) throw new Error(`settings/reservation cleanup failed\n${cleanup.stdout}\n${cleanup.stderr}`);
console.log('PASS: settings save and reservation share provider-budget-admin lock order, and reservation observes the committed risk policy.');
