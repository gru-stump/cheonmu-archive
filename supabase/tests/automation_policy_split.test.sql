begin;

select plan(31);

select has_column('public', 'narrative_admin_settings', 'manual_generation_enabled', 'manual generation has an explicit owner policy');
select has_column('public', 'narrative_admin_settings', 'schedule_automation_enabled', 'scheduled generation has an explicit owner policy');
select has_column('public', 'narrative_admin_settings', 'automation_enabled', 'the legacy combined flag remains as inert compatibility data');
select has_function(
  'public', 'save_narrative_settings',
  array['boolean', 'boolean', 'text', 'jsonb', 'bigint', 'bigint', 'integer', 'integer', 'integer', 'numeric', 'integer'],
  'split policies save through one owner command'
);
select ok(
  to_regprocedure('public.save_narrative_settings(boolean,text,jsonb,bigint,bigint,integer,integer,integer,numeric,integer)') is null,
  'the legacy combined-policy settings command is removed'
);
select ok(
  has_function_privilege('authenticated', 'public.save_narrative_settings(boolean,boolean,text,jsonb,bigint,bigint,integer,integer,integer,numeric,integer)', 'EXECUTE')
    and not has_function_privilege('anon', 'public.save_narrative_settings(boolean,boolean,text,jsonb,bigint,bigint,integer,integer,integer,numeric,integer)', 'EXECUTE')
    and not has_function_privilege('service_role', 'public.save_narrative_settings(boolean,boolean,text,jsonb,bigint,bigint,integer,integer,integer,numeric,integer)', 'EXECUTE'),
  'only authenticated owners receive the split settings command'
);
select ok(
  not has_table_privilege('authenticated', 'public.narrative_admin_settings', 'UPDATE'),
  'policy rows remain server-owned rather than browser-writable'
);

select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-000000000001', true);
set local role authenticated;

select is((public.get_narrative_settings() ->> 'manualGenerationEnabled')::boolean, true, 'the deterministic seed enables manual generation');
select is((public.get_narrative_settings() ->> 'scheduleAutomationEnabled')::boolean, false, 'the deterministic seed keeps schedule automation disabled');
select ok(not (public.get_narrative_settings() ? 'automationEnabled'), 'settings reads no longer expose the legacy combined policy');
select lives_ok(
  $$ select public.save_narrative_settings(false, false, 'fake-local-provider', '[]', 100000000, 20000000, 1, 80, 95, 1380, 30) $$,
  'both policies can be disabled while retaining the selected provider'
);
select is((select count(*) from public.provider_settings where owner_id = auth.uid() and enabled), 1::bigint, 'policy shutdown does not clear the active provider');
select lives_ok(
  $$ select public.save_narrative_settings(true, false, 'fake-local-provider', '[]', 100000000, 20000000, 1, 80, 95, 1380, 30) $$,
  'manual generation can be enabled while schedules remain disabled'
);
select is(
  (select concat(manual_generation_enabled, '|', schedule_automation_enabled) from public.narrative_admin_settings where owner_id = auth.uid()),
  't|f', 'the two policy flags persist independently'
);
select throws_ok(
  $$ select public.save_narrative_settings(true, false, null, '[]', 100000000, 20000000, 1, 80, 95, 1380, 30) $$,
  '22023', 'invalid_settings_command', 'an enabled policy requires exactly one selected provider'
);

reset role;
update public.narrative_admin_settings set automation_enabled = false
where owner_id = '10000000-0000-0000-0000-000000000001';
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-000000000001', true);
set local role authenticated;
select is(
  concat(public.get_narrative_settings() ->> 'manualGenerationEnabled', '|', public.get_narrative_settings() ->> 'scheduleAutomationEnabled'),
  'true|false', 'changing the inert legacy flag cannot change either current policy'
);
select throws_ok(
  $$ select public.save_narrative_schedule(null, 'split-special', 'special', true, '09:00', null, current_date + 1, 60, 'short_dialogue') $$,
  'P0001', 'schedule_automation_disabled', 'an enabled automatic or special schedule requires schedule automation'
);

reset role;
select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;
select throws_ok(
  $$ select public.queue_narrative_access_job('10000000-0000-0000-0000-000000000001', current_timestamp) $$,
  'P0001', 'schedule_automation_disabled', 'access-triggered generation requires schedule automation at evaluation'
);

