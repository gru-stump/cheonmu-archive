import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const container = 'supabase_db_cheonmu-narrative';
const ownerId = '10000000-0000-0000-0000-000000000001';

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

function service(sql) {
  return `begin;
select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;
${sql}
commit;`;
}

function assertResult(result, message) {
  if (result.code !== 0) throw new Error(`${message}\n${result.stdout}\n${result.stderr}`);
}

const claimJob = randomUUID();
const claimDraft = randomUUID();
const firstToken = randomUUID();
const secondToken = randomUUID();
const setup = await runPsql(`
update public.generation_jobs
set scheduled_for = clock_timestamp() + interval '1 day'
where status = 'queued' and worker_attempt_token is null;
update public.narrative_admin_settings set manual_generation_enabled = true, schedule_automation_enabled = true where owner_id = '${ownerId}';
update public.provider_settings set enabled = true, pricing_verified_at = public.narrative_business_date(current_timestamp)
where id = '12000000-0000-0000-0000-000000000001';
insert into public.drafts (id, owner_id, kind, status, title) values ('${claimDraft}', '${ownerId}', 'daily_event', 'queued', 'global claim race');
insert into public.generation_jobs (id, owner_id, draft_id, schedule_key, scheduled_for, payload, provider_setting_id)
values ('${claimJob}', '${ownerId}', '${claimDraft}', 'worker-race:${claimJob}', clock_timestamp() - interval '1 minute',
  '{"source":"manual","mode":"new","kind":"daily_event","manualRequestKey":"worker-race:${claimJob}"}',
  '12000000-0000-0000-0000-000000000001');
`);
assertResult(setup, 'worker race setup failed');

let releaseSecond;
const firstClaimed = new Promise((resolve) => { releaseSecond = resolve; });
const first = runPsql(service(`
select public.claim_generation_worker_job('${firstToken}') ->> 'outcome';
\\echo FIRST_WORKER_CLAIMED
select pg_sleep(2);
`), (stdout) => { if (stdout.includes('FIRST_WORKER_CLAIMED')) releaseSecond(); });
await Promise.race([
  firstClaimed,
  first.then((result) => {
    assertResult(result, 'first worker exited before holding the claim');
    throw new Error('first worker exited before reporting its claim');
  }),
]);
const second = runPsql(service(`select public.claim_generation_worker_job('${secondToken}') ->> 'outcome';`));
const [firstResult, secondResult] = await Promise.all([first, second]);
assertResult(firstResult, 'first worker claim failed');
assertResult(secondResult, 'second worker claim failed');
if (!firstResult.stdout.includes('claimed') || !secondResult.stdout.includes('idle')) {
  throw new Error(`global claim race did not produce one claim and one idle result\n${firstResult.stdout}\n${secondResult.stdout}`);
}

const policyJob = randomUUID();
const policyDraft = randomUUID();
const policyToken = randomUUID();
const policySetup = await runPsql(`
insert into public.drafts (id, owner_id, kind, status, title) values ('${policyDraft}', '${ownerId}', 'short_dialogue', 'queued', 'policy claim race');
insert into public.generation_jobs (id, owner_id, draft_id, schedule_key, scheduled_for, payload, provider_setting_id)
values ('${policyJob}', '${ownerId}', '${policyDraft}', 'worker-policy:${policyJob}', clock_timestamp() - interval '1 minute',
  '{"source":"manual","mode":"new","kind":"short_dialogue","manualRequestKey":"worker-policy:${policyJob}"}',
  '12000000-0000-0000-0000-000000000001');
`);
assertResult(policySetup, 'policy race fixture setup failed');

const releaseFirst = await runPsql(service(`select public.fail_generation_worker_attempt('${claimJob}', '${firstToken}', 'context_selection_failed');`));
assertResult(releaseFirst, 'could not release first race fixture');
await runPsql(`update public.generation_jobs set worker_retry_at = clock_timestamp() + interval '1 hour' where id = '${claimJob}';`);

let releasePolicy;
const policyClaimed = new Promise((resolve) => { releasePolicy = resolve; });
const claimant = runPsql(service(`
select public.claim_generation_worker_job('${policyToken}') ->> 'outcome';
\\echo POLICY_WORKER_CLAIMED
select pg_sleep(2);
`), (stdout) => { if (stdout.includes('POLICY_WORKER_CLAIMED')) releasePolicy(); });
await policyClaimed;
const policyChange = runPsql(`update public.narrative_admin_settings set manual_generation_enabled = false where owner_id = '${ownerId}';`);
const [claimantResult, policyResult] = await Promise.all([claimant, policyChange]);
assertResult(claimantResult, 'policy race claim failed');
assertResult(policyResult, 'policy change failed');
const rejectedRenewal = await runPsql(service(`select public.renew_generation_worker_claim('${policyJob}', '${policyToken}') ->> 'outcome';`));
assertResult(rejectedRenewal, 'policy-off renewal failed unexpectedly');
if (!rejectedRenewal.stdout.includes('dead_lettered')) throw new Error(`policy-off renewal was not terminal\n${rejectedRenewal.stdout}`);

