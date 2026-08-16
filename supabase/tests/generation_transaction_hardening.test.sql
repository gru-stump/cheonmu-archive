begin;

select plan(42);

update public.provider_settings
set enabled = true,
    max_input_tokens = 100,
    max_output_tokens = 50,
    max_revision_output_tokens = 20,
    input_cost_micros_per_million = 0,
    output_cost_micros_per_million = 0,
    fixed_cost_micros = 100
where id = '12000000-0000-0000-0000-000000000001';

update public.budget_periods
set limit_micros = 50, daily_limit_micros = 50
where id = '13000000-0000-0000-0000-000000000001';

insert into public.drafts (id, owner_id, kind, title)
values
  ('a1000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'major_event_proposal', 'major retry'),
  ('a1000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000001', 'daily_event', 'failure retry'),
  ('a1000000-0000-0000-0000-000000000011', '10000000-0000-0000-0000-000000000001', 'daily_event', 'blocked review'),
  ('a1000000-0000-0000-0000-000000000012', '10000000-0000-0000-0000-000000000001', 'daily_event', 'unchecked review'),
  ('a1000000-0000-0000-0000-000000000013', '10000000-0000-0000-0000-000000000001', 'daily_event', 'pass review'),
  ('a1000000-0000-0000-0000-000000000014', '10000000-0000-0000-0000-000000000001', 'daily_event', 'old policy review');

insert into public.generation_jobs (id, owner_id, draft_id, schedule_key, scheduled_for, provider_setting_id, payload)
values
  ('a2000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'a1000000-0000-0000-0000-000000000001', 'major-retry-key', '2026-08-14T01:00:00Z', '12000000-0000-0000-0000-000000000001', '{"source":"manual","mode":"major_event_scene_plan","kind":"major_event_proposal","manualRequestKey":"major-retry-key"}'::jsonb),
  ('a2000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000001', 'a1000000-0000-0000-0000-000000000002', 'failure-retry-key', '2026-08-14T02:00:00Z', '12000000-0000-0000-0000-000000000001', '{"source":"manual","mode":"new","kind":"daily_event","manualRequestKey":"failure-retry-key"}'::jsonb),
  ('a2000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000001', 'a1000000-0000-0000-0000-000000000002', 'failure-retry-key', '2026-08-14T03:00:00Z', '12000000-0000-0000-0000-000000000001', '{"source":"manual","mode":"new","kind":"daily_event","manualRequestKey":"failure-retry-key"}'::jsonb);

insert into public.major_event_workflows (id, owner_id, draft_id, phase)
values ('a3000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'a1000000-0000-0000-0000-000000000001', 'proposal_approved');

insert into public.draft_versions (id, owner_id, draft_id, version_number, content, continuity_level, continuity_policy_version)
values
  ('a4000000-0000-0000-0000-000000000011', '10000000-0000-0000-0000-000000000001', 'a1000000-0000-0000-0000-000000000011', 1, '{"body":"blocked"}', 'block', 'cheonmu-continuity-v1'),
  ('a4000000-0000-0000-0000-000000000012', '10000000-0000-0000-0000-000000000001', 'a1000000-0000-0000-0000-000000000012', 1, '{"body":"unchecked"}', null, null),
  ('a4000000-0000-0000-0000-000000000013', '10000000-0000-0000-0000-000000000001', 'a1000000-0000-0000-0000-000000000013', 1, '{"body":"pass"}', 'pass', 'cheonmu-continuity-v1'),
  ('a4000000-0000-0000-0000-000000000014', '10000000-0000-0000-0000-000000000001', 'a1000000-0000-0000-0000-000000000014', 1, '{"body":"old"}', 'review', 'cheonmu-continuity-v0');

update public.drafts set status = 'reviewing'
where id in (
  'a1000000-0000-0000-0000-000000000011',
  'a1000000-0000-0000-0000-000000000012',
  'a1000000-0000-0000-0000-000000000013',
  'a1000000-0000-0000-0000-000000000014'
);

select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-000000000001', true);
set local role authenticated;

select throws_ok(
  $$ select public.reserve_and_start_generation('a2000000-0000-0000-0000-000000000001', 'a5000000-0000-4000-8000-000000000001', 100) $$,
  '42501', 'permission denied for function reserve_and_start_generation',
  'an authenticated owner cannot directly invoke generation finalization plumbing'
);

reset role;
select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;

select lives_ok(
  $$ select public.freeze_generation_context(
    'a2000000-0000-0000-0000-000000000001',
    'a1000000-0000-0000-0000-000000000001',
    'major_event_scene_plan',
    'major-retry-key',
    array['15000000-0000-0000-0000-000000000001'],
    '[{"versionId":"15000000-0000-0000-0000-000000000001","memoryType":"canon","content":"frozen canon","tokenCount":14}]'::jsonb,
    '12000000-0000-0000-0000-000000000001',
    'a5000000-0000-4000-8000-000000000001'
  ) $$,
  'freezing a major-event context succeeds after the prerequisite'
);
select is((select phase from public.major_event_workflows where id = 'a3000000-0000-0000-0000-000000000001'), 'proposal_approved', 'freezing never advances the workflow phase');
select is((select context_snapshot -> 0 ->> 'content' from public.generation_jobs where id = 'a2000000-0000-0000-0000-000000000001'), 'frozen canon', 'the selected content is frozen with its exact version id');
select is((select public.reserve_and_start_generation('a2000000-0000-0000-0000-000000000001', 'a5000000-0000-4000-8000-000000000001', 100) ->> 'status'), 'blocked', 'a blocked reservation reports blocked');
select is((select public.abort_generation_attempt('a2000000-0000-0000-0000-000000000001', 'a5000000-0000-4000-8000-000000000001', 'major-retry-key', 'budget_blocked') ->> 'outcome'), 'stale', 'a 402 cleanup is harmless after reserve already released the attempt');
select is((select idempotency_key from public.generation_jobs where id = 'a2000000-0000-0000-0000-000000000001'), null, 'a 402 clears the idempotency key for retry');
select is((select status from public.drafts where id = 'a1000000-0000-0000-0000-000000000001'), 'queued', 'a 402 leaves the draft queued');
select is((select phase from public.major_event_workflows where id = 'a3000000-0000-0000-0000-000000000001'), 'proposal_approved', 'a 402 does not consume the major-event phase');

reset role;
update public.budget_periods
set limit_micros = 1000, daily_limit_micros = 1000
where id = '13000000-0000-0000-0000-000000000001';
select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;

select lives_ok(
  $$ select public.freeze_generation_context(
    'a2000000-0000-0000-0000-000000000001',
    'a1000000-0000-0000-0000-000000000001',
    'major_event_scene_plan',
    'major-retry-key',
    array['15000000-0000-0000-0000-000000000001'],
    '[{"versionId":"15000000-0000-0000-0000-000000000001","memoryType":"canon","content":"frozen canon","tokenCount":14}]'::jsonb,
    '12000000-0000-0000-0000-000000000001',
    'a5000000-0000-4000-8000-000000000002'
  ) $$,
  'the same job and key can be frozen again after a 402'
);
select is((select public.reserve_and_start_generation('a2000000-0000-0000-0000-000000000001', 'a5000000-0000-4000-8000-000000000002', 100) ->> 'status'), 'reserved', 'retry can reserve and start');
select is(public.fence_generation_provider_dispatch(
  'a2000000-0000-0000-0000-000000000001', 'a5000000-0000-4000-8000-000000000002', null) ->> 'outcome',
  'fenced', 'retry crosses the provider side-effect fence before finalization');
select throws_ok(
  $$ select public.finalize_generation_success(
    'a2000000-0000-0000-0000-000000000001', 'a5000000-0000-4000-8000-000000000002', 1, '{"inputTokens":14,"outputTokens":10,"costMicros":1}',
    '{"kind":"major_event_proposal","title":"scene plan","body":"private result"}',
    'review', '[]', 'fake-response-major', 'fake-canonical-2026-08-14', 'cheonmu-continuity-v1'
  ) $$,
  'P0001', 'actual_micros_mismatch', 'finalization rejects caller-controlled actual pricing'
);
select is((select count(*) from public.budget_entries where generation_job_id = 'a2000000-0000-0000-0000-000000000001' and entry_type = 'reconciliation'), 0::bigint, 'a failed finalization rolls back reconciliation');
select is((select count(*) from public.draft_versions where generation_job_id = 'a2000000-0000-0000-0000-000000000001'), 0::bigint, 'a failed finalization rolls back version storage');
select is((select phase from public.major_event_workflows where id = 'a3000000-0000-0000-0000-000000000001'), 'proposal_approved', 'a failed finalization rolls back phase advancement');
select lives_ok(
  $$ select public.finalize_generation_success(
    'a2000000-0000-0000-0000-000000000001', 'a5000000-0000-4000-8000-000000000002', 100, '{"inputTokens":14,"outputTokens":10,"costMicros":1}',
    '{"kind":"major_event_proposal","title":"scene plan","body":"private result"}',
    'review', '[{"code":"manual_semantic_review","level":"review","message":"review","sourceIds":["15000000-0000-0000-0000-000000000001"]}]',
    'fake-response-major', 'fake-canonical-2026-08-14', 'cheonmu-continuity-v1'
  ) $$,
  'success finalization commits all generated state atomically'
);
select is((select phase from public.major_event_workflows where id = 'a3000000-0000-0000-0000-000000000001'), 'scene_plan', 'only success finalization advances the phase');
select is((select status from public.generation_jobs where id = 'a2000000-0000-0000-0000-000000000001'), 'completed', 'success finalization completes the job');
select is((select status from public.drafts where id = 'a1000000-0000-0000-0000-000000000001'), 'generated', 'success finalization legally advances the draft');
select is((select count(*) from public.draft_versions where generation_job_id = 'a2000000-0000-0000-0000-000000000001' and continuity_policy_version = 'cheonmu-continuity-v1' and context_snapshot -> 0 ->> 'content' = 'frozen canon'), 1::bigint, 'success creates one policy-stamped immutable version with frozen context');
select is((select provider_response_model from public.draft_versions where generation_job_id = 'a2000000-0000-0000-0000-000000000001'), 'fake-canonical-2026-08-14', 'success persists canonical response-model metadata independently of the configured alias');
select is((select count(*) from public.budget_entries where generation_job_id = 'a2000000-0000-0000-0000-000000000001' and entry_type = 'reconciliation'), 1::bigint, 'success creates one reconciliation in the transaction');
select is((select public.abort_generation_attempt('a2000000-0000-0000-0000-000000000001', 'a5000000-0000-4000-8000-000000000002', 'major-retry-key', 'finalization_failed') ->> 'outcome'), 'completed', 'abort detects an already committed finalization');
select is((select phase from public.major_event_workflows where id = 'a3000000-0000-0000-0000-000000000001'), 'scene_plan', 'abort never reverts a completed major-event phase');

select lives_ok(
  $$ select public.freeze_generation_context(
    'a2000000-0000-0000-0000-000000000002',
    'a1000000-0000-0000-0000-000000000002',
    'new',
    'failure-retry-key',
    array['15000000-0000-0000-0000-000000000001'],
    '[{"versionId":"15000000-0000-0000-0000-000000000001","memoryType":"canon","content":"frozen canon","tokenCount":14}]'::jsonb,
    '12000000-0000-0000-0000-000000000001',
    'a5000000-0000-4000-8000-000000000003'
  ) $$,
  'failure fixture freezes'
);
select is((select public.reserve_and_start_generation('a2000000-0000-0000-0000-000000000002', 'a5000000-0000-4000-8000-000000000003', 100) ->> 'status'), 'reserved', 'failure fixture reserves before provider work');
select is(public.fence_generation_provider_dispatch(
  'a2000000-0000-0000-0000-000000000002', 'a5000000-0000-4000-8000-000000000003', null) ->> 'outcome',
  'fenced', 'failure fixture records the provider side-effect boundary');
select lives_ok(
  $$ select public.abort_generation_attempt('a2000000-0000-0000-0000-000000000002', 'a5000000-0000-4000-8000-000000000003', 'failure-retry-key', 'provider_generation_failed') $$,
  'abort conservatively settles a reservation after response loss'
);
select is((select status from public.generation_jobs where id = 'a2000000-0000-0000-0000-000000000002'), 'failed', 'failure finalization leaves a clear terminal job state');
select is((select status from public.drafts where id = 'a1000000-0000-0000-0000-000000000002'), 'queued', 'failure finalization legally returns the draft to queued');
select is((select idempotency_key from public.generation_jobs where id = 'a2000000-0000-0000-0000-000000000002'), 'failure-retry-key', 'unknown provider outcome preserves the terminal binding');
select is((select sum(amount_micros) from public.budget_entries where generation_job_id = 'a2000000-0000-0000-0000-000000000002'), 100::numeric, 'missing usage conservatively charges the reservation');
select throws_ok(
  $$ select public.freeze_generation_context(
    'a2000000-0000-0000-0000-000000000003',
    'a1000000-0000-0000-0000-000000000002',
    'new',
    'failure-retry-key',
    array['15000000-0000-0000-0000-000000000001'],
    '[{"versionId":"15000000-0000-0000-0000-000000000001","memoryType":"canon","content":"frozen canon","tokenCount":14}]'::jsonb,
    '12000000-0000-0000-0000-000000000001',
    'a5000000-0000-4000-8000-000000000004'
  ) $$,
  'P0001', 'duplicate_generation', 'a new queued job cannot replay an unknown provider outcome key'
);
select is((select public.abort_generation_attempt('a2000000-0000-0000-0000-000000000003', 'a5000000-0000-4000-8000-000000000004', 'failure-retry-key', 'freeze_failed') ->> 'outcome'), 'stale', 'cleanup for a rejected replay is a stale no-op');
select is((select idempotency_key from public.generation_jobs where id = 'a2000000-0000-0000-0000-000000000003'), null, 'rejected replay leaves the queued job unfrozen');
select throws_ok(
  $$ select public.freeze_generation_context(
    'a2000000-0000-0000-0000-000000000003',
    'a1000000-0000-0000-0000-000000000002',
    'new',
    'failure-retry-key',
    array['15000000-0000-0000-0000-000000000001'],
    '[{"versionId":"15000000-0000-0000-0000-000000000001","memoryType":"canon","content":"frozen canon","tokenCount":14}]'::jsonb,
    '12000000-0000-0000-0000-000000000001',
    'a5000000-0000-4000-8000-000000000005'
  ) $$,
  'P0001', 'duplicate_generation', 'later attempts still cannot replay the unknown provider outcome key'
);

reset role;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-000000000001', true);
set local role authenticated;

select throws_ok(
  $$ select public.review_draft_atomic('a1000000-0000-0000-0000-000000000011', 'a4000000-0000-0000-0000-000000000011', 'reviewing', 'approve_private', null, 'blocked-approve', 'cheonmu-continuity-v1') $$,
  'P0001', 'version_not_approvable', 'blocked continuity can never approve'
);
select throws_ok(
  $$ select public.review_draft_atomic('a1000000-0000-0000-0000-000000000012', 'a4000000-0000-0000-0000-000000000012', 'reviewing', 'approve_private', null, 'unchecked-approve', 'cheonmu-continuity-v1') $$,
  'P0001', 'version_not_approvable', 'unchecked continuity can never approve'
);
select throws_ok(
  $$ select public.review_draft_atomic('a1000000-0000-0000-0000-000000000013', 'a4000000-0000-0000-0000-000000000013', 'reviewing', 'approve_private', null, 'pass-approve', 'cheonmu-continuity-v1') $$,
  'P0001', 'version_not_approvable', 'only manual-review continuity can approve'
);
select throws_ok(
  $$ select public.review_draft_atomic('a1000000-0000-0000-0000-000000000014', 'a4000000-0000-0000-0000-000000000014', 'reviewing', 'approve_private', null, 'old-policy-approve', 'cheonmu-continuity-v1') $$,
  'P0001', 'version_not_approvable', 'an old policy version can never approve'
);
select is((select count(*) from public.draft_review_actions where draft_id in ('a1000000-0000-0000-0000-000000000011', 'a1000000-0000-0000-0000-000000000012', 'a1000000-0000-0000-0000-000000000013', 'a1000000-0000-0000-0000-000000000014')), 0::bigint, 'failed approvals leave no review action');

reset role;

select * from finish();

rollback;
