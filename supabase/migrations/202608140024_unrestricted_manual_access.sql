-- Explicit owner access requests may run repeatedly for testing, while cron
-- schedules retain their own interval policy. The existing access activation
-- switch plus budget, pricing, provider, confirmation, and active-job guards
-- remain.

create or replace function public.queue_narrative_access_job(p_owner_id uuid, p_now timestamptz)
returns public.generation_jobs
language plpgsql
security definer
set search_path = ''
as $$
declare
  active_job public.generation_jobs;
  queued_job public.generation_jobs;
  admin_settings public.narrative_admin_settings;
  budget_state text;
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
  budget_state := narrative_private.generation_budget_state_at(p_owner_id, p_now, 'schedule');
  select admin.* into admin_settings
  from public.narrative_admin_settings as admin
  where admin.owner_id = p_owner_id
  for share;
  if admin_settings.owner_id is null or not admin_settings.schedule_automation_enabled then
    raise exception 'schedule_automation_disabled' using errcode = 'P0001';
  end if;

  select candidate.* into active_job
  from public.generation_jobs as candidate
  where candidate.owner_id = p_owner_id
    and candidate.schedule_key = ('access:' || p_owner_id::text)
    and candidate.status in ('queued', 'running')
    and candidate.created_at >= p_now - interval '15 minutes'
  order by candidate.created_at desc, candidate.id
  limit 1;
  if active_job.id is not null then
    return active_job;
  end if;

  if budget_state = 'risk' then
    raise exception 'budget_risk' using errcode = 'P0001';
  end if;

  queued_job := narrative_private.queue_narrative_schedule_job(
    p_owner_id,
    'access:' || p_owner_id::text,
    date_trunc('minute', p_now),
    jsonb_build_object(
      'kind', 'short_dialogue',
      'source', 'access',
      'budgetPolicy', 'block_at_risk'
    )
  );
  return queued_job;
end;
$$;

comment on function public.queue_narrative_access_job(uuid, timestamptz)
is 'Queues an explicit owner access story without automatic interval or daily-count limits; budget and duplicate-work guards remain.';
