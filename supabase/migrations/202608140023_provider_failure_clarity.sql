-- Preserve safe provider diagnostics after the irreversible dispatch fence and
-- separate conservative unknown charges from confirmed owner-facing usage.

alter table public.generation_jobs
  drop constraint generation_jobs_worker_failure_check,
  add constraint generation_jobs_worker_failure_check check (
    worker_failure_code is null or worker_failure_code in (
      'worker_binding_invalid', 'worker_binding_changed', 'worker_policy_disabled',
      'worker_provider_changed', 'worker_pricing_invalid', 'worker_budget_blocked',
      'worker_retry_scheduled', 'worker_attempts_exhausted',
      'worker_reserved_without_dispatch', 'worker_pre_dispatch_retried', 'provider_outcome_unknown',
      'provider_timeout', 'provider_output_limit', 'provider_connection_failed',
      'worker_legacy_frozen', 'worker_legacy_running'
    )
  );

update public.provider_settings
set max_input_tokens = 4000,
    max_output_tokens = 4000,
    max_revision_output_tokens = 2000,
    updated_at = pg_catalog.clock_timestamp()
where provider_key = 'openai'
  and model_key = 'gpt-5-mini'
  and max_input_tokens = 8192
  and max_output_tokens = 2048
  and max_revision_output_tokens = 512;

create function narrative_private.provider_failure_code_after_dispatch(p_failure_code text)
returns text
language sql
immutable
strict
set search_path = ''
as $$
  select case
    when p_failure_code in ('provider_timeout', 'provider_output_limit', 'provider_connection_failed')
      then p_failure_code
    else 'provider_outcome_unknown'
  end
$$;

