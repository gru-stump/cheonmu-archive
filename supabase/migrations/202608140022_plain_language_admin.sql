-- Plain-language owner controls: safe secret deletion, exact access-cost
-- confirmation, cancellable undispatched work, and timestamped dashboard rows.

create function narrative_private.access_cost_quote(p_owner_id uuid, p_at timestamptz)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  active_provider public.provider_settings;
  active_period public.budget_periods;
  settings public.narrative_admin_settings;
  maximum_cost bigint;
  maximum_krw integer;
  business_date date;
begin
  if p_owner_id is null or p_at is null then
    raise exception 'invalid_access_quote' using errcode = '22023';
  end if;
  business_date := public.narrative_business_date(p_at);

  -- Preserve the shared total lock order used by settings save and worker claim.
  select provider.* into active_provider
  from public.provider_settings as provider
  where provider.owner_id = p_owner_id and provider.enabled
  for share;
  select period.* into active_period
  from public.budget_periods as period
  where period.owner_id = p_owner_id and period.currency = 'USD'
    and business_date between period.period_start and period.period_end
  order by period.period_start desc, period.period_end asc, period.id
  limit 1 for share;
  select value.* into settings
  from public.narrative_admin_settings as value
  where value.owner_id = p_owner_id
  for share;

  if settings.owner_id is null or not settings.schedule_automation_enabled then
    raise exception 'schedule_automation_disabled' using errcode = 'P0001';
  end if;
  if active_provider.id is null then
    raise exception 'active_provider_setting_required' using errcode = 'P0001';
  end if;
  if active_period.id is null then
    raise exception 'budget_period_required' using errcode = 'P0001';
  end if;
  if active_provider.pricing_verified_at > public.narrative_business_date(current_timestamp)
    or active_provider.pricing_verified_at < business_date - settings.pricing_valid_days then
    raise exception 'stale_provider_pricing' using errcode = 'P0001';
  end if;
  if active_provider.max_input_tokens <= 0 or active_provider.max_output_tokens <= 0
    or active_provider.input_cost_micros_per_million < 0
    or active_provider.output_cost_micros_per_million < 0
    or active_provider.fixed_cost_micros < 0 then
    raise exception 'invalid_provider_pricing' using errcode = 'P0001';
  end if;

  maximum_cost := active_provider.fixed_cost_micros
    + ceil(active_provider.max_input_tokens::numeric * active_provider.input_cost_micros_per_million / 1000000)::bigint
    + ceil(active_provider.max_output_tokens::numeric * active_provider.output_cost_micros_per_million / 1000000)::bigint;
  maximum_krw := round(maximum_cost::numeric * settings.krw_per_usd / 1000000)::integer;

  return jsonb_build_object(
    'maximumCostMicros', maximum_cost,
    'maximumCostKrw', maximum_krw,
    'modelLabel', active_provider.model_key,
    'providerKey', active_provider.provider_key,
    'quotedAt', p_at
  );
end;
$$;

create function public.quote_narrative_access_cost()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform narrative_private.require_narrative_owner();
  return narrative_private.access_cost_quote(auth.uid(), pg_catalog.clock_timestamp());
end;
$$;

create function public.queue_narrative_access_job(
  p_owner_id uuid,
  p_now timestamptz,
  p_confirmed_maximum_cost_micros bigint
)
returns public.generation_jobs
language plpgsql
security definer
set search_path = ''
as $$
declare
  quote jsonb;
  expected_cost bigint;
  queued_job public.generation_jobs;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'schedule access caller is not authorized' using errcode = '42501';
  end if;
  if p_owner_id is null or p_now is null or p_confirmed_maximum_cost_micros is null
    or p_confirmed_maximum_cost_micros < 0 then
    raise exception 'invalid_schedule_access' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('narrative-access:' || p_owner_id::text, 0)
  );
  quote := narrative_private.access_cost_quote(p_owner_id, p_now);
  expected_cost := (quote ->> 'maximumCostMicros')::bigint;
  if expected_cost is distinct from p_confirmed_maximum_cost_micros then
    raise exception 'stale_cost_confirmation' using errcode = 'P0001';
  end if;

  queued_job := public.queue_narrative_access_job(p_owner_id, p_now);
  if queued_job.confirmed_maximum_cost_micros is not null then
    if queued_job.confirmed_maximum_cost_micros is distinct from expected_cost then
      raise exception 'stale_cost_confirmation' using errcode = 'P0001';
    end if;
    return queued_job;
  end if;
  if queued_job.status is distinct from 'queued'
    or queued_job.worker_attempt_token is not null
    or queued_job.attempt_token is not null
    or queued_job.provider_dispatch_recorded_at is not null then
    raise exception 'access_confirmation_missing' using errcode = 'P0001';
  end if;

  update public.generation_jobs
  set confirmed_maximum_cost_micros = expected_cost,
      payload = payload || jsonb_build_object(
        'maximumCostConfirmed', true,
        'confirmedMaximumCostMicros', expected_cost
      )
  where id = queued_job.id
  returning * into queued_job;
  return queued_job;
