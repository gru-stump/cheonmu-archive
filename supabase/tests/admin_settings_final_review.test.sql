begin;

select plan(24);

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values
  ('00000000-0000-0000-0000-000000000000', 'c1000000-0000-0000-0000-000000000001', 'authenticated', 'authenticated',
   'onboarding@local.invalid', '$2a$10$fixture', now(), '{"provider":"email","providers":["email"]}', '{}', now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'c1000000-0000-0000-0000-000000000002', 'authenticated', 'authenticated',
   'non-owner@local.invalid', '$2a$10$fixture', now(), '{"provider":"email","providers":["email"]}', '{}', now(), now());

insert into public.owner_profiles (owner_id, display_name)
values ('c1000000-0000-0000-0000-000000000001', 'Provider onboarding owner');

select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', 'c1000000-0000-0000-0000-000000000001', true);
set local role authenticated;

select is(
  (select count(*) from jsonb_array_elements(public.get_narrative_settings() -> 'providers')),
  2::bigint,
  'an owner with no provider rows receives safe OpenAI and Anthropic drafts'
);
select is(
  (select string_agg(item ->> 'providerKey', ',' order by item ->> 'providerKey')
   from jsonb_array_elements(public.get_narrative_settings() -> 'providers') as item),
  'anthropic,openai',
  'zero-row onboarding exposes both real provider forms'
);

reset role;
insert into public.provider_settings (
  owner_id, provider_key, enabled, configuration, model_key,
  max_input_tokens, max_output_tokens, max_revision_output_tokens,
  input_cost_micros_per_million, output_cost_micros_per_million, fixed_cost_micros,
  pricing_verified_at
) values (
  'c1000000-0000-0000-0000-000000000001', 'openai', false,
  '{"apiKeyEnv":"LEGACY_BROWSER_SECRET_REF"}', 'gpt-onboarding',
  4096, 1024, 256, 1000000, 2000000, 0, current_date
);
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', 'c1000000-0000-0000-0000-000000000001', true);
set local role authenticated;
select is(
  (select count(*) from jsonb_array_elements(public.get_narrative_settings() -> 'providers')),
  2::bigint,
  'an owner with only OpenAI also receives an Anthropic draft'
);
select ok(
  public.get_narrative_settings()::text not like '%configuration%'
    and public.get_narrative_settings()::text not like '%LEGACY_BROWSER_SECRET_REF%'
    and public.get_narrative_settings()::text not like '%vaultSecretName%',
  'provider onboarding never exposes secret configuration or secret references'
);

select throws_ok($$
  select public.save_narrative_settings(
    false, false, null,
    jsonb_build_array(jsonb_build_object(
      'providerKey', 'openai', 'modelKey', 'future-price',
      'maxInputTokens', 4096, 'maxOutputTokens', 1024, 'maxRevisionOutputTokens', 256,
      'inputPriceMicrosPerMillion', 1, 'outputPriceMicrosPerMillion', 1,
      'pricingVerifiedAt', (now() at time zone 'Asia/Seoul')::date + 1
    )),
    1000000, 1000000, 1, 80, 95, 1300, 30
  )
$$, '22023', 'invalid_provider_setting', 'future pricing verification is rejected even while automation is disabled');

