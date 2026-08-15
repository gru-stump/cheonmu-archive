begin;

select plan(31);

select has_function('public', 'save_manual_draft_version', array['uuid', 'uuid', 'text', 'jsonb'], 'manual edits use one narrow immutable-version command');
select has_function('public', 'queue_draft_revision', array['uuid', 'uuid', 'text', 'text', 'integer', 'bigint'], 'partial revision preparation has one narrow owner command');
select has_function('public', 'archive_narrative_draft', array['uuid', 'uuid', 'text'], 'archive is a narrow reversible command');
select has_function('public', 'retry_narrative_publish', array['uuid', 'uuid', 'text'], 'publish retry is a narrow expected-state command');
select ok(
  has_function_privilege('authenticated', 'public.save_manual_draft_version(uuid,uuid,text,jsonb)', 'EXECUTE')
  and has_function_privilege('authenticated', 'public.queue_draft_revision(uuid,uuid,text,text,integer,bigint)', 'EXECUTE')
  and has_function_privilege('authenticated', 'public.archive_narrative_draft(uuid,uuid,text)', 'EXECUTE')
  and has_function_privilege('authenticated', 'public.retry_narrative_publish(uuid,uuid,text)', 'EXECUTE'),
  'authenticated owner receives only the named workflow commands'
);
select ok(
  not has_function_privilege('anon', 'public.save_manual_draft_version(uuid,uuid,text,jsonb)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.queue_draft_revision(uuid,uuid,text,text,integer,bigint)', 'EXECUTE'),
  'anonymous callers receive no workflow command'
);

