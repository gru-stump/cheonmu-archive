begin;

select plan(10);

update public.budget_periods
set period_start = date_trunc('month', public.narrative_business_date(current_timestamp))::date,
    period_end = (date_trunc('month', public.narrative_business_date(current_timestamp)) + interval '1 month - 1 day')::date,
    limit_micros = 100000000,
    daily_limit_micros = 100000000
where owner_id = '10000000-0000-0000-0000-000000000001';

insert into public.generation_jobs (
  id, owner_id, schedule_key, scheduled_for, status, payload,
  attempt_token, worker_attempt_token, worker_attempt_count, worker_lease_expires_at,
  provider_dispatch_generation_attempt_token, provider_dispatch_recorded_at
) values (
  'a2300000-0000-0000-0000-000000000001',
  '10000000-0000-0000-0000-000000000001',
  'provider-failure-output-limit', current_timestamp, 'running',
  '{"source":"access","kind":"short_dialogue","budgetPolicy":"block_at_risk"}',
  'a2320000-0000-4000-8000-000000000001',
  'a2310000-0000-4000-8000-000000000001', 1,
  current_timestamp + interval '1 minute',
  'a2320000-0000-4000-8000-000000000001', current_timestamp
);
insert into public.budget_entries (
  owner_id, budget_period_id, generation_job_id, amount_micros,
  entry_type, daily_bucket_date, description
)
select '10000000-0000-0000-0000-000000000001', period.id,
  'a2300000-0000-0000-0000-000000000001', 6144,
  'reservation', public.narrative_business_date(current_timestamp), 'provider failure clarity fixture'
from public.budget_periods as period
where period.owner_id = '10000000-0000-0000-0000-000000000001'
  and public.narrative_business_date(current_timestamp) between period.period_start and period.period_end;

select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;
select is(
  public.fail_generation_worker_attempt(
    'a2300000-0000-0000-0000-000000000001',
    'a2310000-0000-4000-8000-000000000001',
    'provider_output_limit'
  ) ->> 'failureCode',
  'provider_output_limit',
  'the worker persists the sanitized output-limit reason after provider dispatch'
);

reset role;
select is((select failure_code from public.generation_jobs where id = 'a2300000-0000-0000-0000-000000000001'), 'provider_output_limit', 'the public job keeps the safe reason');
select is((select worker_failure_code from public.generation_jobs where id = 'a2300000-0000-0000-0000-000000000001'), 'provider_output_limit', 'the worker projection keeps the safe reason');
select is((select amount_micros from public.budget_entries where generation_job_id = 'a2300000-0000-0000-0000-000000000001' and entry_type = 'failure'), 0::bigint, 'unknown billing remains conservatively unreleased');

select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-000000000001', true);
set local role authenticated;
select is((public.get_narrative_dashboard() -> 'budget' ->> 'dailyUnconfirmedMicros')::bigint, 6144::bigint, 'dashboard separates today unconfirmed maximum');
select is((public.get_narrative_dashboard() -> 'budget' ->> 'monthlyUnconfirmedMicros')::bigint, 6144::bigint, 'dashboard separates monthly unconfirmed maximum');
select is((
  select (item ->> 'unconfirmedMaximumCostMicros')::bigint
  from jsonb_array_elements(public.get_narrative_dashboard() -> 'queue') as item
  where item ->> 'id' = 'a2300000-0000-0000-0000-000000000001'
), 6144::bigint, 'failed queue item exposes only its safe maximum amount');
select ok(not ((
  select item from jsonb_array_elements(public.get_narrative_dashboard() -> 'queue') as item
  where item ->> 'id' = 'a2300000-0000-0000-0000-000000000001'
) ? 'payload'), 'dashboard still hides the generation command');
select ok(not ((
  select item from jsonb_array_elements(public.get_narrative_dashboard() -> 'queue') as item
  where item ->> 'id' = 'a2300000-0000-0000-0000-000000000001'
) ? 'workerAttemptToken'), 'dashboard still hides worker credentials');
select is((public.get_narrative_dashboard() -> 'queue' -> 0 ->> 'failureCode'), 'provider_output_limit', 'dashboard returns only the sanitized provider reason');

select * from finish();
rollback;
