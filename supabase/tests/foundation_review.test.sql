begin;

select no_plan();

create function pg_temp.business_date_at(p_timestamp timestamptz)
returns date
language plpgsql
as $$
declare
  result date;
begin
  if to_regprocedure('public.narrative_business_date(timestamp with time zone)') is null then
    return null;
  end if;

  execute 'select public.narrative_business_date($1)'
    into result
    using p_timestamp;
  return result;
end;
$$;

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
values
  (
    '00000000-0000-0000-0000-000000000000',
    '60000000-0000-0000-0000-000000000001',
    'authenticated',
    'authenticated',
    'foundation-review-owner@local.invalid',
    '$2a$10$testfixturesonlynotarealcredential0000000000000000000000000',
    '2026-08-01T00:00:00Z',
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{}'::jsonb,
    '2026-08-01T00:00:00Z',
    '2026-08-01T00:00:00Z'
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    '60000000-0000-0000-0000-000000000002',
    'authenticated',
    'authenticated',
    'foundation-overflow-owner@local.invalid',
    '$2a$10$testfixturesonlynotarealcredential0000000000000000000000000',
    '2026-08-01T00:00:00Z',
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{}'::jsonb,
    '2026-08-01T00:00:00Z',
    '2026-08-01T00:00:00Z'
  )
on conflict (id) do nothing;

insert into public.drafts (id, owner_id, kind, title)
values
  (
    '61000000-0000-0000-0000-000000000001',
    '10000000-0000-0000-0000-000000000001',
    'daily_event',
    'Seed owner draft'
  ),
  (
    '61000000-0000-0000-0000-000000000002',
    '60000000-0000-0000-0000-000000000001',
    'daily_event',
    'Review owner draft'
  ),
  (
    '61000000-0000-0000-0000-000000000004',
    '60000000-0000-0000-0000-000000000001',
    'daily_event',
    'Missing role claim draft'
  );

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
    '62000000-0000-0000-0000-000000000001',
    '60000000-0000-0000-0000-000000000001',
    'USD',
    (current_timestamp at time zone 'Asia/Seoul')::date,
    (current_timestamp at time zone 'Asia/Seoul')::date,
    1000,
    1000
  ),
  (
    '62000000-0000-0000-0000-000000000002',
    '60000000-0000-0000-0000-000000000002',
    'USD',
    (current_timestamp at time zone 'Asia/Seoul')::date,
    (current_timestamp at time zone 'Asia/Seoul')::date,
    9223372036854775807,
    9223372036854775807
  );

insert into public.generation_jobs (id, owner_id, schedule_key, scheduled_for)
values
  (
    '63000000-0000-0000-0000-000000000001',
    '60000000-0000-0000-0000-000000000001',
    'foundation-service-budget',
    current_timestamp
  ),
  (
    '63000000-0000-0000-0000-000000000002',
    '60000000-0000-0000-0000-000000000002',
    'foundation-overflow-budget',
    current_timestamp + interval '1 second'
  );

select ok(
  not exists (
    select 1
    from unnest(array[
      'owner_profiles', 'drafts', 'draft_versions', 'major_event_workflows',
      'memory_items', 'generation_jobs', 'schedules', 'provider_settings',
      'budget_periods', 'budget_entries', 'audit_events'
    ]) as table_name
    cross join unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE']) as privilege_name
    where has_table_privilege('anon', format('public.%I', table_name), privilege_name)
  ),
  'anon has no narrative table privileges'
);

select ok(
  (
    select bool_and(has_table_privilege('authenticated', format('public.%I', table_name), 'SELECT'))
    from unnest(array[
      'owner_profiles', 'drafts', 'draft_versions', 'major_event_workflows',
      'memory_items', 'generation_jobs', 'schedules', 'provider_settings',
      'budget_periods', 'budget_entries', 'audit_events'
    ]) as table_name
  ),
  'authenticated has SELECT on every narrative table'
);

