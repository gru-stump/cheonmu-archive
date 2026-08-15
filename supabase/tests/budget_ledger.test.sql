begin;

select plan(29);

insert into auth.users (
  instance_id,
  id,
  aud,
  role,
  email,
  encrypted_password,
  email_confirmed_at,
  raw_app_meta_data,
  raw_user_meta_data,
  created_at,
  updated_at
)
values (
  '00000000-0000-0000-0000-000000000000',
  '50000000-0000-0000-0000-000000000001',
  'authenticated',
  'authenticated',
  'budget-test-second-owner@local.invalid',
  '$2a$10$testfixturesonlynotarealcredential0000000000000000000000000',
  current_timestamp,
  '{"provider":"email","providers":["email"]}'::jsonb,
  '{}'::jsonb,
  current_timestamp,
  current_timestamp
)
on conflict (id) do nothing;

delete from public.budget_periods
where owner_id = '10000000-0000-0000-0000-000000000001';

insert into public.budget_periods (
  id,
  owner_id,
  currency,
  period_start,
  period_end,
  limit_micros,
  daily_limit_micros
)
values
  (
    '51000000-0000-0000-0000-000000000001',
    '10000000-0000-0000-0000-000000000001',
    'USD',
    (current_timestamp at time zone 'Asia/Seoul')::date,
    (current_timestamp at time zone 'Asia/Seoul')::date,
    1000,
    100
  ),
  (
    '51000000-0000-0000-0000-000000000002',
    '50000000-0000-0000-0000-000000000001',
    'USD',
    (current_timestamp at time zone 'Asia/Seoul')::date - 1,
    (current_timestamp at time zone 'Asia/Seoul')::date,
    100,
    1000
  );

