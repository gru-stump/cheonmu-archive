begin;
select plan(6);

select has_function('narrative_private', 'schedule_dispatch_material', array[]::text[], 'Vault dispatch material boundary exists');
select ok(
  not coalesce(has_function_privilege('service_role', to_regprocedure('narrative_private.schedule_dispatch_material()'), 'execute'), false),
  'runtime roles cannot invoke the internal dispatch material boundary'
);

delete from vault.secrets where name in ('narrative_schedule_dispatch_url', 'narrative_schedule_dispatch_token');
select throws_ok(
  $$ select * from narrative_private.schedule_dispatch_material() $$,
  'P0001', 'schedule_dispatch_runtime_not_configured', 'missing Vault material fails before any network call'
);

select vault.create_secret('dispatch-endpoint-fixture', 'narrative_schedule_dispatch_url');
select vault.create_secret('dispatch-token-fixture', 'narrative_schedule_dispatch_token');
select is(
  (select material.url from narrative_private.schedule_dispatch_material() as material),
  'dispatch-endpoint-fixture', 'Vault endpoint is wired to the HTTP URL argument'
);
select is(
  (select material.body from narrative_private.schedule_dispatch_material() as material),
  '{"action":"dispatch"}'::jsonb, 'dispatch body remains queue-only'
);
select is(
  (select material.headers ->> 'x-schedule-dispatch-token' from narrative_private.schedule_dispatch_material() as material),
  'dispatch-token-fixture', 'Vault token is wired only to the custom dispatch header'
);

select * from finish();
rollback;