select ok(
  not exists (
    select 1
    from unnest(array[
      'owner_profiles', 'drafts', 'draft_versions', 'major_event_workflows',
      'memory_items', 'generation_jobs', 'schedules', 'provider_settings',
      'budget_periods', 'budget_entries', 'audit_events'
    ]) as table_name
    cross join unnest(array['INSERT', 'UPDATE', 'DELETE']) as privilege_name
    where has_table_privilege('authenticated', format('public.%I', table_name), privilege_name)
  ),
  'authenticated has no direct narrative table mutation privileges'
);

select ok(
  (
    select bool_and(has_table_privilege('service_role', format('public.%I', table_name), privilege_name))
    from unnest(array[
      'owner_profiles', 'drafts', 'draft_versions', 'major_event_workflows',
      'memory_items', 'generation_jobs', 'schedules', 'provider_settings',
      'budget_periods', 'budget_entries', 'audit_events'
    ]) as table_name
    cross join unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE']) as privilege_name
  ),
  'service_role has explicit narrative table DML'
);

select ok(
  not exists (
    select 1
    from information_schema.routine_privileges
    where routine_schema = 'public'
      and routine_name in (
        'transition_draft', 'reserve_generation_budget',
        'reconcile_generation_budget', 'fail_generation_budget'
      )
      and grantee in ('PUBLIC', 'anon')
      and privilege_type = 'EXECUTE'
  ),
  'PUBLIC and anon cannot execute narrative mutation RPCs'
);

select ok(
  (
    select bool_and(has_function_privilege('authenticated', function_signature, 'EXECUTE'))
    from unnest(array[
      'public.transition_draft(uuid,text,text)',
      'public.reserve_generation_budget(uuid,bigint)',
      'public.reconcile_generation_budget(uuid,bigint,jsonb)',
      'public.fail_generation_budget(uuid,bigint)'
    ]) as function_signature
  ),
  'authenticated can execute the intended narrative RPCs'
);

select ok(
  (
    select bool_and(has_function_privilege('service_role', function_signature, 'EXECUTE'))
    from unnest(array[
      'public.transition_draft(uuid,text,text)',
      'public.reserve_generation_budget(uuid,bigint)',
      'public.reconcile_generation_budget(uuid,bigint,jsonb)',
      'public.fail_generation_budget(uuid,bigint)'
    ]) as function_signature
  ),
  'service_role can execute the intended narrative RPCs'
);

select is(
  (
    select count(*)::bigint
    from pg_policies
    where schemaname = 'public'
      and tablename in (
        'owner_profiles', 'drafts', 'draft_versions', 'major_event_workflows',
        'memory_items', 'generation_jobs', 'schedules', 'provider_settings',
        'budget_periods', 'budget_entries', 'audit_events'
      )
      and cmd = 'SELECT'
  ),
  11::bigint,
  'each narrative table has one SELECT policy'
);

select ok(
  not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename in (
        'owner_profiles', 'drafts', 'draft_versions', 'major_event_workflows',
        'memory_items', 'generation_jobs', 'schedules', 'provider_settings',
        'budget_periods', 'budget_entries', 'audit_events'
      )
      and cmd <> 'SELECT'
  ),
  'narrative RLS exposes no direct mutation policy'
);

set local role anon;
select throws_ok(
  $$ select * from public.drafts $$,
  '42501',
  null,
  'anon cannot read drafts'
);
reset role;

select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-000000000001', true);
set local role authenticated;

select is(
  (select count(*) from public.drafts),
  1::bigint,
  'authenticated SELECT is owner scoped'
);
select throws_ok(
  $$ insert into public.drafts (owner_id, kind, title) values ('10000000-0000-0000-0000-000000000001', 'daily_event', 'Direct client insert') $$,
  '42501',
  null,
  'authenticated cannot insert drafts directly'
);
select is(
  (
    select status
    from public.transition_draft(
      '61000000-0000-0000-0000-000000000001',
      'queued',
      'generating'
    )
  ),
  'generating',
  'authenticated can transition its own draft through the RPC'
);
select throws_ok(
  $$ select public.transition_draft('61000000-0000-0000-0000-000000000002', 'queued', 'generating') $$,
  'P0002',
  'draft not found or transition expectation did not match',
  'authenticated cannot transition another owner draft'
);

