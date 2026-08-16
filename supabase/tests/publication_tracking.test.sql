begin;

select plan(39);

select has_column('public', 'publish_jobs', 'publication_phase', 'publication exposes a phase distinct from commit status');
select has_column('public', 'publish_jobs', 'tracking_status', 'publication observation has its own terminal state');
select has_column('public', 'publish_jobs', 'workflow_status', 'workflow status is stored separately');
select has_column('public', 'publish_jobs', 'pages_status', 'Pages status is stored separately');
select has_column('public', 'publish_jobs', 'workflow_run_id', 'the exact Actions run id is retained');
select has_column('public', 'publish_jobs', 'pages_deployment_id', 'the exact Pages deployment id is retained');
select has_column('public', 'publish_jobs', 'tracking_next_check_at', 'the next bounded poll is durable');
select has_column('public', 'publish_jobs', 'tracking_expires_at', 'the observation window has a durable deadline');
select has_function('public', 'claim_narrative_publication_check', array['uuid'], 'one service RPC claims only due nonterminal checks');
select has_function('public', 'record_narrative_publication_check', array['uuid','uuid','text','text','text','bigint','bigint','text','text'], 'one exact-token and exact-commit RPC records an observation');
select has_function('public', 'record_narrative_publication_check_retry', array['uuid','uuid','text','text'], 'one exact-token and exact-commit RPC durably schedules provider-error backoff');
select has_function('public', 'retry_narrative_publication_check', array['uuid'], 'one service RPC resets an observation timeout');
select ok(
  (select bool_and(has_function_privilege('service_role', signature, 'EXECUTE')) from unnest(array[
    'public.claim_narrative_publication_check(uuid)',
    'public.record_narrative_publication_check(uuid,uuid,text,text,text,bigint,bigint,text,text)',
    'public.record_narrative_publication_check_retry(uuid,uuid,text,text)',
    'public.retry_narrative_publication_check(uuid)'
  ]) signature),
  'service_role can execute every tracking mutation RPC'
);
select ok(
  not exists (select 1 from unnest(array[
    'public.claim_narrative_publication_check(uuid)',
    'public.record_narrative_publication_check(uuid,uuid,text,text,text,bigint,bigint,text,text)',
    'public.record_narrative_publication_check_retry(uuid,uuid,text,text)',
    'public.retry_narrative_publication_check(uuid)'
  ]) signature where has_function_privilege('authenticated', signature, 'EXECUTE')),
  'authenticated callers cannot mutate publication tracking'
);
select is((select schedule from cron.job where jobname = 'narrative-publication-checker'), '* * * * *', 'the durable dispatcher checks due publications every minute');
select ok(
  not has_function_privilege('authenticated', 'narrative_private.invoke_publication_checker()', 'EXECUTE')
  and not has_function_privilege('service_role', 'narrative_private.invoke_publication_checker()', 'EXECUTE'),
  'the cron transport remains private and cannot be invoked by API roles'
);

update public.narrative_admin_settings
set github_repository_owner = 'cheonmu-owner', github_repository_name = 'cheonmu-archive', github_branch = 'main'
where owner_id = '10000000-0000-0000-0000-000000000001';
select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;
select public.store_narrative_secret('10000000-0000-0000-0000-000000000001', 'github', 'publication-tracking-fixture-value');
reset role;

