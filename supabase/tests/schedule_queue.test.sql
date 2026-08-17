begin;
select plan(20);

select has_function('public', 'queue_narrative_schedule_job', array['uuid', 'text', 'timestamp with time zone', 'jsonb'], 'schedule queue RPC exists');
select has_function('public', 'queue_due_narrative_schedule_job', array['uuid', 'uuid', 'timestamp with time zone'], 'atomic due-schedule queue RPC exists');
select has_function('public', 'narrative_schedule_budget_state', array['uuid'], 'budget state RPC exists');
select has_function('public', 'queue_narrative_access_job', array['uuid', 'timestamp with time zone'], 'atomic access queue RPC exists');
select has_function('narrative_private', 'invoke_schedule_dispatcher', array[]::text[], 'Vault-backed dispatcher exists');
select ok(
  pg_get_functiondef('narrative_private.invoke_schedule_dispatcher()'::regprocedure) like '%schedule_dispatch_material%'
    and pg_get_functiondef('narrative_private.invoke_schedule_dispatcher()'::regprocedure) !~* 'https?://|bearer[[:space:]]+[a-z0-9._-]+|service[_ -]?role[[:space:]]*[:=]',
  'dispatcher uses the tested Vault material boundary and embeds no URL or bearer/service credential'
);

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
)
select
  '00000000-0000-0000-0000-000000000000', fixture.id, 'authenticated', 'authenticated',
  fixture.label || '@local.invalid', '$2a$10$testfixturesonlynotarealcredential0000000000000000000000000',
  '2026-08-01T00:00:00Z', '{"provider":"email","providers":["email"]}'::jsonb,
  '{}'::jsonb, '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z'
from (values
  ('81000000-0000-0000-0000-000000000001'::uuid, 'access-fresh'),
  ('81000000-0000-0000-0000-000000000002'::uuid, 'access-stale'),
  ('81000000-0000-0000-0000-000000000003'::uuid, 'access-interval'),
  ('81000000-0000-0000-0000-000000000004'::uuid, 'access-midnight'),
  ('81000000-0000-0000-0000-000000000005'::uuid, 'access-risk'),
  ('81000000-0000-0000-0000-000000000006'::uuid, 'access-warning')
) as fixture(id, label);

insert into public.budget_periods (id, owner_id, currency, period_start, period_end, limit_micros, daily_limit_micros)
select ('82000000-0000-0000-0000-' || lpad(fixture.ordinality::text, 12, '0'))::uuid,
  fixture.id, 'USD', date '2026-08-01', date '2026-08-31', 100, 100
from unnest(array[
  '81000000-0000-0000-0000-000000000001'::uuid,
  '81000000-0000-0000-0000-000000000002'::uuid,
  '81000000-0000-0000-0000-000000000003'::uuid,
  '81000000-0000-0000-0000-000000000004'::uuid,
  '81000000-0000-0000-0000-000000000005'::uuid,
  '81000000-0000-0000-0000-000000000006'::uuid
]) with ordinality as fixture(id, ordinality);

insert into public.narrative_admin_settings (owner_id, schedule_automation_enabled, manual_call_limit)
select fixture.id, true, case when fixture.id = '81000000-0000-0000-0000-000000000004' then 1 else 3 end
from unnest(array[
  '81000000-0000-0000-0000-000000000001'::uuid,
  '81000000-0000-0000-0000-000000000002'::uuid,
  '81000000-0000-0000-0000-000000000003'::uuid,
  '81000000-0000-0000-0000-000000000004'::uuid,
  '81000000-0000-0000-0000-000000000005'::uuid,
  '81000000-0000-0000-0000-000000000006'::uuid
]) as fixture(id);

