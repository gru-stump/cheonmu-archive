begin;

select plan(61);

select has_column('public', 'memory_items', 'supersedes_memory_item_id', 'memory corrections retain an immutable predecessor link');
select has_column('public', 'schedules', 'special_date', 'special dates are relational schedule state');
select has_column('public', 'schedules', 'minimum_interval_minutes', 'minimum schedule interval is relational state');
select has_column('public', 'schedules', 'last_queued_at', 'minimum interval uses a transactionally maintained queue timestamp');
select has_column('public', 'provider_settings', 'pricing_verified_at', 'provider pricing has a verified date');
select has_table('public', 'narrative_admin_settings', 'owner automation and budget policy have one settings row');
select has_function('public', 'get_narrative_memory', array[]::text[], 'memory is read through an owner command');
select has_function('public', 'set_narrative_memory_enabled', array['uuid', 'boolean'], 'memory enable state uses a narrow command');
select has_function('public', 'correct_narrative_memory', array['uuid', 'text', 'text'], 'memory correction appends through a narrow command');
select has_function('public', 'get_narrative_schedules', array[]::text[], 'schedule reads use an owner command');
select has_function('public', 'save_narrative_schedule', array['uuid', 'text', 'text', 'boolean', 'text', 'integer', 'date', 'integer', 'text'], 'schedule writes use one validated owner command');
select has_function('public', 'queue_due_narrative_schedule_job', array['uuid', 'uuid', 'timestamp with time zone'], 'due schedule queueing has one atomic policy boundary');
select has_function('public', 'get_narrative_settings', array[]::text[], 'settings reads have a secret-free owner command');
select has_function('public', 'save_narrative_settings', array['boolean', 'boolean', 'text', 'jsonb', 'bigint', 'bigint', 'integer', 'integer', 'integer', 'numeric', 'integer'], 'provider and split generation policies save atomically');
select ok(
  not has_function_privilege('authenticated', 'public.store_narrative_secret(uuid,text,text)', 'EXECUTE')
  and has_function_privilege('service_role', 'public.store_narrative_secret(uuid,text,text)', 'EXECUTE'),
  'only the server service role can invoke the Vault secret writer'
);