reset role;
select set_config('request.jwt.claim.role', 'service_role', true);
select set_config('request.jwt.claim.sub', '', true);
set local role service_role;

select throws_ok(
  $$ insert into public.drafts (owner_id, kind, status, title) values ('60000000-0000-0000-0000-000000000001', 'daily_event', 'generating', 'Invalid generating draft') $$,
  'P0001',
  'new drafts must begin queued',
  'service drafts cannot begin generating'
);
select throws_ok(
  $$ insert into public.drafts (owner_id, kind, status, title) values ('60000000-0000-0000-0000-000000000001', 'daily_event', 'generated', 'Invalid generated draft') $$,
  'P0001',
  'new drafts must begin queued',
  'service drafts cannot begin generated'
);
select throws_ok(
  $$ insert into public.drafts (owner_id, kind, status, title) values ('60000000-0000-0000-0000-000000000001', 'daily_event', 'reviewing', 'Invalid reviewing draft') $$,
  'P0001',
  'new drafts must begin queued',
  'service drafts cannot begin reviewing'
);
select throws_ok(
  $$ insert into public.drafts (owner_id, kind, status, title) values ('60000000-0000-0000-0000-000000000001', 'daily_event', 'rejected', 'Invalid rejected draft') $$,
  'P0001',
  'new drafts must begin queued',
  'service drafts cannot begin rejected'
);
select throws_ok(
  $$ insert into public.drafts (owner_id, kind, status, title) values ('60000000-0000-0000-0000-000000000001', 'daily_event', 'archived', 'Invalid archived draft') $$,
  'P0001',
  'new drafts must begin queued',
  'service drafts cannot begin archived'
);
select throws_ok(
  $$ insert into public.drafts (owner_id, kind, status, title) values ('60000000-0000-0000-0000-000000000001', 'daily_event', 'approved_private', 'Invalid private draft') $$,
  'P0001',
  'new drafts must begin queued',
  'service drafts cannot begin approved_private'
);
select throws_ok(
  $$ insert into public.drafts (owner_id, kind, status, title) values ('60000000-0000-0000-0000-000000000001', 'daily_event', 'approved', 'Invalid approved draft') $$,
  'P0001',
  'new drafts must begin queued',
  'service drafts cannot begin approved'
);
select throws_ok(
  $$ insert into public.drafts (owner_id, kind, status, title) values ('60000000-0000-0000-0000-000000000001', 'daily_event', 'publishing', 'Invalid publishing draft') $$,
  'P0001',
  'new drafts must begin queued',
  'service drafts cannot begin publishing'
);
select throws_ok(
  $$ insert into public.drafts (owner_id, kind, status, title) values ('60000000-0000-0000-0000-000000000001', 'daily_event', 'published', 'Invalid published draft') $$,
  'P0001',
  'new drafts must begin queued',
  'service drafts cannot begin published'
);
select throws_ok(
  $$ insert into public.drafts (owner_id, kind, status, title) values ('60000000-0000-0000-0000-000000000001', 'daily_event', 'publish_failed', 'Invalid failed draft') $$,
  'P0001',
  'new drafts must begin queued',
  'service drafts cannot begin publish_failed'
);
select lives_ok(
  $$ insert into public.drafts (id, owner_id, kind, title) values ('61000000-0000-0000-0000-000000000003', '60000000-0000-0000-0000-000000000001', 'daily_event', 'Valid queued service draft') $$,
  'service drafts can begin queued'
);
select throws_ok(
  $$ update public.drafts set status = 'published' where id = '61000000-0000-0000-0000-000000000003' $$,
  'P0001',
  'illegal draft status change',
  'service_role must use the transition RPC for later states'
);
select is(
  (
    select status
    from public.transition_draft(
      '61000000-0000-0000-0000-000000000003',
      'queued',
      'generating'
    )
  ),
  'generating',
  'service_role can transition a locked draft without a caller-supplied owner'
);
select lives_ok(
  $$ select public.reserve_generation_budget('63000000-0000-0000-0000-000000000001', 100) $$,
  'service_role can reserve against a locked job without a caller-supplied owner'
);
select is(
  (
    select owner_id
    from public.budget_entries
    where generation_job_id = '63000000-0000-0000-0000-000000000001'
      and entry_type = 'reservation'
  ),
  '60000000-0000-0000-0000-000000000001'::uuid,
  'the service reservation derives its owner from the locked job'
);

