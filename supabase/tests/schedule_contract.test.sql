begin;
select plan(10);

select has_column('public', 'schedules', 'schedule_type', 'schedules distinguish automatic from manual');
select lives_ok(
  $$ insert into public.schedules (id, owner_id, schedule_key, schedule_type, cron_expression, payload)
     values ('88000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'valid-daily', 'automatic', '5 9 * * *', '{"kind":"daily_event"}') $$,
  'exact-minute exact-hour daily grammar is stored'
);
select lives_ok(
  $$ insert into public.schedules (id, owner_id, schedule_key, schedule_type, cron_expression, payload)
     values ('88000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000001', 'valid-weekly', 'automatic', '5 9 * * 1', '{"kind":"daily_event"}') $$,
  'exact-minute exact-hour weekly grammar is stored'
);
select lives_ok(
  $$ insert into public.schedules (id, owner_id, schedule_key, schedule_type, cron_expression, payload)
     values ('88000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000001', 'valid-manual', 'manual', null, '{"kind":"short_dialogue"}') $$,
  'manual schedules use type plus null cron rather than a fake keyword'
);

select throws_ok(
  $$ insert into public.schedules (owner_id, schedule_key, schedule_type, cron_expression) values ('10000000-0000-0000-0000-000000000001', 'invalid-dom', 'automatic', '5 9 1 * *') $$,
  '23514', 'new row for relation "schedules" violates check constraint "schedules_supported_cron_check"', 'day-of-month syntax is rejected'
);
select throws_ok(
  $$ insert into public.schedules (owner_id, schedule_key, schedule_type, cron_expression) values ('10000000-0000-0000-0000-000000000001', 'invalid-month', 'automatic', '5 9 * 8 *') $$,
  '23514', 'new row for relation "schedules" violates check constraint "schedules_supported_cron_check"', 'month syntax is rejected'
);
select throws_ok(
  $$ insert into public.schedules (owner_id, schedule_key, schedule_type, cron_expression) values ('10000000-0000-0000-0000-000000000001', 'invalid-range', 'automatic', '0-5 9 * * *') $$,
  '23514', 'new row for relation "schedules" violates check constraint "schedules_supported_cron_check"', 'range syntax is rejected'
);
select throws_ok(
  $$ insert into public.schedules (owner_id, schedule_key, schedule_type, cron_expression) values ('10000000-0000-0000-0000-000000000001', 'invalid-step', 'automatic', '*/5 9 * * *') $$,
  '23514', 'new row for relation "schedules" violates check constraint "schedules_supported_cron_check"', 'step syntax is rejected'
);
select throws_ok(
  $$ insert into public.schedules (owner_id, schedule_key, schedule_type, cron_expression) values ('10000000-0000-0000-0000-000000000001', 'invalid-comma', 'automatic', '0,5 9 * * *') $$,
  '23514', 'new row for relation "schedules" violates check constraint "schedules_supported_cron_check"', 'comma syntax is rejected'
);
select throws_ok(
  $$ insert into public.schedules (owner_id, schedule_key, schedule_type, cron_expression) values ('10000000-0000-0000-0000-000000000001', 'invalid-manual-cron', 'manual', '0 9 * * *') $$,
  '23514', 'new row for relation "schedules" violates check constraint "schedules_supported_cron_check"', 'manual schedules cannot carry automatic cron text'
);

select * from finish();
rollback;
