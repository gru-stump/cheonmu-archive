-- `local.invalid` is reserved for non-routable development fixtures.
insert into auth.users (
  instance_id,
  id,
  aud,
  role,
  email,
  encrypted_password,
  confirmation_token,
  recovery_token,
  email_change_token_new,
  email_change,
  email_change_token_current,
  phone_change_token,
  reauthentication_token,
  email_confirmed_at,
  raw_app_meta_data,
  raw_user_meta_data,
  created_at,
  updated_at
)
values (
  '00000000-0000-0000-0000-000000000000',
  '10000000-0000-0000-0000-000000000001',
  'authenticated',
  'authenticated',
  'narrative-seed-owner@local.invalid',
  '$2a$10$seedfixturesonlynotarealcredential0000000000000000000000000',
  '',
  '',
  '',
  '',
  '',
  '',
  '',
  '2026-08-01T00:00:00Z',
  '{"provider":"email","providers":["email"]}'::jsonb,
  '{}'::jsonb,
  '2026-08-01T00:00:00Z',
  '2026-08-01T00:00:00Z'
)
on conflict (id) do nothing;

insert into public.owner_profiles (id, owner_id, display_name)
values (
  '11000000-0000-0000-0000-000000000001',
  '10000000-0000-0000-0000-000000000001',
  'Local narrative owner'
)
on conflict (owner_id) do update set display_name = excluded.display_name;

insert into public.provider_settings (
  id, owner_id, provider_key, enabled, configuration, model_key,
  max_input_tokens, max_output_tokens, max_revision_output_tokens,
  input_cost_micros_per_million, output_cost_micros_per_million, fixed_cost_micros,
  pricing_verified_at
)
values (
  '12000000-0000-0000-0000-000000000001',
  '10000000-0000-0000-0000-000000000001',
  'fake-local-provider',
  true,
  '{"mode":"fixture"}'::jsonb,
  'fake-local-model',
  4096,
  1024,
  256,
  0,
  0,
  100,
  public.narrative_business_date(current_timestamp)
)
on conflict (owner_id, provider_key) do update
set enabled = excluded.enabled,
    configuration = excluded.configuration,
    model_key = excluded.model_key,
    max_input_tokens = excluded.max_input_tokens,
    max_output_tokens = excluded.max_output_tokens,
    max_revision_output_tokens = excluded.max_revision_output_tokens,
    input_cost_micros_per_million = excluded.input_cost_micros_per_million,
    output_cost_micros_per_million = excluded.output_cost_micros_per_million,
    fixed_cost_micros = excluded.fixed_cost_micros,
    pricing_verified_at = excluded.pricing_verified_at;

insert into public.narrative_admin_settings (
  owner_id, automation_enabled, manual_generation_enabled, schedule_automation_enabled
)
values ('10000000-0000-0000-0000-000000000001', true, true, false)
on conflict (owner_id) do update
set manual_generation_enabled = excluded.manual_generation_enabled,
    schedule_automation_enabled = excluded.schedule_automation_enabled,
    updated_at = now();

insert into public.memory_items (
  id, owner_id, memory_type, content, importance, metadata, status, blocking
)
values (
  '15000000-0000-0000-0000-000000000001',
  '10000000-0000-0000-0000-000000000001',
  'canon',
  'Cheonryeong and Muyeong have an established private bond.',
  100,
  '{"tokenCount":14,"continuityFacts":{"relationshipStage":7,"forbiddenReveals":[],"permanentEntities":["Cheonryeong","Muyeong"],"permanentSettings":["Cheonma residence"],"voiceAndTitleRules":true}}'::jsonb,
  'approved',
  false
)
on conflict (id) do update
set content = excluded.content,
    importance = excluded.importance,
    metadata = excluded.metadata,
    status = excluded.status,
    blocking = excluded.blocking;

insert into public.memory_items (
  id, owner_id, memory_type, content, importance, metadata, status, blocking
)
values (
  '15000000-0000-0000-0000-000000000002',
  '10000000-0000-0000-0000-000000000001',
  'canon',
  '무영은 관계 단계와 무관하게 천령을 ''천령 의료관님''이라고 부른다. 대화의 맥락이 분명할 때는 ''의료관님''으로 줄여 부른다. ''천령 선생''과 ''선생님''은 사용하지 않는다. 감정이 크게 흔들릴 때만 ''천령''이라고 부른다.',
  100,
  '{"canonKey":"muyeong-cheonryeong-appellation-v1","tokenCount":70,"continuityFacts":{"relationshipStage":7,"voiceAndTitleRules":true}}'::jsonb,
  'approved',
  false
)
on conflict (id) do update
set content = excluded.content,
    importance = excluded.importance,
    metadata = excluded.metadata,
    status = excluded.status,
    blocking = excluded.blocking;

insert into public.budget_periods (id, owner_id, currency, period_start, period_end, limit_micros, daily_limit_micros)
values (
  '13000000-0000-0000-0000-000000000001',
  '10000000-0000-0000-0000-000000000001',
  'USD',
  date '2026-08-01',
  date '2026-08-31',
  100000000,
  100000000
)
on conflict (owner_id, currency, period_start, period_end) do update
set limit_micros = excluded.limit_micros,
    daily_limit_micros = excluded.daily_limit_micros;

insert into public.schedules (id, owner_id, schedule_key, cron_expression, enabled, payload)
values
  (
    '14000000-0000-0000-0000-000000000001',
    '10000000-0000-0000-0000-000000000001',
    'daily-local-fixture',
    '0 9 * * *',
    false,
    '{}'::jsonb
  ),
  (
    '14000000-0000-0000-0000-000000000002',
    '10000000-0000-0000-0000-000000000001',
    'weekly-local-fixture',
    '0 9 * * 1',
    false,
    '{}'::jsonb
  )
on conflict (owner_id, schedule_key) do update
set cron_expression = excluded.cron_expression,
    enabled = excluded.enabled,
    payload = excluded.payload;