const replacementJob = randomUUID();
const replacementDraft = randomUUID();
const oldToken = randomUUID();
const replacementToken = randomUUID();
await runPsql(`
update public.narrative_admin_settings set manual_generation_enabled = true where owner_id = '${ownerId}';
insert into public.drafts (id, owner_id, kind, status, title) values ('${replacementDraft}', '${ownerId}', 'daily_event', 'queued', 'replacement race');
insert into public.generation_jobs (id, owner_id, draft_id, schedule_key, scheduled_for, payload, provider_setting_id)
values ('${replacementJob}', '${ownerId}', '${replacementDraft}', 'worker-replacement:${replacementJob}', clock_timestamp() - interval '1 minute',
  '{"source":"manual","mode":"new","kind":"daily_event","manualRequestKey":"worker-replacement:${replacementJob}"}',
  '12000000-0000-0000-0000-000000000001');
`);
assertResult(await runPsql(service(`select public.claim_generation_worker_job('${oldToken}');`)), 'old attempt claim failed');
await runPsql(`update public.generation_jobs set worker_lease_expires_at = clock_timestamp() - interval '1 second' where id = '${replacementJob}';`);
assertResult(await runPsql(service(`select public.claim_generation_worker_job('${randomUUID()}');`)), 'expired claim cleanup failed');
await runPsql(`update public.generation_jobs set worker_retry_at = clock_timestamp() - interval '1 second' where id = '${replacementJob}';`);
assertResult(await runPsql(service(`select public.claim_generation_worker_job('${replacementToken}');`)), 'replacement claim failed');
const stale = await Promise.all([
  runPsql(service(`select public.renew_generation_worker_claim('${replacementJob}', '${oldToken}') ->> 'outcome';`)),
  runPsql(service(`select public.fail_generation_worker_attempt('${replacementJob}', '${oldToken}', 'generation_failed') ->> 'outcome';`)),
  runPsql(service(`select public.complete_generation_worker_attempt('${replacementJob}', '${oldToken}') ->> 'outcome';`)),
]);
if (stale.some((result) => result.code !== 0 || !result.stdout.includes('stale'))) {
  throw new Error(`an old attempt mutated or escaped the replacement fence\n${stale.map((value) => `${value.stdout}\n${value.stderr}`).join('\n')}`);
}
assertResult(
  await runPsql(service(`select public.fail_generation_worker_attempt('${replacementJob}', '${replacementToken}', 'context_selection_failed');`)),
  'could not release replacement fixture',
);
await runPsql(`update public.generation_jobs set worker_retry_at = clock_timestamp() + interval '1 hour' where id = '${replacementJob}';`);

const fenceJob = randomUUID();
const fenceDraft = randomUUID();
const workerToken = randomUUID();
const generationToken = randomUUID();
assertResult(await runPsql(`
insert into public.drafts (id, owner_id, kind, status, title) values ('${fenceDraft}', '${ownerId}', 'daily_event', 'queued', 'fence replacement');
insert into public.generation_jobs (id, owner_id, draft_id, schedule_key, scheduled_for, payload, provider_setting_id)
values ('${fenceJob}', '${ownerId}', '${fenceDraft}', 'worker-fence:${fenceJob}', clock_timestamp() - interval '1 minute',
  '{"source":"schedule","kind":"daily_event","budgetPolicy":"block_at_risk"}',
  '12000000-0000-0000-0000-000000000001');
`), 'fence fixture setup failed');
assertResult(await runPsql(service(`
select public.claim_generation_worker_job('${workerToken}');
select public.freeze_generation_worker_context(
  '${fenceJob}', '${fenceDraft}', 'new', 'generation-worker:${fenceJob}',
  array['15000000-0000-0000-0000-000000000001'],
  '[{"versionId":"15000000-0000-0000-0000-000000000001","memoryType":"canon","content":"race","tokenCount":1}]',
  '12000000-0000-0000-0000-000000000001', '${generationToken}', '${workerToken}');
select public.reserve_and_start_worker_generation('${fenceJob}', '${generationToken}', 100, '${workerToken}');
select public.fence_generation_provider_dispatch('${fenceJob}', '${generationToken}', '${workerToken}');
`)), 'provider fence setup failed');
await runPsql(`update public.generation_jobs set worker_lease_expires_at = clock_timestamp() - interval '1 second' where id = '${fenceJob}';`);
const cleanup = await runPsql(service(`select public.claim_generation_worker_job('${randomUUID()}') ->> 'outcome';`));
assertResult(cleanup, 'post-fence expiration cleanup failed');
if (!cleanup.stdout.includes('dead_lettered')) throw new Error(`post-fence expiration was not dead-lettered\n${cleanup.stdout}`);
const fenceVerification = await runPsql(`select concat(status, '|', worker_failure_code, '|', worker_attempt_count, '|', provider_dispatch_recorded_at is not null,
  '|', (select count(*) from public.budget_entries where generation_job_id = '${fenceJob}' and entry_type = 'failure'))
from public.generation_jobs where id = '${fenceJob}';`);
assertResult(fenceVerification, 'post-fence verification failed');
if (!fenceVerification.stdout.includes('failed|provider_outcome_unknown|1|t|1')) {
  throw new Error(`provider fence allowed replacement or duplicate settlement\n${fenceVerification.stdout}`);
}

console.log('PASS: generation worker claims serialize globally, policy changes fence claims, old tokens cannot mutate replacements, and a committed provider fence prevents replacement dispatch.');
