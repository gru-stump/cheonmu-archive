begin;

select plan(21);

select ok(
  not exists (
    select 1
    from pg_proc as procedure
    join pg_namespace as namespace on namespace.oid = procedure.pronamespace
    where namespace.nspname = 'public'
      and procedure.proname in ('reserve_generation_budget', 'reconcile_generation_budget', 'fail_generation_budget')
      and has_function_privilege('authenticated', procedure.oid, 'EXECUTE')
  ),
  'authenticated cannot execute any overload of trusted budget plumbing'
);
select ok(
  not exists (
    select 1
    from pg_proc as procedure
    join pg_namespace as namespace on namespace.oid = procedure.pronamespace
    where namespace.nspname = 'public'
      and procedure.proname in ('reserve_generation_budget', 'reconcile_generation_budget', 'fail_generation_budget')
      and has_function_privilege('anon', procedure.oid, 'EXECUTE')
  ),
  'anon cannot execute any overload of trusted budget plumbing'
);
select ok(
  not exists (
    select 1
    from pg_proc as procedure
    join pg_namespace as namespace on namespace.oid = procedure.pronamespace
    cross join lateral aclexplode(coalesce(procedure.proacl, acldefault('f', procedure.proowner))) as privilege
    where namespace.nspname = 'public'
      and procedure.proname in ('reserve_generation_budget', 'reconcile_generation_budget', 'fail_generation_budget')
      and privilege.grantee = 0
      and privilege.privilege_type = 'EXECUTE'
  ),
  'PUBLIC cannot execute any overload of trusted budget plumbing'
);
select ok(
  (
    select bool_and(has_function_privilege('service_role', procedure.oid, 'EXECUTE'))
    from pg_proc as procedure
    join pg_namespace as namespace on namespace.oid = procedure.pronamespace
    where namespace.nspname = 'public'
      and procedure.proname in ('reserve_generation_budget', 'reconcile_generation_budget', 'fail_generation_budget')
  ),
  'service_role retains every trusted budget helper'
);
select ok(
  not exists (
    select 1
    from pg_proc as procedure
    join pg_namespace as namespace on namespace.oid = procedure.pronamespace
    where namespace.nspname = 'public'
      and procedure.proname in ('transition_draft', 'transition_narrative_draft')
      and has_function_privilege('authenticated', procedure.oid, 'EXECUTE')
  ),
  'authenticated cannot execute any generic narrative draft transition overload'
);
select ok(
  has_function_privilege('service_role', 'public.transition_draft(uuid,text,text)', 'EXECUTE'),
  'service_role retains the internal transition primitive'
);

