begin;

select plan(17);

update public.provider_settings set enabled = true
where id = '12000000-0000-0000-0000-000000000001';

insert into public.drafts (id, owner_id, kind, title)
values ('d1000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'daily_event', 'attempt epoch');
insert into public.generation_jobs (id, owner_id, draft_id, schedule_key, scheduled_for)
values ('d2000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'd1000000-0000-0000-0000-000000000001', 'attempt-epoch', '2026-08-15T00:00:00Z');

select has_column('public', 'generation_jobs', 'attempt_token', 'jobs persist an immutable attempt epoch');
select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;

select lives_ok(
  $$ select public.freeze_generation_context(
    'd2000000-0000-0000-0000-000000000001', 'd1000000-0000-0000-0000-000000000001', 'new', 'same-key',
    array['15000000-0000-0000-0000-000000000001'],
    '[{"versionId":"15000000-0000-0000-0000-000000000001","memoryType":"canon","content":"frozen","tokenCount":1}]',
    '12000000-0000-0000-0000-000000000001', 'd3000000-0000-4000-8000-000000000001'
  ) $$,
  'the winning freeze installs its attempt token'
);
select throws_ok(
  $$ select public.freeze_generation_context(
    'd2000000-0000-0000-0000-000000000001', 'd1000000-0000-0000-0000-000000000001', 'new', 'same-key',
    array['15000000-0000-0000-0000-000000000001'],
    '[{"versionId":"15000000-0000-0000-0000-000000000001","memoryType":"canon","content":"frozen","tokenCount":1}]',
    '12000000-0000-0000-0000-000000000001', 'd3000000-0000-4000-8000-000000000002'
  ) $$,
  'P0001', 'duplicate_generation', 'a concurrent same-key loser is rejected'
);
select is(
  public.abort_generation_attempt('d2000000-0000-0000-0000-000000000001', 'd3000000-0000-4000-8000-000000000002', 'same-key', 'freeze_failed') ->> 'outcome',
  'stale', 'loser cleanup is a stale no-op'
);
select is((select attempt_token::text from public.generation_jobs where id = 'd2000000-0000-0000-0000-000000000001'), 'd3000000-0000-4000-8000-000000000001', 'loser cleanup preserves winner token');
select is((select idempotency_key from public.generation_jobs where id = 'd2000000-0000-0000-0000-000000000001'), 'same-key', 'loser cleanup preserves winner key');
select is((select status from public.generation_jobs where id = 'd2000000-0000-0000-0000-000000000001'), 'queued', 'loser cleanup preserves winner state');
select throws_ok(
  $$ select public.reserve_and_start_generation('d2000000-0000-0000-0000-000000000001', 'd3000000-0000-4000-8000-000000000002', 100) $$,
  'P0001', 'stale_attempt', 'a losing token cannot reserve the winner job'
);

select is(
  public.abort_generation_attempt('d2000000-0000-0000-0000-000000000001', 'd3000000-0000-4000-8000-000000000001', 'same-key', 'freeze_failed') ->> 'outcome',
  'aborted', 'the exact winner token may clean up'
);
select is((select attempt_token from public.generation_jobs where id = 'd2000000-0000-0000-0000-000000000001'), null, 'exact cleanup releases the attempt token');

select lives_ok(
  $$ select public.freeze_generation_context(
    'd2000000-0000-0000-0000-000000000001', 'd1000000-0000-0000-0000-000000000001', 'new', 'same-key',
    array['15000000-0000-0000-0000-000000000001'],
    '[{"versionId":"15000000-0000-0000-0000-000000000001","memoryType":"canon","content":"replacement","tokenCount":1}]',
    '12000000-0000-0000-0000-000000000001', 'd3000000-0000-4000-8000-000000000003'
  ) $$,
  'a replacement attempt gets a new token'
);
select is(
  public.abort_generation_attempt('d2000000-0000-0000-0000-000000000001', 'd3000000-0000-4000-8000-000000000001', 'same-key', 'freeze_failed') ->> 'outcome',
  'stale', 'a delayed old abort cannot cancel the replacement'
);
select is((select attempt_token::text from public.generation_jobs where id = 'd2000000-0000-0000-0000-000000000001'), 'd3000000-0000-4000-8000-000000000003', 'delayed abort preserves replacement token');
select is((select context_snapshot -> 0 ->> 'content' from public.generation_jobs where id = 'd2000000-0000-0000-0000-000000000001'), 'replacement', 'delayed abort preserves replacement context');
select is(
  public.reserve_and_start_generation('d2000000-0000-0000-0000-000000000001', 'd3000000-0000-4000-8000-000000000003', 100) ->> 'status',
  'reserved', 'only the replacement token can reserve'
);
select throws_ok(
  $$ select public.finalize_generation_success(
    'd2000000-0000-0000-0000-000000000001', 'd3000000-0000-4000-8000-000000000001', 100,
    '{"inputTokens":1,"outputTokens":1,"costMicros":0}', '{"kind":"daily_event","body":"stale"}',
    'review', '[]', 'stale-response', 'stale-canonical-model', 'cheonmu-continuity-v1'
  ) $$,
  'P0001', 'stale_attempt', 'an old token cannot finalize the replacement'
);
select is((select status from public.generation_jobs where id = 'd2000000-0000-0000-0000-000000000001'), 'running', 'stale finalization leaves the replacement running');

reset role;
select * from finish();
rollback;
