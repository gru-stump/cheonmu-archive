begin;

select plan(16);

insert into public.drafts (id, owner_id, kind, title)
values ('ab100000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'short_dialogue', 'revision binding');
insert into public.draft_versions (id, owner_id, draft_id, version_number, content, continuity_level)
values ('ab200000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'ab100000-0000-0000-0000-000000000001', 1,
  '{"title":"revision binding","body":"선택 구절 뒤의 본문","canonChangeCandidates":[]}', 'review');
update public.drafts set status = 'reviewing' where id = 'ab100000-0000-0000-0000-000000000001';

select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-000000000001', true);
set local role authenticated;
create temp table revision_binding_result as
select public.queue_draft_revision(
  'ab100000-0000-0000-0000-000000000001', 'ab200000-0000-0000-0000-000000000001',
  '선택 구절', '말투만 다듬기', 64, 100
) as value;
select ok((select value ->> 'job_id' from revision_binding_result) is not null, 'owner revision queue returns a server job');

reset role;
grant select on revision_binding_result to service_role;
select is(
  (select concat(
    job.draft_id, '|', job.provider_setting_id, '|', job.payload ->> 'source', '|',
    job.payload ->> 'mode', '|', job.payload ->> 'kind', '|',
    job.payload ->> 'manualRequestKey', '|', job.schedule_key
  ) from public.generation_jobs as job where job.id = (select (value ->> 'job_id')::uuid from revision_binding_result)),
  (select concat(
    'ab100000-0000-0000-0000-000000000001|12000000-0000-0000-0000-000000000001|manual|revise_selection|short_dialogue|',
    value ->> 'idempotency_key', '|', value ->> 'idempotency_key'
  ) from revision_binding_result),
  'revision queue prebinds draft, provider, source, mode, kind, and the exact server key'
);

select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;
select throws_ok(
  $$ select public.freeze_generation_context(
    (select (value ->> 'job_id')::uuid from revision_binding_result), 'ab100000-0000-0000-0000-000000000001',
    'new', (select value ->> 'idempotency_key' from revision_binding_result), array['binding-context'],
    '[{"versionId":"binding-context","memoryType":"canon","content":"frozen","tokenCount":1}]',
    '12000000-0000-0000-0000-000000000001', 'ab300000-0000-4000-8000-000000000001'
  ) $$,
  'P0001', 'manual_generation_binding_changed', 'revision cannot substitute the full-output new mode'
);
select throws_ok(
  $$ select public.freeze_generation_context(
    (select (value ->> 'job_id')::uuid from revision_binding_result), 'ab100000-0000-0000-0000-000000000001',
    'revise_selection', 'browser-key', array['binding-context'],
    '[{"versionId":"binding-context","memoryType":"canon","content":"frozen","tokenCount":1}]',
    '12000000-0000-0000-0000-000000000001', 'ab300000-0000-4000-8000-000000000002'
  ) $$,
  'P0001', 'manual_generation_binding_changed', 'revision cannot substitute the server idempotency key'
);
select throws_ok(
  $$ select public.freeze_generation_context(
    (select (value ->> 'job_id')::uuid from revision_binding_result), 'ab100000-0000-0000-0000-000000000001',
    'revise_selection', (select value ->> 'idempotency_key' from revision_binding_result), array['binding-context'],
    '[{"versionId":"binding-context","memoryType":"canon","content":"frozen","tokenCount":1}]',
    '12000000-0000-0000-0000-000000000099', 'ab300000-0000-4000-8000-000000000003'
  ) $$,
  'P0001', 'manual_generation_binding_changed', 'revision cannot substitute the provider'
);
select throws_ok(
  $$ select public.freeze_generation_context(
    (select (value ->> 'job_id')::uuid from revision_binding_result), 'ab100000-0000-0000-0000-000000000099',
    'revise_selection', (select value ->> 'idempotency_key' from revision_binding_result), array['binding-context'],
    '[{"versionId":"binding-context","memoryType":"canon","content":"frozen","tokenCount":1}]',
    '12000000-0000-0000-0000-000000000001', 'ab300000-0000-4000-8000-000000000004'
  ) $$,
  'P0001', 'manual_generation_binding_changed', 'revision cannot substitute the draft'
);

reset role;
update public.generation_jobs set payload = jsonb_set(payload, '{kind}', '"daily_event"')
where id = (select (value ->> 'job_id')::uuid from revision_binding_result);
set local role service_role;
select throws_ok(
  $$ select public.freeze_generation_context(
    (select (value ->> 'job_id')::uuid from revision_binding_result), 'ab100000-0000-0000-0000-000000000001',
    'revise_selection', (select value ->> 'idempotency_key' from revision_binding_result), array['binding-context'],
    '[{"versionId":"binding-context","memoryType":"canon","content":"frozen","tokenCount":1}]',
    '12000000-0000-0000-0000-000000000001', 'ab300000-0000-4000-8000-000000000005'
  ) $$,
  'P0001', 'manual_generation_binding_changed', 'revision fails closed when its server-bound kind changes'
);

reset role;
update public.generation_jobs set payload = jsonb_set(payload, '{kind}', '"short_dialogue"')
where id = (select (value ->> 'job_id')::uuid from revision_binding_result);
insert into public.drafts (id, owner_id, kind, status, title) values
  ('ab100000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000001', 'short_dialogue', 'queued', 'missing provider'),
  ('ab100000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000001', 'short_dialogue', 'queued', 'missing key');
insert into public.generation_jobs (id, owner_id, draft_id, schedule_key, scheduled_for, payload, provider_setting_id) values
  ('ab400000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000001', 'ab100000-0000-0000-0000-000000000002', 'missing-provider', now(),
    '{"source":"manual","mode":"revise_selection","kind":"short_dialogue","manualRequestKey":"missing-provider"}', null),
  ('ab400000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000001', 'ab100000-0000-0000-0000-000000000003', 'missing-key', now(),
    '{"source":"manual","mode":"revise_selection","kind":"short_dialogue"}', '12000000-0000-0000-0000-000000000001');
set local role service_role;
select throws_ok(
  $$ select public.freeze_generation_context(
    'ab400000-0000-0000-0000-000000000002', 'ab100000-0000-0000-0000-000000000002', 'revise_selection', 'missing-provider',
    array['binding-context'], '[{"versionId":"binding-context","memoryType":"canon","content":"frozen","tokenCount":1}]',
    '12000000-0000-0000-0000-000000000001', 'ab300000-0000-4000-8000-000000000006'
  ) $$,
  'P0001', 'manual_generation_binding_changed', 'manual freeze fails closed when provider binding is missing'
);
select throws_ok(
  $$ select public.freeze_generation_context(
    'ab400000-0000-0000-0000-000000000003', 'ab100000-0000-0000-0000-000000000003', 'revise_selection', 'missing-key',
    array['binding-context'], '[{"versionId":"binding-context","memoryType":"canon","content":"frozen","tokenCount":1}]',
    '12000000-0000-0000-0000-000000000001', 'ab300000-0000-4000-8000-000000000007'
  ) $$,
  'P0001', 'manual_generation_binding_changed', 'manual freeze fails closed when server key binding is missing'
);

reset role;
insert into public.drafts (id, owner_id, kind, status, title)
values ('ab100000-0000-0000-0000-000000000004', '10000000-0000-0000-0000-000000000001', 'short_dialogue', 'queued', 'corrupt frozen manual');
insert into public.generation_jobs (
  id, owner_id, draft_id, schedule_key, scheduled_for, payload, provider_setting_id,
  idempotency_key, generation_mode, attempt_token, worst_case_cost_micros
) values (
  'ab400000-0000-0000-0000-000000000004', '10000000-0000-0000-0000-000000000001',
  'ab100000-0000-0000-0000-000000000004', 'corrupt-frozen-key', now(),
  '{"source":"manual","mode":"new","kind":"short_dialogue"}',
  '12000000-0000-0000-0000-000000000001', 'corrupt-frozen-key', 'new',
  'ab500000-0000-4000-8000-000000000004', 100
);
set local role service_role;
select throws_ok(
  $$ select public.reserve_and_start_generation(
    'ab400000-0000-0000-0000-000000000004', 'ab500000-0000-4000-8000-000000000004', 100
  ) $$,
  'P0001', 'manual_generation_binding_changed',
  'reserve rejects an incomplete frozen manual identity before budget or status mutation'
);
select is(
  (select concat(status, '|', attempt_token, '|',
    (select count(*) from public.budget_entries where generation_job_id = 'ab400000-0000-0000-0000-000000000004'))
   from public.generation_jobs where id = 'ab400000-0000-0000-0000-000000000004'),
  'queued|ab500000-0000-4000-8000-000000000004|0',
  'failed binding validation preserves attempt evidence and creates no reservation'
);
select is(
  public.abort_generation_attempt(
    'ab400000-0000-0000-0000-000000000004', 'ab500000-0000-4000-8000-000000000004',
    'corrupt-frozen-key', 'freeze_failed'
  ) ->> 'outcome',
  'aborted', 'incomplete frozen manual state can still be cleaned up safely'
);
select is(
  (select concat(status, '|', coalesce(attempt_token::text, '<null>'), '|', coalesce(provider_setting_id::text, '<null>'))
   from public.generation_jobs where id = 'ab400000-0000-0000-0000-000000000004'),
  'queued|<null>|<null>', 'abort never restores a provider for an incomplete manual binding'
);
select lives_ok(
  $$ select public.freeze_generation_context(
    (select (value ->> 'job_id')::uuid from revision_binding_result), 'ab100000-0000-0000-0000-000000000001',
    'revise_selection', (select value ->> 'idempotency_key' from revision_binding_result), array['binding-context'],
    '[{"versionId":"binding-context","memoryType":"canon","content":"frozen","tokenCount":1}]',
    '12000000-0000-0000-0000-000000000001', 'ab300000-0000-4000-8000-000000000008'
  ) $$,
  'the exact server revision binding freezes successfully'
);
select is(
  (select concat(generation_mode, '|', max_revision_output_tokens, '|', worst_case_cost_micros, '|', confirmed_maximum_cost_micros)
   from public.generation_jobs where id = (select (value ->> 'job_id')::uuid from revision_binding_result)),
  'revise_selection|64|100|100',
  'exact revision freeze preserves confirmed output and cost semantics'
);
select is(
  public.reserve_and_start_generation(
    (select (value ->> 'job_id')::uuid from revision_binding_result), 'ab300000-0000-4000-8000-000000000008', 100
  ) ->> 'status',
  'reserved', 'exact revision enters the existing atomic manual reserve path'
);

reset role;
select * from finish();
rollback;
