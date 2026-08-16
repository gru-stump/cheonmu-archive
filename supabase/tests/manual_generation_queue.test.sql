begin;

select plan(29);

select has_function(
  'public', 'queue_manual_generation',
  array['uuid', 'text', 'text', 'text', 'text', 'text[]'],
  'owner manual generation has one atomic queue boundary'
);
select ok(
  has_function_privilege('authenticated', 'public.queue_manual_generation(uuid,text,text,text,text,text[])', 'EXECUTE')
    and not has_function_privilege('anon', 'public.queue_manual_generation(uuid,text,text,text,text,text[])', 'EXECUTE')
    and not has_function_privilege('service_role', 'public.queue_manual_generation(uuid,text,text,text,text,text[])', 'EXECUTE'),
  'only authenticated owners can queue manual generation'
);

update public.narrative_admin_settings set manual_generation_enabled = false
where owner_id = '10000000-0000-0000-0000-000000000001';
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-000000000001', true);
set local role authenticated;
select throws_ok(
  $$ select public.queue_manual_generation(null, 'new', 'short_dialogue', '정책 차단', 'seed', array['tag']) $$,
  'P0001', 'manual_generation_disabled', 'manual-off rejects before creating a draft or job'
);
select is((select count(*) from public.drafts where title = '정책 차단'), 0::bigint, 'policy rejection is atomic');

reset role;
update public.narrative_admin_settings set manual_generation_enabled = true, manual_call_limit = 10
where owner_id = '10000000-0000-0000-0000-000000000001';
update public.provider_settings set pricing_verified_at = public.narrative_business_date(now()) - 31
where id = '12000000-0000-0000-0000-000000000001';
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-000000000001', true);
set local role authenticated;
select throws_ok(
  $$ select public.queue_manual_generation(null, 'new', 'daily_event', '오래된 단가', null, array[]::text[]) $$,
  'P0001', 'stale_provider_pricing', 'stale pricing rejects before manual queue creation'
);
select is((select count(*) from public.drafts where title = '오래된 단가'), 0::bigint, 'pricing rejection is atomic');

reset role;
update public.provider_settings set pricing_verified_at = public.narrative_business_date(now())
where id = '12000000-0000-0000-0000-000000000001';
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-000000000001', true);
set local role authenticated;

create temp table manual_short_result as
select public.queue_manual_generation(null, 'new', 'short_dialogue', '새 수동 대화', '빗소리', array['비', '약속']) as value;
select is((select concat(value ->> 'mode', '|', value ->> 'kind') from manual_short_result), 'new|short_dialogue', 'new request returns server-derived mode and kind');
select is(
  (select concat(draft.owner_id, '|', draft.status, '|', draft.title)
   from public.drafts as draft where draft.id = (select (value ->> 'draft_id')::uuid from manual_short_result)),
  '10000000-0000-0000-0000-000000000001|queued|새 수동 대화', 'new request atomically creates the owned queued draft'
);
select is(
  (select concat(job.payload ->> 'source', '|', job.payload ->> 'mode', '|', job.payload ->> 'kind', '|', job.payload ->> 'seed', '|', job.provider_setting_id, '|', job.idempotency_key is null)
   from public.generation_jobs as job where job.id = (select (value ->> 'job_id')::uuid from manual_short_result)),
  'manual|new|short_dialogue|빗소리|12000000-0000-0000-0000-000000000001|t', 'job stores server-owned source/mode/kind/provider while freeze retains the idempotency fence'
);
select is(
  (select (value -> 'tags')::text from manual_short_result),
  '["비", "약속"]', 'bounded tags round-trip from the owner request'
);
select throws_ok(
  $$ select public.queue_manual_generation(null, 'major_event_scene_plan', 'major_event_proposal', '단계 위조', null, array[]::text[]) $$,
  'P0001', 'manual_generation_mode_mismatch', 'a browser cannot select a later mode for a new draft'
);
select throws_ok(
  $$ select public.queue_manual_generation(null, 'new', 'browser_kind', '종류 위조', null, array[]::text[]) $$,
  '22023', 'invalid_manual_generation_request', 'kind input is bounded by the owner command'
);
select throws_ok(
  $$ select public.queue_manual_generation(null, 'new', 'daily_event', '', null, array[]::text[]) $$,
  '22023', 'invalid_manual_generation_request', 'blank titles are rejected'
);
select throws_ok(
  $$ select public.queue_manual_generation(null, null, 'daily_event', '누락 모드', null, array[]::text[]) $$,
  '22023', 'invalid_manual_generation_request', 'a missing requested mode fails closed'
);
select throws_ok(
  $$ select public.queue_manual_generation(null, 'new', null, '누락 종류', null, array[]::text[]) $$,
  '22023', 'invalid_manual_generation_request', 'a missing new-draft kind fails closed'
);

create temp table manual_major_result as
select public.queue_manual_generation(null, 'new', 'major_event_proposal', '중대 사건', '봉인된 서신', array['정사']) as value;
select is(
  (select workflow.phase from public.major_event_workflows as workflow where workflow.draft_id = (select (value ->> 'draft_id')::uuid from manual_major_result)),
  'proposal', 'a new major request atomically creates its proposal workflow'
);
select throws_ok(
  $$ select public.queue_manual_generation((select (value ->> 'draft_id')::uuid from manual_major_result), 'major_event_scene_plan', null, null, null, null) $$,
  'P0001', 'workflow_phase_not_approved', 'a later major stage requires the approved workflow phase'
);

