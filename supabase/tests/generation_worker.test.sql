begin;

select plan(69);

select has_column('public', 'generation_jobs', 'worker_attempt_token', 'generation jobs persist a worker attempt token');
select has_column('public', 'generation_jobs', 'worker_attempt_count', 'generation jobs persist bounded worker attempt count');
select has_column('public', 'generation_jobs', 'worker_retry_at', 'generation jobs persist deterministic retry time');
select has_column('public', 'generation_jobs', 'worker_lease_expires_at', 'generation jobs persist the current lease');
select has_column('public', 'generation_jobs', 'provider_dispatch_recorded_at', 'generation jobs persist the provider side-effect boundary');
select has_function('public', 'claim_generation_worker_job', array['uuid'], 'the service worker has one globally serialized claim RPC');
select has_function('public', 'renew_generation_worker_claim', array['uuid', 'uuid'], 'the service worker has a token-scoped renewal RPC');
select has_function('public', 'fence_generation_provider_dispatch', array['uuid', 'uuid', 'uuid'], 'provider dispatch has an exact database fence');
select has_function('public', 'complete_generation_worker_attempt', array['uuid', 'uuid'], 'worker completion is token scoped');
select has_function('public', 'fail_generation_worker_attempt', array['uuid', 'uuid', 'text'], 'worker failure is token scoped');
select ok(
  has_function_privilege('service_role', 'public.claim_generation_worker_job(uuid)', 'execute')
    and not has_function_privilege('authenticated', 'public.claim_generation_worker_job(uuid)', 'execute')
    and not has_function_privilege('anon', 'public.claim_generation_worker_job(uuid)', 'execute'),
  'only service role can claim generation work'
);
select ok(
  not has_function_privilege('authenticated', 'public.renew_generation_worker_claim(uuid,uuid)', 'execute')
    and not has_function_privilege('authenticated', 'public.fence_generation_provider_dispatch(uuid,uuid,uuid)', 'execute')
    and not has_function_privilege('authenticated', 'public.complete_generation_worker_attempt(uuid,uuid)', 'execute')
    and not has_function_privilege('authenticated', 'public.fail_generation_worker_attempt(uuid,uuid,text)', 'execute'),
  'owners cannot invoke worker lifecycle mutations'
);
select ok(
  has_table_privilege('authenticated', 'public.generation_jobs', 'select')
    and not has_table_privilege('authenticated', 'public.generation_jobs', 'insert')
    and not has_table_privilege('authenticated', 'public.generation_jobs', 'update')
    and not has_table_privilege('authenticated', 'public.generation_jobs', 'delete'),
  'generation jobs remain owner-readable and mutation-free'
);

update public.narrative_admin_settings
set manual_generation_enabled = true, schedule_automation_enabled = true
where owner_id = '10000000-0000-0000-0000-000000000001';
update public.provider_settings
set enabled = true, pricing_verified_at = public.narrative_business_date(current_timestamp)
where id = '12000000-0000-0000-0000-000000000001';

insert into public.generation_jobs (id, owner_id, schedule_key, scheduled_for, payload) values
  ('a0200000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'worker:daily:due', clock_timestamp() - interval '2 minutes',
    '{"source":"schedule","kind":"daily_event","budgetPolicy":"block_at_risk"}'),
  ('a0200000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000001', 'worker:daily:future', clock_timestamp() + interval '1 hour',
    '{"source":"schedule","kind":"daily_event","budgetPolicy":"block_at_risk"}');

select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;

create temp table first_claim on commit drop as
select public.claim_generation_worker_job('a0210000-0000-4000-8000-000000000001') as value;

select is((select value ->> 'outcome' from first_claim), 'claimed', 'one due schedule job is claimed');
select ok((select (value ->> 'draftId')::uuid from first_claim) =
  (select draft_id from public.generation_jobs where id = 'a0200000-0000-0000-0000-000000000001'),
  'claim creates and returns the same server-owned draft');
select is(
  (select concat_ws('|', worker_source, worker_policy_class, worker_generation_mode, worker_kind)
   from public.generation_jobs where id = 'a0200000-0000-0000-0000-000000000001'),
  'schedule|schedule|new|daily_event',
  'claim freezes the source, policy class, mode, and kind'
);
select ok(
  (select worker_lease_expires_at > worker_claimed_at
    and worker_lease_expires_at <= worker_claimed_at + interval '90 seconds'
   from public.generation_jobs where id = 'a0200000-0000-0000-0000-000000000001'),
  'the initial lease is positive and at most ninety seconds'
);
select is((select worker_attempt_count from public.generation_jobs where id = 'a0200000-0000-0000-0000-000000000001'), 1,
  'the first claim records one worker attempt');