insert into public.generation_jobs (id, owner_id, schedule_key, scheduled_for)
values
  ('52000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'budget-test-owner-one', current_timestamp),
  ('52000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000001', 'budget-test-owner-two', current_timestamp + interval '1 second'),
  ('52000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000001', 'budget-test-owner-three', current_timestamp + interval '2 seconds'),
  ('52000000-0000-0000-0000-000000000004', '50000000-0000-0000-0000-000000000001', 'budget-test-other-one', current_timestamp + interval '3 seconds'),
  ('52000000-0000-0000-0000-000000000005', '50000000-0000-0000-0000-000000000001', 'budget-test-other-two', current_timestamp + interval '4 seconds'),
  ('52000000-0000-0000-0000-000000000006', '50000000-0000-0000-0000-000000000001', 'budget-test-other-three', current_timestamp + interval '5 seconds');

insert into public.budget_entries (
  owner_id,
  budget_period_id,
  generation_job_id,
  amount_micros,
  entry_type,
  daily_bucket_date,
  description,
  created_at
)
values (
  '50000000-0000-0000-0000-000000000001',
  '51000000-0000-0000-0000-000000000002',
  null,
  60,
  'reservation',
  (current_timestamp at time zone 'Asia/Seoul')::date - 1,
  'existing period reservation',
  (date_trunc('day', current_timestamp at time zone 'Asia/Seoul') - interval '12 hours') at time zone 'Asia/Seoul'
),
(
  '10000000-0000-0000-0000-000000000001',
  '51000000-0000-0000-0000-000000000001',
  '52000000-0000-0000-0000-000000000003',
  60,
  'reservation',
  (current_timestamp at time zone 'Asia/Seoul')::date - 1,
  'prior Seoul-day reservation',
  (date_trunc('day', current_timestamp at time zone 'Asia/Seoul') - interval '12 hours') at time zone 'Asia/Seoul'
);

select is(
  public.narrative_business_date('2026-08-14 15:00:00+00'::timestamptz),
  date '2026-08-15',
  'budget accounting uses the deterministic Seoul business day'
);
select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;

-- pgTAP runs this script through one connection, so these calls cover the
-- deterministic cap behavior. budget_concurrency.test.mjs supplements this
-- with two real psql connections and proves the shared period-row lock.
select lives_ok(
  $$ select public.reserve_generation_budget('52000000-0000-0000-0000-000000000001', 60) $$,
  'the first competing job reserves within the daily cap'
);
select is(
  (select count(*) from public.budget_entries where generation_job_id = '52000000-0000-0000-0000-000000000001' and entry_type = 'reservation'),
  1::bigint,
  'a reservation creates exactly one ledger entry'
);
select lives_ok(
  $$ select public.reserve_generation_budget('52000000-0000-0000-0000-000000000001', 99) $$,
  'repeating a reservation is idempotent'
);
select is(
  (select sum(amount_micros)::bigint from public.budget_entries where generation_job_id = '52000000-0000-0000-0000-000000000001'),
  60::bigint,
  'a repeated reservation does not add another charge'
);
select throws_ok(
  $$ select public.reserve_generation_budget('52000000-0000-0000-0000-000000000002', 50) $$,
  'P0001',
  'budget_limit_exceeded',
  'a competing reservation that would exceed the daily cap is rejected'
);
select is(
  (select count(*) from public.budget_entries where generation_job_id = '52000000-0000-0000-0000-000000000002'),
  0::bigint,
  'the rejected competing reservation creates no entry'
);

select ok(not has_function_privilege('authenticated', 'public.reserve_generation_budget(uuid,bigint)', 'EXECUTE'), 'authenticated cannot reserve or pre-settle a job');
select ok(not has_function_privilege('authenticated', 'public.reconcile_generation_budget(uuid,bigint,jsonb)', 'EXECUTE'), 'authenticated cannot reconcile or pre-settle a job');
select ok(not has_function_privilege('authenticated', 'public.fail_generation_budget(uuid,bigint)', 'EXECUTE'), 'authenticated cannot fail or pre-settle a job');

select lives_ok(
  $$ select public.reconcile_generation_budget('52000000-0000-0000-0000-000000000001', 30, '{"inputTokens":100,"outputTokens":20,"costMicros":30}'::jsonb) $$,
  'a reservation can reconcile to the actual cost'
);
select is(
  (select sum(amount_micros)::bigint from public.budget_entries where generation_job_id = '52000000-0000-0000-0000-000000000001'),
  30::bigint,
  'reconciliation replaces the reserved total with the actual charge'
);
select is(
  (select usage_json from public.budget_entries where generation_job_id = '52000000-0000-0000-0000-000000000001' and entry_type = 'reconciliation'),
  '{"inputTokens":100,"outputTokens":20,"costMicros":30}'::jsonb,
  'reconciliation preserves provider-neutral usage'
);
select lives_ok(
  $$ select public.reconcile_generation_budget('52000000-0000-0000-0000-000000000001', 30, '{"inputTokens":100,"outputTokens":20,"costMicros":30}'::jsonb) $$,
  'repeating reconciliation is idempotent'
);
select is(
  (select count(*) from public.budget_entries where generation_job_id = '52000000-0000-0000-0000-000000000001' and entry_type in ('reconciliation', 'failure')),
  1::bigint,
  'a job has one terminal settlement entry'
);
select is(
  (select sum(amount_micros)::bigint from public.budget_entries where generation_job_id = '52000000-0000-0000-0000-000000000001'),
  30::bigint,
  'repeated reconciliation does not double charge'
);
select lives_ok(
  $$ select public.reconcile_generation_budget('52000000-0000-0000-0000-000000000003', 0, '{"inputTokens":0,"outputTokens":0,"costMicros":0}'::jsonb) $$,
  'a prior Seoul-day reservation settles without changing today''s bucket'
);
select throws_ok(
  $$ select public.reserve_generation_budget('52000000-0000-0000-0000-000000000002', 71) $$,
  'P0001',
  'budget_limit_exceeded',
  'a prior-day settlement cannot create extra daily capacity today'
);
select is(
  (select count(*) from public.budget_entries where generation_job_id = '52000000-0000-0000-0000-000000000002'),
  0::bigint,
  'the daily-cap rejection after a prior-day settlement creates no entry'
);

reset role;

select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;

select lives_ok(
  $$ select public.reserve_generation_budget('52000000-0000-0000-0000-000000000004', 30) $$,
  'a reservation below the period cap succeeds'
);
select lives_ok(
  $$ select public.reserve_generation_budget('52000000-0000-0000-0000-000000000005', 10) $$,
  'a second reservation can consume the remaining period capacity'
);
select throws_ok(
  $$ select public.reserve_generation_budget('52000000-0000-0000-0000-000000000006', 1) $$,
  'P0001',
  'budget_limit_exceeded',
  'existing prior-day reservations count toward the period cap'
);
select throws_ok(
  $$ select public.reconcile_generation_budget('52000000-0000-0000-0000-000000000004', 31, '{"inputTokens":31,"outputTokens":0,"costMicros":31}'::jsonb) $$,
  'P0001',
  'actual_micros_exceeds_reservation',
  'reconciliation cannot exceed the job worst-case reservation'
);
select throws_ok(
  $$ select public.fail_generation_budget('52000000-0000-0000-0000-000000000005', 11) $$,
  'P0001',
  'charged_micros_exceeds_reservation',
  'failure settlement cannot exceed the job worst-case reservation'
);
select lives_ok(
  $$ select public.fail_generation_budget('52000000-0000-0000-0000-000000000004', 10) $$,
  'a failed job can settle to its charged amount'
);
select is(
  (select sum(amount_micros)::bigint from public.budget_entries where generation_job_id = '52000000-0000-0000-0000-000000000004'),
  10::bigint,
  'failure settlement replaces the reservation with the charged amount'
);
select lives_ok(
  $$ select public.fail_generation_budget('52000000-0000-0000-0000-000000000004', 10) $$,
  'repeating failure settlement is idempotent'
);
select is(
  (select count(*) from public.budget_entries where generation_job_id = '52000000-0000-0000-0000-000000000004' and entry_type in ('reconciliation', 'failure')),
  1::bigint,
  'a failed job has one terminal settlement entry'
);
select is(
  (select sum(amount_micros)::bigint from public.budget_entries where generation_job_id = '52000000-0000-0000-0000-000000000004'),
  10::bigint,
  'repeated failure settlement does not double charge'
);

reset role;

select * from finish();

rollback;
