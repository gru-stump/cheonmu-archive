-- Harden Task 4 scheduling without altering its original migration.
create or replace function public.recent_narrative_access_job(p_owner_id uuid)
returns public.generation_jobs
language plpgsql
security definer
set search_path = ''
as $$
declare job public.generation_jobs;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'schedule access caller is not authorized' using errcode = '42501'; end if;
  select candidate.* into job from public.generation_jobs as candidate
  where candidate.owner_id = p_owner_id and candidate.schedule_key = ('access:' || p_owner_id::text)
    and candidate.status in ('queued', 'running') and candidate.created_at >= current_timestamp - interval '15 minutes'
  order by candidate.created_at desc limit 1;
  return job;
end;
$$;

create or replace function public.narrative_access_eligibility(p_owner_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare last_success timestamptz; daily_calls integer;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'schedule access caller is not authorized' using errcode = '42501'; end if;
  select max(version.created_at) into last_success
  from public.draft_versions as version
  join public.generation_jobs as job on job.id = version.generation_job_id
  where job.owner_id = p_owner_id and job.schedule_key = ('access:' || p_owner_id::text) and job.status = 'completed';
  select count(*) into daily_calls
  from public.draft_versions as version
  join public.generation_jobs as job on job.id = version.generation_job_id
  where job.owner_id = p_owner_id and job.schedule_key = ('access:' || p_owner_id::text) and job.status = 'completed'
    and public.narrative_business_date(version.created_at) = public.narrative_business_date(current_timestamp);
  return jsonb_build_object('last_success_at', last_success, 'next_allowed_at', case when last_success is null then null else last_success + interval '1 hour' end, 'daily_call_count', daily_calls, 'budget_state', narrative_private.schedule_budget_state(p_owner_id));
end;
$$;