select is(public.claim_generation_worker_job('a0210000-0000-4000-8000-000000000002') ->> 'outcome', 'idle',
  'a future job is not selected while the only due job is already claimed');
select throws_ok(
  $$ select public.freeze_generation_context(
    'a0200000-0000-0000-0000-000000000001',
    (select draft_id from public.generation_jobs where id = 'a0200000-0000-0000-0000-000000000001'),
    'new', (select worker_idempotency_key from public.generation_jobs where id = 'a0200000-0000-0000-0000-000000000001'),
    array['15000000-0000-0000-0000-000000000001'],
    '[{"versionId":"15000000-0000-0000-0000-000000000001","memoryType":"canon","content":"worker","tokenCount":1}]',
    '12000000-0000-0000-0000-000000000001', 'a0220000-0000-4000-8000-000000000001'
  ) $$,
  'P0001', 'generation_worker_claim_required', 'a browser-shaped generation call cannot take a worker-owned job'
);
select lives_ok(
  $$ select public.freeze_generation_worker_context(
    'a0200000-0000-0000-0000-000000000001',
    (select draft_id from public.generation_jobs where id = 'a0200000-0000-0000-0000-000000000001'),
    'new', (select worker_idempotency_key from public.generation_jobs where id = 'a0200000-0000-0000-0000-000000000001'),
    array['15000000-0000-0000-0000-000000000001'],
    '[{"versionId":"15000000-0000-0000-0000-000000000001","memoryType":"canon","content":"worker","tokenCount":1}]',
    '12000000-0000-0000-0000-000000000001', 'a0220000-0000-4000-8000-000000000001',
    'a0210000-0000-4000-8000-000000000001'
  ) $$,
  'the exact worker may freeze context through the existing pipeline'
);
select is(
  public.reserve_and_start_worker_generation(
    'a0200000-0000-0000-0000-000000000001', 'a0220000-0000-4000-8000-000000000001', 100,
    'a0210000-0000-4000-8000-000000000001'
  ) ->> 'status',
  'reserved', 'the exact worker may reserve and start through the existing pipeline'
);
select is(
  public.renew_generation_worker_claim('a0200000-0000-0000-0000-000000000001', 'a0210000-0000-4000-8000-000000000001') ->> 'outcome',
  'renewed', 'the exact live worker renews before provider dispatch'
);
select ok(
  (select worker_lease_expires_at <= clock_timestamp() + interval '90 seconds'
   from public.generation_jobs where id = 'a0200000-0000-0000-0000-000000000001'),
  'renewal never extends more than ninety seconds from renewal time'
);
select ok(
  (select worker_lease_expires_at <= worker_claimed_at + interval '5 minutes'
   from public.generation_jobs where id = 'a0200000-0000-0000-0000-000000000001'),
  'renewal never extends beyond five minutes from the original claim'
);
select is(
  public.fence_generation_provider_dispatch(
    'a0200000-0000-0000-0000-000000000001', 'a0220000-0000-4000-8000-000000000001',
    'a0210000-0000-4000-8000-000000000001'
  ) ->> 'outcome',
  'fenced', 'the exact provider fence records the side-effect boundary'
);
select is(
  public.fence_generation_provider_dispatch(
    'a0200000-0000-0000-0000-000000000001', 'a0220000-0000-4000-8000-000000000001',
    'a0210000-0000-4000-8000-000000000001'
  ) ->> 'outcome',
  'already_dispatched', 'a repeated provider fence never authorizes another call'
);
select is(
  public.fail_generation_worker_attempt(
    'a0200000-0000-0000-0000-000000000001', 'a0210000-0000-4000-8000-000000000001', 'provider_dispatch_uncertain'
  ) ->> 'outcome',
  'dead_lettered', 'an uncertain post-fence attempt is dead-lettered'
);
select is((select worker_failure_code from public.generation_jobs where id = 'a0200000-0000-0000-0000-000000000001'),
  'provider_outcome_unknown', 'post-fence failure stores a stable unknown-provider code');