insert into public.drafts (id, owner_id, kind, title) values
  ('a1000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'short_dialogue', 'editable'),
  ('a1000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000001', 'short_dialogue', 'blocked'),
  ('a1000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000001', 'short_dialogue', 'revise'),
  ('a1000000-0000-0000-0000-000000000004', '10000000-0000-0000-0000-000000000001', 'short_dialogue', 'archive'),
  ('a1000000-0000-0000-0000-000000000005', '10000000-0000-0000-0000-000000000001', 'short_dialogue', 'retry'),
  ('a1000000-0000-0000-0000-000000000006', '10000000-0000-0000-0000-000000000001', 'short_dialogue', 'generated success');
insert into public.generation_jobs (id, owner_id, draft_id, schedule_key, scheduled_for, status, created_at) values
  ('a3000000-0000-0000-0000-000000000006', '10000000-0000-0000-0000-000000000001', 'a1000000-0000-0000-0000-000000000006', 'completed-admin-success', '2026-08-14 01:23:00+00', 'completed', '2026-08-14 01:20:00+00');
insert into public.draft_versions (id, owner_id, draft_id, generation_job_id, version_number, content, context_version_ids, continuity_level, continuity_policy_version, created_at) values
  ('a2000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'a1000000-0000-0000-0000-000000000001', null, 1, '{"title":"editable","body":"선택 구절","canonChangeCandidates":[]}', array['canon-v7'], 'review', 'cheonmu-continuity-v1', default),
  ('a2000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000001', 'a1000000-0000-0000-0000-000000000002', null, 1, '{"title":"blocked","body":"blocked","canonChangeCandidates":[]}', array['canon-v7'], 'block', 'cheonmu-continuity-v1', default),
  ('a2000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000001', 'a1000000-0000-0000-0000-000000000003', null, 1, '{"title":"revise","body":"선택 구절 뒤의 본문","canonChangeCandidates":[]}', array['canon-v7'], 'review', 'cheonmu-continuity-v1', default),
  ('a2000000-0000-0000-0000-000000000004', '10000000-0000-0000-0000-000000000001', 'a1000000-0000-0000-0000-000000000004', null, 1, '{"title":"archive","body":"archive body","canonChangeCandidates":[]}', array['canon-v7'], 'review', 'cheonmu-continuity-v1', default),
  ('a2000000-0000-0000-0000-000000000005', '10000000-0000-0000-0000-000000000001', 'a1000000-0000-0000-0000-000000000005', null, 1, '{"title":"retry","body":"retry body","canonChangeCandidates":[]}', array['canon-v7'], 'review', 'cheonmu-continuity-v1', default),
  ('a2000000-0000-0000-0000-000000000006', '10000000-0000-0000-0000-000000000001', 'a1000000-0000-0000-0000-000000000006', 'a3000000-0000-0000-0000-000000000006', 1, '{"title":"generated success","body":"generated body","canonChangeCandidates":[]}', array['canon-v7'], 'review', 'cheonmu-continuity-v1', '2026-08-14 01:23:45+00');
update public.drafts set status = 'reviewing' where id in ('a1000000-0000-0000-0000-000000000001', 'a1000000-0000-0000-0000-000000000002', 'a1000000-0000-0000-0000-000000000003', 'a1000000-0000-0000-0000-000000000006');
update public.drafts set status = 'generated' where id = 'a1000000-0000-0000-0000-000000000004';
update public.drafts set status = 'publish_failed' where id = 'a1000000-0000-0000-0000-000000000005';
insert into public.publish_jobs (id, owner_id, draft_id, draft_version_id, status) values ('a3000000-0000-0000-0000-000000000005', '10000000-0000-0000-0000-000000000001', 'a1000000-0000-0000-0000-000000000005', 'a2000000-0000-0000-0000-000000000005', 'failed');
update public.schedules set enabled = true where owner_id = '10000000-0000-0000-0000-000000000001' and schedule_key = 'daily-local-fixture';

select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-000000000001', true);
set local role authenticated;

select ok((public.get_narrative_dashboard() ->> 'nextScheduleAt') is not null, 'dashboard derives the next enabled Seoul schedule before a job is queued');
select is((public.get_narrative_dashboard() ->> 'lastSuccessAt')::timestamptz, '2026-08-14 01:23:45+00'::timestamptz, 'dashboard last success comes from a completed generated version');
select lives_ok($$ select public.save_manual_draft_version('a1000000-0000-0000-0000-000000000006', 'a2000000-0000-0000-0000-000000000006', 'reviewing', '{"title":"manual follow-up","body":"manual body","canonChangeCandidates":[]}') $$, 'manual follow-up appends after generated success');
select is((public.get_narrative_dashboard() ->> 'lastSuccessAt')::timestamptz, '2026-08-14 01:23:45+00'::timestamptz, 'manual versions do not advance dashboard last success');
select lives_ok($$ select public.save_manual_draft_version('a1000000-0000-0000-0000-000000000001', 'a2000000-0000-0000-0000-000000000001', 'reviewing', '{"title":"edited","body":"new body","canonChangeCandidates":[]}') $$, 'manual edit creates a version');
select is((select count(*) from public.draft_versions where draft_id = 'a1000000-0000-0000-0000-000000000001'), 2::bigint, 'manual edit appends instead of overwriting');
select is((select content ->> 'body' from public.draft_versions where id = 'a2000000-0000-0000-0000-000000000001'), '선택 구절', 'the selected source version remains immutable');
select throws_ok($$ select public.save_manual_draft_version('a1000000-0000-0000-0000-000000000002', 'a2000000-0000-0000-0000-000000000002', 'reviewing', '{"title":"blocked edit","body":"bad","canonChangeCandidates":[]}') $$, 'P0001', 'blocked_version_reject_only', 'blocked latest version cannot be edited');
select throws_ok($$ select public.queue_draft_revision('a1000000-0000-0000-0000-000000000002', 'a2000000-0000-0000-0000-000000000002', 'blocked', 'rewrite', 64, 0) $$, 'P0001', 'blocked_version_reject_only', 'blocked latest version cannot be AI revised');
select throws_ok($$ select public.queue_draft_revision('a1000000-0000-0000-0000-000000000001', 'a2000000-0000-0000-0000-000000000001', '선택 구절', 'rewrite', 64, 0) $$, 'P0001', 'stale_revision', 'a stale source version cannot queue a revision');
select is((select count(*) from public.generation_jobs where draft_id = 'a1000000-0000-0000-0000-000000000001'), 0::bigint, 'a stale revision leaves no queued job');
select is((select status from public.drafts where id = 'a1000000-0000-0000-0000-000000000002'), 'reviewing', 'blocked command attempts leave the draft inspectable');
select lives_ok($$ select public.queue_draft_revision('a1000000-0000-0000-0000-000000000003', 'a2000000-0000-0000-0000-000000000003', '선택 구절', '말투만 수정', 64, 100) $$, 'confirmed focused revision is queued');
select is((select count(*) from public.generation_jobs where draft_id = 'a1000000-0000-0000-0000-000000000003' and source_draft_version_id = 'a2000000-0000-0000-0000-000000000003'), 1::bigint, 'revision job points at the immutable selected version');
select is((select payload #>> '{revision,selectedText}' from public.generation_jobs where draft_id = 'a1000000-0000-0000-0000-000000000003'), '선택 구절', 'revision job retains the selected passage and instruction payload');
select is((select requested_max_output_tokens from public.generation_jobs where draft_id = 'a1000000-0000-0000-0000-000000000003'), 64, 'revision job retains the requested output ceiling and cost confirmation');
select throws_ok($$ select public.archive_narrative_draft('a1000000-0000-0000-0000-000000000003', 'a2000000-0000-0000-0000-000000000003', 'queued') $$, '22023', 'invalid_archive_state', 'a queued revision cannot be archived without cancellation');
select lives_ok($$ select public.archive_narrative_draft('a1000000-0000-0000-0000-000000000004', 'a2000000-0000-0000-0000-000000000004', 'generated') $$, 'owner can reversibly archive an expected latest version');
select is((select status from public.drafts where id = 'a1000000-0000-0000-0000-000000000004'), 'archived', 'archive moves the draft to archived without deleting its version');
select throws_ok($$ select public.archive_narrative_draft('a1000000-0000-0000-0000-000000000002', 'a2000000-0000-0000-0000-000000000002', 'reviewing') $$, 'P0001', 'blocked_version_reject_only', 'blocked latest version cannot be archived');
select lives_ok($$ select public.retry_narrative_publish('a1000000-0000-0000-0000-000000000005', 'a2000000-0000-0000-0000-000000000005', 'publish_failed') $$, 'failed publication can be retried for the exact latest approved version');
select is((select status from public.drafts where id = 'a1000000-0000-0000-0000-000000000005'), 'publishing', 'publish retry keeps approval and moves the draft back to publishing');
select is((select status from public.publish_jobs where id = 'a3000000-0000-0000-0000-000000000005'), 'queued', 'publish retry requeues the existing immutable-version job');
select throws_ok($$ select public.archive_narrative_draft('a1000000-0000-0000-0000-000000000005', 'a2000000-0000-0000-0000-000000000005', 'publishing') $$, '22023', 'invalid_archive_state', 'an in-flight publication cannot be archived without cancellation');
reset role;
update public.drafts set status = 'published' where id = 'a1000000-0000-0000-0000-000000000005';
set local role authenticated;
select throws_ok($$ select public.archive_narrative_draft('a1000000-0000-0000-0000-000000000005', 'a2000000-0000-0000-0000-000000000005', 'published') $$, '22023', 'invalid_archive_state', 'a published draft cannot be archived as a substitute for unpublishing');

reset role;
select * from finish();
rollback;