reset role;
update public.drafts set status = 'approved_private'
where id = (select (value ->> 'draft_id')::uuid from manual_major_result);
update public.major_event_workflows set phase = 'proposal_approved'
where draft_id = (select (value ->> 'draft_id')::uuid from manual_major_result);
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-000000000001', true);
set local role authenticated;
select throws_ok(
  $$ select public.queue_manual_generation((select (value ->> 'draft_id')::uuid from manual_major_result), 'major_event_draft', null, null, null, null) $$,
  'P0001', 'manual_generation_mode_mismatch', 'the owner cannot skip the workflow-derived next stage'
);
create temp table manual_scene_result as
select public.queue_manual_generation(
  (select (value ->> 'draft_id')::uuid from manual_major_result),
  'major_event_scene_plan', null, null, null, null
) as value;
select is((select value ->> 'mode' from manual_scene_result), 'major_event_scene_plan', 'approved proposal derives the scene-plan mode');
select is(
  (select status from public.drafts where id = (select (value ->> 'draft_id')::uuid from manual_scene_result)),
  'queued', 'later-stage queue safely requeues the approved private draft'
);
select is(
  (select concat(job.payload ->> 'source', '|', job.payload ->> 'mode', '|', job.provider_setting_id, '|', job.payload ->> 'manualRequestKey')
   from public.generation_jobs as job where job.id = (select (value ->> 'job_id')::uuid from manual_scene_result)),
  (select concat('manual|major_event_scene_plan|12000000-0000-0000-0000-000000000001|', value ->> 'idempotency_key') from manual_scene_result),
  'later-stage job binds source, derived mode, provider, and server idempotency key'
);

reset role;
grant select on manual_scene_result to service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;
select throws_ok(
  $$ select public.freeze_generation_context(
    (select (value ->> 'job_id')::uuid from manual_scene_result),
    (select (value ->> 'draft_id')::uuid from manual_scene_result),
    'major_event_draft', (select value ->> 'idempotency_key' from manual_scene_result),
    array['15000000-0000-0000-0000-000000000001'],
    '[{"versionId":"15000000-0000-0000-0000-000000000001","memoryType":"canon","content":"frozen","tokenCount":1}]',
    '12000000-0000-0000-0000-000000000001', 'da000000-0000-4000-8000-000000000001'
  ) $$,
  'P0001', 'manual_generation_binding_changed', 'direct Edge mode substitution is fenced at freeze'
);
select throws_ok(
  $$ select public.freeze_generation_context(
    (select (value ->> 'job_id')::uuid from manual_scene_result),
    (select (value ->> 'draft_id')::uuid from manual_scene_result),
    'major_event_scene_plan', (select value ->> 'idempotency_key' from manual_scene_result),
    array['15000000-0000-0000-0000-000000000001'],
    '[{"versionId":"15000000-0000-0000-0000-000000000001","memoryType":"canon","content":"frozen","tokenCount":1}]',
    '12000000-0000-0000-0000-000000000099', 'da000000-0000-4000-8000-000000000002'
  ) $$,
  'P0001', 'manual_generation_binding_changed', 'direct Edge provider substitution is fenced at freeze'
);
select lives_ok(
  $$ select public.freeze_generation_context(
    (select (value ->> 'job_id')::uuid from manual_scene_result),
    (select (value ->> 'draft_id')::uuid from manual_scene_result),
    'major_event_scene_plan', (select value ->> 'idempotency_key' from manual_scene_result),
    array['15000000-0000-0000-0000-000000000001'],
    '[{"versionId":"15000000-0000-0000-0000-000000000001","memoryType":"canon","content":"frozen","tokenCount":1}]',
    '12000000-0000-0000-0000-000000000001', 'da000000-0000-4000-8000-000000000003'
  ) $$,
  'the exact server-returned binding freezes successfully'
);
select is(
  (select concat(generation_mode, '|', idempotency_key, '|', provider_setting_id)
   from public.generation_jobs where id = (select (value ->> 'job_id')::uuid from manual_scene_result)),
  (select concat('major_event_scene_plan|', value ->> 'idempotency_key', '|12000000-0000-0000-0000-000000000001') from manual_scene_result),
  'freeze preserves the exact queued manual binding'
);
select is(
  public.reserve_and_start_generation(
    (select (value ->> 'job_id')::uuid from manual_scene_result),
    'da000000-0000-4000-8000-000000000003',
    (select worst_case_cost_micros from public.generation_jobs where id = (select (value ->> 'job_id')::uuid from manual_scene_result))
  ) ->> 'status',
  'reserved', 'the real owner-queued manual job enters the atomic manual reserve path'
);

reset role;
update public.generation_jobs set status = 'completed'
where id = (select (value ->> 'job_id')::uuid from manual_scene_result);
update public.drafts set status = 'approved_private'
where id = (select (value ->> 'draft_id')::uuid from manual_scene_result);
update public.major_event_workflows set phase = 'scene_plan_approved'
where draft_id = (select (value ->> 'draft_id')::uuid from manual_scene_result);
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-000000000001', true);
set local role authenticated;
select is(
  public.queue_manual_generation(
    (select (value ->> 'draft_id')::uuid from manual_scene_result),
    'major_event_draft', null, null, null, null
  ) ->> 'mode',
  'major_event_draft', 'approved scene plan derives the final major draft mode'
);
select is(
  (select count(*) from public.drafts where id = (select (value ->> 'draft_id')::uuid from manual_major_result)),
  1::bigint, 'all major stages retain the same owned draft'
);
select is(
  (select count(*) from public.generation_jobs where draft_id = (select (value ->> 'draft_id')::uuid from manual_major_result) and payload ->> 'source' = 'manual'),
  3::bigint, 'proposal, scene plan, and final draft each have one server-owned manual job'
);

reset role;
select * from finish();
rollback;