select is((select count(*) from public.budget_entries where generation_job_id = 'a0200000-0000-0000-0000-000000000001' and entry_type = 'failure'),
  1::bigint, 'unknown provider outcome settles the existing reservation exactly once');
select is(
  public.fail_generation_worker_attempt(
    'a0200000-0000-0000-0000-000000000001', 'a0210000-0000-4000-8000-000000000001', 'provider_dispatch_uncertain'
  ) ->> 'outcome',
  'dead_lettered', 'repeated exact failure is idempotent'
);
select is((select count(*) from public.budget_entries where generation_job_id = 'a0200000-0000-0000-0000-000000000001' and entry_type = 'failure'),
  1::bigint, 'repeated failure does not settle the budget twice');

insert into public.drafts (id, owner_id, kind, status, title)
values ('a0230000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'short_dialogue', 'queued', 'retry');
insert into public.generation_jobs (id, owner_id, draft_id, schedule_key, scheduled_for, payload, provider_setting_id, direct_dispatch_expires_at) values (
  'a0240000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001',
  'a0230000-0000-0000-0000-000000000001', 'worker:manual:retry', clock_timestamp() - interval '1 minute',
  '{"source":"manual","mode":"new","kind":"short_dialogue","manualRequestKey":"worker:manual:retry"}',
  '12000000-0000-0000-0000-000000000001', clock_timestamp() - interval '1 second'
);
select is(public.claim_generation_worker_job('a0250000-0000-4000-8000-000000000001') ->> 'outcome', 'claimed',
  'a due exact manual binding is claimable');
select is(public.fail_generation_worker_attempt('a0240000-0000-0000-0000-000000000001', 'a0250000-0000-4000-8000-000000000001', 'context_selection_failed') ->> 'outcome',
  'retry_wait', 'the first safe pre-provider failure is retried');
select ok((select worker_retry_at between clock_timestamp() + interval '59 seconds' and clock_timestamp() + interval '61 seconds'
  from public.generation_jobs where id = 'a0240000-0000-0000-0000-000000000001'), 'attempt one persists a one-minute retry delay');

reset role;
update public.generation_jobs set worker_retry_at = clock_timestamp() - interval '1 second'
where id = 'a0240000-0000-0000-0000-000000000001';
select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;
select is(public.claim_generation_worker_job('a0250000-0000-4000-8000-000000000002') ->> 'outcome', 'claimed',
  'the persisted retry becomes claimable when due');
select is(public.renew_generation_worker_claim('a0240000-0000-0000-0000-000000000001', 'a0250000-0000-4000-8000-000000000001') ->> 'outcome', 'stale',
  'an old token cannot renew a replacement');
select is(public.fail_generation_worker_attempt('a0240000-0000-0000-0000-000000000001', 'a0250000-0000-4000-8000-000000000001', 'context_selection_failed') ->> 'outcome', 'stale',
  'an old token cannot fail a replacement');
select is(public.complete_generation_worker_attempt('a0240000-0000-0000-0000-000000000001', 'a0250000-0000-4000-8000-000000000001') ->> 'outcome', 'stale',
  'an old token cannot complete a replacement');
select is(public.fail_generation_worker_attempt('a0240000-0000-0000-0000-000000000001', 'a0250000-0000-4000-8000-000000000002', 'context_selection_failed') ->> 'outcome',
  'retry_wait', 'the second safe pre-provider failure is retried');
select ok((select worker_retry_at between clock_timestamp() + interval '4 minutes 59 seconds' and clock_timestamp() + interval '5 minutes 1 second'
  from public.generation_jobs where id = 'a0240000-0000-0000-0000-000000000001'), 'attempt two persists a five-minute retry delay');

reset role;
update public.generation_jobs set worker_retry_at = clock_timestamp() - interval '1 second'
where id = 'a0240000-0000-0000-0000-000000000001';
select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;
select is(public.claim_generation_worker_job('a0250000-0000-4000-8000-000000000003') ->> 'outcome', 'claimed',
  'the third bounded attempt is claimable');
select is(public.fail_generation_worker_attempt('a0240000-0000-0000-0000-000000000001', 'a0250000-0000-4000-8000-000000000003', 'context_selection_failed') ->> 'outcome',
  'dead_lettered', 'the third safe failure is terminal');
select is((select worker_failure_code from public.generation_jobs where id = 'a0240000-0000-0000-0000-000000000001'),
  'worker_attempts_exhausted', 'retry exhaustion stores a stable dead-letter code');

insert into public.generation_jobs (id, owner_id, schedule_key, scheduled_for, payload) values (
  'a0260000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001',
  'worker:corrupt', clock_timestamp() - interval '1 minute', '{"source":"schedule","kind":null,"budgetPolicy":"block_at_risk"}'
);
select is(public.claim_generation_worker_job('a0270000-0000-4000-8000-000000000001') ->> 'outcome', 'dead_lettered',
  'a corrupt persisted row is consumed without provider work');
select is((select worker_failure_code from public.generation_jobs where id = 'a0260000-0000-0000-0000-000000000001'),
  'worker_binding_invalid', 'corrupt persisted input receives a stable terminal code');

insert into public.drafts (id, owner_id, kind, status, title)
values ('a0280000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'daily_event', 'queued', 'completion');
insert into public.generation_jobs (id, owner_id, draft_id, schedule_key, scheduled_for, payload, provider_setting_id, direct_dispatch_expires_at) values (
  'a0290000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001',
  'a0280000-0000-0000-0000-000000000001', 'worker:manual:complete', clock_timestamp() - interval '1 minute',
  '{"source":"manual","mode":"new","kind":"daily_event","manualRequestKey":"worker:manual:complete"}',
  '12000000-0000-0000-0000-000000000001', clock_timestamp() - interval '1 second'
);
select is(public.claim_generation_worker_job('a02a0000-0000-4000-8000-000000000001') ->> 'outcome', 'claimed', 'completion fixture is claimed');
select lives_ok(
  $$ select public.freeze_generation_worker_context(
    'a0290000-0000-0000-0000-000000000001', 'a0280000-0000-0000-0000-000000000001', 'new', 'worker:manual:complete',
    array['15000000-0000-0000-0000-000000000001'],
    '[{"versionId":"15000000-0000-0000-0000-000000000001","memoryType":"canon","content":"complete","tokenCount":1}]',
    '12000000-0000-0000-0000-000000000001', 'a02b0000-0000-4000-8000-000000000001',
    'a02a0000-0000-4000-8000-000000000001'
  ) $$,
  'completion fixture freezes through the worker boundary'
);
select is(public.reserve_and_start_worker_generation(
  'a0290000-0000-0000-0000-000000000001', 'a02b0000-0000-4000-8000-000000000001', 100,
  'a02a0000-0000-4000-8000-000000000001') ->> 'status', 'reserved', 'completion fixture reserves once');
select is(public.fence_generation_provider_dispatch(
  'a0290000-0000-0000-0000-000000000001', 'a02b0000-0000-4000-8000-000000000001',
  'a02a0000-0000-4000-8000-000000000001') ->> 'outcome', 'fenced', 'completion fixture crosses one provider fence');
select lives_ok(
  $$ select public.finalize_worker_generation_success(
    'a0290000-0000-0000-0000-000000000001', 'a02b0000-0000-4000-8000-000000000001', 100,
    '{"inputTokens":1,"outputTokens":1}', '{"kind":"daily_event","title":"done","body":"done"}',
    'review', '[]', 'worker-response', 'fake-local-model', 'cheonmu-continuity-v1',
    'a02a0000-0000-4000-8000-000000000001'
  ) $$,
  'the exact worker finalizes through the existing generation transaction'
);
select is(public.complete_generation_worker_attempt('a0290000-0000-0000-0000-000000000001', 'a02a0000-0000-4000-8000-000000000001') ->> 'outcome',
  'completed', 'worker cleanup observes committed generation success');
select is(public.complete_generation_worker_attempt('a0290000-0000-0000-0000-000000000001', 'a02a0000-0000-4000-8000-000000000001') ->> 'outcome',
  'completed', 'lost completion response is idempotently recoverable');
select is((select count(*) from public.draft_versions where generation_job_id = 'a0290000-0000-0000-0000-000000000001'),
  1::bigint, 'completion creates exactly one generated version');
select is((select count(*) from public.budget_entries where generation_job_id = 'a0290000-0000-0000-0000-000000000001' and entry_type in ('reconciliation','failure')),
  1::bigint, 'completion settles the reservation exactly once');

insert into public.drafts (id, owner_id, kind, status, title)
values ('a02c0000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'short_dialogue', 'queued', 'direct fence loss');
insert into public.generation_jobs (id, owner_id, draft_id, schedule_key, scheduled_for, payload, provider_setting_id) values (
  'a02d0000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001',
  'a02c0000-0000-0000-0000-000000000001', 'direct:fence:loss', clock_timestamp(),
  '{"source":"manual","mode":"new","kind":"short_dialogue","manualRequestKey":"direct:fence:loss"}',
  '12000000-0000-0000-0000-000000000001'
);
select lives_ok(
  $$ select public.freeze_generation_context(
    'a02d0000-0000-0000-0000-000000000001', 'a02c0000-0000-0000-0000-000000000001', 'new', 'direct:fence:loss',
    array['15000000-0000-0000-0000-000000000001'],
    '[{"versionId":"15000000-0000-0000-0000-000000000001","memoryType":"canon","content":"direct","tokenCount":1}]',
    '12000000-0000-0000-0000-000000000001', 'a02e0000-0000-4000-8000-000000000001'
  ) $$,
  'direct generation still freezes through the established pipeline'
);
select is(public.reserve_and_start_generation(
  'a02d0000-0000-0000-0000-000000000001', 'a02e0000-0000-4000-8000-000000000001', 100) ->> 'status',
  'reserved', 'direct generation reserves before its provider fence');
select is(public.fence_generation_provider_dispatch(
  'a02d0000-0000-0000-0000-000000000001', 'a02e0000-0000-4000-8000-000000000001', null) ->> 'outcome',
  'fenced', 'direct generation crosses the exact provider fence');
select is(public.abort_generation_attempt(
  'a02d0000-0000-0000-0000-000000000001', 'a02e0000-0000-4000-8000-000000000001', 'direct:fence:loss', 'provider_dispatch_uncertain') ->> 'outcome',
  'dead_lettered', 'a lost direct fence response cannot make the job replayable');
select is((select concat(status, '|', worker_failure_code) from public.generation_jobs where id = 'a02d0000-0000-0000-0000-000000000001'),
  'failed|provider_outcome_unknown', 'direct fence uncertainty stores a stable terminal state');
select is((select count(*) from public.budget_entries where generation_job_id = 'a02d0000-0000-0000-0000-000000000001' and entry_type = 'failure'),
  1::bigint, 'direct fence uncertainty settles its reservation exactly once');

reset role;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-000000000001', true);
set local role authenticated;
select is(jsonb_typeof(public.get_narrative_dashboard() -> 'queue'), 'array', 'owner dashboard exposes a recent sanitized queue');
select ok(
  (select bool_and(item ? 'source' and item ? 'state' and item ? 'attemptCount' and item ? 'retryAt'
    and item ? 'leaseExpiresAt' and item ? 'failureCode')
   from jsonb_array_elements(public.get_narrative_dashboard() -> 'queue') as item),
  'every dashboard queue item exposes the required operational fields'
);
select ok(
  public.get_narrative_dashboard()::text !~* '(attemptToken|attempt_token|idempotency|contextSnapshot|providerResponse|selectedText|instruction)',
  'dashboard queue visibility excludes tokens, prompts, provider responses, and private bindings'
);
select ok(
  exists (select 1 from jsonb_array_elements(public.get_narrative_dashboard() -> 'queue') as item
    where item ->> 'id' = 'a0240000-0000-0000-0000-000000000001' and item ->> 'state' = 'failed/dead-letter'),
  'owner queue visibility distinguishes terminal dead-letter state'
);

reset role;
select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;
select throws_ok($$ select public.claim_generation_worker_job(null) $$, '22023', 'invalid_generation_worker_claim',
  'claim rejects a NULL attempt token');
select is(public.renew_generation_worker_claim('a0290000-0000-0000-0000-000000000001', null) ->> 'outcome', 'stale',
  'renew rejects a missing token as a stable stale outcome');
select is(public.complete_generation_worker_attempt('a0290000-0000-0000-0000-000000000001', null) ->> 'outcome', 'stale',
  'complete rejects a missing token as a stable stale outcome');
select is(public.fail_generation_worker_attempt('a0290000-0000-0000-0000-000000000001', null, 'generation_failed') ->> 'outcome', 'stale',
  'fail rejects a missing token as a stable stale outcome');

reset role;
select * from finish();
rollback;