insert into public.drafts (id, owner_id, kind, title) values
  ('a8100000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'daily_event', 'tracking fixture'),
  ('a8100000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000001', 'daily_event', 'nonterminal fixture');
insert into public.draft_versions (id, owner_id, draft_id, version_number, content, continuity_level, continuity_policy_version) values
  ('a8200000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'a8100000-0000-0000-0000-000000000001', 1, '{"title":"tracking","body":"body","canonChangeCandidates":[],"unresolvedCallbacks":[],"publication":{"id":"tracking-record"}}', 'review', 'cheonmu-continuity-v1'),
  ('a8200000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000001', 'a8100000-0000-0000-0000-000000000002', 1, '{"title":"tracking two","body":"body","canonChangeCandidates":[],"unresolvedCallbacks":[],"publication":{"id":"tracking-record-two"}}', 'review', 'cheonmu-continuity-v1');
insert into public.draft_review_actions (id, owner_id, draft_id, draft_version_id, idempotency_key, action, expected_state, resulting_state) values
  ('a8300000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'a8100000-0000-0000-0000-000000000001', 'a8200000-0000-0000-0000-000000000001', 'tracking-approval', 'approve_public', 'reviewing', 'approved'),
  ('a8300000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000001', 'a8100000-0000-0000-0000-000000000002', 'a8200000-0000-0000-0000-000000000002', 'tracking-approval-two', 'approve_public', 'reviewing', 'approved');
update public.drafts set status = 'published' where id in (
  'a8100000-0000-0000-0000-000000000001', 'a8100000-0000-0000-0000-000000000002'
);
insert into public.publish_jobs (
  id, owner_id, draft_id, draft_version_id, status, repository_owner, repository_name, repository_branch,
  commit_sha, published_path, commit_created_at, publication_phase, tracking_status, workflow_status, pages_status,
  tracking_started_at, tracking_expires_at, tracking_next_check_at
) values
  ('a8400000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'a8100000-0000-0000-0000-000000000001', 'a8200000-0000-0000-0000-000000000001', 'published', 'cheonmu-owner', 'cheonmu-archive', 'main', repeat('1', 40), 'src/content/records/08-tracking-record.md', now(), 'commit_created', 'pending', 'pending', 'pending', now(), now() + interval '6 hours', now() - interval '1 second'),
  ('a8400000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000001', 'a8100000-0000-0000-0000-000000000002', 'a8200000-0000-0000-0000-000000000002', 'published', 'cheonmu-owner', 'cheonmu-archive', 'main', repeat('2', 40), 'src/content/records/09-tracking-record-two.md', now(), 'deployed', 'completed', 'success', 'success', now(), now() + interval '6 hours', null);

select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;
create temp table first_claim on commit drop as
select public.claim_narrative_publication_check('a8500000-0000-4000-8000-000000000001') value;
reset role;

select is((select value ->> 'outcome' from first_claim), 'claimed', 'a due nonterminal publication is claimed');
select is((select value ->> 'commit_sha' from first_claim), repeat('1', 40), 'the claim returns the exact immutable commit SHA');
select is((select value ->> 'credential' from first_claim), 'publication-tracking-fixture-value', 'the GitHub credential is materialized only inside the service claim response');
select is((select tracking_status || '|' || tracking_check_count from public.publish_jobs where id = 'a8400000-0000-0000-0000-000000000001'), 'observing|1', 'claim records one bounded observation attempt');

select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;
select lives_ok(
  $$ select public.record_narrative_publication_check('a8400000-0000-0000-0000-000000000001', 'a8500000-0000-4000-8000-000000000001', repeat('1', 40), 'in_progress', 'pending', 42, null, null, null) $$,
  'the exact check token records a running workflow'
);
reset role;
select is((select publication_phase || '|' || workflow_status || '|' || pages_status || '|' || tracking_status from public.publish_jobs where id = 'a8400000-0000-0000-0000-000000000001'), 'workflow_running|in_progress|pending|pending', 'workflow and Pages remain separate nonterminal phases');
select ok((select tracking_next_check_at > now() and tracking_next_check_at <= now() + interval '2 minutes' from public.publish_jobs where id = 'a8400000-0000-0000-0000-000000000001'), 'the first retry interval is bounded');

update public.publish_jobs set tracking_next_check_at = now() - interval '1 second' where id = 'a8400000-0000-0000-0000-000000000001';
select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;
select public.claim_narrative_publication_check('a8500000-0000-4000-8000-000000000002');
select throws_ok(
  $$ select public.record_narrative_publication_check('a8400000-0000-0000-0000-000000000001', 'a8500000-0000-4000-8000-000000000002', repeat('9', 40), 'in_progress', 'pending', 42, null, null, null) $$,
  'P0001', 'publication_check_commit_mismatch', 'a valid check token cannot record observation for a different commit SHA'
);
select throws_ok(
  $$ select public.record_narrative_publication_check('a8400000-0000-0000-0000-000000000001', 'a8500000-0000-4000-8000-000000000001', repeat('1', 40), 'failure', 'pending', 42, null, null, 'workflow_failed') $$,
  'P0001', 'publication_check_attempt_mismatch', 'a replaced observation token cannot mutate tracking'
);
select throws_ok(
  $$ select public.record_narrative_publication_check_retry('a8400000-0000-0000-0000-000000000001', 'a8500000-0000-4000-8000-000000000002', repeat('9', 40), 'github_timeout') $$,
  'P0001', 'publication_check_commit_mismatch', 'a provider retry cannot be scheduled for a different commit SHA'
);
select lives_ok(
  $$ select public.record_narrative_publication_check_retry('a8400000-0000-0000-0000-000000000001', 'a8500000-0000-4000-8000-000000000002', repeat('1', 40), 'github_timeout') $$,
  'a transient provider failure durably schedules the replacement observation with backoff'
);
reset role;
select ok(
  (select tracking_next_check_at > now() + interval '90 seconds' and tracking_next_check_at <= now() + interval '3 minutes'
   from public.publish_jobs where id = 'a8400000-0000-0000-0000-000000000001'),
  'the second retry interval increases and remains bounded'
);
update public.publish_jobs set tracking_next_check_at = now() - interval '1 second' where id = 'a8400000-0000-0000-0000-000000000001';
select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;
select public.claim_narrative_publication_check('a8500000-0000-4000-8000-000000000003');
select lives_ok(
  $$ select public.record_narrative_publication_check('a8400000-0000-0000-0000-000000000001', 'a8500000-0000-4000-8000-000000000003', repeat('1', 40), 'failure', 'pending', 42, null, null, 'workflow_failed') $$,
  'the current token can record a terminal workflow failure'
);
reset role;
select is((select status || '|' || publication_phase || '|' || workflow_status || '|' || tracking_status from public.publish_jobs where id = 'a8400000-0000-0000-0000-000000000001'), 'published|workflow_failed|failure|completed', 'workflow failure never rewrites commit success');
select is((select status from public.drafts where id = 'a8100000-0000-0000-0000-000000000001'), 'published', 'tracking failure never changes narrative approval or published commit state');

update public.publish_jobs
set tracking_started_at = now() - interval '7 hours', tracking_expires_at = now() - interval '1 hour', tracking_next_check_at = now() - interval '1 second'
where id = 'a8400000-0000-0000-0000-000000000002';
select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;
create temp table timeout_claim on commit drop as
select public.claim_narrative_publication_check('a8500000-0000-4000-8000-000000000004') value;
reset role;
select is((select value ->> 'outcome' from timeout_claim), 'timed_out', 'an expired observation window stops before any GitHub claim material is returned');
select is((select status || '|' || publication_phase || '|' || tracking_status from public.publish_jobs where id = 'a8400000-0000-0000-0000-000000000002'), 'published|tracking_timed_out|timed_out', 'observation timeout remains separate from commit success');
select is((select status from public.drafts where id = 'a8100000-0000-0000-0000-000000000002'), 'published', 'observation timeout never changes narrative approval');

update public.publish_jobs set tracking_status = 'timed_out', publication_phase = 'tracking_timed_out', workflow_status = 'timed_out', pages_status = 'timed_out', tracking_next_check_at = null where id = 'a8400000-0000-0000-0000-000000000001';
select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;
select lives_ok($$ select public.retry_narrative_publication_check('a8400000-0000-0000-0000-000000000001') $$, 'a service-only retry resets the observation window');
reset role;
select is((select status || '|' || tracking_status || '|' || publication_phase from public.publish_jobs where id = 'a8400000-0000-0000-0000-000000000001'), 'published|pending|commit_created', 'tracking retry leaves commit success intact');
select is((select status from public.drafts where id = 'a8100000-0000-0000-0000-000000000001'), 'published', 'tracking retry does not change narrative approval');
select is((select count(*) from public.audit_events where entity_id = 'a8100000-0000-0000-0000-000000000001' and payload::text ~* '(fixture-value|https?://|credential|token)'), 0::bigint, 'tracking audits contain bounded identifiers and codes only');
select hasnt_column('public', 'publish_jobs', 'github_credential', 'GitHub tracking credentials are never persisted');

select * from finish();
rollback;
