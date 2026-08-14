begin;

select plan(17);

insert into public.drafts (id, owner_id, kind, title)
values
  ('81000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'daily_event', 'reject fixture'),
  ('81000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000001', 'daily_event', 'private fixture'),
  ('81000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000001', 'daily_event', 'public fixture');

insert into public.draft_versions (id, owner_id, draft_id, version_number, content, continuity_level, continuity_policy_version)
values
  ('82000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', '81000000-0000-0000-0000-000000000001', 1, '{"body":"reject body"}', 'block', 'cheonmu-continuity-v1'),
  ('82000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000001', '81000000-0000-0000-0000-000000000002', 1, '{"body":"private body"}', 'review', 'cheonmu-continuity-v1'),
  ('82000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000001', '81000000-0000-0000-0000-000000000003', 1, '{"body":"public body"}', 'review', 'cheonmu-continuity-v1');

update public.drafts set status = 'reviewing'
where id in (
  '81000000-0000-0000-0000-000000000001',
  '81000000-0000-0000-0000-000000000002',
  '81000000-0000-0000-0000-000000000003'
);

select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-000000000001', true);
set local role authenticated;

select lives_ok(
  $$ select public.review_draft_atomic('81000000-0000-0000-0000-000000000001', '82000000-0000-0000-0000-000000000001', 'reviewing', 'reject', '인물이 맞지 않음', 'reject-once', 'cheonmu-continuity-v1') $$,
  'reject commits atomically'
);
select is((select status from public.drafts where id = '81000000-0000-0000-0000-000000000001'), 'rejected', 'reject transitions the draft');
select is((select count(*) from public.memory_items where source_draft_version_id = '82000000-0000-0000-0000-000000000001' and memory_type = 'feedback'), 1::bigint, 'reject writes one feedback memory');
select is((select count(*) from public.memory_items where source_draft_version_id = '82000000-0000-0000-0000-000000000001' and memory_type = 'continuity'), 0::bigint, 'reject never promotes continuity');
select is((select count(*) from public.publish_jobs where draft_version_id = '82000000-0000-0000-0000-000000000001'), 0::bigint, 'reject never queues publishing');
select throws_ok(
  $$ select public.review_draft_atomic('81000000-0000-0000-0000-000000000001', '82000000-0000-0000-0000-000000000001', 'reviewing', 'reject', 'duplicate', 'reject-once', 'cheonmu-continuity-v1') $$,
  'P0001', 'duplicate_review', 'a duplicate review action returns a conflict signal'
);

select lives_ok(
  $$ select public.review_draft_atomic('81000000-0000-0000-0000-000000000002', '82000000-0000-0000-0000-000000000002', 'reviewing', 'approve_private', null, 'private-once', 'cheonmu-continuity-v1') $$,
  'private approval commits atomically'
);
select is((select status from public.drafts where id = '81000000-0000-0000-0000-000000000002'), 'approved_private', 'private approval uses the private state');
select is((select count(*) from public.memory_items where source_draft_version_id = '82000000-0000-0000-0000-000000000002' and memory_type = 'continuity' and status = 'approved'), 1::bigint, 'private approval writes approved continuity');
select is((select count(*) from public.publish_jobs where draft_version_id = '82000000-0000-0000-0000-000000000002'), 0::bigint, 'private approval does not queue publishing');

select lives_ok(
  $$ select public.review_draft_atomic('81000000-0000-0000-0000-000000000003', '82000000-0000-0000-0000-000000000003', 'reviewing', 'approve_public', null, 'public-once', 'cheonmu-continuity-v1') $$,
  'public approval commits atomically'
);
select is((select status from public.drafts where id = '81000000-0000-0000-0000-000000000003'), 'approved', 'public approval reaches approved through legal transitions');
select is((select count(*) from public.memory_items where source_draft_version_id = '82000000-0000-0000-0000-000000000003' and memory_type = 'continuity' and status = 'approved'), 1::bigint, 'public approval writes approved continuity');
select is((select count(*) from public.publish_jobs where draft_version_id = '82000000-0000-0000-0000-000000000003' and status = 'queued'), 1::bigint, 'public approval queues exactly one publish job');
select is((select count(*) from public.draft_review_actions where draft_version_id = '82000000-0000-0000-0000-000000000003'), 1::bigint, 'public approval records one review action');
select throws_ok(
  $$ select public.review_draft_atomic('81000000-0000-0000-0000-000000000003', '82000000-0000-0000-0000-000000000003', 'reviewing', 'approve_public', null, 'public-stale', 'cheonmu-continuity-v1') $$,
  'P0001', 'stale_review', 'a stale optimistic transition returns a conflict signal'
);
select is((select count(*) from public.draft_review_actions where draft_version_id = '82000000-0000-0000-0000-000000000003'), 1::bigint, 'a stale review leaves no partial action row');

reset role;

select * from finish();

rollback;