insert into public.memory_items (id, owner_id, memory_type, content, status, blocking)
values ('b1000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'continuity', '옛 약속', 'approved', false);

insert into public.drafts (id, owner_id, kind, title)
values ('b2000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'daily_event', '거절 대상');
insert into public.draft_versions (id, owner_id, draft_id, version_number, content, continuity_level, continuity_policy_version)
values ('b3000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'b2000000-0000-0000-0000-000000000001', 1, '{"body":"발생하지 않은 사건"}', 'block', 'cheonmu-continuity-v1');
update public.drafts set status = 'reviewing' where id = 'b2000000-0000-0000-0000-000000000001';

update public.budget_periods
set period_start = (current_timestamp at time zone 'Asia/Seoul')::date - 2,
    period_end = (current_timestamp at time zone 'Asia/Seoul')::date + 400
where owner_id = '10000000-0000-0000-0000-000000000001';

insert into public.budget_entries (owner_id, budget_period_id, amount_micros, entry_type, daily_bucket_date, description)
select '10000000-0000-0000-0000-000000000001', id, 500, 'reservation', (current_timestamp at time zone 'Asia/Seoul')::date, 'settings floor fixture'
from public.budget_periods where owner_id = '10000000-0000-0000-0000-000000000001';

select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-000000000001', true);
set local role authenticated;

select throws_ok(
  $$ select public.set_narrative_memory_enabled('15000000-0000-0000-0000-000000000001', false) $$,
  'P0001', 'fixed_canon_read_only', 'fixed canon cannot be disabled'
);
select throws_ok(
  $$ select public.correct_narrative_memory('15000000-0000-0000-0000-000000000001', '바뀐 정사', '관리자 교정') $$,
  'P0001', 'fixed_canon_read_only', 'fixed canon cannot be corrected in the admin'
);
select lives_ok(
  $$ select public.correct_narrative_memory('b1000000-0000-0000-0000-000000000001', '치료실에서 다시 만나기로 한 약속', '장소 명시') $$,
  'mutable memory correction appends a replacement'
);
select is((select content from public.memory_items where id = 'b1000000-0000-0000-0000-000000000001'), '옛 약속', 'correction never overwrites the old content');
select is((select count(*) from public.memory_items where supersedes_memory_item_id = 'b1000000-0000-0000-0000-000000000001' and content = '치료실에서 다시 만나기로 한 약속'), 1::bigint, 'correction history points at its immutable predecessor');
select is(public.get_narrative_memory() -> 'continuity' -> 0 -> 'correctionHistory' -> 0 ->> 'note', '장소 명시', 'memory reads attach each immutable correction note to the replaced content');
select lives_ok(
  $$ select public.set_narrative_memory_enabled((select id from public.memory_items where supersedes_memory_item_id = 'b1000000-0000-0000-0000-000000000001'), false) $$,
  'a corrected memory can be disabled independently'
);
select lives_ok(
  $$ select public.correct_narrative_memory((select id from public.memory_items where supersedes_memory_item_id = 'b1000000-0000-0000-0000-000000000001'), '비활성 상태에서 교정한 약속', '상태 보존 확인') $$,
  'a disabled memory can append another correction'
);
select is(
  (select status || '|' || coalesce(metadata ->> 'adminPreviousStatus', '') from public.memory_items where content = '비활성 상태에서 교정한 약속'),
  'inactive|approved', 'correction preserves both disabled state and its restorable previous status'
);

select lives_ok(
  $$ select public.review_draft_atomic('b2000000-0000-0000-0000-000000000001', 'b3000000-0000-0000-0000-000000000001', 'reviewing', 'reject', '정사와 맞지 않음', 'task-3-reject', 'cheonmu-continuity-v1') $$,
  'rejection remains available'
);
select is((select count(*) from public.memory_items where source_draft_version_id = 'b3000000-0000-0000-0000-000000000001' and memory_type = 'feedback'), 1::bigint, 'rejected drafts create feedback');
select is((select count(*) from public.memory_items where source_draft_version_id = 'b3000000-0000-0000-0000-000000000001' and memory_type <> 'feedback'), 0::bigint, 'rejected drafts create no continuity, recent, or unresolved memory');

select throws_ok(
  $$ select public.save_narrative_schedule(null, null, 'special', false, '09:00', null, (current_timestamp at time zone 'Asia/Seoul')::date + 1, 60, 'short_dialogue') $$,
  '22023', 'invalid_schedule_command', 'required schedule values are rejected by the command boundary'
);

select lives_ok($$
  select public.save_narrative_settings(
    true, true, 'openai',
    jsonb_build_array(
      jsonb_build_object('providerKey', 'openai', 'modelKey', 'gpt-test', 'maxInputTokens', 4096, 'maxOutputTokens', 1024, 'maxRevisionOutputTokens', 256, 'inputPriceMicrosPerMillion', 1250000, 'outputPriceMicrosPerMillion', 5000000, 'pricingVerifiedAt', (current_timestamp at time zone 'Asia/Seoul')::date),
      jsonb_build_object('providerKey', 'anthropic', 'modelKey', 'claude-test', 'maxInputTokens', 4096, 'maxOutputTokens', 1024, 'maxRevisionOutputTokens', 256, 'inputPriceMicrosPerMillion', 2000000, 'outputPriceMicrosPerMillion', 6000000, 'pricingVerifiedAt', (current_timestamp at time zone 'Asia/Seoul')::date)
    ),
    200000000, 20000000, 3, 80, 95, 1380.5, 30
  )
$$, 'one provider can be activated with fresh pricing');
select is((select count(*) from public.provider_settings where owner_id = auth.uid() and enabled), 1::bigint, 'provider activation leaves exactly one enabled row');
select is((select provider_key from public.provider_settings where owner_id = auth.uid() and enabled), 'openai', 'the requested provider is the sole active row');

select throws_ok($$
  select public.save_narrative_settings(
    true, true, 'anthropic',
    jsonb_build_array(
      jsonb_build_object('providerKey', 'openai', 'modelKey', 'gpt-test', 'maxInputTokens', 4096, 'maxOutputTokens', 1024, 'maxRevisionOutputTokens', 256, 'inputPriceMicrosPerMillion', 1250000, 'outputPriceMicrosPerMillion', 5000000, 'pricingVerifiedAt', (current_timestamp at time zone 'Asia/Seoul')::date),
      jsonb_build_object('providerKey', 'anthropic', 'modelKey', 'claude-test', 'maxInputTokens', 4096, 'maxOutputTokens', 1024, 'maxRevisionOutputTokens', 256, 'inputPriceMicrosPerMillion', 2000000, 'outputPriceMicrosPerMillion', 6000000, 'pricingVerifiedAt', (current_timestamp at time zone 'Asia/Seoul')::date - 31)
    ),
    200000000, 20000000, 3, 80, 95, 1380.5, 30
  )
$$, 'P0001', 'stale_provider_pricing', 'stale pricing blocks enabling automation');
select is((select provider_key from public.provider_settings where owner_id = auth.uid() and enabled), 'openai', 'failed provider switch rolls back atomically');

select throws_ok($$
  select public.save_narrative_settings(
    true, true, 'openai',
    jsonb_build_array(jsonb_build_object('providerKey', 'openai', 'modelKey', 'gpt-test', 'maxInputTokens', 4096, 'maxOutputTokens', 1024, 'maxRevisionOutputTokens', 256, 'inputPriceMicrosPerMillion', 1250000, 'outputPriceMicrosPerMillion', 5000000, 'pricingVerifiedAt', (current_timestamp at time zone 'Asia/Seoul')::date)),
    100, 100, 3, 80, 95, 1380.5, 30
  )
$$, 'P0001', 'budget_limit_below_committed', 'budget cannot be lowered below spent plus reserved');

select lives_ok($$
  select public.save_narrative_schedule(null, 'memorial', 'special', true, '21:30', null, (current_timestamp at time zone 'Asia/Seoul')::date + 31, 1440, 'short_dialogue')
$$, 'a fresh-priced special date can be enabled in Seoul time');
select ok((public.get_narrative_schedules() -> 'schedules' -> 0 ->> 'seoulTime') ~ '^\d{2}:\d{2}$', 'schedule reads return a Seoul local wall-clock time');
select ok((public.get_narrative_schedules()::text like '%' || ((current_timestamp at time zone 'Asia/Seoul')::date + 31)::text || '%') and (public.get_narrative_schedules()::text like '%minimumIntervalMinutes%'), 'schedule response includes special date and minimum interval');

select lives_ok($$
  select public.save_narrative_schedule(null, 'two-day', 'automatic', true, '09:00', null, null, 2880, 'daily_event')
$$, 'a two-day minimum interval schedule can be configured');
reset role;
select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;
select lives_ok($$
  select public.queue_due_narrative_schedule_job(
    '10000000-0000-0000-0000-000000000001',
    (select id from public.schedules where owner_id = '10000000-0000-0000-0000-000000000001' and schedule_key = 'two-day'),
    (((current_timestamp at time zone 'Asia/Seoul')::date - 2 + time '09:00') at time zone 'Asia/Seoul')
  )
$$, 'the first due schedule queues through the atomic boundary');
select is(
  (select payload ->> 'budgetPolicy' from public.generation_jobs
   where owner_id = '10000000-0000-0000-0000-000000000001'
     and schedule_key like '%:two-day:%'
   order by created_at limit 1),
  'block_at_risk',
  'daily automatic queue payload freezes its reservation-time risk policy'
);
select throws_ok($$
  select public.queue_due_narrative_schedule_job(
    '10000000-0000-0000-0000-000000000001',
    (select id from public.schedules where owner_id = '10000000-0000-0000-0000-000000000001' and schedule_key = 'two-day'),
    (((current_timestamp at time zone 'Asia/Seoul')::date - 1 + time '09:00') at time zone 'Asia/Seoul')
  )
$$, 'P0001', 'schedule_interval_not_elapsed', 'a daily cron cannot bypass a two-day minimum interval');
select lives_ok($$
  select public.queue_due_narrative_schedule_job(
    '10000000-0000-0000-0000-000000000001',
    (select id from public.schedules where owner_id = '10000000-0000-0000-0000-000000000001' and schedule_key = 'two-day'),
    (((current_timestamp at time zone 'Asia/Seoul')::date + time '09:00') at time zone 'Asia/Seoul')
  )
$$, 'the exact minimum interval boundary is eligible');
reset role;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-000000000001', true);
set local role authenticated;
select ok(
  (select (item ->> 'nextRunAt')::timestamptz from jsonb_array_elements(public.get_narrative_schedules() -> 'schedules') as item where item ->> 'scheduleKey' = 'two-day')
    = (((current_timestamp at time zone 'Asia/Seoul')::date + 2 + time '09:00') at time zone 'Asia/Seoul'),
  'next run uses the same two-day interval rule as queueing'
);

select lives_ok($$
  select public.save_narrative_schedule(null, 'thirty-day', 'automatic', true, '09:00', null, null, 43200, 'daily_event')
$$, 'a representative interval longer than eight days can be configured');
reset role;
update public.schedules
set last_queued_at = (((current_timestamp at time zone 'Asia/Seoul')::date - 1 + time '09:00') at time zone 'Asia/Seoul')
where owner_id = '10000000-0000-0000-0000-000000000001' and schedule_key = 'thirty-day';
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-000000000001', true);
set local role authenticated;
select is(
  (select (item ->> 'nextRunAt')::timestamptz from jsonb_array_elements(public.get_narrative_schedules() -> 'schedules') as item where item ->> 'scheduleKey' = 'thirty-day'),
  (((current_timestamp at time zone 'Asia/Seoul')::date + 29 + time '09:00') at time zone 'Asia/Seoul'),
  'next run searches from the interval eligibility boundary even when it is more than eight days away'
);

reset role;
update public.provider_settings set pricing_verified_at = (current_timestamp at time zone 'Asia/Seoul')::date
where owner_id = '10000000-0000-0000-0000-000000000001' and provider_key = 'openai';
select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;
select throws_ok($$
  select public.queue_due_narrative_schedule_job(
    '10000000-0000-0000-0000-000000000001',
    (select id from public.schedules where owner_id = '10000000-0000-0000-0000-000000000001' and schedule_key = 'memorial'),
    (((current_timestamp at time zone 'Asia/Seoul')::date + 31 + time '21:30') at time zone 'Asia/Seoul')
  )
$$, 'P0001', 'stale_provider_pricing', 'queueing rechecks provider freshness at the advanced Seoul business date');
reset role;
update public.provider_settings set pricing_verified_at = (current_timestamp at time zone 'Asia/Seoul')::date
where owner_id = '10000000-0000-0000-0000-000000000001' and provider_key = 'openai';
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-000000000001', true);
set local role authenticated;

select lives_ok($$
  select public.save_narrative_settings(true, true, 'openai', '[]', 4000, 4000, 0, 10, 20, 1380.5, 30)
$$, 'non-default manual, warning, and risk policy can be saved');
reset role;
select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;
select is(public.narrative_schedule_budget_state('10000000-0000-0000-0000-000000000001'), 'warning', 'the configured 10 percent warning threshold affects scheduling');
select lives_ok(
  $$ select public.queue_narrative_access_job('10000000-0000-0000-0000-000000000001', (((current_timestamp at time zone 'Asia/Seoul')::date + time '15:00') at time zone 'Asia/Seoul')) $$,
  'the configured direct-generation count limit does not block explicit owner access queueing'
);
reset role;
insert into public.budget_entries (owner_id, budget_period_id, amount_micros, entry_type, daily_bucket_date, description)
select '10000000-0000-0000-0000-000000000001', id, 400, 'reservation', (current_timestamp at time zone 'Asia/Seoul')::date, 'custom risk threshold fixture'
from public.budget_periods where owner_id = '10000000-0000-0000-0000-000000000001';
update public.schedules
set special_date = (current_timestamp at time zone 'Asia/Seoul')::date
where owner_id = '10000000-0000-0000-0000-000000000001' and schedule_key = 'memorial';
select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;
select is(public.narrative_schedule_budget_state('10000000-0000-0000-0000-000000000001'), 'risk', 'the configured 20 percent risk threshold affects scheduling before the hard limit');
select throws_ok($$
  select public.queue_due_narrative_schedule_job(
    '10000000-0000-0000-0000-000000000001',
    (select id from public.schedules where owner_id = '10000000-0000-0000-0000-000000000001' and schedule_key = 'memorial'),
    (((current_timestamp at time zone 'Asia/Seoul')::date + time '21:30') at time zone 'Asia/Seoul')
  )
$$, 'P0001', 'budget_risk', 'the atomic schedule queue blocks at the configured risk threshold');
reset role;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-000000000001', true);
set local role authenticated;
select lives_ok($$
  select public.save_narrative_settings(true, true, 'openai', '[]', 200000000, 20000000, 3, 80, 95, 1380.5, 30)
$$, 'runtime policy can be restored after non-default threshold checks');

reset role;
insert into public.drafts (id, owner_id, kind, title)
values ('b2000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000001', 'short_dialogue', 'stale reserve target');
insert into public.generation_jobs (
  id, owner_id, draft_id, schedule_key, scheduled_for, payload, idempotency_key,
  provider_setting_id, worst_case_cost_micros, attempt_token
)
select 'b4000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000001',
  'b2000000-0000-0000-0000-000000000002', 'stale-reserve', now(), '{"source":"schedule","budgetPolicy":"block_at_risk"}', 'stale-reserve-key',
  id, 1, 'b5000000-0000-4000-8000-000000000002'
from public.provider_settings where owner_id = '10000000-0000-0000-0000-000000000001' and enabled;
update public.provider_settings set pricing_verified_at = public.narrative_business_date(current_timestamp) - 31
where owner_id = '10000000-0000-0000-0000-000000000001' and enabled;
select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;
select throws_ok(
  $$ select public.reserve_and_start_generation('b4000000-0000-0000-0000-000000000002', 'b5000000-0000-4000-8000-000000000002', 1) $$,
  'P0001', 'stale_provider_pricing', 'generation reservation atomically rechecks expired pricing before provider work'
);
reset role;
update public.provider_settings set pricing_verified_at = public.narrative_business_date(current_timestamp)
where owner_id = '10000000-0000-0000-0000-000000000001' and enabled;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-000000000001', true);
set local role authenticated;

select lives_ok($$ select public.save_narrative_settings(false, false, null, '[]', 200000000, 20000000, 4, 80, 95, 1380.5, 30) $$, 'both generation policies can be disabled explicitly');
select is((select count(*) from public.provider_settings where owner_id = auth.uid() and enabled), 0::bigint, 'disabled automation permits no active provider');
select ok(public.get_narrative_settings()::text not like '%configuration%', 'settings response never returns provider secret configuration');

reset role;

select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;
select lives_ok(
  $$ select public.store_narrative_secret('10000000-0000-0000-0000-000000000001', 'github', 'transient-test-material') $$,
  'service secret writer stores through Vault without returning material'
);
reset role;
select is((select count(*) from public.audit_events where event_type = 'narrative_secret_configured' and owner_id = '10000000-0000-0000-0000-000000000001'), 1::bigint, 'secret write appends one audit event');
select ok((select payload::text from public.audit_events where event_type = 'narrative_secret_configured' and owner_id = '10000000-0000-0000-0000-000000000001') not like '%transient-test-material%', 'secret material never enters the audit payload');

select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-000000000001', true);
set local role authenticated;
select is((public.get_narrative_settings() -> 'secrets' ->> 'github')::boolean, true, 'settings report only that the stored GitHub secret is configured');
select ok(public.get_narrative_settings()::text not like '%transient-test-material%', 'settings never return stored secret material');
reset role;

select * from finish();
rollback;
