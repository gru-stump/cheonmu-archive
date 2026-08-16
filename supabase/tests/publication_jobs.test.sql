begin;

select plan(67);

select has_column('public', 'publish_jobs', 'approval_action_id', 'publication binds the exact public approval action');
select has_column('public', 'publish_jobs', 'publication_details', 'publication metadata is frozen on the server-owned job');
select has_column('public', 'publish_jobs', 'idempotency_key', 'publication persists the owner request idempotency key');
select has_column('public', 'publish_jobs', 'attempt_token', 'publication completion is scoped to one server attempt');
select has_column('public', 'publish_jobs', 'attempt_count', 'publication retries are explicit and counted');
select has_column('public', 'publish_jobs', 'repository_owner', 'the claimed job freezes repository owner');
select has_column('public', 'publish_jobs', 'repository_name', 'the claimed job freezes repository name');
select has_column('public', 'publish_jobs', 'repository_branch', 'the claimed job freezes repository branch');
select has_column('public', 'publish_jobs', 'commit_sha', 'commit success records its SHA');
select has_column('public', 'publish_jobs', 'published_path', 'commit success records its exact archive path');
select has_column('public', 'publish_jobs', 'failure_code', 'publication stores only a sanitized failure code');
select has_column('public', 'publish_jobs', 'claimed_at', 'the current publication claim is observable');
select has_column('public', 'publish_jobs', 'claim_expires_at', 'publication claims have a durable recovery lease');
select has_function('public', 'claim_narrative_publication', array['uuid','uuid','uuid','text','uuid'], 'one service RPC claims a locked publication snapshot');
select has_function('public', 'renew_narrative_publication_claim', array['uuid','uuid'], 'one service RPC renews and fences the exact attempt before publication');
select has_function('public', 'complete_narrative_publication', array['uuid','uuid','text','text'], 'one service RPC records commit success');
select has_function('public', 'fail_narrative_publication', array['uuid','uuid','text'], 'one service RPC records sanitized failure');
select ok(
  (select bool_and(has_function_privilege('service_role', signature, 'EXECUTE')) from unnest(array[
    'public.claim_narrative_publication(uuid,uuid,uuid,text,uuid)',
    'public.renew_narrative_publication_claim(uuid,uuid)',
    'public.complete_narrative_publication(uuid,uuid,text,text)',
    'public.fail_narrative_publication(uuid,uuid,text)'
  ]) as signature),
  'service_role can execute every publication mutation RPC'
);
select ok(
  not exists (select 1 from unnest(array[
    'public.claim_narrative_publication(uuid,uuid,uuid,text,uuid)',
    'public.renew_narrative_publication_claim(uuid,uuid)',
    'public.complete_narrative_publication(uuid,uuid,text,text)',
    'public.fail_narrative_publication(uuid,uuid,text)'
  ]) as signature where has_function_privilege('authenticated', signature, 'EXECUTE')),
  'authenticated callers cannot invoke publication mutation RPCs directly'
);
select ok(
  not exists (
    select 1 from information_schema.routine_privileges
    where routine_schema = 'public'
      and routine_name in ('claim_narrative_publication', 'renew_narrative_publication_claim', 'complete_narrative_publication', 'fail_narrative_publication')
      and grantee in ('PUBLIC', 'anon', 'authenticated') and privilege_type = 'EXECUTE'
  ),
  'PUBLIC, anon, and authenticated have no publication mutation grants'
);
select ok(has_table_privilege('authenticated', 'public.publish_jobs', 'SELECT'), 'authenticated owners retain read-only publication access');
select ok(
  not has_table_privilege('authenticated', 'public.publish_jobs', 'INSERT')
  and not has_table_privilege('authenticated', 'public.publish_jobs', 'UPDATE')
  and not has_table_privilege('authenticated', 'public.publish_jobs', 'DELETE'),
  'authenticated owners cannot mutate publication rows'
);
select hasnt_function('public', 'retry_narrative_publish', array['uuid','uuid','text'], 'the old browser-callable retry mutation is removed');
select ok((select relrowsecurity from pg_class where oid = 'public.publish_jobs'::regclass), 'publish jobs retain RLS as defense in depth');

update public.narrative_admin_settings
set github_repository_owner = 'cheonmu-owner', github_repository_name = 'cheonmu-archive', github_branch = 'main'
where owner_id = '10000000-0000-0000-0000-000000000001';

select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;
select public.store_narrative_secret('10000000-0000-0000-0000-000000000001', 'github', 'publication-pgtap-fixture-value');
reset role;

