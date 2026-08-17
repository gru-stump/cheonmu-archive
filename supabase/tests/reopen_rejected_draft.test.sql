begin;
select plan(16);

select has_function('public', 'reopen_rejected_draft', array['uuid', 'uuid'], 'reopen is one narrow owner command');
select ok(has_function_privilege('authenticated', 'public.reopen_rejected_draft(uuid,uuid)', 'EXECUTE'), 'authenticated owner may reopen a rejected draft');
select ok(not has_function_privilege('anon', 'public.reopen_rejected_draft(uuid,uuid)', 'EXECUTE'), 'anonymous callers cannot reopen drafts');
select ok(not has_function_privilege('service_role', 'public.reopen_rejected_draft(uuid,uuid)', 'EXECUTE'), 'service role cannot impersonate the owner reopen action');

insert into public.drafts (id, owner_id, kind, title)
values ('aa100000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'short_dialogue', 'reopen fixture');
insert into public.draft_versions (id, owner_id, draft_id, version_number, content, context_version_ids, continuity_level, continuity_policy_version)
values ('aa200000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'aa100000-0000-0000-0000-000000000001', 1, '{"title":"reopen fixture","body":"immutable rejected body","canonChangeCandidates":[]}', '{}', 'review', 'cheonmu-continuity-v1');
insert into public.draft_review_actions (owner_id, draft_id, draft_version_id, idempotency_key, action, expected_state, resulting_state, reason)
values ('10000000-0000-0000-0000-000000000001', 'aa100000-0000-0000-0000-000000000001', 'aa200000-0000-0000-0000-000000000001', 'reopen-fixture-reject', 'reject', 'reviewing', 'rejected', '말투를 다시 다듬어야 한다.');
update public.drafts set status = 'rejected' where id = 'aa100000-0000-0000-0000-000000000001';

select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-000000000001', true);
set local role authenticated;
select lives_ok($$ select public.reopen_rejected_draft('aa100000-0000-0000-0000-000000000001', 'aa200000-0000-0000-0000-000000000001') $$, 'owner reopens the exact rejected latest version');
select is((select status from public.drafts where id = 'aa100000-0000-0000-0000-000000000001'), 'reviewing', 'reopened draft returns to reviewing');
select is((select count(*) from public.draft_versions where draft_id = 'aa100000-0000-0000-0000-000000000001'), 1::bigint, 'reopen leaves immutable version count unchanged');
select is((select content ->> 'body' from public.draft_versions where id = 'aa200000-0000-0000-0000-000000000001'), 'immutable rejected body', 'reopen leaves immutable content unchanged');
select is((select reason from public.draft_review_actions where idempotency_key = 'reopen-fixture-reject'), '말투를 다시 다듬어야 한다.', 'reopen preserves rejection feedback');
select is((select count(*) from public.audit_events where entity_id = 'aa100000-0000-0000-0000-000000000001' and event_type = 'draft_review_reopened'), 1::bigint, 'reopen writes one audit event');
reset role;

update public.drafts set status = 'rejected' where id = 'aa100000-0000-0000-0000-000000000001';
select set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-000000000002', true);
set local role authenticated;
select throws_ok($$ select public.reopen_rejected_draft('aa100000-0000-0000-0000-000000000001', 'aa200000-0000-0000-0000-000000000001') $$, 'P0002', 'reopen target not found', 'another owner cannot reopen the draft');
reset role;
select is((select status from public.drafts where id = 'aa100000-0000-0000-0000-000000000001'), 'rejected', 'foreign reopen leaves the draft rejected');

select set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-000000000001', true);
set local role authenticated;
select throws_ok($$ select public.reopen_rejected_draft('aa100000-0000-0000-0000-000000000001', 'aa200000-0000-0000-0000-000000000099') $$, 'P0001', 'stale_reopen', 'stale expected version cannot reopen the draft');
select is((select status from public.drafts where id = 'aa100000-0000-0000-0000-000000000001'), 'rejected', 'stale reopen leaves the draft rejected');
reset role;
update public.drafts set status = 'reviewing' where id = 'aa100000-0000-0000-0000-000000000001';
set local role authenticated;
select throws_ok($$ select public.reopen_rejected_draft('aa100000-0000-0000-0000-000000000001', 'aa200000-0000-0000-0000-000000000001') $$, 'P0001', 'stale_reopen', 'an already active draft cannot be reopened again');
select is((select count(*) from public.audit_events where entity_id = 'aa100000-0000-0000-0000-000000000001' and event_type = 'draft_review_reopened'), 1::bigint, 'failed reopen attempts add no audit event');

select * from finish();
rollback;
