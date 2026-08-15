-- Final admin review corrections: reversible archive, one next-run policy, and canonical schedule lock order.

create function public.restore_narrative_draft(p_draft_id uuid, p_expected_version_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  locked_draft public.drafts;
  locked_version public.draft_versions;
  archive_event public.audit_events;
  restored_state text;
begin
  if auth.role() is distinct from 'authenticated' or auth.uid() is null then
    raise exception 'restore caller is not authorized' using errcode = '42501';
  end if;
  select draft.* into locked_draft from public.drafts as draft where draft.id = p_draft_id for update;
  if locked_draft.id is null or locked_draft.owner_id is distinct from auth.uid() then
    raise exception 'restore target not found' using errcode = 'P0002';
  end if;
  select version.* into locked_version from public.draft_versions as version
  where version.id = p_expected_version_id
    and version.owner_id = locked_draft.owner_id
    and version.draft_id = locked_draft.id
    and version.version_number = (
      select max(latest.version_number) from public.draft_versions as latest
      where latest.owner_id = locked_draft.owner_id and latest.draft_id = locked_draft.id
    )
  for update;
  select event.* into archive_event from public.audit_events as event
  where event.owner_id = locked_draft.owner_id and event.entity_type = 'draft'
    and event.entity_id = locked_draft.id and event.event_type = 'draft_archived'
  order by event.created_at desc, event.id desc limit 1;
  if locked_draft.status is distinct from 'archived' or locked_version.id is null
    or archive_event.id is null or archive_event.payload ->> 'versionId' is distinct from p_expected_version_id::text then
    raise exception 'stale_restore' using errcode = 'P0001';
  end if;
  restored_state := archive_event.payload ->> 'previousState';
  if restored_state not in ('generated', 'reviewing', 'rejected', 'approved_private', 'publish_failed') then
    raise exception 'invalid_restore_state' using errcode = 'P0001';
  end if;
  update public.drafts set status = restored_state, updated_at = now()
  where id = locked_draft.id and status = 'archived';
  insert into public.audit_events (owner_id, event_type, entity_type, entity_id, payload)
  values (locked_draft.owner_id, 'draft_restored', 'draft', locked_draft.id,
    jsonb_build_object('restoredState', restored_state, 'versionId', locked_version.id, 'archiveAuditId', archive_event.id));
  return jsonb_build_object('status', restored_state);
end;
$$;

revoke all on function public.restore_narrative_draft(uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function public.restore_narrative_draft(uuid, uuid) to authenticated;

create function narrative_private.next_narrative_schedule_at(p_schedule_id uuid, p_after timestamptz)
returns timestamptz
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  schedule public.schedules;
  eligible_after timestamptz;
  special_at timestamptz;
  next_at timestamptz;
begin
  if p_schedule_id is null or p_after is null then return null; end if;
  select candidate.* into schedule from public.schedules as candidate where candidate.id = p_schedule_id;
  if schedule.id is null or not schedule.enabled or schedule.schedule_type = 'manual' then return null; end if;
  eligible_after := greatest(p_after, coalesce(
    schedule.last_queued_at + make_interval(mins => schedule.minimum_interval_minutes), p_after
  ));
  if schedule.schedule_type = 'special' then
    special_at := (schedule.special_date + schedule.seoul_time) at time zone 'Asia/Seoul';
    if special_at > p_after and special_at >= eligible_after then return special_at; end if;
    return null;
  end if;
  select min(candidate.local_minute at time zone 'Asia/Seoul') into next_at
  from generate_series(
    date_trunc('minute', eligible_after at time zone 'Asia/Seoul'),
    date_trunc('minute', eligible_after at time zone 'Asia/Seoul') + interval '8 days',
    interval '1 minute'
  ) as candidate(local_minute)
  where candidate.local_minute at time zone 'Asia/Seoul' > p_after
    and candidate.local_minute at time zone 'Asia/Seoul' >= eligible_after
    and extract(minute from candidate.local_minute)::integer = split_part(schedule.cron_expression, ' ', 1)::integer
    and extract(hour from candidate.local_minute)::integer = split_part(schedule.cron_expression, ' ', 2)::integer
    and (split_part(schedule.cron_expression, ' ', 5) = '*'
      or extract(dow from candidate.local_minute)::integer = split_part(schedule.cron_expression, ' ', 5)::integer);
  return next_at;
end;
$$;

revoke all on function narrative_private.next_narrative_schedule_at(uuid, timestamptz)
from public, anon, authenticated, service_role;

create or replace function public.get_narrative_schedules()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform narrative_private.require_narrative_owner();
  return (
    select jsonb_build_object('schedules', coalesce(jsonb_agg(jsonb_build_object(
      'id', schedule.id,
      'scheduleKey', schedule.schedule_key,
      'scheduleType', schedule.schedule_type,
      'enabled', schedule.enabled,
      'seoulTime', to_char(schedule.seoul_time, 'HH24:MI'),
      'weekday', case when schedule.schedule_type = 'automatic' and split_part(schedule.cron_expression, ' ', 5) <> '*'
        then split_part(schedule.cron_expression, ' ', 5)::integer else null end,
      'specialDate', schedule.special_date,
      'minimumIntervalMinutes', schedule.minimum_interval_minutes,
      'kind', coalesce(schedule.payload ->> 'kind', 'short_dialogue'),
      'lastRunAt', (
        select max(job.scheduled_for) from public.generation_jobs as job
        where job.owner_id = schedule.owner_id
          and split_part(job.schedule_key, ':', 1) = schedule.owner_id::text
          and split_part(job.schedule_key, ':', 2) = schedule.schedule_key
          and job.status in ('running', 'completed', 'failed')
      ),
      'nextRunAt', narrative_private.next_narrative_schedule_at(schedule.id, now())
    ) order by schedule.schedule_key), '[]'::jsonb))
    from public.schedules as schedule where schedule.owner_id = auth.uid()
  );
end;
$$;

create or replace function public.get_narrative_dashboard()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare result jsonb;
begin
  perform narrative_private.require_narrative_owner();
  with current_period as (
    select period.* from public.budget_periods as period
    where period.owner_id = auth.uid() and public.narrative_business_date(now()) between period.period_start and period.period_end
    order by period.period_start desc limit 1
  ), ledger as (
    select entry.*, exists(select 1 from public.budget_entries as settled where settled.owner_id = entry.owner_id and settled.generation_job_id = entry.generation_job_id and settled.entry_type in ('reconciliation', 'failure')) as settled
    from public.budget_entries as entry join current_period on current_period.id = entry.budget_period_id
  ), totals as (
    select coalesce(sum(amount_micros) filter (where settled), 0)::bigint as spent,
      coalesce(sum(amount_micros) filter (where not settled and entry_type = 'reservation'), 0)::bigint as reserved,
      coalesce(sum(amount_micros) filter (where settled and daily_bucket_date = public.narrative_business_date(now())), 0)::bigint as daily_spent
    from ledger
  )
  select jsonb_build_object(
    'budget', jsonb_build_object(
      'dailySpentMicros', totals.daily_spent, 'monthlySpentMicros', totals.spent, 'reservedMicros', totals.reserved,
      'dailyRemainingMicros', greatest(coalesce(current_period.daily_limit_micros, 0) - totals.daily_spent - totals.reserved, 0),
      'monthlyRemainingMicros', greatest(coalesce(current_period.limit_micros, 0) - totals.spent - totals.reserved, 0)
    ),
    'nextScheduleAt', (
      select min(candidate.at) from (
        select job.scheduled_for as at from public.generation_jobs as job
        where job.owner_id = auth.uid() and job.status = 'queued' and job.scheduled_for >= now()
        union all
        select narrative_private.next_narrative_schedule_at(schedule.id, now()) as at
        from public.schedules as schedule where schedule.owner_id = auth.uid() and schedule.enabled
      ) as candidate where candidate.at is not null
    ),
    'lastSuccessAt', (
      select max(version.created_at) from public.draft_versions as version
      join public.generation_jobs as job on job.id = version.generation_job_id and job.owner_id = version.owner_id
      where version.owner_id = auth.uid() and job.status = 'completed'
    ),
    'failures', coalesce((select jsonb_agg(jsonb_build_object('id', failed.id, 'occurredAt', coalesce(failed.failure_at, failed.created_at), 'code', coalesce(failed.failure_code, 'generation_failed')) order by coalesce(failed.failure_at, failed.created_at) desc) from (select job.* from public.generation_jobs as job where job.owner_id = auth.uid() and job.status = 'failed' order by coalesce(job.failure_at, job.created_at) desc limit 10) as failed), '[]'::jsonb)
  ) into result from current_period right join totals on true;
  return coalesce(result, jsonb_build_object('budget', jsonb_build_object('dailySpentMicros',0,'monthlySpentMicros',0,'reservedMicros',0,'dailyRemainingMicros',0,'monthlyRemainingMicros',0),'nextScheduleAt',null,'lastSuccessAt',null,'failures','[]'::jsonb));
end;
$$;

revoke all on function public.get_narrative_schedules(), public.get_narrative_dashboard() from public, anon, authenticated, service_role;
grant execute on function public.get_narrative_schedules(), public.get_narrative_dashboard() to authenticated;

create or replace function public.save_narrative_schedule(
  p_schedule_id uuid,
  p_schedule_key text,
  p_schedule_type text,
  p_enabled boolean,
  p_seoul_time text,
  p_weekday integer,
  p_special_date date,
  p_minimum_interval_minutes integer,
  p_kind text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  parsed_hour integer;
  parsed_minute integer;
  cron_value text;
  settings public.narrative_admin_settings;
  active_provider public.provider_settings;
  stored_schedule public.schedules;
begin
  perform narrative_private.require_narrative_owner();
  if p_schedule_key is null or p_schedule_type is null or p_enabled is null
    or p_seoul_time is null or p_minimum_interval_minutes is null or p_kind is null
    or p_schedule_key !~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$'
    or p_schedule_type not in ('automatic', 'manual', 'special')
    or p_seoul_time !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
    or p_minimum_interval_minutes not between 1 and 525600
    or p_kind not in ('short_dialogue', 'daily_event')
    or (p_schedule_type = 'automatic' and p_weekday is not null and p_weekday not between 0 and 6)
    or (p_schedule_type = 'special' and p_special_date is null)
    or (p_schedule_type <> 'special' and p_special_date is not null) then
    raise exception 'invalid_schedule_command' using errcode = '22023';
  end if;
  parsed_hour := split_part(p_seoul_time, ':', 1)::integer;
  parsed_minute := split_part(p_seoul_time, ':', 2)::integer;
  cron_value := case when p_schedule_type = 'automatic'
    then parsed_minute::text || ' ' || parsed_hour::text || ' * * ' || coalesce(p_weekday::text, '*')
    else null end;

  -- Dispatch takes advisory schedule -> schedule row -> provider -> budget -> admin.
  -- Existing saves take the same schedule prefix, then provider -> admin; new rows are invisible until commit.
  if p_schedule_id is not null then
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('narrative-schedule:' || p_schedule_id::text, 0));
    select schedule.* into stored_schedule from public.schedules as schedule
    where schedule.id = p_schedule_id and schedule.owner_id = auth.uid() for update;
    if stored_schedule.id is null then raise exception 'schedule not found' using errcode = 'P0002'; end if;
  else
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('narrative-schedule-key:' || auth.uid()::text || ':' || p_schedule_key, 0));
  end if;

  if p_enabled and p_schedule_type in ('automatic', 'special') then
    select provider.* into active_provider from public.provider_settings as provider
    where provider.owner_id = auth.uid() and provider.enabled for share;
    select admin.* into settings from public.narrative_admin_settings as admin
    where admin.owner_id = auth.uid() for update;
    if settings.owner_id is null or not settings.automation_enabled then raise exception 'automation_disabled' using errcode = 'P0001'; end if;
    if active_provider.id is null
      or active_provider.pricing_verified_at > public.narrative_business_date(current_timestamp)
      or active_provider.pricing_verified_at < public.narrative_business_date(current_timestamp) - settings.pricing_valid_days then
      raise exception 'stale_provider_pricing' using errcode = 'P0001';
    end if;
  end if;
  if p_schedule_id is null then
    insert into public.schedules (owner_id, schedule_key, schedule_type, cron_expression, enabled, payload, special_date, seoul_time, minimum_interval_minutes)
    values (auth.uid(), p_schedule_key, p_schedule_type, cron_value, p_enabled, jsonb_build_object('kind', p_kind), p_special_date, make_time(parsed_hour, parsed_minute, 0), p_minimum_interval_minutes)
    returning * into stored_schedule;
  else
    update public.schedules set schedule_key = p_schedule_key, schedule_type = p_schedule_type,
      cron_expression = cron_value, enabled = p_enabled, payload = jsonb_build_object('kind', p_kind),
      special_date = p_special_date, seoul_time = make_time(parsed_hour, parsed_minute, 0),
      minimum_interval_minutes = p_minimum_interval_minutes, updated_at = now()
    where id = stored_schedule.id returning * into stored_schedule;
  end if;
  insert into public.audit_events (owner_id, event_type, entity_type, entity_id, payload)
  values (auth.uid(), 'narrative_schedule_saved', 'schedule', stored_schedule.id,
    jsonb_build_object('scheduleType', stored_schedule.schedule_type, 'enabled', stored_schedule.enabled));
  return jsonb_build_object('scheduleId', stored_schedule.id);
exception when unique_violation then
  raise exception 'duplicate_schedule_key' using errcode = 'P0001';
end;
$$;

revoke all on function public.save_narrative_schedule(uuid, text, text, boolean, text, integer, date, integer, text)
from public, anon, authenticated, service_role;
grant execute on function public.save_narrative_schedule(uuid, text, text, boolean, text, integer, date, integer, text)
to authenticated;
