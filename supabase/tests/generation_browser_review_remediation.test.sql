begin;

select plan(25);

select has_function(
  'public', 'submit_draft_for_review', array['uuid', 'uuid', 'text'],
  'owner review submission has one narrow expected-state/version RPC'
);
select ok(
  has_function_privilege('authenticated', 'public.submit_draft_for_review(uuid,uuid,text)', 'EXECUTE'),
  'authenticated owners can submit generated drafts for review'
);
select ok(
  not has_function_privilege('anon', 'public.submit_draft_for_review(uuid,uuid,text)', 'EXECUTE')
  and not has_function_privilege('service_role', 'public.submit_draft_for_review(uuid,uuid,text)', 'EXECUTE'),
  'anonymous and service roles cannot use the owner-only submission RPC'
);
select ok(
  not has_function_privilege('authenticated', 'public.transition_draft(uuid,text,text)', 'EXECUTE')
  and has_function_privilege('service_role', 'public.transition_draft(uuid,text,text)', 'EXECUTE'),
  'the generic transition primitive remains service-only'
);
select ok(
  not exists (
    select 1
    from pg_proc as procedure
    join pg_namespace as namespace on namespace.oid = procedure.pronamespace
    where namespace.nspname = 'public'
      and procedure.proname in ('reserve_generation_budget', 'reconcile_generation_budget', 'fail_generation_budget')
      and has_function_privilege('authenticated', procedure.oid, 'EXECUTE')
  ),
  'trusted budget mutation RPCs remain unavailable to authenticated users'
);

