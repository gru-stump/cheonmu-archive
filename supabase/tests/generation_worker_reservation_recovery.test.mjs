import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const container = 'supabase_db_cheonmu-narrative';
const ownerId = '10000000-0000-0000-0000-000000000001';
const providerId = '12000000-0000-0000-0000-000000000001';
const contextId = '15000000-0000-0000-0000-000000000001';

function psql(sql) {
  const result = spawnSync('docker', ['exec', '-i', container, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1'], {
    input: sql, encoding: 'utf8', windowsHide: true,
  });
  if (result.status !== 0) throw new Error(`database command failed\n${result.stdout}\n${result.stderr}`);
  return result.stdout.trim();
}

function service(sql) {
  return `begin;
select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;
${sql}
commit;`;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const jobId = randomUUID();
const draftId = randomUUID();
const workerToken = randomUUID();
const generationToken = randomUUID();

psql(`
update public.generation_jobs set scheduled_for = clock_timestamp() + interval '1 day'
where status = 'queued' and worker_attempt_token is null;
update public.narrative_admin_settings set schedule_automation_enabled = true where owner_id = '${ownerId}';
update public.provider_settings set enabled = true, pricing_verified_at = public.narrative_business_date(current_timestamp)
where id = '${providerId}';
insert into public.drafts (id, owner_id, kind, status, title)
values ('${draftId}', '${ownerId}', 'daily_event', 'queued', 'reservation response recovery');
insert into public.generation_jobs (id, owner_id, draft_id, schedule_key, scheduled_for, payload, provider_setting_id)
values ('${jobId}', '${ownerId}', '${draftId}', 'reservation-recovery:${jobId}', clock_timestamp() - interval '1 minute',
  '{"source":"schedule","kind":"daily_event","budgetPolicy":"block_at_risk"}', '${providerId}');
`);

const responses = psql(service(`
select public.claim_generation_worker_job('${workerToken}') ->> 'outcome';
select public.freeze_generation_worker_context(
  '${jobId}', '${draftId}', 'new', 'generation-worker:${jobId}', array['${contextId}'],
  '[{"versionId":"${contextId}","memoryType":"canon","content":"recovery","tokenCount":1}]',
  '${providerId}', '${generationToken}', '${workerToken}') is not null;
select public.reserve_and_start_worker_generation(
  '${jobId}', '${generationToken}',
  (select worst_case_cost_micros from public.generation_jobs where id = '${jobId}'), '${workerToken}') ->> 'status';
-- This is the same request after a committed response was lost.
select public.reserve_and_start_worker_generation(
  '${jobId}', '${generationToken}',
  (select worst_case_cost_micros from public.generation_jobs where id = '${jobId}'), '${workerToken}') ->> 'status';
`)).split(/\r?\n/).filter(Boolean);
assert(responses.includes('claimed') && responses.filter((value) => value === 'reserved').length === 2,
  `the exact reservation retry was not idempotent: ${responses.join('|')}`);

psql(`update public.generation_jobs set worker_lease_expires_at = clock_timestamp() - interval '1 second' where id = '${jobId}';`);
const cleanup = JSON.parse(psql(service(`select public.claim_generation_worker_job('${randomUUID()}');`)).split(/\r?\n/).filter(Boolean).at(-1));
assert(cleanup.outcome === 'retry_wait' && cleanup.jobId !== jobId,
  `an expired reserved pre-fence attempt was not zero-settled into a distinct retry job: ${JSON.stringify(cleanup)}`);

const accounting = psql(`select concat_ws('|', old.status, old.worker_failure_code,
  (select count(*) from public.budget_entries where generation_job_id = old.id and entry_type = 'reservation'),
  (select count(*) from public.budget_entries where generation_job_id = old.id and entry_type = 'failure'),
  (select coalesce(sum(amount_micros), 0) from public.budget_entries where generation_job_id = old.id),
  replacement.status, replacement.draft_id = old.draft_id, replacement.worker_attempt_count)
from public.generation_jobs old
join public.generation_jobs replacement on replacement.id = '${cleanup.jobId}'
where old.id = '${jobId}';`);
assert(accounting === 'failed|worker_pre_dispatch_retried|1|1|0|queued|t|1',
  `pre-fence retry did not preserve exactly-once zero accounting and attempt history: ${accounting}`);

console.log('PASS: a lost reserve response is idempotently recovered, and an abandoned reserved pre-fence attempt is zero-settled once into a distinct retry job.');