reset role;

select set_config('request.jwt.claim.role', '', true);
select set_config('request.jwt.claim.sub', '60000000-0000-0000-0000-000000000001', true);
set local role authenticated;
select throws_ok(
  $$ select public.transition_draft('61000000-0000-0000-0000-000000000004', 'queued', 'generating') $$,
  '42501',
  'draft transition caller is not authorized',
  'transition rejects an authenticated database role without an authenticated JWT role claim'
);
select throws_ok(
  $$ select public.reserve_generation_budget('63000000-0000-0000-0000-000000000001', 100) $$,
  '42501',
  'generation budget caller is not authorized',
  'budget RPCs reject an authenticated database role without an authenticated JWT role claim'
);
reset role;

select is(
  pg_temp.business_date_at('2026-08-14 14:59:59.999999+00'::timestamptz),
  date '2026-08-14',
  'the instant before Seoul midnight remains on the prior business date'
);
select is(
  pg_temp.business_date_at('2026-08-14 15:00:00+00'::timestamptz),
  date '2026-08-15',
  'Seoul midnight begins the next business date'
);

select throws_ok(
  format(
    $sql$
      insert into public.budget_periods (
        owner_id, currency, period_start, period_end, limit_micros, daily_limit_micros
      ) values (
        '60000000-0000-0000-0000-000000000001', 'USD', %L::date, %L::date, 10, 10
      )
    $sql$,
    ((current_timestamp at time zone 'Asia/Seoul')::date - 1)::text,
    ((current_timestamp at time zone 'Asia/Seoul')::date + 1)::text
  ),
  '23P01',
  null,
  'overlapping owner and currency budget periods are rejected atomically'
);

select throws_ok(
  $$
    insert into public.budget_entries (
      owner_id, budget_period_id, amount_micros, entry_type, daily_bucket_date, description
    ) values (
      '60000000-0000-0000-0000-000000000001',
      '62000000-0000-0000-0000-000000000001',
      -1, 'reservation', (current_timestamp at time zone 'Asia/Seoul')::date, 'invalid reservation'
    )
  $$,
  '23514',
  null,
  'reservations cannot be negative'
);
select throws_ok(
  $$
    insert into public.budget_entries (
      owner_id, budget_period_id, amount_micros, entry_type, daily_bucket_date, description
    ) values (
      '60000000-0000-0000-0000-000000000001',
      '62000000-0000-0000-0000-000000000001',
      1, 'reconciliation', (current_timestamp at time zone 'Asia/Seoul')::date, 'invalid reconciliation'
    )
  $$,
  '23514',
  null,
  'reconciliation adjustments cannot be positive'
);
select throws_ok(
  $$
    insert into public.budget_entries (
      owner_id, budget_period_id, amount_micros, entry_type, daily_bucket_date, description
    ) values (
      '60000000-0000-0000-0000-000000000001',
      '62000000-0000-0000-0000-000000000001',
      1, 'failure', (current_timestamp at time zone 'Asia/Seoul')::date, 'invalid failure settlement'
    )
  $$,
  '23514',
  null,
  'failure adjustments cannot be positive'
);

