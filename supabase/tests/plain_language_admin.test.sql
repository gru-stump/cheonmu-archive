begin;

select plan(35);

select has_function('public', 'delete_narrative_secret', array['uuid', 'text'], 'server can delete one owner secret safely');
select has_function('public', 'cancel_queued_generation_job', array['uuid'], 'owner can cancel an eligible queued job');
select has_function('public', 'quote_narrative_access_cost', array[]::text[], 'owner can request the current access maximum cost');
select has_function('public', 'queue_narrative_access_job', array['uuid', 'timestamp with time zone', 'bigint'], 'service queue requires the confirmed maximum cost');

select ok(
  has_function_privilege('service_role', 'public.delete_narrative_secret(uuid,text)', 'execute')
    and not has_function_privilege('authenticated', 'public.delete_narrative_secret(uuid,text)', 'execute')
    and not has_function_privilege('anon', 'public.delete_narrative_secret(uuid,text)', 'execute'),
  'only service role can delete Vault material'
);
select ok(
  has_function_privilege('authenticated', 'public.cancel_queued_generation_job(uuid)', 'execute')
    and not has_function_privilege('service_role', 'public.cancel_queued_generation_job(uuid)', 'execute')
    and not has_function_privilege('anon', 'public.cancel_queued_generation_job(uuid)', 'execute'),
  'only an authenticated owner can cancel queued work'
);
select ok(
  has_function_privilege('authenticated', 'public.quote_narrative_access_cost()', 'execute')
    and not has_function_privilege('service_role', 'public.quote_narrative_access_cost()', 'execute')
    and not has_function_privilege('anon', 'public.quote_narrative_access_cost()', 'execute'),
  'only an authenticated owner can read their quote'
);
select ok(
  has_function_privilege('service_role', 'public.queue_narrative_access_job(uuid,timestamptz,bigint)', 'execute')
    and not has_function_privilege('authenticated', 'public.queue_narrative_access_job(uuid,timestamptz,bigint)', 'execute'),
  'only service role can queue a confirmed access job'
);

update public.provider_settings set enabled = false
where owner_id = '10000000-0000-0000-0000-000000000001';
insert into public.provider_settings (
  owner_id, provider_key, enabled, configuration, model_key,
  max_input_tokens, max_output_tokens, max_revision_output_tokens,
  input_cost_micros_per_million, output_cost_micros_per_million,
  fixed_cost_micros, pricing_verified_at
)
values (
  '10000000-0000-0000-0000-000000000001', 'openai', true,
  '{"vaultSecretName":"narrative_10000000-0000-0000-0000-000000000001_openai"}',
  'gpt-5-mini', 4000, 4000, 2000, 250000, 2000000, 0,
  public.narrative_business_date(current_timestamp)
)
on conflict (owner_id, provider_key) do update set
  enabled = excluded.enabled, configuration = excluded.configuration, model_key = excluded.model_key,
  max_input_tokens = excluded.max_input_tokens, max_output_tokens = excluded.max_output_tokens,
  max_revision_output_tokens = excluded.max_revision_output_tokens,
  input_cost_micros_per_million = excluded.input_cost_micros_per_million,
  output_cost_micros_per_million = excluded.output_cost_micros_per_million,
  fixed_cost_micros = excluded.fixed_cost_micros,
  pricing_verified_at = excluded.pricing_verified_at;
update public.narrative_admin_settings
set manual_generation_enabled = true, schedule_automation_enabled = true, krw_per_usd = 1380
where owner_id = '10000000-0000-0000-0000-000000000001';
update public.budget_periods
set period_start = date_trunc('month', public.narrative_business_date(current_timestamp))::date,
    period_end = (date_trunc('month', public.narrative_business_date(current_timestamp)) + interval '1 month - 1 day')::date,
    limit_micros = 100000000, daily_limit_micros = 100000000
where owner_id = '10000000-0000-0000-0000-000000000001';
select vault.create_secret(
  'fixture-value',
  'narrative_10000000-0000-0000-0000-000000000001_openai',
  'plain language admin pgTAP fixture'
);

select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-000000000001', true);
set local role authenticated;

select is((public.quote_narrative_access_cost() ->> 'maximumCostMicros')::bigint, 9000::bigint, 'quote uses exact configured token caps and prices');
select is((public.quote_narrative_access_cost() ->> 'maximumCostKrw')::integer, 12, 'quote converts maximum cost to rounded won');
select is(public.quote_narrative_access_cost() ->> 'modelLabel', 'gpt-5-mini', 'quote identifies the active model');

reset role;
select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;
select throws_ok(
  $$ select public.queue_narrative_access_job('10000000-0000-0000-0000-000000000001', current_timestamp, 8999) $$,
  'P0001', 'stale_cost_confirmation', 'changed or substituted access cost is rejected'
);
select is(
  (select count(*) from public.generation_jobs where schedule_key = 'access:10000000-0000-0000-0000-000000000001'),
  0::bigint, 'a rejected cost creates no job'
);
create temp table confirmed_job on commit drop as
select public.queue_narrative_access_job(
  '10000000-0000-0000-0000-000000000001', current_timestamp, 9000
) as value;
select ok((select (value).id is not null from confirmed_job), 'the exact confirmed cost queues one job');
select is(
  (select confirmed_maximum_cost_micros from public.generation_jobs where id = (select (value).id from confirmed_job)),
  9000::bigint, 'the accepted confirmation is persisted for audit and worker binding'
);
select is(
  (public.queue_narrative_access_job(
    '10000000-0000-0000-0000-000000000001', current_timestamp + interval '10 seconds', 9000
  )).id,
  (select (value).id from confirmed_job), 'duplicate confirmation reuses the same active job'
);