reset role;
insert into public.drafts (id, owner_id, kind, title)
values ('d8100000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'short_dialogue', 'manual revision policy');
insert into public.draft_versions (id, owner_id, draft_id, version_number, content, continuity_level, continuity_policy_version)
values ('d8200000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'd8100000-0000-0000-0000-000000000001', 1,
  '{"title":"revision","body":"선택 구절","canonChangeCandidates":[]}', 'pass', 'cheonmu-continuity-v1');
update public.drafts set status = 'reviewing' where id = 'd8100000-0000-0000-0000-000000000001';
update public.narrative_admin_settings set manual_generation_enabled = false, schedule_automation_enabled = false
where owner_id = '10000000-0000-0000-0000-000000000001';
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-000000000001', true);
set local role authenticated;
select throws_ok(
  $$ select public.queue_draft_revision('d8100000-0000-0000-0000-000000000001', 'd8200000-0000-0000-0000-000000000001', '선택 구절', '말투만 수정', 64, 100) $$,
  'P0001', 'manual_generation_disabled', 'owner revision requests require manual generation policy'
);

reset role;
update public.narrative_admin_settings set manual_generation_enabled = true
where owner_id = '10000000-0000-0000-0000-000000000001';
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-000000000001', true);
set local role authenticated;
select lives_ok(
  $$ select public.queue_draft_revision('d8100000-0000-0000-0000-000000000001', 'd8200000-0000-0000-0000-000000000001', '선택 구절', '말투만 수정', 64, 100) $$,
  'an enabled owner can queue a manual revision'
);
select is(
  (select payload ->> 'source' from public.generation_jobs where source_draft_version_id = 'd8200000-0000-0000-0000-000000000001'),
  'manual', 'the revision RPC stores its server-owned manual source'
);

reset role;
insert into public.drafts (id, owner_id, kind, title) values
  ('d8300000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'daily_event', 'manual off'),
  ('d8300000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000001', 'daily_event', 'schedule off'),
  ('d8300000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000001', 'daily_event', 'missing source'),
  ('d8300000-0000-0000-0000-000000000004', '10000000-0000-0000-0000-000000000001', 'daily_event', 'unknown source'),
  ('d8300000-0000-0000-0000-000000000005', '10000000-0000-0000-0000-000000000001', 'daily_event', 'stale price'),
  ('d8300000-0000-0000-0000-000000000006', '10000000-0000-0000-0000-000000000001', 'daily_event', 'manual one'),
  ('d8300000-0000-0000-0000-000000000007', '10000000-0000-0000-0000-000000000001', 'daily_event', 'manual two');
insert into public.generation_jobs (
  id, owner_id, draft_id, schedule_key, scheduled_for, payload, idempotency_key,
  provider_setting_id, worst_case_cost_micros, attempt_token
) values
  ('d8400000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'd8300000-0000-0000-0000-000000000001', 'manual-off', now(), '{"kind":"daily_event","source":"manual"}', 'manual-off', '12000000-0000-0000-0000-000000000001', 100, 'd8500000-0000-4000-8000-000000000001'),
  ('d8400000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000001', 'd8300000-0000-0000-0000-000000000002', 'schedule-off', now(), '{"kind":"daily_event","source":"schedule","budgetPolicy":"block_at_risk"}', 'schedule-off', '12000000-0000-0000-0000-000000000001', 100, 'd8500000-0000-4000-8000-000000000002'),
  ('d8400000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000001', 'd8300000-0000-0000-0000-000000000003', 'missing-source', now(), '{"kind":"daily_event"}', 'missing-source', '12000000-0000-0000-0000-000000000001', 100, 'd8500000-0000-4000-8000-000000000003'),
  ('d8400000-0000-0000-0000-000000000004', '10000000-0000-0000-0000-000000000001', 'd8300000-0000-0000-0000-000000000004', 'unknown-source', now(), '{"kind":"daily_event","source":"browser"}', 'unknown-source', '12000000-0000-0000-0000-000000000001', 100, 'd8500000-0000-4000-8000-000000000004'),
  ('d8400000-0000-0000-0000-000000000005', '10000000-0000-0000-0000-000000000001', 'd8300000-0000-0000-0000-000000000005', 'stale-price', now(), '{"kind":"daily_event","source":"manual"}', 'stale-price', '12000000-0000-0000-0000-000000000001', 100, 'd8500000-0000-4000-8000-000000000005'),
  ('d8400000-0000-0000-0000-000000000006', '10000000-0000-0000-0000-000000000001', 'd8300000-0000-0000-0000-000000000006', 'manual-one', now(), '{"kind":"daily_event","source":"manual"}', 'manual-one', '12000000-0000-0000-0000-000000000001', 100, 'd8500000-0000-4000-8000-000000000006'),
  ('d8400000-0000-0000-0000-000000000007', '10000000-0000-0000-0000-000000000001', 'd8300000-0000-0000-0000-000000000007', 'manual-two', now(), '{"kind":"daily_event","source":"manual"}', 'manual-two', '12000000-0000-0000-0000-000000000001', 100, 'd8500000-0000-4000-8000-000000000007');

update public.generation_jobs
set generation_mode = 'new',
    payload = payload || jsonb_build_object('mode', 'new', 'manualRequestKey', schedule_key)
where id in (
  'd8400000-0000-0000-0000-000000000001',
  'd8400000-0000-0000-0000-000000000005',
  'd8400000-0000-0000-0000-000000000006',
  'd8400000-0000-0000-0000-000000000007'
);

update public.narrative_admin_settings set manual_generation_enabled = false, schedule_automation_enabled = false, manual_call_limit = 1
where owner_id = '10000000-0000-0000-0000-000000000001';
select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;
select throws_ok(
  $$ select public.reserve_and_start_generation('d8400000-0000-0000-0000-000000000001', 'd8500000-0000-4000-8000-000000000001', 100) $$,
  'P0001', 'manual_generation_disabled', 'manual reserve/start rechecks emergency shutdown'
);
select throws_ok(
  $$ select public.reserve_and_start_generation('d8400000-0000-0000-0000-000000000002', 'd8500000-0000-4000-8000-000000000002', 100) $$,
  'P0001', 'schedule_automation_disabled', 'scheduled reserve/start rechecks emergency shutdown'
);
select throws_ok(
  $$ select public.reserve_and_start_generation('d8400000-0000-0000-0000-000000000003', 'd8500000-0000-4000-8000-000000000003', 100) $$,
  'P0001', 'invalid_generation_source', 'a missing source fails closed before provider work'
);
select throws_ok(
  $$ select public.reserve_and_start_generation('d8400000-0000-0000-0000-000000000004', 'd8500000-0000-4000-8000-000000000004', 100) $$,
  'P0001', 'invalid_generation_source', 'an unknown source fails closed before provider work'
);

reset role;
update public.narrative_admin_settings set manual_generation_enabled = true
where owner_id = '10000000-0000-0000-0000-000000000001';
update public.provider_settings set pricing_verified_at = public.narrative_business_date(now()) - 31
where id = '12000000-0000-0000-0000-000000000001';
select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;
select throws_ok(
  $$ select public.reserve_and_start_generation('d8400000-0000-0000-0000-000000000005', 'd8500000-0000-4000-8000-000000000005', 100) $$,
  'P0001', 'stale_provider_pricing', 'manual reserve/start requires current provider pricing'
);

reset role;
update public.provider_settings set pricing_verified_at = public.narrative_business_date(now())
where id = '12000000-0000-0000-0000-000000000001';
select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;
select is(
  public.reserve_and_start_generation('d8400000-0000-0000-0000-000000000006', 'd8500000-0000-4000-8000-000000000006', 100) ->> 'status',
  'reserved', 'the first manual provider-call reservation succeeds atomically'
);
select throws_ok(
  $$ select public.reserve_and_start_generation('d8400000-0000-0000-0000-000000000007', 'd8500000-0000-4000-8000-000000000007', 100) $$,
  'P0001', 'manual_call_limit_reached', 'the Seoul-day manual call quota rejects the next reservation'
);
select is(
  (select count(*) from public.budget_entries as entry
   join public.generation_jobs as job on job.id = entry.generation_job_id
   where entry.owner_id = '10000000-0000-0000-0000-000000000001'
     and entry.entry_type = 'reservation'
     and entry.daily_bucket_date = (current_timestamp at time zone 'Asia/Seoul')::date
     and job.payload ->> 'source' = 'manual'),
  1::bigint, 'only the admitted manual provider call owns a reservation'
);
select is((select status from public.generation_jobs where id = 'd8400000-0000-0000-0000-000000000007'), 'queued', 'a quota-rejected manual job never starts');
select is((select count(*) from public.provider_settings where owner_id = '10000000-0000-0000-0000-000000000001' and enabled), 1::bigint, 'policy checks preserve the one-active-provider invariant');

reset role;
select * from finish();
rollback;