reset role;
insert into public.drafts (id, owner_id, kind, title)
values ('c2000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'daily_event', 'source correction');
insert into public.draft_versions (
  id, owner_id, draft_id, version_number, content, continuity_level, continuity_policy_version
) values (
  'c3000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001',
  'c2000000-0000-0000-0000-000000000001', 1,
  '{"body":"original source body","tags":["stale-source-tag"]}', 'pass', 'cheonmu-continuity-v1'
);
insert into public.memory_items (
  id, owner_id, memory_type, content, status, blocking, source_draft_version_id
) values (
  'c4000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001',
  'continuity', 'original source body', 'approved', false, 'c3000000-0000-0000-0000-000000000001'
);
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-000000000001', true);
set local role authenticated;
select lives_ok(
  $$ select public.correct_narrative_memory('c4000000-0000-0000-0000-000000000001', 'corrected body', 'source-backed correction') $$,
  'source-backed continuity memory can be corrected'
);
select is(
  (select source_draft_version_id from public.memory_items where supersedes_memory_item_id = 'c4000000-0000-0000-0000-000000000001'),
  'c3000000-0000-0000-0000-000000000001'::uuid,
  'correction preserves source-version lineage'
);
select is(
  (select (metadata ->> 'tokenCount')::integer from public.memory_items where supersedes_memory_item_id = 'c4000000-0000-0000-0000-000000000001'),
  4,
  'source-backed correction derives token count from corrected content'
);
select ok(
  not ((select metadata from public.memory_items where supersedes_memory_item_id = 'c4000000-0000-0000-0000-000000000001') -> 'tags' ? 'stale-source-tag'),
  'source-backed correction does not inherit stale source tags'
);

reset role;
select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;
select lives_ok(
  $$ select public.store_narrative_secret('c1000000-0000-0000-0000-000000000001', 'openai', 'vault-rotation-sentinel') $$,
  'provider secret rotation succeeds through the service-only command'
);
reset role;
select is(
  (select configuration ->> 'vaultSecretName' from public.provider_settings
   where owner_id = 'c1000000-0000-0000-0000-000000000001' and provider_key = 'openai'),
  'narrative_c1000000-0000-0000-0000-000000000001_openai',
  'secret rotation switches a legacy environment provider to its deterministic Vault reference'
);
select ok(
  ((select configuration from public.provider_settings
   where owner_id = 'c1000000-0000-0000-0000-000000000001' and provider_key = 'openai') ? 'apiKeyEnv') is false,
  'secret rotation removes the legacy environment reference atomically'
);

reset role;
update public.budget_periods
set period_start = public.narrative_business_date(now()) - 1,
    period_end = public.narrative_business_date(now()) + 30,
    limit_micros = 1000,
    daily_limit_micros = 1000
where owner_id = '10000000-0000-0000-0000-000000000001';
delete from public.budget_entries where owner_id = '10000000-0000-0000-0000-000000000001';
update public.narrative_admin_settings
set manual_generation_enabled = true, schedule_automation_enabled = true, pricing_valid_days = 30,
    warning_threshold_percent = 80, risk_threshold_percent = 90
where owner_id = '10000000-0000-0000-0000-000000000001';
update public.provider_settings
set enabled = true, pricing_verified_at = public.narrative_business_date(now()) + 2
where id = '12000000-0000-0000-0000-000000000001';
insert into public.schedules (
  id, owner_id, schedule_key, cron_expression, schedule_type, enabled, payload,
  special_date, seoul_time, minimum_interval_minutes
) values (
  'c5000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001',
  'future-pricing', null, 'special', true, '{"kind":"daily_event"}',
  public.narrative_business_date(now()) + 1, time '09:00', 60
);
select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;
select throws_ok($$
  select public.queue_due_narrative_schedule_job(
    '10000000-0000-0000-0000-000000000001', 'c5000000-0000-0000-0000-000000000001',
    ((((now() at time zone 'Asia/Seoul')::date + 1) + time '09:00') at time zone 'Asia/Seoul')
  )
$$, 'P0001', 'invalid_provider_pricing', 'queueing fails closed for a persisted future verification date');

reset role;
insert into public.drafts (id, owner_id, kind, title) values
  ('c2000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000001', 'daily_event', 'future reserve'),
  ('c2000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000001', 'daily_event', 'risk reserve'),
  ('c2000000-0000-0000-0000-000000000004', '10000000-0000-0000-0000-000000000001', 'daily_event', 'manual reserve'),
  ('c2000000-0000-0000-0000-000000000005', '10000000-0000-0000-0000-000000000001', 'daily_event', 'weekly warning reserve');
insert into public.generation_jobs (
  id, owner_id, draft_id, schedule_key, scheduled_for, payload, idempotency_key,
  provider_setting_id, worst_case_cost_micros, attempt_token
) values
  ('c6000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'c2000000-0000-0000-0000-000000000002', 'future-reserve', now(), '{"kind":"daily_event","source":"schedule","budgetPolicy":"block_at_risk"}', 'future-reserve-key', '12000000-0000-0000-0000-000000000001', 10, 'c7000000-0000-4000-8000-000000000001'),
  ('c6000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000001', 'c2000000-0000-0000-0000-000000000003', 'risk-reserve', now(), '{"kind":"daily_event","source":"access","budgetPolicy":"block_at_risk"}', 'risk-reserve-key', '12000000-0000-0000-0000-000000000001', 10, 'c7000000-0000-4000-8000-000000000002'),
  ('c6000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000001', 'c2000000-0000-0000-0000-000000000004', 'confirmed-manual', now(), '{"kind":"daily_event","mode":"revise_selection","source":"manual","maximumCostConfirmed":true}', 'manual-reserve-key', '12000000-0000-0000-0000-000000000001', 10, 'c7000000-0000-4000-8000-000000000003');
insert into public.generation_jobs (
  id, owner_id, draft_id, schedule_key, scheduled_for, payload, idempotency_key,
  provider_setting_id, worst_case_cost_micros, attempt_token
) values (
  'c6000000-0000-0000-0000-000000000004', '10000000-0000-0000-0000-000000000001',
  'c2000000-0000-0000-0000-000000000005', 'weekly-warning-reserve', now(),
  '{"kind":"daily_event","source":"schedule","budgetPolicy":"block_at_warning"}', 'weekly-warning-reserve-key',
  '12000000-0000-0000-0000-000000000001', 10, 'c7000000-0000-4000-8000-000000000004'
);
update public.generation_jobs
set schedule_key = 'manual-reserve-key', generation_mode = 'new',
    payload = '{"kind":"daily_event","mode":"new","source":"manual","manualRequestKey":"manual-reserve-key","maximumCostConfirmed":true}'
where id = 'c6000000-0000-0000-0000-000000000003';
select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;
select throws_ok(
  $$ select public.reserve_and_start_generation('c6000000-0000-0000-0000-000000000001', 'c7000000-0000-4000-8000-000000000001', 10) $$,
  'P0001', 'invalid_provider_pricing', 'reservation fails closed for a persisted future verification date'
);
reset role;
update public.provider_settings
set pricing_verified_at = public.narrative_business_date(now())
where id = '12000000-0000-0000-0000-000000000001';
insert into public.budget_entries (
  owner_id, budget_period_id, amount_micros, entry_type, daily_bucket_date, description
)
select '10000000-0000-0000-0000-000000000001', id, 800, 'reservation',
  public.narrative_business_date(now()), 'warning after queue'
from public.budget_periods where owner_id = '10000000-0000-0000-0000-000000000001';
select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;
select is(
  public.reserve_and_start_generation('c6000000-0000-0000-0000-000000000004', 'c7000000-0000-4000-8000-000000000004', 10) ->> 'status',
  'blocked',
  'a queued weekly automatic job rechecks and blocks at the configured warning threshold'
);
reset role;
insert into public.budget_entries (
  owner_id, budget_period_id, amount_micros, entry_type, daily_bucket_date, description
)
select '10000000-0000-0000-0000-000000000001', id, 100, 'reservation',
  public.narrative_business_date(now()), 'risk after queue'
from public.budget_periods where owner_id = '10000000-0000-0000-0000-000000000001';
select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;
select is(
  public.reserve_and_start_generation('c6000000-0000-0000-0000-000000000002', 'c7000000-0000-4000-8000-000000000002', 10) ->> 'status',
  'blocked',
  'a queued automatic job rechecks and blocks at the configured risk threshold before provider work'
);
select is(
  public.reserve_and_start_generation('c6000000-0000-0000-0000-000000000003', 'c7000000-0000-4000-8000-000000000003', 10) ->> 'status',
  'reserved',
  'a confirmed manual job remains permitted below the atomic hard budget limit'
);

select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', 'c1000000-0000-0000-0000-000000000002', true);
set local role authenticated;
select throws_ok($$ select public.get_narrative_memory() $$, '42501', 'owner_access_required', 'non-owner cannot call memory read RPC directly');
select throws_ok($$ select public.set_narrative_memory_enabled('c4000000-0000-0000-0000-000000000001', false) $$, '42501', 'owner_access_required', 'non-owner cannot call memory write RPC directly');
select throws_ok($$ select public.correct_narrative_memory('c4000000-0000-0000-0000-000000000001', 'x', 'y') $$, '42501', 'owner_access_required', 'non-owner cannot call correction RPC directly');
select throws_ok($$ select public.get_narrative_schedules() $$, '42501', 'owner_access_required', 'non-owner cannot call schedule read RPC directly');
select throws_ok($$ select public.save_narrative_schedule(null, 'x', 'automatic', false, '09:00', null, null, 60, 'daily_event') $$, '42501', 'owner_access_required', 'non-owner cannot call schedule write RPC directly');
select throws_ok($$ select public.get_narrative_settings() $$, '42501', 'owner_access_required', 'non-owner cannot call settings read RPC directly');
select throws_ok($$ select public.save_narrative_settings(false, false, null, '[]', 1, 1, 1, 80, 95, 1300, 30) $$, '42501', 'owner_access_required', 'non-owner cannot call settings write RPC directly');

reset role;

select * from finish();
rollback;
