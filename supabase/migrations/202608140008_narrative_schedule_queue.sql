-- Queue-only scheduling. Provider calls remain exclusively in the generation worker.
create extension if not exists pg_cron with schema cron;
create extension if not exists pg_net with schema net;
create extension if not exists supabase_vault with schema vault;
create schema if not exists narrative_private;

create function narrative_private.schedule_budget_state(p_owner_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  active_period public.budget_periods;
  daily_used numeric;
  period_used numeric;
  daily_ratio numeric;
  period_ratio numeric;
begin
  select period.* into active_period
  from public.budget_periods as period
  where period.owner_id = p_owner_id and period.currency = 'USD'
    and public.narrative_business_date(current_timestamp) between period.period_start and period.period_end
  order by period.period_start desc, period.period_end asc, period.id limit 1;
  if active_period.id is null then return 'risk'; end if;
  select coalesce(sum(entry.amount_micros), 0) into daily_used from public.budget_entries as entry
  where entry.budget_period_id = active_period.id and entry.daily_bucket_date = public.narrative_business_date(current_timestamp);
  select coalesce(sum(entry.amount_micros), 0) into period_used from public.budget_entries as entry where entry.budget_period_id = active_period.id;
  daily_ratio := case when active_period.daily_limit_micros = 0 then 1 else daily_used / active_period.daily_limit_micros::numeric end;
  period_ratio := case when active_period.limit_micros = 0 then 1 else period_used / active_period.limit_micros::numeric end;
  if greatest(daily_ratio, period_ratio) >= 1 then return 'risk'; end if;
  if greatest(daily_ratio, period_ratio) >= 0.8 then return 'warning'; end if;
  return 'normal';
end;
$$;

create function public.narrative_schedule_budget_state(p_owner_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.role() is distinct from 'service_role' then raise exception 'schedule budget caller is not authorized' using errcode = '42501'; end if;
  return narrative_private.schedule_budget_state(p_owner_id);
end;
$$;

create function narrative_private.queue_narrative_schedule_job(
  p_owner_id uuid, p_schedule_key text, p_scheduled_for timestamptz, p_payload jsonb
)
returns public.generation_jobs
language plpgsql
security definer
set search_path = ''
as $$
declare created_job public.generation_jobs;
begin
  if p_owner_id is null or p_schedule_key is null or btrim(p_schedule_key) = '' or p_scheduled_for is null
    or p_payload is null or jsonb_typeof(p_payload) <> 'object'
    or p_payload ->> 'kind' not in ('short_dialogue', 'daily_event')
    or p_payload ->> 'source' not in ('schedule', 'access') then
    raise exception 'invalid_schedule_job' using errcode = '22023';
  end if;
  insert into public.generation_jobs (owner_id, schedule_key, scheduled_for, payload)
  values (p_owner_id, p_schedule_key, p_scheduled_for, p_payload)
  on conflict (schedule_key, scheduled_for) do nothing
  returning * into created_job;
  if created_job.id is null then
    select job.* into created_job from public.generation_jobs as job
    where job.schedule_key = p_schedule_key and job.scheduled_for = p_scheduled_for;
    if created_job.id is null or created_job.owner_id is distinct from p_owner_id then raise exception 'schedule_key_conflict' using errcode = 'P0001'; end if;
  end if;
  return created_job;
end;
$$;

create function public.queue_narrative_schedule_job(
  p_owner_id uuid, p_schedule_key text, p_scheduled_for timestamptz, p_payload jsonb
)
returns public.generation_jobs
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.role() is distinct from 'service_role' then raise exception 'schedule queue caller is not authorized' using errcode = '42501'; end if;
  return narrative_private.queue_narrative_schedule_job(p_owner_id, p_schedule_key, p_scheduled_for, p_payload);
end;
$$;

create function public.recent_narrative_access_job(p_owner_id uuid)
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
    and candidate.status in ('queued', 'running')
  order by candidate.created_at desc limit 1;
  return job;
end;
$$;

create function public.narrative_access_eligibility(p_owner_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare last_success timestamptz; daily_calls integer;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'schedule access caller is not authorized' using errcode = '42501'; end if;
  select max(job.created_at) into last_success from public.generation_jobs as job
  where job.owner_id = p_owner_id and job.schedule_key = ('access:' || p_owner_id::text) and job.status = 'completed';
  select count(*) into daily_calls from public.generation_jobs as job
  where job.owner_id = p_owner_id and job.schedule_key = ('access:' || p_owner_id::text) and job.status = 'completed'
    and public.narrative_business_date(job.created_at) = public.narrative_business_date(current_timestamp);
  return jsonb_build_object('last_success_at', last_success, 'next_allowed_at', case when last_success is null then null else last_success + interval '1 hour' end, 'daily_call_count', daily_calls, 'budget_state', narrative_private.schedule_budget_state(p_owner_id));
end;
$$;

revoke all on function narrative_private.schedule_budget_state(uuid) from public, anon, authenticated, service_role;
revoke all on function narrative_private.queue_narrative_schedule_job(uuid, text, timestamptz, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.narrative_schedule_budget_state(uuid) from public, anon, authenticated, service_role;
revoke all on function public.queue_narrative_schedule_job(uuid, text, timestamptz, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.recent_narrative_access_job(uuid) from public, anon, authenticated, service_role;
revoke all on function public.narrative_access_eligibility(uuid) from public, anon, authenticated, service_role;
grant execute on function public.narrative_schedule_budget_state(uuid) to service_role;
grant execute on function public.queue_narrative_schedule_job(uuid, text, timestamptz, jsonb) to service_role;
grant execute on function public.recent_narrative_access_job(uuid) to service_role;
grant execute on function public.narrative_access_eligibility(uuid) to service_role;

-- Values are provisioned outside migrations in Supabase Vault. This migration
-- intentionally contains only secret names, never a URL or credential.
create function narrative_private.invoke_schedule_dispatcher()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare dispatcher_url text; dispatcher_token text;
begin
  select decrypted_secret into dispatcher_url from vault.decrypted_secrets where name = 'narrative_schedule_dispatch_url';
  select decrypted_secret into dispatcher_token from vault.decrypted_secrets where name = 'narrative_schedule_dispatch_token';
  if dispatcher_url is null or dispatcher_token is null then raise exception 'schedule_dispatch_runtime_not_configured' using errcode = 'P0001'; end if;
  perform net.http_post(url := dispatcher_url, body := jsonb_build_object('action', 'dispatch'), headers := jsonb_build_object('content-type', 'application/json', 'x-schedule-dispatch-token', dispatcher_token));
end;
$$;
revoke all on function narrative_private.invoke_schedule_dispatcher() from public, anon, authenticated, service_role;
select cron.schedule('narrative-schedule-dispatcher', '*/5 * * * *', $$select narrative_private.invoke_schedule_dispatcher()$$)
where not exists (select 1 from cron.job where jobname = 'narrative-schedule-dispatcher');
