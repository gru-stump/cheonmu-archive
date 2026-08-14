-- `local.invalid` is reserved for non-routable development fixtures.
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
  '10000000-0000-0000-0000-000000000001',
  'authenticated',
  'authenticated',
  'narrative-seed-owner@local.invalid',
  '$2a$10$seedfixturesonlynotarealcredential0000000000000000000000000',
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

insert into public.provider_settings (id, owner_id, provider_key, enabled, configuration)
values (
  '12000000-0000-0000-0000-000000000001',
  '10000000-0000-0000-0000-000000000001',
  'fake-local-provider',
  false,
  '{"mode":"fixture"}'::jsonb
)
on conflict (owner_id, provider_key) do update
set enabled = excluded.enabled,
    configuration = excluded.configuration;

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
