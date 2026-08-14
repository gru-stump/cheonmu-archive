-- Serialize authenticated access eligibility and queueing in one service-only transaction.
create function public.queue_narrative_access_job(
  p_owner_id uuid,
  p_now timestamptz
)
returns public.generation_jobs
language plpgsql
security definer
set search_path = ''
as $$
declare
  active_job public.generation_jobs;
  queued_job public.generation_jobs;
  active_period public.budget_periods;
  last_success timestamptz;
  daily_calls integer;
  daily_used numeric;
  period_used numeric;
  daily_ratio numeric;
  period_ratio numeric;
  budget_state text;
  business_date date;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'schedule access caller is not authorized' using errcode = '42501';
  end if;
  if p_owner_id is null or p_now is null then
    raise exception 'invalid_schedule_access' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('narrative-access:' || p_owner_id::text, 0)
  );

  select candidate.* into active_job
  from public.generation_jobs as candidate
  where candidate.owner_id = p_owner_id
    and candidate.schedule_key = ('access:' || p_owner_id::text)
    and candidate.status in ('queued', 'running')
    and candidate.created_at >= p_now - interval '15 minutes'
  order by candidate.created_at desc, candidate.id
  limit 1;
  if active_job.id is not null then return active_job; end if;

  select max(version.created_at), count(*) filter (
    where public.narrative_business_date(version.created_at) = public.narrative_business_date(p_now)
  )::integer
  into last_success, daily_calls
  from public.draft_versions as version
  join public.generation_jobs as job on job.id = version.generation_job_id
  where job.owner_id = p_owner_id
    and job.schedule_key = ('access:' || p_owner_id::text)
    and job.status = 'completed';

  if last_success is not null and last_success + interval '1 hour' > p_now then
    raise exception 'access_interval_not_elapsed' using errcode = 'P0001';
  end if;
  if coalesce(daily_calls, 0) >= 1 then
    raise exception 'daily_access_limit' using errcode = 'P0001';
  end if;

  business_date := public.narrative_business_date(p_now);
  select period.* into active_period
  from public.budget_periods as period
  where period.owner_id = p_owner_id and period.currency = 'USD'
    and business_date between period.period_start and period.period_end
  order by period.period_start desc, period.period_end asc, period.id
  limit 1
  for update;
  if active_period.id is null then
    budget_state := 'risk';
  else
    select coalesce(sum(entry.amount_micros), 0) into daily_used
    from public.budget_entries as entry
    where entry.budget_period_id = active_period.id and entry.daily_bucket_date = business_date;
    select coalesce(sum(entry.amount_micros), 0) into period_used
    from public.budget_entries as entry
    where entry.budget_period_id = active_period.id;
    daily_ratio := case when active_period.daily_limit_micros = 0 then 1 else daily_used / active_period.daily_limit_micros::numeric end;
    period_ratio := case when active_period.limit_micros = 0 then 1 else period_used / active_period.limit_micros::numeric end;
    budget_state := case when greatest(daily_ratio, period_ratio) >= 1 then 'risk'
      when greatest(daily_ratio, period_ratio) >= 0.8 then 'warning' else 'normal' end;
  end if;
  if budget_state = 'risk' then raise exception 'budget_risk' using errcode = 'P0001'; end if;

  queued_job := narrative_private.queue_narrative_schedule_job(
    p_owner_id,
    'access:' || p_owner_id::text,
    date_trunc('minute', p_now),
    jsonb_build_object('kind', 'short_dialogue', 'source', 'access')
  );
  return queued_job;
end;
$$;

revoke all on function public.queue_narrative_access_job(uuid, timestamptz)
  from public, anon, authenticated, service_role;
grant execute on function public.queue_narrative_access_job(uuid, timestamptz) to service_role;

-- The atomic mutation supersedes the two legacy eligibility reads.
revoke execute on function public.recent_narrative_access_job(uuid) from service_role;
revoke execute on function public.narrative_access_eligibility(uuid) from service_role;
