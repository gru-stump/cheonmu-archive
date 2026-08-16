begin;

select plan(12);

insert into public.drafts (id, owner_id, kind, status, title) values
  ('e1000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'short_dialogue', 'queued', 'missing source'),
  ('e1000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000001', 'short_dialogue', 'queued', 'unknown source'),
  ('e1000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000001', 'short_dialogue', 'queued', 'schedule missing policy'),
  ('e1000000-0000-0000-0000-000000000004', '10000000-0000-0000-0000-000000000001', 'short_dialogue', 'queued', 'schedule unknown policy'),
  ('e1000000-0000-0000-0000-000000000005', '10000000-0000-0000-0000-000000000001', 'short_dialogue', 'queued', 'access missing policy'),
  ('e1000000-0000-0000-0000-000000000006', '10000000-0000-0000-0000-000000000001', 'short_dialogue', 'queued', 'access warning policy'),
  ('e1000000-0000-0000-0000-000000000007', '10000000-0000-0000-0000-000000000001', 'short_dialogue', 'queued', 'schedule risk policy'),
  ('e1000000-0000-0000-0000-000000000008', '10000000-0000-0000-0000-000000000001', 'short_dialogue', 'queued', 'schedule warning policy'),
  ('e1000000-0000-0000-0000-000000000009', '10000000-0000-0000-0000-000000000001', 'short_dialogue', 'queued', 'access risk policy'),
  ('e1000000-0000-0000-0000-000000000010', '10000000-0000-0000-0000-000000000001', 'short_dialogue', 'queued', 'manual source');

insert into public.generation_jobs (id, owner_id, draft_id, schedule_key, scheduled_for, payload, provider_setting_id) values
  ('e2000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'e1000000-0000-0000-0000-000000000001', 'missing-source', now(), '{"kind":"short_dialogue"}', null),
  ('e2000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000001', 'e1000000-0000-0000-0000-000000000002', 'unknown-source', now(), '{"kind":"short_dialogue","source":"browser"}', null),
  ('e2000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000001', 'e1000000-0000-0000-0000-000000000003', 'schedule-missing-policy', now(), '{"kind":"short_dialogue","source":"schedule"}', null),
  ('e2000000-0000-0000-0000-000000000004', '10000000-0000-0000-0000-000000000001', 'e1000000-0000-0000-0000-000000000004', 'schedule-unknown-policy', now(), '{"kind":"short_dialogue","source":"schedule","budgetPolicy":"allow"}', null),
  ('e2000000-0000-0000-0000-000000000005', '10000000-0000-0000-0000-000000000001', 'e1000000-0000-0000-0000-000000000005', 'access-missing-policy', now(), '{"kind":"short_dialogue","source":"access"}', null),
  ('e2000000-0000-0000-0000-000000000006', '10000000-0000-0000-0000-000000000001', 'e1000000-0000-0000-0000-000000000006', 'access-warning-policy', now(), '{"kind":"short_dialogue","source":"access","budgetPolicy":"block_at_warning"}', null),
  ('e2000000-0000-0000-0000-000000000007', '10000000-0000-0000-0000-000000000001', 'e1000000-0000-0000-0000-000000000007', 'schedule-risk-policy', now(), '{"kind":"short_dialogue","source":"schedule","budgetPolicy":"block_at_risk"}', null),
  ('e2000000-0000-0000-0000-000000000008', '10000000-0000-0000-0000-000000000001', 'e1000000-0000-0000-0000-000000000008', 'schedule-warning-policy', now(), '{"kind":"short_dialogue","source":"schedule","budgetPolicy":"block_at_warning"}', null),
  ('e2000000-0000-0000-0000-000000000009', '10000000-0000-0000-0000-000000000001', 'e1000000-0000-0000-0000-000000000009', 'access-risk-policy', now(), '{"kind":"short_dialogue","source":"access","budgetPolicy":"block_at_risk"}', null),
  ('e2000000-0000-0000-0000-000000000010', '10000000-0000-0000-0000-000000000001', 'e1000000-0000-0000-0000-000000000010', 'manual-source', now(), '{"kind":"short_dialogue","source":"manual","mode":"new","manualRequestKey":"manual-source"}', '12000000-0000-0000-0000-000000000001');

select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;

select throws_ok(
  $$ select public.freeze_generation_context('e2000000-0000-0000-0000-000000000001', 'e1000000-0000-0000-0000-000000000001', 'new', 'missing-source', array['source-context'], '[{"versionId":"source-context","memoryType":"canon","content":"frozen","tokenCount":1}]', '12000000-0000-0000-0000-000000000001', 'e3000000-0000-4000-8000-000000000001') $$,
  'P0001', 'invalid_generation_source', 'freeze rejects a missing source before mutation'
);
select throws_ok(
  $$ select public.freeze_generation_context('e2000000-0000-0000-0000-000000000002', 'e1000000-0000-0000-0000-000000000002', 'new', 'unknown-source', array['source-context'], '[{"versionId":"source-context","memoryType":"canon","content":"frozen","tokenCount":1}]', '12000000-0000-0000-0000-000000000001', 'e3000000-0000-4000-8000-000000000002') $$,
  'P0001', 'invalid_generation_source', 'freeze rejects an unknown source before mutation'
);
select throws_ok(
  $$ select public.freeze_generation_context('e2000000-0000-0000-0000-000000000003', 'e1000000-0000-0000-0000-000000000003', 'new', 'schedule-missing-policy', array['source-context'], '[{"versionId":"source-context","memoryType":"canon","content":"frozen","tokenCount":1}]', '12000000-0000-0000-0000-000000000001', 'e3000000-0000-4000-8000-000000000003') $$,
  'P0001', 'invalid_generation_source', 'freeze rejects a schedule without a budget policy before mutation'
);
select throws_ok(
  $$ select public.freeze_generation_context('e2000000-0000-0000-0000-000000000004', 'e1000000-0000-0000-0000-000000000004', 'new', 'schedule-unknown-policy', array['source-context'], '[{"versionId":"source-context","memoryType":"canon","content":"frozen","tokenCount":1}]', '12000000-0000-0000-0000-000000000001', 'e3000000-0000-4000-8000-000000000004') $$,
  'P0001', 'invalid_generation_source', 'freeze rejects a schedule with an unknown budget policy before mutation'
);
select throws_ok(
  $$ select public.freeze_generation_context('e2000000-0000-0000-0000-000000000005', 'e1000000-0000-0000-0000-000000000005', 'new', 'access-missing-policy', array['source-context'], '[{"versionId":"source-context","memoryType":"canon","content":"frozen","tokenCount":1}]', '12000000-0000-0000-0000-000000000001', 'e3000000-0000-4000-8000-000000000005') $$,
  'P0001', 'invalid_generation_source', 'freeze rejects access without its fixed budget policy before mutation'
);
select throws_ok(
  $$ select public.freeze_generation_context('e2000000-0000-0000-0000-000000000006', 'e1000000-0000-0000-0000-000000000006', 'new', 'access-warning-policy', array['source-context'], '[{"versionId":"source-context","memoryType":"canon","content":"frozen","tokenCount":1}]', '12000000-0000-0000-0000-000000000001', 'e3000000-0000-4000-8000-000000000006') $$,
  'P0001', 'invalid_generation_source', 'freeze rejects access warning policy before mutation'
);
select is(
  (select count(*) from public.generation_jobs where id in (
    'e2000000-0000-0000-0000-000000000001', 'e2000000-0000-0000-0000-000000000002',
    'e2000000-0000-0000-0000-000000000003', 'e2000000-0000-0000-0000-000000000004',
    'e2000000-0000-0000-0000-000000000005', 'e2000000-0000-0000-0000-000000000006'
  ) and status = 'queued' and idempotency_key is null and generation_mode is null
    and provider_setting_id is null and cardinality(context_version_ids) = 0 and context_snapshot = '[]'::jsonb
    and attempt_token is null and model_key is null and worst_case_cost_micros is null),
  6::bigint, 'invalid source failures preserve every frozen field and the attempt epoch'
);

select lives_ok(
  $$ select public.freeze_generation_context('e2000000-0000-0000-0000-000000000007', 'e1000000-0000-0000-0000-000000000007', 'new', 'schedule-risk-policy', array['source-context'], '[{"versionId":"source-context","memoryType":"canon","content":"frozen","tokenCount":1}]', '12000000-0000-0000-0000-000000000001', 'e3000000-0000-4000-8000-000000000007') $$,
  'schedule block_at_risk remains a valid freeze source'
);
select lives_ok(
  $$ select public.freeze_generation_context('e2000000-0000-0000-0000-000000000008', 'e1000000-0000-0000-0000-000000000008', 'new', 'schedule-warning-policy', array['source-context'], '[{"versionId":"source-context","memoryType":"canon","content":"frozen","tokenCount":1}]', '12000000-0000-0000-0000-000000000001', 'e3000000-0000-4000-8000-000000000008') $$,
  'schedule block_at_warning remains a valid freeze source'
);
select lives_ok(
  $$ select public.freeze_generation_context('e2000000-0000-0000-0000-000000000009', 'e1000000-0000-0000-0000-000000000009', 'new', 'access-risk-policy', array['source-context'], '[{"versionId":"source-context","memoryType":"canon","content":"frozen","tokenCount":1}]', '12000000-0000-0000-0000-000000000001', 'e3000000-0000-4000-8000-000000000009') $$,
  'access block_at_risk remains a valid freeze source'
);
select lives_ok(
  $$ select public.freeze_generation_context('e2000000-0000-0000-0000-000000000010', 'e1000000-0000-0000-0000-000000000010', 'new', 'manual-source', array['source-context'], '[{"versionId":"source-context","memoryType":"canon","content":"frozen","tokenCount":1}]', '12000000-0000-0000-0000-000000000001', 'e3000000-0000-4000-8000-000000000010') $$,
  'an exact manual binding remains a valid freeze source'
);
select is(
  (select count(*) from public.generation_jobs where id in (
    'e2000000-0000-0000-0000-000000000007', 'e2000000-0000-0000-0000-000000000008',
    'e2000000-0000-0000-0000-000000000009', 'e2000000-0000-0000-0000-000000000010'
  ) and status = 'queued' and idempotency_key is not null and generation_mode = 'new'
    and provider_setting_id = '12000000-0000-0000-0000-000000000001'
    and cardinality(context_version_ids) = 1 and context_snapshot <> '[]'::jsonb and attempt_token is not null),
  4::bigint, 'all legitimate manual, schedule, and access sources freeze normally'
);

reset role;
select * from finish();
rollback;
