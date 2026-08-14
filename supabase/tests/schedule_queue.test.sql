begin;
select plan(6);

select has_function('public', 'queue_narrative_schedule_job', array['uuid', 'text', 'timestamp with time zone', 'jsonb'], 'schedule queue RPC exists');
select has_function('public', 'narrative_schedule_budget_state', array['uuid'], 'budget state RPC exists');

select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;
select lives_ok(
  $$ select public.queue_narrative_schedule_job('10000000-0000-0000-0000-000000000001', 'schedule-test', '2026-08-13T15:00:00Z', '{"kind":"daily_event","source":"schedule"}'::jsonb) $$,
  'service role queues a schedule job'
);
select is(
  (select count(*)::integer from public.generation_jobs where schedule_key = 'schedule-test' and scheduled_for = '2026-08-13T15:00:00Z'),
  1, 'queue insertion stores one job'
);
select is(
  (select (public.queue_narrative_schedule_job('10000000-0000-0000-0000-000000000001', 'schedule-test', '2026-08-13T15:00:00Z', '{"kind":"daily_event","source":"schedule"}'::jsonb)).id::text),
  (select id::text from public.generation_jobs where schedule_key = 'schedule-test' and scheduled_for = '2026-08-13T15:00:00Z'),
  'same schedule key and timestamp return the existing queue job'
);
reset role;
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;
select throws_ok(
  $$ select public.queue_narrative_schedule_job('10000000-0000-0000-0000-000000000001', 'denied', '2026-08-13T15:00:00Z', '{"kind":"daily_event","source":"schedule"}'::jsonb) $$,
  '42501', 'permission denied for function queue_narrative_schedule_job', 'authenticated callers cannot mutate schedule jobs directly'
);
reset role;
select * from finish();
rollback;
