begin;

select plan(6);

select has_table('public', 'drafts', 'drafts exists');
select policies_are('public', 'drafts', array['owner can read drafts']);
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

insert into public.drafts (id, owner_id, kind, title)
values
  ('30000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'daily_event', 'Direct update guard'),
  ('30000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000001', 'daily_event', 'Legal transition'),
  ('30000000-0000-0000-0000-000000000003', '20000000-0000-0000-0000-000000000002', 'daily_event', 'Other owner draft');

update public.drafts
set status = 'generated'
where id in (
  '30000000-0000-0000-0000-000000000001',
  '30000000-0000-0000-0000-000000000002',
  '30000000-0000-0000-0000-000000000003'
);

select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-000000000001', true);
set local role authenticated;

select throws_ok(
  $$ update public.drafts set status = 'published' where id = '30000000-0000-0000-0000-000000000001' $$,
  '42501',
  null,
  'authenticated cannot update draft status directly'
);
select throws_ok(
  $$ select public.transition_draft('30000000-0000-0000-0000-000000000002', 'generated', 'reviewing') $$,
  '42501',
  'permission denied for function transition_draft',
  'owner cannot bypass guarded review through the generic transition RPC'
);
select throws_ok(
  $$ select public.transition_draft('30000000-0000-0000-0000-000000000003', 'generated', 'reviewing') $$,
  '42501',
  'permission denied for function transition_draft',
  'generic transition denial does not reveal another owner draft'
);

reset role;

select * from finish();

rollback;
