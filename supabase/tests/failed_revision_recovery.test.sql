begin;

select plan(3);

insert into public.drafts (id, owner_id, kind, title)
values ('ac100000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'short_dialogue', 'failed revision recovery');
insert into public.draft_versions (id, owner_id, draft_id, version_number, content, continuity_level)
values (
  'ac200000-0000-0000-0000-000000000001',
  '10000000-0000-0000-0000-000000000001',
  'ac100000-0000-0000-0000-000000000001',
  1,
  '{"title":"failed revision recovery","body":"기존 초안 본문","canonChangeCandidates":[]}',
  'review'
);
update public.drafts set status = 'reviewing' where id = 'ac100000-0000-0000-0000-000000000001';

select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-000000000001', true);
set local role authenticated;
create temp table failed_revision_job as
select public.queue_draft_revision(
  'ac100000-0000-0000-0000-000000000001',
  'ac200000-0000-0000-0000-000000000001',
  '기존 초안',
  '말투를 다듬기',
  64,
  100
) as value;

reset role;
update public.generation_jobs
set status = 'failed',
    generation_mode = 'revise_selection',
    failure_code = 'provider_output_limit',
    failure_at = now()
where id = (select (value ->> 'job_id')::uuid from failed_revision_job);

select is(
  (select status from public.drafts where id = 'ac100000-0000-0000-0000-000000000001'),
  'reviewing',
  'a failed focused revision restores the existing draft to review'
);
select is(
  (select count(*) from public.draft_versions where draft_id = 'ac100000-0000-0000-0000-000000000001'),
  1::bigint,
  'revision failure keeps the existing immutable version'
);

insert into public.drafts (id, owner_id, kind, status, title)
values ('ac100000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000001', 'short_dialogue', 'queued', 'failed new generation');
insert into public.generation_jobs (
  id, owner_id, draft_id, schedule_key, scheduled_for, status, payload, generation_mode, failure_code, failure_at
) values (
  'ac300000-0000-0000-0000-000000000002',
  '10000000-0000-0000-0000-000000000001',
  'ac100000-0000-0000-0000-000000000002',
  'failed-new-generation',
  now(),
  'failed',
  '{"source":"manual","mode":"new","kind":"short_dialogue","manualRequestKey":"failed-new-generation"}',
  'new',
  'provider_output_limit',
  now()
);
select is(
  (select status from public.drafts where id = 'ac100000-0000-0000-0000-000000000002'),
  'queued',
  'a failed new generation is not mistaken for a reviewable revision'
);

select * from finish();
rollback;