create or replace function narrative_private.dead_letter_generation_worker_job(
  p_job_id uuid,
  p_failure_code text,
  p_charge_unknown boolean
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  locked_job public.generation_jobs;
  reservation public.budget_entries;
begin
  if p_failure_code not in (
    'worker_binding_invalid', 'worker_binding_changed', 'worker_policy_disabled',
    'worker_provider_changed', 'worker_pricing_invalid', 'worker_budget_blocked',
    'worker_attempts_exhausted', 'worker_reserved_without_dispatch',
    'provider_outcome_unknown', 'provider_timeout', 'provider_output_limit', 'provider_connection_failed',
    'worker_legacy_frozen', 'worker_legacy_running'
  ) then raise exception 'invalid_generation_worker_failure' using errcode = '22023'; end if;
  select job.* into locked_job from public.generation_jobs as job where job.id = p_job_id for update;
  if locked_job.id is null then return jsonb_build_object('outcome', 'stale'); end if;
  if locked_job.status = 'completed' and exists (
    select 1 from public.draft_versions as version
    where version.generation_job_id = locked_job.id
      and version.owner_id = locked_job.owner_id
      and version.draft_id = locked_job.draft_id
  ) then
    update public.generation_jobs set worker_lease_expires_at = null,
      worker_completed_at = coalesce(worker_completed_at, now()), worker_failure_code = null
    where id = locked_job.id;
    return jsonb_build_object('outcome', 'completed', 'jobId', locked_job.id);
  end if;
  if locked_job.status = 'failed' and locked_job.worker_failure_code is not null then
    return jsonb_build_object('outcome', 'dead_lettered', 'jobId', locked_job.id, 'failureCode', locked_job.worker_failure_code);
  end if;
  select entry.* into reservation from public.budget_entries as entry
  where entry.generation_job_id = locked_job.id and entry.owner_id = locked_job.owner_id
    and entry.entry_type = 'reservation';
  if reservation.id is not null then
    perform public.fail_generation_budget(locked_job.id, case when p_charge_unknown then reservation.amount_micros else 0 end);
  end if;
  update public.drafts set status = 'queued', updated_at = now()
  where id = locked_job.draft_id and owner_id = locked_job.owner_id and status = 'generating';
  update public.generation_jobs
  set status = 'failed', failure_code = p_failure_code, failure_at = now(),
      worker_failure_code = p_failure_code, worker_retry_at = null,
      worker_lease_expires_at = null
  where id = locked_job.id;
  insert into public.audit_events (owner_id, event_type, entity_type, entity_id, payload)
  values (locked_job.owner_id, 'generation_worker_dead_lettered', 'generation_job', locked_job.id,
    jsonb_build_object('failureCode', p_failure_code, 'attemptCount', locked_job.worker_attempt_count));
  return jsonb_build_object('outcome', 'dead_lettered', 'jobId', locked_job.id, 'failureCode', p_failure_code);
end;
$$;

create or replace function public.abort_generation_attempt(
  p_job_id uuid, p_attempt_token uuid, p_idempotency_key text, p_failure_code text
)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare locked_job public.generation_jobs; terminal jsonb;
begin
  select job.* into locked_job from public.generation_jobs as job where job.id = p_job_id for update;
  if locked_job.worker_attempt_token is not null then return jsonb_build_object('outcome', 'stale'); end if;
  if locked_job.status = 'completed' then
    return public.generation_direct_abort_attempt_v2(p_job_id, p_attempt_token, p_idempotency_key, p_failure_code);
  end if;
  if locked_job.provider_dispatch_recorded_at is not null then
    terminal := narrative_private.dead_letter_generation_worker_job(
      locked_job.id, narrative_private.provider_failure_code_after_dispatch(p_failure_code), true
    );
    return terminal;
  end if;
  return public.generation_direct_abort_attempt_v2(p_job_id, p_attempt_token, p_idempotency_key, p_failure_code);
end;
$$;

create or replace function public.abort_worker_generation_attempt(
  p_job_id uuid, p_attempt_token uuid, p_idempotency_key text, p_failure_code text,
  p_worker_attempt_token uuid
)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare locked_job public.generation_jobs; result jsonb;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'generation worker abort caller is not authorized' using errcode = '42501'; end if;
  select job.* into locked_job from public.generation_jobs as job where job.id = p_job_id for update;
  if locked_job.id is null or locked_job.worker_attempt_token is distinct from p_worker_attempt_token
    or locked_job.worker_lease_expires_at is null or locked_job.worker_lease_expires_at <= pg_catalog.clock_timestamp()
    or locked_job.attempt_token is distinct from p_attempt_token
    or not narrative_private.generation_worker_binding_valid(locked_job) then
    return jsonb_build_object('outcome', 'stale');
  end if;
  if locked_job.provider_dispatch_recorded_at is not null then
    result := narrative_private.dead_letter_generation_worker_job(
      locked_job.id, narrative_private.provider_failure_code_after_dispatch(p_failure_code), true
    );
    return result;
  end if;
  result := public.generation_direct_abort_attempt_v2(p_job_id, p_attempt_token, p_idempotency_key, p_failure_code);
  if result ->> 'outcome' = 'aborted' then
    update public.generation_jobs set provider_setting_id = worker_provider_setting_id where id = p_job_id;
  end if;
  return result;
end;
$$;

create or replace function public.fail_generation_worker_attempt(
  p_job_id uuid, p_worker_attempt_token uuid, p_failure_code text
)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare locked_job public.generation_jobs; policy_failure text;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'generation worker failure caller is not authorized' using errcode = '42501'; end if;
  if p_job_id is null or p_worker_attempt_token is null then return jsonb_build_object('outcome', 'stale'); end if;
  if p_failure_code is null or length(p_failure_code) > 100 or p_failure_code !~ '^[a-z0-9_]+$' then
    raise exception 'invalid_generation_worker_failure' using errcode = '22023';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('narrative-generation-worker', 0));
  select job.* into locked_job from public.generation_jobs as job where job.id = p_job_id for update;
  if locked_job.id is null or locked_job.worker_attempt_token is distinct from p_worker_attempt_token then
    return jsonb_build_object('outcome', 'stale');
  end if;
  if locked_job.status = 'completed' then return public.complete_generation_worker_attempt(p_job_id, p_worker_attempt_token); end if;
  if locked_job.status = 'failed' and locked_job.worker_failure_code is not null then
    return jsonb_build_object('outcome', 'dead_lettered', 'jobId', locked_job.id, 'failureCode', locked_job.worker_failure_code);
  end if;
  if locked_job.worker_lease_expires_at is null or locked_job.worker_lease_expires_at <= pg_catalog.clock_timestamp() then
    return jsonb_build_object('outcome', 'stale');
  end if;
  if locked_job.provider_dispatch_recorded_at is not null then
    return narrative_private.dead_letter_generation_worker_job(
      locked_job.id, narrative_private.provider_failure_code_after_dispatch(p_failure_code), true
    );
  end if;
  policy_failure := narrative_private.generation_worker_policy_failure(locked_job);
  if policy_failure is not null then
    return narrative_private.dead_letter_generation_worker_job(locked_job.id, policy_failure, false);
  end if;
  if p_failure_code in (
    'manual_generation_disabled', 'schedule_automation_disabled', 'active_provider_setting_required',
    'stale_provider_pricing', 'invalid_provider_pricing', 'budget_blocked', 'manual_call_limit_reached',
    'generation_worker_attempt_mismatch', 'generation_binding_changed'
  ) then
    return narrative_private.dead_letter_generation_worker_job(
      locked_job.id,
      case
        when p_failure_code in ('manual_generation_disabled', 'schedule_automation_disabled') then 'worker_policy_disabled'
        when p_failure_code in ('active_provider_setting_required') then 'worker_provider_changed'
        when p_failure_code in ('stale_provider_pricing', 'invalid_provider_pricing') then 'worker_pricing_invalid'
        when p_failure_code in ('budget_blocked', 'manual_call_limit_reached') then 'worker_budget_blocked'
        else 'worker_binding_changed' end,
      false
    );
  end if;
  return narrative_private.retry_generation_worker_job(locked_job.id);