insert into public.drafts (id, owner_id, kind, title) values
  ('91000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'daily_event', 'approved publication'),
  ('91000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000001', 'daily_event', 'not approved publication'),
  ('91000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000001', 'daily_event', 'retry publication'),
  ('91000000-0000-0000-0000-000000000004', '10000000-0000-0000-0000-000000000001', 'daily_event', 'queued behind publication');

insert into public.draft_versions (id, owner_id, draft_id, version_number, content, continuity_level, continuity_policy_version) values
  ('92000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', '91000000-0000-0000-0000-000000000001', 1,
    '{"title":"비가 그친 뒤","body":"공개 본문","canonChangeCandidates":["candidate-1"],"unresolvedCallbacks":[],"publication":{"id":"rainy-return","recordNumber":"08","relationshipStage":7,"date":"2026-08-15","summary":"공개 요약","characters":["cheonryeong","muyeong"],"tags":["비"],"related":["witnessing"],"quote":"대표 문장","archiveSnapshot":{"recordIds":["witnessing"],"recordNumbers":["CM-07"]}}}'::jsonb,
    'review', 'cheonmu-continuity-v1'),
  ('92000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000001', '91000000-0000-0000-0000-000000000002', 1,
    '{"title":"미승인","body":"비공개 본문","canonChangeCandidates":[],"unresolvedCallbacks":[],"publication":{"id":"not-approved","recordNumber":"09","relationshipStage":7,"date":"2026-08-15","summary":"요약","characters":["cheonryeong","muyeong"],"tags":["비"],"related":[],"quote":"대표 문장","archiveSnapshot":{"recordIds":["witnessing"],"recordNumbers":["CM-07"]}}}'::jsonb,
    'review', 'cheonmu-continuity-v1'),
  ('92000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000001', '91000000-0000-0000-0000-000000000003', 1,
    '{"title":"재시도","body":"재시도 본문","canonChangeCandidates":[],"unresolvedCallbacks":[],"publication":{"id":"retry-record","recordNumber":"10","relationshipStage":7,"date":"2026-08-15","summary":"요약","characters":["cheonryeong","muyeong"],"tags":["재시도"],"related":[],"quote":"대표 문장","archiveSnapshot":{"recordIds":["witnessing"],"recordNumbers":["CM-07"]}}}'::jsonb,
    'review', 'cheonmu-continuity-v1'),
  ('92000000-0000-0000-0000-000000000004', '10000000-0000-0000-0000-000000000001', '91000000-0000-0000-0000-000000000004', 1,
    '{"title":"대기","body":"대기 본문","canonChangeCandidates":[],"unresolvedCallbacks":[],"publication":{"id":"queued-record","recordNumber":"11","relationshipStage":7,"date":"2026-08-15","summary":"요약","characters":["cheonryeong","muyeong"],"tags":["대기"],"related":[],"quote":"대표 문장","archiveSnapshot":{"recordIds":["witnessing"],"recordNumbers":["CM-07"]}}}'::jsonb,
    'review', 'cheonmu-continuity-v1');

insert into public.draft_review_actions (id, owner_id, draft_id, draft_version_id, idempotency_key, action, expected_state, resulting_state) values
  ('93000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', '91000000-0000-0000-0000-000000000001', '92000000-0000-0000-0000-000000000001', 'approval-one', 'approve_public', 'reviewing', 'approved'),
  ('93000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000001', '91000000-0000-0000-0000-000000000002', '92000000-0000-0000-0000-000000000002', 'approval-two', 'approve_public', 'reviewing', 'approved'),
  ('93000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000001', '91000000-0000-0000-0000-000000000003', '92000000-0000-0000-0000-000000000003', 'approval-three', 'approve_public', 'reviewing', 'approved'),
  ('93000000-0000-0000-0000-000000000004', '10000000-0000-0000-0000-000000000001', '91000000-0000-0000-0000-000000000004', '92000000-0000-0000-0000-000000000004', 'approval-four', 'approve_public', 'reviewing', 'approved');

update public.drafts set status = case id
  when '91000000-0000-0000-0000-000000000002'::uuid then 'reviewing'
  else 'approved'
end
where id in (
  '91000000-0000-0000-0000-000000000001', '91000000-0000-0000-0000-000000000002',
  '91000000-0000-0000-0000-000000000003', '91000000-0000-0000-0000-000000000004'
);

insert into public.publish_jobs (id, owner_id, draft_id, draft_version_id, status, publication_details) values
  ('94000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', '91000000-0000-0000-0000-000000000001', '92000000-0000-0000-0000-000000000001', 'queued', '{"id":"forged-browser-record"}'::jsonb),
  ('94000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000001', '91000000-0000-0000-0000-000000000002', '92000000-0000-0000-0000-000000000002', 'queued', '{}'::jsonb),
  ('94000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000001', '91000000-0000-0000-0000-000000000003', '92000000-0000-0000-0000-000000000003', 'queued', '{}'::jsonb),
  ('94000000-0000-0000-0000-000000000004', '10000000-0000-0000-0000-000000000001', '91000000-0000-0000-0000-000000000004', '92000000-0000-0000-0000-000000000004', 'queued', '{}'::jsonb);

select is((select approval_action_id from public.publish_jobs where id = '94000000-0000-0000-0000-000000000001'), '93000000-0000-0000-0000-000000000001'::uuid, 'new jobs bind the exact public approval row');
select is((select publication_details ->> 'id' from public.publish_jobs where id = '94000000-0000-0000-0000-000000000001'), 'rainy-return', 'new jobs freeze publication metadata from the immutable approved version');

select throws_ok(
  $$ do $command$ begin
    update public.publish_jobs set owner_id = '10000000-0000-0000-0000-000000000099' where id = '94000000-0000-0000-0000-000000000004';
    raise exception 'queued_binding_mutation_accepted' using errcode = 'P0001';
  end $command$ $$,
  '55000', 'publication binding is immutable after creation', 'a queued job cannot change its bound owner'
);
select throws_ok(
  $$ do $command$ begin
    update public.publish_jobs set draft_id = '91000000-0000-0000-0000-000000000001' where id = '94000000-0000-0000-0000-000000000004';
    raise exception 'queued_binding_mutation_accepted' using errcode = 'P0001';
  end $command$ $$,
  '55000', 'publication binding is immutable after creation', 'a queued job cannot change its bound draft'
);
select throws_ok(
  $$ do $command$ begin
    update public.publish_jobs set draft_version_id = '92000000-0000-0000-0000-000000000001' where id = '94000000-0000-0000-0000-000000000004';
    raise exception 'queued_binding_mutation_accepted' using errcode = 'P0001';
  end $command$ $$,
  '55000', 'publication binding is immutable after creation', 'a queued job cannot change its bound immutable version'
);
select throws_ok(
  $$ do $command$ begin
    update public.publish_jobs set approval_action_id = '93000000-0000-0000-0000-000000000001' where id = '94000000-0000-0000-0000-000000000004';
    raise exception 'queued_binding_mutation_accepted' using errcode = 'P0001';
  end $command$ $$,
  '55000', 'publication binding is immutable after creation', 'a queued job cannot change its exact public approval'
);
select throws_ok(
  $$ do $command$ begin
    update public.publish_jobs set publication_details = '{"id":"forged-update"}'::jsonb where id = '94000000-0000-0000-0000-000000000004';
    raise exception 'queued_binding_mutation_accepted' using errcode = 'P0001';
  end $command$ $$,
  '55000', 'publication binding is immutable after creation', 'a queued job cannot replace its frozen publication details'
);

alter table public.publish_jobs disable trigger publish_jobs_protect_claimed_binding;
update public.publish_jobs set publication_details = '{"id":"forged-corruption"}'::jsonb
where id = '94000000-0000-0000-0000-000000000004';
alter table public.publish_jobs enable trigger publish_jobs_protect_claimed_binding;
select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;
select throws_ok(
  $$ do $command$ begin
    perform public.claim_narrative_publication('10000000-0000-0000-0000-000000000001', '94000000-0000-0000-0000-000000000004', '92000000-0000-0000-0000-000000000004', 'tampered-binding', '95000000-0000-4000-8000-000000000099');
    raise exception 'tampered_publication_claim_accepted' using errcode = 'P0001';
  end $command$ $$,
  'P0001', 'publication_not_approved', 'claim revalidates frozen publication details against the immutable version'
);
reset role;
alter table public.publish_jobs disable trigger publish_jobs_protect_claimed_binding;
update public.publish_jobs set publication_details = (select content -> 'publication' from public.draft_versions where id = '92000000-0000-0000-0000-000000000004')
where id = '94000000-0000-0000-0000-000000000004';
alter table public.publish_jobs enable trigger publish_jobs_protect_claimed_binding;

select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;

select throws_ok(
  $$ select public.claim_narrative_publication('10000000-0000-0000-0000-000000000001', '94000000-0000-0000-0000-000000000002', '92000000-0000-0000-0000-000000000002', 'publish-not-approved', '95000000-0000-4000-8000-000000000002') $$,
  'P0001', 'publication_not_approved', 'only an approved draft may enter initial publishing'
);
select lives_ok(
  $$ select public.claim_narrative_publication('10000000-0000-0000-0000-000000000001', '94000000-0000-0000-0000-000000000001', '92000000-0000-0000-0000-000000000001', 'publish-one', '95000000-0000-4000-8000-000000000001') $$,
  'an approved exact version enters publishing'
);

reset role;

select is((select status from public.drafts where id = '91000000-0000-0000-0000-000000000001'), 'publishing', 'claim transitions the approved draft to publishing');
select is((select status from public.publish_jobs where id = '94000000-0000-0000-0000-000000000001'), 'publishing', 'claim transitions the queue row to publishing');
select is((select idempotency_key from public.publish_jobs where id = '94000000-0000-0000-0000-000000000001'), 'publish-one', 'claim freezes the idempotency key');
select is((select attempt_count from public.publish_jobs where id = '94000000-0000-0000-0000-000000000001'), 1, 'first claim records one attempt');
select is((select repository_owner || '/' || repository_name || '@' || repository_branch from public.publish_jobs where id = '94000000-0000-0000-0000-000000000001'), 'cheonmu-owner/cheonmu-archive@main', 'claim freezes server-side repository settings');
select is((select jsonb_typeof(content -> 'canonChangeCandidates') from public.draft_versions where id = '92000000-0000-0000-0000-000000000001'), 'array', 'claim leaves immutable raw canon candidates unchanged');

select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;
select lives_ok(
  $$ select public.complete_narrative_publication('94000000-0000-0000-0000-000000000001', '95000000-0000-4000-8000-000000000001', '1111111111111111111111111111111111111111', 'src/content/records/08-rainy-return.md') $$,
  'the exact attempt records commit success'
);
reset role;

select is((select status from public.drafts where id = '91000000-0000-0000-0000-000000000001'), 'published', 'commit success transitions the draft to published');
select is((select status || '|' || commit_sha || '|' || published_path from public.publish_jobs where id = '94000000-0000-0000-0000-000000000001'), 'published|1111111111111111111111111111111111111111|src/content/records/08-rainy-return.md', 'commit success remains distinct and records exact commit metadata');

select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;
select is(
  public.claim_narrative_publication('10000000-0000-0000-0000-000000000001', '94000000-0000-0000-0000-000000000001', '92000000-0000-0000-0000-000000000001', 'publish-one', '95000000-0000-4000-8000-000000000009') ->> 'outcome',
  'already_published', 'same-key replay reconciles to the existing commit without a new claim'
);
reset role;
select is((select attempt_count from public.publish_jobs where id = '94000000-0000-0000-0000-000000000001'), 1, 'same-key replay does not increment attempts');

select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;
select lives_ok(
  $$ select public.claim_narrative_publication('10000000-0000-0000-0000-000000000001', '94000000-0000-0000-0000-000000000003', '92000000-0000-0000-0000-000000000003', 'publish-retry', '95000000-0000-4000-8000-000000000003') $$,
  'retry fixture enters its first publishing attempt'
);
select lives_ok(
  $$ select public.fail_narrative_publication('94000000-0000-0000-0000-000000000003', '95000000-0000-4000-8000-000000000003', 'github_timeout') $$,
  'a failed exact attempt records a sanitized failure'
);
reset role;
select is((select status from public.drafts where id = '91000000-0000-0000-0000-000000000003'), 'publish_failed', 'publication failure preserves approval in the retriable draft state');
select is((select status || '|' || failure_code from public.publish_jobs where id = '94000000-0000-0000-0000-000000000003'), 'failed|github_timeout', 'job failure stores only its bounded code');

select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;
select throws_ok(
  $$ select public.claim_narrative_publication('10000000-0000-0000-0000-000000000001', '94000000-0000-0000-0000-000000000003', '92000000-0000-0000-0000-000000000003', 'changed-key', '95000000-0000-4000-8000-000000000004') $$,
  'P0001', 'publication_idempotency_mismatch', 'retry cannot change the frozen idempotency key'
);
select lives_ok(
  $$ select public.claim_narrative_publication('10000000-0000-0000-0000-000000000001', '94000000-0000-0000-0000-000000000003', '92000000-0000-0000-0000-000000000003', 'publish-retry', '95000000-0000-4000-8000-000000000005') $$,
  'same-key retry returns the failed publication to publishing'
);
reset role;
select is((select draft.status || '|' || job.status from public.drafts as draft join public.publish_jobs as job on job.draft_id = draft.id where job.id = '94000000-0000-0000-0000-000000000003'), 'publishing|publishing', 'retry transactionally restores both states to publishing');
select is((select attempt_count from public.publish_jobs where id = '94000000-0000-0000-0000-000000000003'), 2, 'retry records a distinct second attempt');
select ok((select claim_expires_at > now() from public.publish_jobs where id = '94000000-0000-0000-0000-000000000003'), 'a live publication attempt has an unexpired durable lease');

select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;
select throws_ok(
  $$ select public.claim_narrative_publication('10000000-0000-0000-0000-000000000001', '94000000-0000-0000-0000-000000000003', '92000000-0000-0000-0000-000000000003', 'publish-retry', '95000000-0000-4000-8000-000000000007') $$,
  'P0001', 'publication_in_progress', 'an unexpired lease does not admit a concurrent same-key publisher'
);
reset role;

update public.publish_jobs set claim_expires_at = now() - interval '1 second'
where id = '94000000-0000-0000-0000-000000000003';
select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;
select lives_ok(
  $$ select public.claim_narrative_publication('10000000-0000-0000-0000-000000000001', '94000000-0000-0000-0000-000000000003', '92000000-0000-0000-0000-000000000003', 'publish-retry', '95000000-0000-4000-8000-000000000008') $$,
  'the same job and key recover an expired committed claim'
);
reset role;
select is((select attempt_count from public.publish_jobs where id = '94000000-0000-0000-0000-000000000003'), 3, 'lease recovery records one new attempt without duplicating the job');
select is((select attempt_token from public.publish_jobs where id = '94000000-0000-0000-0000-000000000003'), '95000000-0000-4000-8000-000000000008'::uuid, 'only the recovered attempt owns completion authority');

update public.publish_jobs set claim_expires_at = now() + interval '1 second'
where id = '94000000-0000-0000-0000-000000000003';
create temp table publication_stale_renewal_snapshot on commit drop as
select attempt_token, attempt_count, claim_expires_at, updated_at
from public.publish_jobs where id = '94000000-0000-0000-0000-000000000003';
select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;
select throws_ok(
  $$ select public.renew_narrative_publication_claim('94000000-0000-0000-0000-000000000003', '95000000-0000-4000-8000-000000000005') $$,
  'P0001', 'publication_attempt_mismatch', 'an expired worker cannot renew after a replacement attempt owns the job'
);
reset role;
select ok(
  (select row(job.attempt_token, job.attempt_count, job.claim_expires_at, job.updated_at)
    = row(snapshot.attempt_token, snapshot.attempt_count, snapshot.claim_expires_at, snapshot.updated_at)
   from public.publish_jobs as job cross join publication_stale_renewal_snapshot as snapshot
   where job.id = '94000000-0000-0000-0000-000000000003'),
  'a stale renewal failure is mutation-free'
);
select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;
select throws_ok(
  $$ select public.complete_narrative_publication('94000000-0000-0000-0000-000000000003', '95000000-0000-4000-8000-000000000005', '2222222222222222222222222222222222222222', 'src/content/records/09-stale-worker.md') $$,
  'P0001', 'publication_attempt_mismatch', 'a replaced worker cannot complete publication'
);
select lives_ok(
  $$ select public.renew_narrative_publication_claim('94000000-0000-0000-0000-000000000003', '95000000-0000-4000-8000-000000000008') $$,
  'the current exact attempt renews immediately before its external write'
);
reset role;
select ok(
  (select claim_expires_at > now() + interval '4 minutes' from public.publish_jobs where id = '94000000-0000-0000-0000-000000000003'),
  'pre-publication renewal restores the full bounded side-effect lease'
);

select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;
select throws_ok(
  $$ select public.claim_narrative_publication('10000000-0000-0000-0000-000000000001', '94000000-0000-0000-0000-000000000004', '92000000-0000-0000-0000-000000000004', 'publish-four', '95000000-0000-4000-8000-000000000006') $$,
  'P0001', 'publication_queue_busy', 'one publishing row serializes the repository queue'
);
reset role;

select throws_ok(
  $$ update public.publish_jobs set publication_details = jsonb_build_object('id', 'changed') where id = '94000000-0000-0000-0000-000000000003' $$,
  '55000', 'publication binding is immutable after creation', 'a retry cannot replace the frozen publication material'
);
select is((select count(*) from public.audit_events where entity_id = '91000000-0000-0000-0000-000000000001' and payload::text ~* '(prompt|provider|memory|cost|publication-pgtap-fixture-value|공개 본문)'), 0::bigint, 'publication audit payloads contain no source, private fields, costs, or credentials');
select hasnt_column('public', 'publish_jobs', 'credential', 'GitHub credentials are never persisted on publication rows');

select * from finish();

rollback;