insert into public.drafts (id, owner_id, kind, title)
values
  ('d1000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'daily_event', 'review path'),
  ('d1000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000001', 'daily_event', 'stale version'),
  ('d1000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000001', 'daily_event', 'queued state'),
  ('d1000000-0000-0000-0000-000000000004', '10000000-0000-0000-0000-000000000001', 'daily_event', 'blocked result'),
  ('d1000000-0000-0000-0000-000000000005', '10000000-0000-0000-0000-000000000001', 'daily_event', 'foreign owner probe');

insert into public.draft_versions (id, owner_id, draft_id, version_number, content, continuity_level, continuity_policy_version)
values
  ('d2000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'd1000000-0000-0000-0000-000000000001', 1, '{"kind":"daily_event","body":"review me"}', 'review', 'cheonmu-continuity-v1'),
  ('d2000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000001', 'd1000000-0000-0000-0000-000000000002', 1, '{"kind":"daily_event","body":"old"}', 'review', 'cheonmu-continuity-v1'),
  ('d2000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000001', 'd1000000-0000-0000-0000-000000000002', 2, '{"kind":"daily_event","body":"latest"}', 'review', 'cheonmu-continuity-v1'),
  ('d2000000-0000-0000-0000-000000000004', '10000000-0000-0000-0000-000000000001', 'd1000000-0000-0000-0000-000000000003', 1, '{"kind":"daily_event","body":"queued"}', 'review', 'cheonmu-continuity-v1'),
  ('d2000000-0000-0000-0000-000000000005', '10000000-0000-0000-0000-000000000001', 'd1000000-0000-0000-0000-000000000004', 1, '{"kind":"daily_event","body":"blocked"}', 'block', 'cheonmu-continuity-v1'),
  ('d2000000-0000-0000-0000-000000000006', '10000000-0000-0000-0000-000000000001', 'd1000000-0000-0000-0000-000000000005', 1, '{"kind":"daily_event","body":"private"}', 'review', 'cheonmu-continuity-v1');

update public.drafts
set status = 'generated'
where id in (
  'd1000000-0000-0000-0000-000000000001', 'd1000000-0000-0000-0000-000000000002',
  'd1000000-0000-0000-0000-000000000004', 'd1000000-0000-0000-0000-000000000005'
);

select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-000000000001', true);
set local role authenticated;

select throws_ok(
  $$ select public.submit_draft_for_review('d1000000-0000-0000-0000-000000000001', 'd2000000-0000-0000-0000-000000000001', 'reviewing') $$,
  '22023', 'invalid_review_submission',
  'the owner command cannot request a transition other than generated to reviewing'
);
select throws_ok(
  $$ select public.submit_draft_for_review('d1000000-0000-0000-0000-000000000003', 'd2000000-0000-0000-0000-000000000004', 'generated') $$,
  'P0001', 'stale_review_submission',
  'a draft not currently generated is rejected as stale'
);
select throws_ok(
  $$ select public.submit_draft_for_review('d1000000-0000-0000-0000-000000000002', 'd2000000-0000-0000-0000-000000000002', 'generated') $$,
  'P0001', 'stale_review_submission',
  'a non-latest version cannot enter review'
);
select is(
  (select status from public.drafts where id = 'd1000000-0000-0000-0000-000000000002'),
  'generated',
  'a stale version leaves the generated draft unchanged'
);

select set_config('request.jwt.claim.sub', '20000000-0000-0000-0000-000000000002', true);
select throws_ok(
  $$ select public.submit_draft_for_review('d1000000-0000-0000-0000-000000000005', 'd2000000-0000-0000-0000-000000000006', 'generated') $$,
  'P0002', 'review target not found',
  'a foreign draft is not disclosed or transitioned'
);
select set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-000000000001', true);

select lives_ok(
  $$ select public.submit_draft_for_review('d1000000-0000-0000-0000-000000000001', 'd2000000-0000-0000-0000-000000000001', 'generated') $$,
  'the owner can submit the latest generated version for review'
);
select is(
  (select status from public.drafts where id = 'd1000000-0000-0000-0000-000000000001'),
  'reviewing',
  'submission performs exactly generated to reviewing'
);
select lives_ok(
  $$ select public.review_draft_atomic('d1000000-0000-0000-0000-000000000001', 'd2000000-0000-0000-0000-000000000001', 'reviewing', 'approve_private', null, 'remediation-approve', 'cheonmu-continuity-v1') $$,
  'the guarded review action is reachable after owner submission'
);
select is(
  (select status from public.drafts where id = 'd1000000-0000-0000-0000-000000000001'),
  'approved_private',
  'the full generated-reviewing-guarded approval path completes'
);
select is(
  (select count(*) from public.memory_items where source_draft_version_id = 'd2000000-0000-0000-0000-000000000001' and status = 'approved'),
  1::bigint,
  'guarded private approval promotes exactly one continuity memory'
);
select throws_ok(
  $$ select public.submit_draft_for_review('d1000000-0000-0000-0000-000000000001', 'd2000000-0000-0000-0000-000000000001', 'generated') $$,
  'P0001', 'stale_review_submission',
  'an already-reviewed draft cannot be resubmitted'
);

select lives_ok(
  $$ select public.submit_draft_for_review('d1000000-0000-0000-0000-000000000004', 'd2000000-0000-0000-0000-000000000005', 'generated') $$,
  'blocked generated content may enter review for explicit rejection'
);
select throws_ok(
  $$ select public.review_draft_atomic('d1000000-0000-0000-0000-000000000004', 'd2000000-0000-0000-0000-000000000005', 'reviewing', 'approve_private', null, 'blocked-approve', 'cheonmu-continuity-v1') $$,
  'P0001', 'version_not_approvable',
  'submission does not loosen blocked-version approval policy'
);
select throws_ok(
  $$ select public.review_draft_atomic('d1000000-0000-0000-0000-000000000004', 'd2000000-0000-0000-0000-000000000005', 'reviewing', 'approve_public', null, 'blocked-publish', 'cheonmu-continuity-v1') $$,
  'P0001', 'version_not_approvable',
  'submission does not loosen blocked-version publication policy'
);
select lives_ok(
  $$ select public.review_draft_atomic('d1000000-0000-0000-0000-000000000004', 'd2000000-0000-0000-0000-000000000005', 'reviewing', 'reject', 'blocked by continuity policy', 'blocked-reject', 'cheonmu-continuity-v1') $$,
  'blocked content remains rejectable through guarded review'
);
select is(
  (select status from public.drafts where id = 'd1000000-0000-0000-0000-000000000004'),
  'rejected',
  'blocked content cannot escape the guarded rejection path'
);
select is(
  (select count(*) from public.memory_items where source_draft_version_id = 'd2000000-0000-0000-0000-000000000005' and memory_type = 'continuity'),
  0::bigint,
  'blocked content never becomes continuity memory'
);
select is(
  (select count(*) from public.publish_jobs where draft_version_id = 'd2000000-0000-0000-0000-000000000005'),
  0::bigint,
  'blocked content never creates a publication job'
);
select is(
  (select count(*) from public.memory_items where source_draft_version_id = 'd2000000-0000-0000-0000-000000000005' and memory_type = 'feedback' and status = 'active' and blocking),
  1::bigint,
  'explicit rejection records exactly one blocking feedback memory'
);

reset role;
set local role anon;

select throws_ok(
  $$ select public.submit_draft_for_review('d1000000-0000-0000-0000-000000000002', 'd2000000-0000-0000-0000-000000000003', 'generated') $$,
  '42501', 'permission denied for function submit_draft_for_review',
  'anonymous callers cannot call the owner submission command'
);

reset role;

select * from finish();
rollback;