end;
$$;

create or replace function public.get_narrative_dashboard()
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
  daily_unconfirmed bigint;
  monthly_unconfirmed bigint;
begin
  perform narrative_private.require_narrative_owner();
  base := public.get_narrative_dashboard_v2();
  select coalesce((
    select settings.krw_per_usd
    from public.narrative_admin_settings as settings
    where settings.owner_id = auth.uid()
  ), 1380) into exchange_rate;

  select
    coalesce(sum(reservation.amount_micros) filter (
      where reservation.daily_bucket_date = public.narrative_business_date(current_timestamp)
    ), 0)::bigint,
    coalesce(sum(reservation.amount_micros), 0)::bigint
  into daily_unconfirmed, monthly_unconfirmed
  from public.generation_jobs as job
  join public.budget_entries as reservation
    on reservation.generation_job_id = job.id and reservation.owner_id = job.owner_id
      and reservation.entry_type = 'reservation'
  join public.budget_entries as failure
    on failure.generation_job_id = job.id and failure.owner_id = job.owner_id
      and failure.entry_type = 'failure' and failure.amount_micros = 0
  join public.budget_periods as period on period.id = reservation.budget_period_id
  where job.owner_id = auth.uid()
    and coalesce(job.worker_failure_code, job.failure_code) in (
      'provider_outcome_unknown', 'provider_timeout', 'provider_output_limit', 'provider_connection_failed'
    )
    and public.narrative_business_date(current_timestamp) between period.period_start and period.period_end;

  base := jsonb_set(coalesce(base, '{}'::jsonb), '{budget,dailyUnconfirmedMicros}', to_jsonb(daily_unconfirmed), true);
  base := jsonb_set(base, '{budget,monthlyUnconfirmedMicros}', to_jsonb(monthly_unconfirmed), true);

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
    'failedAt', item.failure_at,
    'unconfirmedMaximumCostMicros', case
      when coalesce(item.worker_failure_code, item.failure_code) in (
        'provider_outcome_unknown', 'provider_timeout', 'provider_output_limit', 'provider_connection_failed'
      ) then coalesce((
        select reservation.amount_micros
        from public.budget_entries as reservation
        where reservation.generation_job_id = item.id
          and reservation.owner_id = item.owner_id
          and reservation.entry_type = 'reservation'
          and exists (
            select 1 from public.budget_entries as failure
            where failure.generation_job_id = item.id
              and failure.owner_id = item.owner_id
              and failure.entry_type = 'failure'
              and failure.amount_micros = 0
          )
      ), 0) else 0 end
  ) order by item.created_at desc, item.id desc), '[]'::jsonb)
  into recent_queue
  from (
    select job.* from public.generation_jobs as job
    where job.owner_id = auth.uid()
    order by job.created_at desc, job.id desc limit 25
  ) as item;
  return (base - 'queue') || jsonb_build_object('queue', recent_queue, 'krwPerUsd', exchange_rate);
end;
$$;

revoke all on function narrative_private.provider_failure_code_after_dispatch(text) from public, anon, authenticated, service_role;

comment on function narrative_private.provider_failure_code_after_dispatch(text)
  is 'Maps only sanitized provider diagnostics across the irreversible dispatch boundary.';
