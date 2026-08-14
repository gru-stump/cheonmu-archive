begin;

select plan(6);

select has_table('public', 'drafts', 'drafts exists');
select policies_are('public', 'drafts', array['owner can manage drafts']);
select throws_ok(
  $$ select transition_draft(gen_random_uuid(), 'generated', 'published') $$,
  'P0001',
  'illegal draft transition'
);

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
  '20000000-0000-0000-0000-000000000002',
  'authenticated',
  'authenticated',
  'narrative-test-other-owner@local.invalid',
  '$2a$10$testfixturesonlynotarealcredential0000000000000000000000000',
  '2026-08-01T00:00:00Z',
  '{"provider":"email","providers":["email"]}'::jsonb,
  '{}'::jsonb,
  '2026-08-01T00:00:00Z',
  '2026-08-01T00:00:00Z'
)
on conflict (id) do nothing;

insert into public.drafts (id, owner_id, kind, status, title)
values
  ('30000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'daily_event', 'generated', 'Direct update guard'),
  ('30000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000001', 'daily_event', 'generated', 'Legal transition'),
  ('30000000-0000-0000-0000-000000000003', '20000000-0000-0000-0000-000000000002', 'daily_event', 'generated', 'Other owner draft');

select set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-000000000001', true);
set local role authenticated;

select throws_ok(
  $$ update public.drafts set status = 'published' where id = '30000000-0000-0000-0000-000000000001' $$,
  'P0001',
  'illegal draft status change'
);
select is(
  (select status from public.transition_draft('30000000-0000-0000-0000-000000000002', 'generated', 'reviewing')),
  'reviewing',
  'owner can make a legal transition through the RPC'
);
select throws_ok(
  $$ select public.transition_draft('30000000-0000-0000-0000-000000000003', 'generated', 'reviewing') $$,
  'P0002',
  'draft not found or transition expectation did not match'
);

reset role;

select * from finish();

rollback;