insert into public.provider_settings (
  id, owner_id, provider_key, enabled, configuration, model_key,
  max_input_tokens, max_output_tokens, max_revision_output_tokens,
  input_cost_micros_per_million, output_cost_micros_per_million, fixed_cost_micros,
  pricing_verified_at
)
select ('88000000-0000-0000-0000-' || lpad(fixture.ordinality::text, 12, '0'))::uuid,
  fixture.id, 'fake-local-provider', true, '{"mode":"fixture"}'::jsonb, 'fake-local-model',
  4096, 1024, 256, 0, 0, 0, date '2026-08-14'
from unnest(array[
  '81000000-0000-0000-0000-000000000001'::uuid,
  '81000000-0000-0000-0000-000000000002'::uuid,
  '81000000-0000-0000-0000-000000000003'::uuid,
  '81000000-0000-0000-0000-000000000004'::uuid,
  '81000000-0000-0000-0000-000000000005'::uuid,
  '81000000-0000-0000-0000-000000000006'::uuid
]) with ordinality as fixture(id, ordinality);

update public.narrative_admin_settings
set schedule_automation_enabled = true
where owner_id = '10000000-0000-0000-0000-000000000001';

update public.schedules
set enabled = true, last_queued_at = null
where id = '14000000-0000-0000-0000-000000000001';

insert into public.generation_jobs (id, owner_id, schedule_key, scheduled_for, status, created_at)
values
  ('83000000-0000-0000-0000-000000000001', '81000000-0000-0000-0000-000000000002', 'access:81000000-0000-0000-0000-000000000002', '2026-08-14T10:00:00Z', 'queued', '2026-08-14T10:00:00Z'),
  ('83000000-0000-0000-0000-000000000002', '81000000-0000-0000-0000-000000000002', 'access:81000000-0000-0000-0000-000000000002', '2026-08-14T10:01:00Z', 'running', '2026-08-14T10:01:00Z');

insert into public.drafts (id, owner_id, kind, title)
values
  ('84000000-0000-0000-0000-000000000003', '81000000-0000-0000-0000-000000000003', 'short_dialogue', 'interval evidence'),
  ('84000000-0000-0000-0000-000000000004', '81000000-0000-0000-0000-000000000004', 'short_dialogue', 'midnight evidence');
insert into public.generation_jobs (id, owner_id, draft_id, schedule_key, scheduled_for, status, created_at)
values
  ('85000000-0000-0000-0000-000000000003', '81000000-0000-0000-0000-000000000003', '84000000-0000-0000-0000-000000000003', 'access:81000000-0000-0000-0000-000000000003', '2026-08-14T15:50:00Z', 'completed', '2026-08-14T15:50:00Z'),
  ('85000000-0000-0000-0000-000000000004', '81000000-0000-0000-0000-000000000004', '84000000-0000-0000-0000-000000000004', 'access:81000000-0000-0000-0000-000000000004', '2026-08-14T14:50:00Z', 'completed', '2026-08-14T14:50:00Z');
insert into public.draft_versions (id, owner_id, draft_id, generation_job_id, version_number, content, created_at)
values
  ('86000000-0000-0000-0000-000000000003', '81000000-0000-0000-0000-000000000003', '84000000-0000-0000-0000-000000000003', '85000000-0000-0000-0000-000000000003', 1, '{}', '2026-08-14T16:00:00Z'),
  ('86000000-0000-0000-0000-000000000004', '81000000-0000-0000-0000-000000000004', '84000000-0000-0000-0000-000000000004', '85000000-0000-0000-0000-000000000004', 1, '{}', '2026-08-14T15:10:00Z');

insert into public.budget_entries (id, owner_id, budget_period_id, amount_micros, entry_type, daily_bucket_date, description)
values
  ('87000000-0000-0000-0000-000000000005', '81000000-0000-0000-0000-000000000005', '82000000-0000-0000-0000-000000000005', 100, 'reservation', '2026-08-15', 'risk fixture'),
  ('87000000-0000-0000-0000-000000000006', '81000000-0000-0000-0000-000000000006', '82000000-0000-0000-0000-000000000006', 80, 'reservation', '2026-08-15', 'warning fixture');

