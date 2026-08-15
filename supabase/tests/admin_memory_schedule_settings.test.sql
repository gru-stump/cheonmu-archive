begin;

select plan(40);

select has_column('public', 'memory_items', 'supersedes_memory_item_id', 'memory corrections retain an immutable predecessor link');
select has_column('public', 'schedules', 'special_date', 'special dates are relational schedule state');
select has_column('public', 'schedules', 'minimum_interval_minutes', 'minimum schedule interval is relational state');
select has_column('public', 'provider_settings', 'pricing_verified_at', 'provider pricing has a verified date');
select has_table('public', 'narrative_admin_settings', 'owner automation and budget policy have one settings row');
select has_function('public', 'get_narrative_memory', array[]::text[], 'memory is read through an owner command');
select has_function('public', 'set_narrative_memory_enabled', array['uuid', 'boolean'], 'memory enable state uses a narrow command');
select has_function('public', 'correct_narrative_memory', array['uuid', 'text', 'text'], 'memory correction appends through a narrow command');
select has_function('public', 'get_narrative_schedules', array[]::text[], 'schedule reads use an owner command');
select has_function('public', 'save_narrative_schedule', array['uuid', 'text', 'text', 'boolean', 'text', 'integer', 'date', 'integer', 'text'], 'schedule writes use one validated owner command');
select has_function('public', 'get_narrative_settings', array[]::text[], 'settings reads have a secret-free owner command');
select has_function('public', 'save_narrative_settings', array['boolean', 'text', 'jsonb', 'bigint', 'bigint', 'integer', 'integer', 'integer', 'numeric', 'integer'], 'provider and budget policy save atomically');
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

insert into public.budget_entries (owner_id, budget_period_id, amount_micros, entry_type, daily_bucket_date, description)
select '10000000-0000-0000-0000-000000000001', id, 500, 'reservation', date '2026-08-15', 'settings floor fixture'
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
  $$ select public.review_draft_atomic('b2000000-0000-0000-0000-000000000001', 'b3000000-0000-0000-0000-000000000001', 'reviewing', 'reject', '정사와 맞지 않음', 'task-3-reject', 'cheonmu-continuity-v1') $$,
  'rejection remains available'
);
select is((select count(*) from public.memory_items where source_draft_version_id = 'b3000000-0000-0000-0000-000000000001' and memory_type = 'feedback'), 1::bigint, 'rejected drafts create feedback');
select is((select count(*) from public.memory_items where source_draft_version_id = 'b3000000-0000-0000-0000-000000000001' and memory_type <> 'feedback'), 0::bigint, 'rejected drafts create no continuity, recent, or unresolved memory');

select throws_ok(
  $$ select public.save_narrative_schedule(null, null, 'special', false, '09:00', null, date '2026-09-07', 60, 'short_dialogue') $$,
  '22023', 'invalid_schedule_command', 'required schedule values are rejected by the command boundary'
);

select lives_ok($$
  select public.save_narrative_settings(
    true, 'openai',
    '[{"providerKey":"openai","modelKey":"gpt-test","maxInputTokens":4096,"maxOutputTokens":1024,"maxRevisionOutputTokens":256,"inputPriceMicrosPerMillion":1250000,"outputPriceMicrosPerMillion":5000000,"pricingVerifiedAt":"2026-08-15"},{"providerKey":"anthropic","modelKey":"claude-test","maxInputTokens":4096,"maxOutputTokens":1024,"maxRevisionOutputTokens":256,"inputPriceMicrosPerMillion":2000000,"outputPriceMicrosPerMillion":6000000,"pricingVerifiedAt":"2026-08-15"}]',
    200000000, 20000000, 3, 80, 95, 1380.5, 30
  )
$$, 'one provider can be activated with fresh pricing');
select is((select count(*) from public.provider_settings where owner_id = auth.uid() and enabled), 1::bigint, 'provider activation leaves exactly one enabled row');
select is((select provider_key from public.provider_settings where owner_id = auth.uid() and enabled), 'openai', 'the requested provider is the sole active row');

select throws_ok($$
  select public.save_narrative_settings(
    true, 'anthropic',
    '[{"providerKey":"openai","modelKey":"gpt-test","maxInputTokens":4096,"maxOutputTokens":1024,"maxRevisionOutputTokens":256,"inputPriceMicrosPerMillion":1250000,"outputPriceMicrosPerMillion":5000000,"pricingVerifiedAt":"2026-08-15"},{"providerKey":"anthropic","modelKey":"claude-test","maxInputTokens":4096,"maxOutputTokens":1024,"maxRevisionOutputTokens":256,"inputPriceMicrosPerMillion":2000000,"outputPriceMicrosPerMillion":6000000,"pricingVerifiedAt":"2026-01-01"}]',
    200000000, 20000000, 3, 80, 95, 1380.5, 30
  )
$$, 'P0001', 'stale_provider_pricing', 'stale pricing blocks enabling automation');
select is((select provider_key from public.provider_settings where owner_id = auth.uid() and enabled), 'openai', 'failed provider switch rolls back atomically');

select throws_ok($$
  select public.save_narrative_settings(
    true, 'openai',
    '[{"providerKey":"openai","modelKey":"gpt-test","maxInputTokens":4096,"maxOutputTokens":1024,"maxRevisionOutputTokens":256,"inputPriceMicrosPerMillion":1250000,"outputPriceMicrosPerMillion":5000000,"pricingVerifiedAt":"2026-08-15"}]',
    100, 100, 3, 80, 95, 1380.5, 30
  )
$$, 'P0001', 'budget_limit_below_committed', 'budget cannot be lowered below spent plus reserved');

select lives_ok($$
  select public.save_narrative_schedule(null, 'memorial', 'special', true, '21:30', null, date '2026-09-07', 1440, 'short_dialogue')
$$, 'a fresh-priced special date can be enabled in Seoul time');
select ok((public.get_narrative_schedules() -> 'schedules' -> 0 ->> 'seoulTime') ~ '^\d{2}:\d{2}$', 'schedule reads return a Seoul local wall-clock time');
select ok((public.get_narrative_schedules()::text like '%2026-09-07%') and (public.get_narrative_schedules()::text like '%minimumIntervalMinutes%'), 'schedule response includes special date and minimum interval');

select lives_ok($$ select public.save_narrative_settings(false, null, '[]', 200000000, 20000000, 4, 80, 95, 1380.5, 30) $$, 'automation can be disabled explicitly');
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
