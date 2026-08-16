begin;
select plan(22);

select has_function('public', 'restore_narrative_draft', array['uuid', 'uuid'], 'restore is one narrow owner command');
select ok(has_function_privilege('authenticated', 'public.restore_narrative_draft(uuid,uuid)', 'EXECUTE'), 'authenticated may restore through the narrow command');
select ok(not has_function_privilege('anon', 'public.restore_narrative_draft(uuid,uuid)', 'EXECUTE'), 'anonymous callers cannot restore drafts');

insert into public.drafts (id, owner_id, kind, title)
values ('f1000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'short_dialogue', 'restore fixture');
insert into public.draft_versions (id, owner_id, draft_id, version_number, content, context_version_ids, continuity_level, continuity_policy_version)
values ('f2000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'f1000000-0000-0000-0000-000000000001', 1, '{"title":"restore fixture","body":"immutable restore body","canonChangeCandidates":[]}', '{}', 'review', 'cheonmu-continuity-v1');
insert into public.memory_items (id, owner_id, memory_type, content, status)
values ('f3000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'canon', 'restore canon baseline', 'active');
update public.drafts set status = 'generated' where id = 'f1000000-0000-0000-0000-000000000001';

select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-000000000001', true);
set local role authenticated;
select lives_ok($$ select public.archive_narrative_draft('f1000000-0000-0000-0000-000000000001', 'f2000000-0000-0000-0000-000000000001', 'generated') $$, 'owner archives the exact latest version');
select is((select status from public.drafts where id = 'f1000000-0000-0000-0000-000000000001'), 'archived', 'archived draft remains listed authoritatively');
select is((select payload ->> 'previousState' from public.audit_events where entity_id = 'f1000000-0000-0000-0000-000000000001' and event_type = 'draft_archived' order by created_at desc limit 1), 'generated', 'archive audit records the safe prior state');
select lives_ok($$ select public.restore_narrative_draft('f1000000-0000-0000-0000-000000000001', 'f2000000-0000-0000-0000-000000000001') $$, 'owner restores the exact archived latest version');
select is((select status from public.drafts where id = 'f1000000-0000-0000-0000-000000000001'), 'generated', 'restore returns to the audited prior state');
select is((select count(*) from public.draft_versions where draft_id = 'f1000000-0000-0000-0000-000000000001'), 1::bigint, 'restore leaves immutable version count unchanged');
select is((select content ->> 'body' from public.draft_versions where id = 'f2000000-0000-0000-0000-000000000001'), 'immutable restore body', 'restore leaves immutable version content unchanged');
select is((select count(*) from public.publish_jobs where draft_id = 'f1000000-0000-0000-0000-000000000001'), 0::bigint, 'restore creates no publish side effect');
select is((select count(*) from public.memory_items where id = 'f3000000-0000-0000-0000-000000000001' and memory_type = 'canon' and content = 'restore canon baseline'), 1::bigint, 'restore leaves canon unchanged');
select is((select payload ->> 'restoredState' from public.audit_events where entity_id = 'f1000000-0000-0000-0000-000000000001' and event_type = 'draft_restored' order by created_at desc limit 1), 'generated', 'restore emits an audited resulting state');
select lives_ok($$ select public.archive_narrative_draft('f1000000-0000-0000-0000-000000000001', 'f2000000-0000-0000-0000-000000000001', 'generated') $$, 'restored draft can be archived again');
select throws_ok($$ select public.restore_narrative_draft('f1000000-0000-0000-0000-000000000001', 'f2000000-0000-0000-0000-000000000099') $$, 'P0001', 'stale_restore', 'restore rejects a stale expected version');
select is((select status from public.drafts where id = 'f1000000-0000-0000-0000-000000000001'), 'archived', 'stale restore leaves archive state unchanged');
reset role;
update public.audit_events set payload = payload || '{"previousState":"published"}'::jsonb
where entity_id = 'f1000000-0000-0000-0000-000000000001' and event_type = 'draft_archived';
set local role authenticated;
select throws_ok($$ select public.restore_narrative_draft('f1000000-0000-0000-0000-000000000001', 'f2000000-0000-0000-0000-000000000001') $$, 'P0001', 'invalid_restore_state', 'restore refuses an unsafe audited prior state');
select is((select status from public.drafts where id = 'f1000000-0000-0000-0000-000000000001'), 'archived', 'unsafe restore leaves archive state unchanged');
reset role;

insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values ('00000000-0000-0000-0000-000000000000', 'f4000000-0000-0000-0000-000000000001', 'authenticated', 'authenticated', 'dashboard-policy@local.invalid', '$2a$10$fixtureonly00000000000000000000000000000000000000000000000', now(), '{"provider":"email","providers":["email"]}', '{}', now(), now());
insert into public.owner_profiles (owner_id, display_name) values ('f4000000-0000-0000-0000-000000000001', 'Dashboard policy owner');
insert into public.budget_periods (owner_id, currency, period_start, period_end, limit_micros, daily_limit_micros)
values ('f4000000-0000-0000-0000-000000000001', 'USD', public.narrative_business_date(now()) - 1, public.narrative_business_date(now()) + 30, 100000, 100000);
insert into public.schedules (id, owner_id, schedule_key, schedule_type, cron_expression, enabled, payload, seoul_time, minimum_interval_minutes, last_queued_at)
select 'f5000000-0000-0000-0000-000000000001', 'f4000000-0000-0000-0000-000000000001', 'interval-gated', 'automatic',
  extract(minute from local_target)::integer || ' ' || extract(hour from local_target)::integer || ' * * *', true, '{"kind":"daily_event"}', local_target::time(0), 1440, now()
from (select (date_trunc('minute', now()) + interval '1 minute') at time zone 'Asia/Seoul' as local_target) as target;

select has_function('narrative_private', 'next_narrative_schedule_at', array['uuid', 'timestamp with time zone'], 'one helper owns per-schedule next-run policy');
select ok(narrative_private.next_narrative_schedule_at('f5000000-0000-0000-0000-000000000001', now()) > now() + interval '23 hours', 'minimum interval prevents advertising the next nominal cron minute');

insert into public.schedules (id, owner_id, schedule_key, schedule_type, cron_expression, enabled, payload, special_date, seoul_time, minimum_interval_minutes)
select 'f5000000-0000-0000-0000-000000000002', 'f4000000-0000-0000-0000-000000000001', 'earlier-special', 'special', null, true, '{"kind":"short_dialogue"}', local_target::date, local_target::time(0), 60
from (select (date_trunc('minute', now()) + interval '2 hours') at time zone 'Asia/Seoul' as local_target) as target;

select set_config('request.jwt.claim.sub', 'f4000000-0000-0000-0000-000000000001', true);
set local role authenticated;
select is(
  (public.get_narrative_dashboard() ->> 'nextScheduleAt')::timestamptz,
  (select (special_date + seoul_time) at time zone 'Asia/Seoul' from public.schedules where id = 'f5000000-0000-0000-0000-000000000002'),
  'dashboard selects an earlier enabled special date over an interval-gated cron'
);
select is(
  (public.get_narrative_dashboard() ->> 'nextScheduleAt')::timestamptz,
  (select min((item ->> 'nextRunAt')::timestamptz) from jsonb_array_elements(public.get_narrative_schedules() -> 'schedules') as item where item ->> 'nextRunAt' is not null),
  'dashboard and schedule management expose the same authoritative next run'
);

reset role;
select * from finish();
rollback;