end;
$$;

create function public.cancel_queued_generation_job(p_job_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  locked_job public.generation_jobs;
begin
  perform narrative_private.require_narrative_owner();
  if p_job_id is null then
    raise exception 'invalid_generation_job' using errcode = '22023';
  end if;
  select job.* into locked_job
  from public.generation_jobs as job
  where job.id = p_job_id and job.owner_id = auth.uid()
  for update;
  if locked_job.id is null then
    raise exception 'generation_job_not_found' using errcode = 'P0001';
  end if;
  if locked_job.status is distinct from 'queued'
    or locked_job.worker_attempt_token is not null
    or locked_job.attempt_token is not null
    or locked_job.provider_dispatch_recorded_at is not null then
    raise exception 'generation_job_not_cancellable' using errcode = 'P0001';
  end if;

  update public.generation_jobs
  set status = 'cancelled',
      failure_code = 'owner_cancelled',
      failure_at = pg_catalog.clock_timestamp(),
      worker_completed_at = pg_catalog.clock_timestamp(),
      worker_retry_at = null,
      worker_lease_expires_at = null
  where id = locked_job.id;
  insert into public.audit_events (owner_id, event_type, entity_type, entity_id, payload)
  values (auth.uid(), 'generation_job_cancelled', 'generation_job', locked_job.id,
    jsonb_build_object('source', case when locked_job.payload ->> 'source' in ('manual', 'schedule', 'access')
      then locked_job.payload ->> 'source' else 'unknown' end));
  return jsonb_build_object('id', locked_job.id, 'status', 'cancelled');
end;
$$;

create function public.delete_narrative_secret(p_owner_id uuid, p_secret_kind text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  settings public.narrative_admin_settings;
  secret_name text;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'secret deletion caller is not authorized' using errcode = '42501';
  end if;
  if p_owner_id is null or p_secret_kind not in ('openai', 'anthropic', 'github') then
    raise exception 'invalid_secret_reference' using errcode = '22023';
  end if;
  if not exists (select 1 from public.owner_profiles where owner_id = p_owner_id) then
    raise exception 'narrative_owner_not_found' using errcode = 'P0001';
  end if;

  secret_name := 'narrative_' || p_owner_id::text || '_' || p_secret_kind;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(secret_name, 0));
  perform 1 from public.provider_settings
  where owner_id = p_owner_id order by id for update;
  perform 1 from public.budget_periods
  where owner_id = p_owner_id order by period_start, id for update;
  select value.* into settings from public.narrative_admin_settings as value
  where value.owner_id = p_owner_id for update;
  if settings.owner_id is null then
    raise exception 'narrative_owner_not_found' using errcode = 'P0001';
  end if;

  delete from vault.secrets where name = secret_name;
  if p_secret_kind in ('openai', 'anthropic') then
    update public.provider_settings
    set enabled = false,
        configuration = configuration - 'vaultSecretName',
        updated_at = pg_catalog.clock_timestamp()
    where owner_id = p_owner_id and provider_key = p_secret_kind;
    update public.narrative_admin_settings
    set manual_generation_enabled = false,
        schedule_automation_enabled = false,
        updated_at = pg_catalog.clock_timestamp()
    where owner_id = p_owner_id;
  else
    update public.narrative_admin_settings
    set github_repository_owner = null,
        github_repository_name = null,
        github_branch = null,
        updated_at = pg_catalog.clock_timestamp()
    where owner_id = p_owner_id;
  end if;

  insert into public.audit_events (owner_id, event_type, entity_type, payload)
  values (p_owner_id, 'narrative_secret_deleted', 'server_secret',
    jsonb_build_object('secretKind', p_secret_kind, 'configured', false));
  return jsonb_build_object(
    'configured', false,
    'generationPaused', p_secret_kind in ('openai', 'anthropic')
  );
end;
$$;

-- Replace only the owner projection. The previous implementation remains
-- private for compatibility with its nested budget/schedule projection.
alter function public.get_narrative_dashboard() rename to get_narrative_dashboard_v2;
create function public.get_narrative_dashboard()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  base jsonb;
  recent_queue jsonb;
  exchange_rate integer;
begin
  perform narrative_private.require_narrative_owner();
  base := public.get_narrative_dashboard_v2();
  select coalesce((
    select settings.krw_per_usd
    from public.narrative_admin_settings as settings
    where settings.owner_id = auth.uid()
  ), 1380) into exchange_rate;
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', item.id,
    'source', case when item.payload ->> 'source' in ('manual', 'schedule', 'access')
      then item.payload ->> 'source' else 'unknown' end,
    'state', case
      when item.status = 'completed' then 'completed'
      when item.status = 'cancelled' then 'cancelled'
      when item.status = 'failed' then 'failed/dead-letter'
      when item.worker_retry_at is not null and item.worker_retry_at > pg_catalog.clock_timestamp() then 'retry-wait'
      when item.worker_attempt_token is not null and item.worker_lease_expires_at > pg_catalog.clock_timestamp() then 'running'
      when item.status = 'running' then 'running'
      else 'queued' end,
    'attemptCount', item.worker_attempt_count,
    'retryAt', item.worker_retry_at,
    'leaseExpiresAt', item.worker_lease_expires_at,
    'failureCode', coalesce(item.worker_failure_code, item.failure_code),
    'scheduledFor', item.scheduled_for,
    'createdAt', item.created_at,
    'completedAt', item.worker_completed_at,
    'failedAt', item.failure_at
  ) order by item.created_at desc, item.id desc), '[]'::jsonb)
  into recent_queue
  from (
    select job.* from public.generation_jobs as job
    where job.owner_id = auth.uid()
    order by job.created_at desc, job.id desc limit 25
  ) as item;
  return (coalesce(base, '{}'::jsonb) - 'queue') || jsonb_build_object('queue', recent_queue, 'krwPerUsd', exchange_rate);