reset role;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-000000000001', true);
set local role authenticated;
select is(
  public.cancel_queued_generation_job((
    select id from public.generation_jobs
    where schedule_key = 'access:10000000-0000-0000-0000-000000000001'
    order by created_at desc limit 1
  )) ->> 'status',
  'cancelled', 'owner can cancel an undispatched queued job'
);
select is(
  (select status from public.generation_jobs
   where schedule_key = 'access:10000000-0000-0000-0000-000000000001'
   order by created_at desc limit 1),
  'cancelled', 'cancellation persists the terminal job state'
);
select throws_ok(
  $$ select public.cancel_queued_generation_job((
    select id from public.generation_jobs
    where schedule_key = 'access:10000000-0000-0000-0000-000000000001'
    order by created_at desc limit 1
  )) $$,
  'P0001', 'generation_job_not_cancellable', 'terminal work cannot be cancelled again'
);

reset role;
insert into public.generation_jobs (id, owner_id, schedule_key, scheduled_for, status, payload, worker_attempt_token)
values (
  'a2200000-0000-0000-0000-000000000001',
  '10000000-0000-0000-0000-000000000001', 'plain-language-running', current_timestamp,
  'running', '{"source":"access","kind":"short_dialogue","budgetPolicy":"block_at_risk"}',
  'a2210000-0000-4000-8000-000000000001'
);
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-000000000001', true);
set local role authenticated;
select throws_ok(
  $$ select public.cancel_queued_generation_job('a2200000-0000-0000-0000-000000000001') $$,
  'P0001', 'generation_job_not_cancellable', 'running or dispatched work cannot be cancelled'
);
select throws_ok(
  $$ select public.cancel_queued_generation_job('ffffffff-ffff-ffff-ffff-ffffffffffff') $$,
  'P0001', 'generation_job_not_found', 'unknown or other-owner work is not exposed'
);

reset role;
insert into public.generation_jobs (id, owner_id, schedule_key, scheduled_for, status, payload, worker_completed_at)
values (
  'a2200000-0000-0000-0000-000000000002',
  '10000000-0000-0000-0000-000000000001', 'plain-language-completed', current_timestamp - interval '2 hours',
  'completed', '{"source":"manual","private":"must-not-leak"}', current_timestamp - interval '1 hour'
);
insert into public.generation_jobs (id, owner_id, schedule_key, scheduled_for, status, payload, failure_code, failure_at)
values (
  'a2200000-0000-0000-0000-000000000003',
  '10000000-0000-0000-0000-000000000001', 'plain-language-failed', current_timestamp - interval '3 hours',
  'failed', '{"source":"access","private":"must-not-leak"}', 'provider_outcome_unknown', current_timestamp - interval '2 hours'
);
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-000000000001', true);
set local role authenticated;
select ok(((public.get_narrative_dashboard() -> 'queue' -> 0) ? 'createdAt'), 'dashboard queue includes creation time');
select is((public.get_narrative_dashboard() ->> 'krwPerUsd')::integer, 1380, 'dashboard includes the owner exchange rate for plain KRW display');
select ok(exists(
  select 1 from jsonb_array_elements(public.get_narrative_dashboard() -> 'queue') item
  where item ->> 'id' = 'a2200000-0000-0000-0000-000000000002' and item ->> 'completedAt' is not null
), 'completed queue item includes completion time');
select ok(exists(
  select 1 from jsonb_array_elements(public.get_narrative_dashboard() -> 'queue') item
  where item ->> 'id' = 'a2200000-0000-0000-0000-000000000003' and item ->> 'failedAt' is not null
), 'failed queue item includes failure time');
select ok(not ((public.get_narrative_dashboard() -> 'queue' -> 0) ? 'payload'), 'dashboard never exposes command payload');
select ok(not ((public.get_narrative_dashboard() -> 'queue' -> 0) ? 'workerAttemptToken'), 'dashboard never exposes worker tokens');

reset role;
select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;
select is(
  public.delete_narrative_secret('10000000-0000-0000-0000-000000000001', 'openai') ->> 'configured',
  'false', 'provider secret deletion returns only safe state'
);
select is(
  (select count(*) from vault.secrets where name = 'narrative_10000000-0000-0000-0000-000000000001_openai'),
  0::bigint, 'provider secret material is removed from Vault'
);
select is(
  (select enabled from public.provider_settings where owner_id = '10000000-0000-0000-0000-000000000001' and provider_key = 'openai'),
  false, 'the deleted provider is disabled'
);
select is(
  (select concat(manual_generation_enabled, '|', schedule_automation_enabled)
   from public.narrative_admin_settings where owner_id = '10000000-0000-0000-0000-000000000001'),
  'f|f', 'provider secret deletion pauses manual and scheduled generation'
);
select ok((select count(*) from public.memory_items where owner_id = '10000000-0000-0000-0000-000000000001') > 0, 'secret deletion preserves narrative history');
select ok(exists(
  select 1 from public.audit_events
  where owner_id = '10000000-0000-0000-0000-000000000001'
    and event_type = 'narrative_secret_deleted' and payload ->> 'secretKind' = 'openai'
), 'secret deletion leaves a safe audit event');
select throws_ok(
  $$ select public.delete_narrative_secret('10000000-0000-0000-0000-000000000001', 'unknown') $$,
  '22023', 'invalid_secret_reference', 'unknown secret kinds are rejected'
);
select throws_ok(
  $$ select public.delete_narrative_secret('ffffffff-ffff-ffff-ffff-ffffffffffff', 'openai') $$,
  'P0001', 'narrative_owner_not_found', 'a nonexistent owner cannot be targeted'
);

select * from finish();
rollback;