insert into public.drafts (id, owner_id, kind, title)
values
  ('f1000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'daily_event', 'generic bypass'),
  ('f1000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000001', 'daily_event', 'blocked review'),
  ('f1000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000001', 'daily_event', 'old policy review'),
  ('f1000000-0000-0000-0000-000000000004', '10000000-0000-0000-0000-000000000001', 'daily_event', 'tagged approval'),
  ('f1000000-0000-0000-0000-000000000005', '10000000-0000-0000-0000-000000000001', 'daily_event', 'rejected continuity');

insert into public.draft_versions (id, owner_id, draft_id, version_number, content, continuity_level, continuity_policy_version)
values
  ('f2000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000001', 'f1000000-0000-0000-0000-000000000002', 1, '{"kind":"daily_event","body":"blocked"}', 'block', 'cheonmu-continuity-v1'),
  ('f2000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000001', 'f1000000-0000-0000-0000-000000000003', 1, '{"kind":"daily_event","body":"old policy"}', 'review', 'cheonmu-continuity-v0'),
  ('f2000000-0000-0000-0000-000000000004', '10000000-0000-0000-0000-000000000001', 'f1000000-0000-0000-0000-000000000004', 1,
    '{"kind":"daily_event","title":"치료실의 약속","setting":{"place":"치료실","time":"밤"},"body":"천령과 무영은 약속을 지켰다.","continuityUsed":["rain-promise"],"continuityCandidates":["healing"]}', 'review', 'cheonmu-continuity-v1'),
  ('f2000000-0000-0000-0000-000000000005', '10000000-0000-0000-0000-000000000001', 'f1000000-0000-0000-0000-000000000005', 1,
    '{"kind":"daily_event","setting":{"place":"치료실","time":"낮"},"body":"승인되지 않은 사건","continuityCandidates":["unapproved"]}', 'block', 'cheonmu-continuity-v1');

update public.drafts set status = 'generated' where id = 'f1000000-0000-0000-0000-000000000001';
update public.drafts set status = 'reviewing' where id in (
  'f1000000-0000-0000-0000-000000000002', 'f1000000-0000-0000-0000-000000000003',
  'f1000000-0000-0000-0000-000000000004', 'f1000000-0000-0000-0000-000000000005'
);

select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-000000000001', true);
set local role authenticated;

select throws_ok(
  $$ select public.transition_draft('f1000000-0000-0000-0000-000000000001', 'generated', 'reviewing') $$,
  '42501', 'permission denied for function transition_draft',
  'an authenticated owner cannot enter review through the generic transition primitive'
);
select is((select status from public.drafts where id = 'f1000000-0000-0000-0000-000000000001'), 'generated', 'the denied transition leaves the draft unchanged');
select throws_ok(
  $$ select public.review_draft_atomic('f1000000-0000-0000-0000-000000000002', 'f2000000-0000-0000-0000-000000000002', 'reviewing', 'approve_private', null, 'blocked-approval', 'cheonmu-continuity-v1') $$,
  'P0001', 'version_not_approvable', 'blocked continuity cannot be approved through the guarded review RPC'
);
select throws_ok(
  $$ select public.review_draft_atomic('f1000000-0000-0000-0000-000000000003', 'f2000000-0000-0000-0000-000000000003', 'reviewing', 'approve_public', null, 'old-policy-approval', 'cheonmu-continuity-v1') $$,
  'P0001', 'version_not_approvable', 'old-policy continuity cannot be published through the guarded review RPC'
);
select is((select count(*) from public.memory_items where source_draft_version_id in ('f2000000-0000-0000-0000-000000000002', 'f2000000-0000-0000-0000-000000000003')), 0::bigint, 'failed approvals create no incomplete memory state');
select is((select count(*) from public.drafts where id in ('f1000000-0000-0000-0000-000000000002', 'f1000000-0000-0000-0000-000000000003') and status = 'reviewing'), 2::bigint, 'failed approvals leave both drafts reviewing');

select lives_ok(
  $$ select public.review_draft_atomic('f1000000-0000-0000-0000-000000000004', 'f2000000-0000-0000-0000-000000000004', 'reviewing', 'approve_private', null, 'tagged-approval', 'cheonmu-continuity-v1') $$,
  'valid approval promotes continuity atomically'
);
select is(
  (select metadata -> 'tags' from public.memory_items where source_draft_version_id = 'f2000000-0000-0000-0000-000000000004'),
  '["치료실", "밤", "rain-promise", "healing"]'::jsonb,
  'approval persists deterministic relevance tags for later context selection'
);
select is(
  (select metadata #>> '{continuityFacts,continuityId}' from public.memory_items where source_draft_version_id = 'f2000000-0000-0000-0000-000000000004'),
  'f2000000-0000-0000-0000-000000000004',
  'approval persists structured continuity identity'
);
select is(
  (
    select array_agg(source_draft_version_id order by source_draft_version_id)
    from public.memory_items
    where memory_type = 'continuity'
      and status = 'approved'
      and metadata -> 'tags' ? 'rain-promise'
  ),
  array['f2000000-0000-0000-0000-000000000004'::uuid],
  'the next tagged-context predicate selects only the newly approved continuity'
);
select ok(
  (select jsonb_array_length(metadata -> 'tags') <= 20 and not exists (
    select 1 from jsonb_array_elements_text(metadata -> 'tags') as tag where length(tag) > 100
  ) from public.memory_items where source_draft_version_id = 'f2000000-0000-0000-0000-000000000004'),
  'approval metadata is bounded'
);
select lives_ok(
  $$ select public.review_draft_atomic('f1000000-0000-0000-0000-000000000005', 'f2000000-0000-0000-0000-000000000005', 'reviewing', 'reject', '승인되지 않은 사건', 'reject-unapproved', 'cheonmu-continuity-v1') $$,
  'rejection remains available for blocked content'
);
select is((select count(*) from public.memory_items where source_draft_version_id = 'f2000000-0000-0000-0000-000000000005' and memory_type = 'continuity'), 0::bigint, 'rejected content never becomes continuity memory');

reset role;

select is((select schedule from cron.job where jobname = 'narrative-schedule-dispatcher'), '* * * * *', 'dispatcher runs every minute so every accepted minute is reachable');
select is((select count(*) from cron.job where jobname = 'narrative-schedule-dispatcher'), 1::bigint, 'the every-minute dispatcher remains idempotently single');

select * from finish();
rollback;