select throws_ok(
  $$
    insert into public.draft_versions (owner_id, draft_id, version_number, content)
    values (
      '10000000-0000-0000-0000-000000000001',
      '61000000-0000-0000-0000-000000000002',
      1,
      '{}'::jsonb
    )
  $$,
  '23503',
  null,
  'draft versions must share their draft owner'
);
select throws_ok(
  $$
    insert into public.major_event_workflows (owner_id, draft_id)
    values (
      '10000000-0000-0000-0000-000000000001',
      '61000000-0000-0000-0000-000000000002'
    )
  $$,
  '23503',
  null,
  'major-event workflows must share their draft owner'
);
select throws_ok(
  $$
    insert into public.generation_jobs (owner_id, draft_id, schedule_key, scheduled_for)
    values (
      '10000000-0000-0000-0000-000000000001',
      '61000000-0000-0000-0000-000000000002',
      'invalid-cross-owner-draft',
      current_timestamp + interval '2 seconds'
    )
  $$,
  '23503',
  null,
  'generation jobs must share their draft owner'
);
select throws_ok(
  $$
    insert into public.budget_entries (
      owner_id, budget_period_id, amount_micros, entry_type, daily_bucket_date, description
    ) values (
      '10000000-0000-0000-0000-000000000001',
      '62000000-0000-0000-0000-000000000001',
      1, 'reservation', (current_timestamp at time zone 'Asia/Seoul')::date, 'invalid period owner'
    )
  $$,
  '23503',
  null,
  'budget entries must share their period owner'
);
select throws_ok(
  $$
    insert into public.budget_entries (
      owner_id, budget_period_id, generation_job_id, amount_micros,
      entry_type, daily_bucket_date, description
    ) values (
      '60000000-0000-0000-0000-000000000001',
      '62000000-0000-0000-0000-000000000001',
      '63000000-0000-0000-0000-000000000002',
      1, 'reservation', (current_timestamp at time zone 'Asia/Seoul')::date, 'invalid job owner'
    )
  $$,
  '23503',
  null,
  'budget entries must share their generation-job owner'
);

insert into public.budget_entries (
  owner_id,
  budget_period_id,
  amount_micros,
  entry_type,
  daily_bucket_date,
  description
)
values (
  '60000000-0000-0000-0000-000000000002',
  '62000000-0000-0000-0000-000000000002',
  9223372036854775800,
  'reservation',
  (current_timestamp at time zone 'Asia/Seoul')::date,
  'near-bigint-limit reservation'
);

select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', '60000000-0000-0000-0000-000000000002', true);
set local role authenticated;
select throws_ok(
  $$ select public.reserve_generation_budget('63000000-0000-0000-0000-000000000002', 8) $$,
  'P0001',
  'budget_limit_exceeded',
  'extreme bigint caps reject over-limit reservations without arithmetic overflow'
);
reset role;

select is(
  (select id from public.owner_profiles where owner_id = '10000000-0000-0000-0000-000000000001'),
  '11000000-0000-0000-0000-000000000001'::uuid,
  'the seeded owner profile has a stable fixture UUID'
);
select is(
  (select id from public.provider_settings where owner_id = '10000000-0000-0000-0000-000000000001'),
  '12000000-0000-0000-0000-000000000001'::uuid,
  'the seeded provider setting has a stable fixture UUID'
);
select is(
  (select id from public.budget_periods where owner_id = '10000000-0000-0000-0000-000000000001'),
  '13000000-0000-0000-0000-000000000001'::uuid,
  'the seeded budget period has a stable fixture UUID'
);
select results_eq(
  $$
    select id
    from public.schedules
    where owner_id = '10000000-0000-0000-0000-000000000001'
    order by schedule_key
  $$,
  $$ values
    ('14000000-0000-0000-0000-000000000001'::uuid),
    ('14000000-0000-0000-0000-000000000002'::uuid)
  $$,
  'the seeded schedules have stable fixture UUIDs'
);

select * from finish();

rollback;