select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;
select lives_ok(
  $$ select public.queue_due_narrative_schedule_job('10000000-0000-0000-0000-000000000001', '14000000-0000-0000-0000-000000000001', '2026-08-15T00:00:00Z') $$,
  'service role queues a due schedule job through the atomic policy boundary'
);
select is(
  (select count(*)::integer from public.generation_jobs where schedule_key = '10000000-0000-0000-0000-000000000001:daily-local-fixture:2026-08-15' and scheduled_for = '2026-08-15T00:00:00Z'),
  1, 'queue insertion stores one job'
);
select is(
  (select (public.queue_due_narrative_schedule_job('10000000-0000-0000-0000-000000000001', '14000000-0000-0000-0000-000000000001', '2026-08-15T00:00:00Z')).id::text),
  (select id::text from public.generation_jobs where schedule_key = '10000000-0000-0000-0000-000000000001:daily-local-fixture:2026-08-15' and scheduled_for = '2026-08-15T00:00:00Z'),
  'same schedule key and timestamp return the existing queue job'
);

select lives_ok(
  $$ select public.queue_narrative_access_job('81000000-0000-0000-0000-000000000001', '2026-08-14T16:30:00Z') $$,
  'eligible access queues atomically'
);
select is(
  (select (public.queue_narrative_access_job('81000000-0000-0000-0000-000000000001', '2026-08-14T16:30:30Z')).id::text),
  (select id::text from public.generation_jobs where owner_id = '81000000-0000-0000-0000-000000000001'),
  'repeated access returns the persisted active job'
);
select is(
  (select count(*)::integer from public.generation_jobs where owner_id = '81000000-0000-0000-0000-000000000001'),
  1, 'repeated access creates one row'
);
select lives_ok(
  $$ select public.queue_narrative_access_job('81000000-0000-0000-0000-000000000002', '2026-08-14T16:30:00Z') $$,
  'stale queued and running work does not block new access'
);
select is(
  (select count(*)::integer from public.generation_jobs where owner_id = '81000000-0000-0000-0000-000000000002'),
  3, 'the real recency cutoff preserves stale history and queues one fresh job'
);
select lives_ok(
  $$ select public.queue_narrative_access_job('81000000-0000-0000-0000-000000000003', '2026-08-14T16:30:00Z') $$,
  'a recent successful access story does not delay an explicit owner request'
);
select lives_ok(
  $$ select public.queue_narrative_access_job('81000000-0000-0000-0000-000000000004', '2026-08-14T16:30:00Z') $$,
  'the configured daily direct-generation count does not block an explicit owner request'
);
select throws_ok(
  $$ select public.queue_narrative_access_job('81000000-0000-0000-0000-000000000005', '2026-08-14T16:30:00Z') $$,
  'P0001', 'budget_risk', 'risk budget blocks access queueing'
);
select lives_ok(
  $$ select public.queue_narrative_access_job('81000000-0000-0000-0000-000000000006', '2026-08-14T16:30:00Z') $$,
  'warning budget permits authenticated access'
);
reset role;
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;
select throws_ok(
  $$ select public.queue_narrative_schedule_job('10000000-0000-0000-0000-000000000001', 'denied', '2026-08-13T15:00:00Z', '{"kind":"daily_event","source":"schedule"}'::jsonb) $$,
  '42501', 'permission denied for function queue_narrative_schedule_job', 'authenticated callers cannot mutate schedule jobs directly'
);
select throws_ok(
  $$ select public.queue_narrative_access_job('81000000-0000-0000-0000-000000000001', '2026-08-14T17:30:00Z') $$,
  '42501', 'permission denied for function queue_narrative_access_job', 'authenticated callers cannot invoke the atomic access mutation directly'
);
reset role;
select * from finish();
rollback;