end;
$$;

revoke all on function narrative_private.access_cost_quote(uuid, timestamptz) from public, anon, authenticated, service_role;
revoke all on function public.quote_narrative_access_cost() from public, anon, authenticated, service_role;
revoke all on function public.queue_narrative_access_job(uuid, timestamptz, bigint) from public, anon, authenticated, service_role;
revoke all on function public.cancel_queued_generation_job(uuid) from public, anon, authenticated, service_role;
revoke all on function public.delete_narrative_secret(uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.get_narrative_dashboard_v2() from public, anon, authenticated, service_role;
revoke all on function public.get_narrative_dashboard() from public, anon, authenticated, service_role;

grant execute on function public.quote_narrative_access_cost() to authenticated;
grant execute on function public.queue_narrative_access_job(uuid, timestamptz, bigint) to service_role;
grant execute on function public.cancel_queued_generation_job(uuid) to authenticated;
grant execute on function public.delete_narrative_secret(uuid, text) to service_role;
grant execute on function public.get_narrative_dashboard() to authenticated;

comment on function public.quote_narrative_access_cost()
  is 'Returns an owner-only maximum access-generation quote with no provider credentials.';
comment on function public.queue_narrative_access_job(uuid, timestamptz, bigint)
  is 'Recomputes access cost under locks and queues only an exact service-confirmed amount.';
comment on function public.delete_narrative_secret(uuid, text)
  is 'Deletes one owner Vault secret and safely pauses dependent operations.';
