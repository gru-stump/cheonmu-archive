alter table public.memory_items
  drop constraint memory_items_memory_type_check,
  add constraint memory_items_owner_id_id_key unique (owner_id, id),
  add column supersedes_memory_item_id uuid,
  add column correction_note text,
  add constraint memory_items_memory_type_check check (
    memory_type in ('canon', 'feedback', 'continuity', 'summary', 'unresolved')
  ),
  add constraint memory_items_owner_supersedes_fkey
    foreign key (owner_id, supersedes_memory_item_id)
    references public.memory_items (owner_id, id)
    on delete restrict,
  add constraint memory_items_not_self_superseding check (id is distinct from supersedes_memory_item_id);

create unique index memory_items_one_correction_per_predecessor_idx
  on public.memory_items (supersedes_memory_item_id)
  where supersedes_memory_item_id is not null;

create function narrative_private.reject_memory_history_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'memory_history_is_immutable' using errcode = '55000';
  end if;
  if old.owner_id is distinct from new.owner_id
    or old.memory_type is distinct from new.memory_type
    or old.content is distinct from new.content
    or old.source_draft_version_id is distinct from new.source_draft_version_id
    or old.supersedes_memory_item_id is distinct from new.supersedes_memory_item_id
    or old.correction_note is distinct from new.correction_note then
    raise exception 'memory_history_is_immutable' using errcode = '55000';
  end if;
  return new;
end;
$$;

revoke all on function narrative_private.reject_memory_history_mutation()
  from public, anon, authenticated, service_role;

create trigger memory_items_preserve_history
before update or delete on public.memory_items
for each row execute function narrative_private.reject_memory_history_mutation();

alter table public.provider_settings
  add column pricing_verified_at date not null default date '1970-01-01';

update public.provider_settings
set enabled = false, updated_at = now()
where enabled;

create table public.narrative_admin_settings (
  owner_id uuid primary key references auth.users(id) on delete cascade,
  automation_enabled boolean not null default false,
  pricing_valid_days integer not null default 30 check (pricing_valid_days between 1 and 365),
  manual_call_limit integer not null default 3 check (manual_call_limit >= 0),
  warning_threshold_percent integer not null default 80 check (warning_threshold_percent between 1 and 99),
  risk_threshold_percent integer not null default 95 check (risk_threshold_percent between 2 and 100),
  krw_per_usd numeric(12, 4) not null default 1350 check (krw_per_usd > 0),
  updated_at timestamptz not null default now(),
  check (warning_threshold_percent < risk_threshold_percent)
);

insert into public.narrative_admin_settings (owner_id, automation_enabled)
select owner.owner_id, false
from public.owner_profiles as owner
on conflict (owner_id) do nothing;

alter table public.narrative_admin_settings enable row level security;
create policy "owner can read narrative admin settings"
on public.narrative_admin_settings for select
using (auth.uid() = owner_id);
revoke all privileges on table public.narrative_admin_settings
  from public, anon, authenticated, service_role;
grant select on table public.narrative_admin_settings to authenticated;
grant select, insert, update, delete on table public.narrative_admin_settings to service_role;

alter table public.schedules
  drop constraint schedules_schedule_type_check,
  drop constraint schedules_supported_cron_check,
  add column special_date date,
  add column seoul_time time(0) without time zone not null default time '09:00',
  add column minimum_interval_minutes integer not null default 60 check (minimum_interval_minutes between 1 and 525600),
  add column last_queued_at timestamptz;

update public.schedules
set seoul_time = make_time(
  split_part(cron_expression, ' ', 2)::integer,
  split_part(cron_expression, ' ', 1)::integer,
  0
)
where schedule_type = 'automatic'
  and cron_expression ~ '^([0-9]|[1-5][0-9]) ([0-9]|1[0-9]|2[0-3]) [*] [*] ([*]|[0-6])$';

with queued as (
  select job.owner_id, split_part(job.schedule_key, ':', 2) as schedule_key,
    max(job.scheduled_for) as last_queued_at
  from public.generation_jobs as job
  where job.status in ('queued', 'running', 'completed', 'failed')
    and split_part(job.schedule_key, ':', 1) = job.owner_id::text
  group by job.owner_id, split_part(job.schedule_key, ':', 2)
)
update public.schedules as schedule
set last_queued_at = queued.last_queued_at
from queued
where queued.owner_id = schedule.owner_id and queued.schedule_key = schedule.schedule_key;

alter table public.schedules
  add constraint schedules_schedule_type_check check (schedule_type in ('automatic', 'manual', 'special')),
  add constraint schedules_supported_cron_check check (
    (schedule_type = 'manual' and cron_expression is null and special_date is null)
    or (schedule_type = 'special' and cron_expression is null and special_date is not null)
    or (
      schedule_type = 'automatic'
      and special_date is null
      and cron_expression is not null
      and (
        not enabled
        or cron_expression ~ '^([0-9]|[1-5][0-9]) ([0-9]|1[0-9]|2[0-3]) [*] [*] ([*]|[0-6])$'
      )
    )
  );

create function public.get_narrative_memory()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with recursive latest as (
    select memory.*
    from public.memory_items as memory
    where memory.owner_id = auth.uid()
      and not exists (
        select 1 from public.memory_items as newer
        where newer.owner_id = memory.owner_id
          and newer.supersedes_memory_item_id = memory.id
      )
  ), history as (
    select current.id as latest_id, previous.*, current.correction_note as applied_note, 1 as depth
    from latest as current
    join public.memory_items as previous
      on previous.id = current.supersedes_memory_item_id
      and previous.owner_id = current.owner_id
    union all
    select history.latest_id, previous.*, history.correction_note as applied_note, history.depth + 1
    from history
    join public.memory_items as previous
      on previous.id = history.supersedes_memory_item_id
      and previous.owner_id = history.owner_id
  ), shaped as (
    select latest.memory_type,
      jsonb_build_object(
        'id', latest.id,
        'memoryType', latest.memory_type,
        'content', latest.content,
        'enabled', latest.status <> 'inactive',
        'createdAt', latest.created_at,
        'correctionHistory', coalesce((
          select jsonb_agg(jsonb_build_object(
            'id', old.id, 'content', old.content, 'note', old.applied_note, 'createdAt', old.created_at
          ) order by old.depth desc)
          from history as old where old.latest_id = latest.id
        ), '[]'::jsonb)
      ) as item
    from latest
  )
  select jsonb_build_object(
    'fixedCanon', coalesce(jsonb_agg(item order by item ->> 'createdAt') filter (where memory_type = 'canon'), '[]'::jsonb),
    'continuity', coalesce(jsonb_agg(item order by item ->> 'createdAt') filter (where memory_type = 'continuity'), '[]'::jsonb),
    'recent', coalesce(jsonb_agg(item order by item ->> 'createdAt') filter (where memory_type = 'summary'), '[]'::jsonb),
    'feedback', coalesce(jsonb_agg(item order by item ->> 'createdAt') filter (where memory_type = 'feedback'), '[]'::jsonb),
    'unresolved', coalesce(jsonb_agg(item order by item ->> 'createdAt') filter (where memory_type = 'unresolved'), '[]'::jsonb)
  )
  from shaped
  where auth.role() = 'authenticated' and auth.uid() is not null;
$$;

create function public.set_narrative_memory_enabled(p_memory_id uuid, p_enabled boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  locked_memory public.memory_items;
  next_status text;
begin
  if auth.role() is distinct from 'authenticated' or auth.uid() is null or p_memory_id is null or p_enabled is null then
    raise exception 'memory command caller is not authorized' using errcode = '42501';
  end if;
  select memory.* into locked_memory
  from public.memory_items as memory
  where memory.id = p_memory_id and memory.owner_id = auth.uid()
  for update;
  if locked_memory.id is null then raise exception 'memory not found' using errcode = 'P0002'; end if;
  if locked_memory.memory_type = 'canon' then raise exception 'fixed_canon_read_only' using errcode = 'P0001'; end if;
  if exists (select 1 from public.memory_items where owner_id = locked_memory.owner_id and supersedes_memory_item_id = locked_memory.id) then
    raise exception 'stale_memory' using errcode = 'P0001';
  end if;
  next_status := case when not p_enabled then 'inactive'
    when locked_memory.metadata ->> 'adminPreviousStatus' in ('active', 'approved') then locked_memory.metadata ->> 'adminPreviousStatus'
    when locked_memory.memory_type in ('continuity', 'summary') then 'approved'
    else 'active' end;
  update public.memory_items
  set status = next_status,
      metadata = case when not p_enabled
        then metadata || jsonb_build_object('adminPreviousStatus', status)
        else metadata - 'adminPreviousStatus' end,
      updated_at = now()
  where id = locked_memory.id;
  insert into public.audit_events (owner_id, event_type, entity_type, entity_id, payload)
  values (locked_memory.owner_id, 'memory_enabled_changed', 'memory_item', locked_memory.id, jsonb_build_object('enabled', p_enabled));
  return jsonb_build_object('enabled', p_enabled);
end;
$$;

create function public.correct_narrative_memory(p_memory_id uuid, p_content text, p_note text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  locked_memory public.memory_items;
  created_memory public.memory_items;
begin
  if auth.role() is distinct from 'authenticated' or auth.uid() is null then
    raise exception 'memory command caller is not authorized' using errcode = '42501';
  end if;
  if p_memory_id is null or nullif(btrim(p_content), '') is null or nullif(btrim(p_note), '') is null
    or length(p_content) > 20000 or length(p_note) > 1000 then
    raise exception 'invalid_memory_correction' using errcode = '22023';
  end if;
  select memory.* into locked_memory
  from public.memory_items as memory
  where memory.id = p_memory_id and memory.owner_id = auth.uid()
  for update;
  if locked_memory.id is null then raise exception 'memory not found' using errcode = 'P0002'; end if;
  if locked_memory.memory_type = 'canon' then raise exception 'fixed_canon_read_only' using errcode = 'P0001'; end if;
  if exists (select 1 from public.memory_items where owner_id = locked_memory.owner_id and supersedes_memory_item_id = locked_memory.id) then
    raise exception 'stale_memory' using errcode = 'P0001';
  end if;
  update public.memory_items set status = 'inactive', updated_at = now() where id = locked_memory.id;
  insert into public.memory_items (
    owner_id, memory_type, content, importance, metadata, source_draft_version_id,
    status, blocking, supersedes_memory_item_id, correction_note
  ) values (
    locked_memory.owner_id, locked_memory.memory_type, btrim(p_content), locked_memory.importance,
    locked_memory.metadata || jsonb_build_object('tokenCount', greatest(1, ceil(length(btrim(p_content)) / 4.0)::integer)),
    locked_memory.source_draft_version_id,
    locked_memory.status,
    locked_memory.blocking, locked_memory.id, btrim(p_note)
  ) returning * into created_memory;
  insert into public.audit_events (owner_id, event_type, entity_type, entity_id, payload)
  values (locked_memory.owner_id, 'memory_correction_created', 'memory_item', created_memory.id,
    jsonb_build_object('supersedesMemoryItemId', locked_memory.id));
  return jsonb_build_object('memoryId', created_memory.id);
end;
$$;

create function public.get_narrative_schedules()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
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
    'nextRunAt', case
      when not schedule.enabled or schedule.schedule_type = 'manual' then null
      when schedule.schedule_type = 'special' then
        case when (schedule.special_date + schedule.seoul_time) at time zone 'Asia/Seoul' > now()
          and (schedule.last_queued_at is null or (schedule.special_date + schedule.seoul_time) at time zone 'Asia/Seoul'
            >= schedule.last_queued_at + make_interval(mins => schedule.minimum_interval_minutes))
          then (schedule.special_date + schedule.seoul_time) at time zone 'Asia/Seoul' else null end
      else (
        select min(candidate.local_minute at time zone 'Asia/Seoul')
        from generate_series(
          date_trunc('minute', greatest(now(), coalesce(
            schedule.last_queued_at + make_interval(mins => schedule.minimum_interval_minutes), now()
          )) at time zone 'Asia/Seoul'),
          date_trunc('minute', greatest(now(), coalesce(
            schedule.last_queued_at + make_interval(mins => schedule.minimum_interval_minutes), now()
          )) at time zone 'Asia/Seoul') + interval '8 days',
          interval '1 minute'
        ) as candidate(local_minute)
        where candidate.local_minute at time zone 'Asia/Seoul' > now()
          and extract(minute from candidate.local_minute)::integer = split_part(schedule.cron_expression, ' ', 1)::integer
          and extract(hour from candidate.local_minute)::integer = split_part(schedule.cron_expression, ' ', 2)::integer
          and (split_part(schedule.cron_expression, ' ', 5) = '*'
            or extract(dow from candidate.local_minute)::integer = split_part(schedule.cron_expression, ' ', 5)::integer)
          and (schedule.last_queued_at is null or candidate.local_minute at time zone 'Asia/Seoul'
            >= schedule.last_queued_at + make_interval(mins => schedule.minimum_interval_minutes))
      ) end
  ) order by schedule.schedule_key), '[]'::jsonb))
  from public.schedules as schedule
  where schedule.owner_id = auth.uid() and auth.role() = 'authenticated';
$$;

create function public.save_narrative_schedule(
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
  if auth.role() is distinct from 'authenticated' or auth.uid() is null then raise exception 'schedule caller is not authorized' using errcode = '42501'; end if;
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
  if p_enabled and p_schedule_type in ('automatic', 'special') then
    select admin.* into settings from public.narrative_admin_settings as admin where admin.owner_id = auth.uid() for update;
    if settings.owner_id is null or not settings.automation_enabled then raise exception 'automation_disabled' using errcode = 'P0001'; end if;
    select provider.* into active_provider from public.provider_settings as provider where provider.owner_id = auth.uid() and provider.enabled for share;
    if active_provider.id is null
      or active_provider.pricing_verified_at < public.narrative_business_date(current_timestamp) - settings.pricing_valid_days then
      raise exception 'stale_provider_pricing' using errcode = 'P0001';
    end if;
  end if;
  if p_schedule_id is null then
    insert into public.schedules (
      owner_id, schedule_key, schedule_type, cron_expression, enabled, payload,
      special_date, seoul_time, minimum_interval_minutes
    ) values (
      auth.uid(), p_schedule_key, p_schedule_type, cron_value, p_enabled, jsonb_build_object('kind', p_kind),
      p_special_date, make_time(parsed_hour, parsed_minute, 0), p_minimum_interval_minutes
    ) returning * into stored_schedule;
  else
    select schedule.* into stored_schedule from public.schedules as schedule
    where schedule.id = p_schedule_id and schedule.owner_id = auth.uid() for update;
    if stored_schedule.id is null then raise exception 'schedule not found' using errcode = 'P0002'; end if;
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

create function public.get_narrative_settings()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  result jsonb;
begin
  if auth.role() is distinct from 'authenticated' or auth.uid() is null then raise exception 'settings caller is not authorized' using errcode = '42501'; end if;
  with admin as (
    select * from public.narrative_admin_settings where owner_id = auth.uid()
  ), current_period as (
    select period.* from public.budget_periods as period
    where period.owner_id = auth.uid() and public.narrative_business_date(now()) between period.period_start and period.period_end
    order by period.period_start desc limit 1
  ), totals as (
    select coalesce(sum(entry.amount_micros), 0)::bigint as committed,
      coalesce(sum(entry.amount_micros) filter (where entry.entry_type = 'reservation'
        and not exists (select 1 from public.budget_entries as settlement where settlement.generation_job_id = entry.generation_job_id and settlement.entry_type in ('reconciliation', 'failure'))), 0)::bigint as reserved
    from public.budget_entries as entry join current_period on current_period.id = entry.budget_period_id
  )
  select jsonb_build_object(
    'automationEnabled', coalesce(admin.automation_enabled, false),
    'pricingValidDays', coalesce(admin.pricing_valid_days, 30),
    'providers', coalesce((select jsonb_agg(jsonb_build_object(
      'providerKey', provider.provider_key, 'enabled', provider.enabled, 'modelKey', provider.model_key,
      'maxInputTokens', provider.max_input_tokens, 'maxOutputTokens', provider.max_output_tokens,
      'maxRevisionOutputTokens', provider.max_revision_output_tokens,
      'inputPriceMicrosPerMillion', provider.input_cost_micros_per_million,
      'outputPriceMicrosPerMillion', provider.output_cost_micros_per_million,
      'pricingVerifiedAt', provider.pricing_verified_at
    ) order by provider.provider_key) from public.provider_settings as provider where provider.owner_id = auth.uid()), '[]'::jsonb),
    'budget', jsonb_build_object(
      'monthlyLimitMicros', coalesce(current_period.limit_micros, 0),
      'dailyLimitMicros', coalesce(current_period.daily_limit_micros, 0),
      'spentMicros', greatest(coalesce(totals.committed, 0) - coalesce(totals.reserved, 0), 0),
      'reservedMicros', greatest(coalesce(totals.reserved, 0), 0),
      'manualCallLimit', coalesce(admin.manual_call_limit, 3),
      'warningThresholdPercent', coalesce(admin.warning_threshold_percent, 80),
      'riskThresholdPercent', coalesce(admin.risk_threshold_percent, 95),
      'krwPerUsd', coalesce(admin.krw_per_usd, 1350)
    ),
    'secrets', jsonb_build_object(
      'openai', exists(select 1 from vault.decrypted_secrets where name = 'narrative_' || auth.uid()::text || '_openai'),
      'anthropic', exists(select 1 from vault.decrypted_secrets where name = 'narrative_' || auth.uid()::text || '_anthropic'),
      'github', exists(select 1 from vault.decrypted_secrets where name = 'narrative_' || auth.uid()::text || '_github')
    )
  ) into result
  from admin full join current_period on true full join totals on true;
  return coalesce(result, jsonb_build_object(
    'automationEnabled', false, 'pricingValidDays', 30, 'providers', '[]'::jsonb,
    'budget', jsonb_build_object('monthlyLimitMicros',0,'dailyLimitMicros',0,'spentMicros',0,'reservedMicros',0,'manualCallLimit',3,'warningThresholdPercent',80,'riskThresholdPercent',95,'krwPerUsd',1350),
    'secrets', jsonb_build_object('openai',false,'anthropic',false,'github',false)
  ));
end;
$$;

create function public.save_narrative_settings(
  p_automation_enabled boolean,
  p_active_provider_key text,
  p_provider_updates jsonb,
  p_monthly_limit_micros bigint,
  p_daily_limit_micros bigint,
  p_manual_call_limit integer,
  p_warning_threshold_percent integer,
  p_risk_threshold_percent integer,
  p_krw_per_usd numeric,
  p_pricing_valid_days integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  provider_update jsonb;
  provider_key_value text;
  current_period public.budget_periods;
  monthly_committed numeric;
  daily_committed numeric;
  updated_provider public.provider_settings;
  update_count integer := 0;
begin
  if auth.role() is distinct from 'authenticated' or auth.uid() is null then raise exception 'settings caller is not authorized' using errcode = '42501'; end if;
  if p_automation_enabled is null or p_provider_updates is null or jsonb_typeof(p_provider_updates) <> 'array'
    or p_monthly_limit_micros < 0 or p_daily_limit_micros < 0 or p_manual_call_limit < 0
    or p_warning_threshold_percent not between 1 and 99 or p_risk_threshold_percent not between 2 and 100
    or p_warning_threshold_percent >= p_risk_threshold_percent or p_krw_per_usd <= 0
    or p_pricing_valid_days not between 1 and 365
    or (p_automation_enabled and p_active_provider_key is null)
    or (not p_automation_enabled and p_active_provider_key is not null) then
    raise exception 'invalid_settings_command' using errcode = '22023';
  end if;
  perform 1 from public.provider_settings where owner_id = auth.uid() for update;
  for provider_update in select value from jsonb_array_elements(p_provider_updates)
  loop
    provider_key_value := provider_update ->> 'providerKey';
    if provider_key_value not in ('openai', 'anthropic', 'fake-local-provider')
      or nullif(btrim(provider_update ->> 'modelKey'), '') is null
      or coalesce(provider_update ->> 'maxInputTokens', '') !~ '^[0-9]+$'
      or coalesce(provider_update ->> 'maxOutputTokens', '') !~ '^[0-9]+$'
      or coalesce(provider_update ->> 'maxRevisionOutputTokens', '') !~ '^[0-9]+$'
      or coalesce(provider_update ->> 'inputPriceMicrosPerMillion', '') !~ '^[0-9]+$'
      or coalesce(provider_update ->> 'outputPriceMicrosPerMillion', '') !~ '^[0-9]+$'
      or coalesce(provider_update ->> 'pricingVerifiedAt', '') !~ '^\d{4}-\d{2}-\d{2}$'
      or (provider_update ->> 'maxInputTokens')::integer < 1
      or (provider_update ->> 'maxOutputTokens')::integer < 1
      or (provider_update ->> 'maxRevisionOutputTokens')::integer < 1
      or (provider_update ->> 'maxRevisionOutputTokens')::integer > (provider_update ->> 'maxOutputTokens')::integer then
      raise exception 'invalid_provider_setting' using errcode = '22023';
    end if;
    update_count := update_count + 1;
    insert into public.provider_settings (
      owner_id, provider_key, enabled, configuration, model_key,
      max_input_tokens, max_output_tokens, max_revision_output_tokens,
      input_cost_micros_per_million, output_cost_micros_per_million, pricing_verified_at
    ) values (
      auth.uid(), provider_key_value, false,
      case when provider_key_value = 'fake-local-provider' then jsonb_build_object('mode', 'fixture')
        else jsonb_build_object('vaultSecretName', 'narrative_' || auth.uid()::text || '_' || provider_key_value) end,
      btrim(provider_update ->> 'modelKey'),
      (provider_update ->> 'maxInputTokens')::integer,
      (provider_update ->> 'maxOutputTokens')::integer,
      (provider_update ->> 'maxRevisionOutputTokens')::integer,
      (provider_update ->> 'inputPriceMicrosPerMillion')::bigint,
      (provider_update ->> 'outputPriceMicrosPerMillion')::bigint,
      (provider_update ->> 'pricingVerifiedAt')::date
    ) on conflict (owner_id, provider_key) do update set
      model_key = excluded.model_key,
      max_input_tokens = excluded.max_input_tokens,
      max_output_tokens = excluded.max_output_tokens,
      max_revision_output_tokens = excluded.max_revision_output_tokens,
      input_cost_micros_per_million = excluded.input_cost_micros_per_million,
      output_cost_micros_per_million = excluded.output_cost_micros_per_million,
      pricing_verified_at = excluded.pricing_verified_at,
      updated_at = now();
  end loop;
  if update_count <> (select count(distinct value ->> 'providerKey') from jsonb_array_elements(p_provider_updates)) then
    raise exception 'duplicate_provider_setting' using errcode = '22023';
  end if;

  select period.* into current_period from public.budget_periods as period
  where period.owner_id = auth.uid() and period.currency = 'USD'
    and public.narrative_business_date(now()) between period.period_start and period.period_end
  order by period.period_start desc limit 1 for update;
  if current_period.id is null then
    insert into public.budget_periods (owner_id, currency, period_start, period_end, limit_micros, daily_limit_micros)
    values (auth.uid(), 'USD', date_trunc('month', public.narrative_business_date(now()))::date,
      (date_trunc('month', public.narrative_business_date(now())) + interval '1 month - 1 day')::date,
      p_monthly_limit_micros, p_daily_limit_micros)
    returning * into current_period;
  else
    select coalesce(sum(entry.amount_micros), 0) into monthly_committed
    from public.budget_entries as entry where entry.budget_period_id = current_period.id;
    select coalesce(sum(entry.amount_micros), 0) into daily_committed
    from public.budget_entries as entry where entry.budget_period_id = current_period.id
      and entry.daily_bucket_date = public.narrative_business_date(now());
    if p_monthly_limit_micros < greatest(monthly_committed, 0)
      or p_daily_limit_micros < greatest(daily_committed, 0) then
      raise exception 'budget_limit_below_committed' using errcode = 'P0001';
    end if;
    update public.budget_periods set limit_micros = p_monthly_limit_micros,
      daily_limit_micros = p_daily_limit_micros where id = current_period.id;
  end if;

  insert into public.narrative_admin_settings (
    owner_id, automation_enabled, pricing_valid_days, manual_call_limit,
    warning_threshold_percent, risk_threshold_percent, krw_per_usd, updated_at
  ) values (
    auth.uid(), p_automation_enabled, p_pricing_valid_days, p_manual_call_limit,
    p_warning_threshold_percent, p_risk_threshold_percent, p_krw_per_usd, now()
  ) on conflict (owner_id) do update set
    automation_enabled = excluded.automation_enabled,
    pricing_valid_days = excluded.pricing_valid_days,
    manual_call_limit = excluded.manual_call_limit,
    warning_threshold_percent = excluded.warning_threshold_percent,
    risk_threshold_percent = excluded.risk_threshold_percent,
    krw_per_usd = excluded.krw_per_usd,
    updated_at = now();

  update public.provider_settings set enabled = false, updated_at = now() where owner_id = auth.uid() and enabled;
  if p_automation_enabled then
    select provider.* into updated_provider from public.provider_settings as provider
    where provider.owner_id = auth.uid() and provider.provider_key = p_active_provider_key for update;
    if updated_provider.id is null then raise exception 'active_provider_setting_required' using errcode = 'P0001'; end if;
    if updated_provider.pricing_verified_at < public.narrative_business_date(now()) - p_pricing_valid_days then
      raise exception 'stale_provider_pricing' using errcode = 'P0001';
    end if;
    update public.provider_settings set enabled = true, updated_at = now() where id = updated_provider.id;
  end if;
  insert into public.audit_events (owner_id, event_type, entity_type, payload)
  values (auth.uid(), 'narrative_settings_saved', 'narrative_settings',
    jsonb_build_object('automationEnabled', p_automation_enabled, 'activeProviderKey', p_active_provider_key,
      'monthlyLimitMicros', p_monthly_limit_micros, 'dailyLimitMicros', p_daily_limit_micros));
  return jsonb_build_object('saved', true);
end;
$$;

create function narrative_private.schedule_budget_state_at(p_owner_id uuid, p_at timestamptz)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  active_period public.budget_periods;
  admin_settings public.narrative_admin_settings;
  active_provider public.provider_settings;
  daily_used numeric;
  period_used numeric;
  usage_percent numeric;
  warning_percent integer := 80;
  risk_percent integer := 95;
  business_date date;
begin
  if p_owner_id is null or p_at is null then return 'risk'; end if;
  business_date := public.narrative_business_date(p_at);
  select admin.* into admin_settings from public.narrative_admin_settings as admin
  where admin.owner_id = p_owner_id for share;
  if admin_settings.owner_id is not null then
    warning_percent := admin_settings.warning_threshold_percent;
    risk_percent := admin_settings.risk_threshold_percent;
    if not admin_settings.automation_enabled then return 'risk'; end if;
    select provider.* into active_provider from public.provider_settings as provider
    where provider.owner_id = p_owner_id and provider.enabled for share;
    if active_provider.id is null
      or active_provider.pricing_verified_at < business_date - admin_settings.pricing_valid_days then
      return 'risk';
    end if;
  end if;
  select period.* into active_period
  from public.budget_periods as period
  where period.owner_id = p_owner_id and period.currency = 'USD'
    and business_date between period.period_start and period.period_end
  order by period.period_start desc, period.period_end asc, period.id limit 1 for share;
  if active_period.id is null then return 'risk'; end if;
  select coalesce(sum(entry.amount_micros), 0) into daily_used from public.budget_entries as entry
  where entry.budget_period_id = active_period.id and entry.daily_bucket_date = business_date;
  select coalesce(sum(entry.amount_micros), 0) into period_used from public.budget_entries as entry
  where entry.budget_period_id = active_period.id;
  usage_percent := greatest(
    case when active_period.daily_limit_micros = 0 then 100 else daily_used * 100 / active_period.daily_limit_micros::numeric end,
    case when active_period.limit_micros = 0 then 100 else period_used * 100 / active_period.limit_micros::numeric end
  );
  if usage_percent >= risk_percent then return 'risk'; end if;
  if usage_percent >= warning_percent then return 'warning'; end if;
  return 'normal';
end;
$$;

create or replace function narrative_private.schedule_budget_state(p_owner_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
begin
  return narrative_private.schedule_budget_state_at(p_owner_id, current_timestamp);
end;
$$;

create or replace function public.queue_narrative_access_job(
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
  admin_settings public.narrative_admin_settings;
  last_success timestamptz;
  daily_calls integer;
  manual_limit integer := 3;
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
  select admin.* into admin_settings from public.narrative_admin_settings as admin
  where admin.owner_id = p_owner_id for share;
  if admin_settings.owner_id is not null then manual_limit := admin_settings.manual_call_limit; end if;
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
  if coalesce(daily_calls, 0) >= manual_limit then
    raise exception 'daily_access_limit' using errcode = 'P0001';
  end if;
  budget_state := narrative_private.schedule_budget_state_at(p_owner_id, p_now);
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

create function public.queue_due_narrative_schedule_job(
  p_owner_id uuid,
  p_schedule_id uuid,
  p_scheduled_for timestamptz
)
returns public.generation_jobs
language plpgsql
security definer
set search_path = ''
as $$
declare
  locked_schedule public.schedules;
  admin_settings public.narrative_admin_settings;
  active_provider public.provider_settings;
  existing_job public.generation_jobs;
  queued_job public.generation_jobs;
  local_scheduled timestamp without time zone;
  queue_key text;
  budget_state text;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'schedule queue caller is not authorized' using errcode = '42501';
  end if;
  if p_owner_id is null or p_schedule_id is null or p_scheduled_for is null
    or date_trunc('minute', p_scheduled_for) is distinct from p_scheduled_for then
    raise exception 'invalid_schedule_job' using errcode = '22023';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('narrative-schedule:' || p_schedule_id::text, 0));
  select schedule.* into locked_schedule from public.schedules as schedule
  where schedule.id = p_schedule_id and schedule.owner_id = p_owner_id for update;
  if locked_schedule.id is null or not locked_schedule.enabled or locked_schedule.schedule_type = 'manual' then
    raise exception 'schedule_not_due' using errcode = 'P0001';
  end if;
  local_scheduled := p_scheduled_for at time zone 'Asia/Seoul';
  if locked_schedule.schedule_type = 'special' then
    if locked_schedule.special_date is distinct from local_scheduled::date
      or locked_schedule.seoul_time is distinct from local_scheduled::time(0) then
      raise exception 'schedule_not_due' using errcode = 'P0001';
    end if;
  elsif extract(minute from local_scheduled)::integer is distinct from split_part(locked_schedule.cron_expression, ' ', 1)::integer
    or extract(hour from local_scheduled)::integer is distinct from split_part(locked_schedule.cron_expression, ' ', 2)::integer
    or (split_part(locked_schedule.cron_expression, ' ', 5) <> '*'
      and extract(dow from local_scheduled)::integer is distinct from split_part(locked_schedule.cron_expression, ' ', 5)::integer) then
    raise exception 'schedule_not_due' using errcode = 'P0001';
  end if;
  queue_key := p_owner_id::text || ':' || locked_schedule.schedule_key || ':' || public.narrative_business_date(p_scheduled_for)::text;
  select job.* into existing_job from public.generation_jobs as job
  where job.owner_id = p_owner_id and job.schedule_key = queue_key and job.scheduled_for = p_scheduled_for;
  if existing_job.id is not null then return existing_job; end if;
  select admin.* into admin_settings from public.narrative_admin_settings as admin
  where admin.owner_id = p_owner_id for share;
  if admin_settings.owner_id is null or not admin_settings.automation_enabled then
    raise exception 'automation_disabled' using errcode = 'P0001';
  end if;
  select provider.* into active_provider from public.provider_settings as provider
  where provider.owner_id = p_owner_id and provider.enabled for share;
  if active_provider.id is null then raise exception 'active_provider_setting_required' using errcode = 'P0001'; end if;
  if active_provider.pricing_verified_at < public.narrative_business_date(p_scheduled_for) - admin_settings.pricing_valid_days then
    raise exception 'stale_provider_pricing' using errcode = 'P0001';
  end if;
  if locked_schedule.last_queued_at is not null
    and locked_schedule.last_queued_at + make_interval(mins => locked_schedule.minimum_interval_minutes) > p_scheduled_for then
    raise exception 'schedule_interval_not_elapsed' using errcode = 'P0001';
  end if;
  budget_state := narrative_private.schedule_budget_state_at(p_owner_id, p_scheduled_for);
  if budget_state = 'risk' then raise exception 'budget_risk' using errcode = 'P0001'; end if;
  if budget_state = 'warning' and locked_schedule.schedule_type = 'automatic'
    and split_part(locked_schedule.cron_expression, ' ', 5) <> '*' then
    raise exception 'budget_warning_long_schedule' using errcode = 'P0001';
  end if;
  queued_job := narrative_private.queue_narrative_schedule_job(
    p_owner_id, queue_key, p_scheduled_for,
    jsonb_build_object('kind', locked_schedule.payload ->> 'kind', 'source', 'schedule')
  );
  update public.schedules set last_queued_at = p_scheduled_for, updated_at = now()
  where id = locked_schedule.id;
  return queued_job;
end;
$$;

create or replace function public.reserve_and_start_generation(
  p_job_id uuid,
  p_attempt_token uuid,
  p_amount_micros bigint
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  locked_job public.generation_jobs;
  admin_settings public.narrative_admin_settings;
  active_provider public.provider_settings;
  result jsonb;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'generation reserve caller is not authorized' using errcode = '42501';
  end if;
  if p_attempt_token is null then raise exception 'invalid_attempt_token' using errcode = '22023'; end if;
  select job.* into locked_job from public.generation_jobs as job where job.id = p_job_id for update;
  if locked_job.id is null then raise exception 'generation target not found' using errcode = 'P0002'; end if;
  if locked_job.attempt_token is distinct from p_attempt_token then raise exception 'stale_attempt' using errcode = 'P0001'; end if;
  select admin.* into admin_settings from public.narrative_admin_settings as admin
  where admin.owner_id = locked_job.owner_id for share;
  select provider.* into active_provider from public.provider_settings as provider
  where provider.id = locked_job.provider_setting_id and provider.owner_id = locked_job.owner_id and provider.enabled for share;
  if admin_settings.owner_id is null or not admin_settings.automation_enabled or active_provider.id is null then
    raise exception 'active_provider_setting_required' using errcode = 'P0001';
  end if;
  if active_provider.pricing_verified_at < public.narrative_business_date(current_timestamp) - admin_settings.pricing_valid_days then
    raise exception 'stale_provider_pricing' using errcode = 'P0001';
  end if;
  result := public.generation_internal_reserve_start_v1(p_job_id, p_amount_micros);
  if result ->> 'status' = 'blocked' then
    update public.generation_jobs set attempt_token = null where id = p_job_id;
  end if;
  return result;
end;
$$;

create function public.store_narrative_secret(p_owner_id uuid, p_secret_kind text, p_secret_value text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  secret_name text;
  existing_id uuid;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'secret writer is not authorized' using errcode = '42501'; end if;
  if p_owner_id is null or p_secret_kind not in ('openai', 'anthropic', 'github')
    or nullif(btrim(p_secret_value), '') is null or length(p_secret_value) > 20000
    or not exists (select 1 from public.owner_profiles where owner_id = p_owner_id) then
    raise exception 'invalid_secret_command' using errcode = '22023';
  end if;
  secret_name := 'narrative_' || p_owner_id::text || '_' || p_secret_kind;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(secret_name, 0));
  select secret.id into existing_id from vault.secrets as secret where secret.name = secret_name;
  if existing_id is null then
    perform vault.create_secret(p_secret_value, secret_name, 'Cheonmu narrative server secret');
  else
    perform vault.update_secret(existing_id, p_secret_value);
  end if;
  insert into public.audit_events (owner_id, event_type, entity_type, payload)
  values (p_owner_id, 'narrative_secret_configured', 'server_secret',
    jsonb_build_object('secretKind', p_secret_kind, 'configured', true));
  return true;
end;
$$;

create function public.read_narrative_secret(p_owner_id uuid, p_secret_kind text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare value text;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'secret reader is not authorized' using errcode = '42501'; end if;
  if p_owner_id is null or p_secret_kind not in ('openai', 'anthropic', 'github') then raise exception 'invalid_secret_reference' using errcode = '22023'; end if;
  select secret.decrypted_secret into value from vault.decrypted_secrets as secret
  where secret.name = 'narrative_' || p_owner_id::text || '_' || p_secret_kind;
  return value;
end;
$$;

revoke all on function public.get_narrative_memory() from public, anon, authenticated, service_role;
revoke all on function public.set_narrative_memory_enabled(uuid, boolean) from public, anon, authenticated, service_role;
revoke all on function public.correct_narrative_memory(uuid, text, text) from public, anon, authenticated, service_role;
revoke all on function public.get_narrative_schedules() from public, anon, authenticated, service_role;
revoke all on function public.save_narrative_schedule(uuid, text, text, boolean, text, integer, date, integer, text) from public, anon, authenticated, service_role;
revoke all on function public.get_narrative_settings() from public, anon, authenticated, service_role;
revoke all on function public.save_narrative_settings(boolean, text, jsonb, bigint, bigint, integer, integer, integer, numeric, integer) from public, anon, authenticated, service_role;
revoke all on function narrative_private.schedule_budget_state_at(uuid, timestamptz) from public, anon, authenticated, service_role;
revoke all on function public.queue_due_narrative_schedule_job(uuid, uuid, timestamptz) from public, anon, authenticated, service_role;
revoke execute on function public.queue_narrative_schedule_job(uuid, text, timestamptz, jsonb) from service_role;
revoke all on function public.store_narrative_secret(uuid, text, text) from public, anon, authenticated, service_role;
revoke all on function public.read_narrative_secret(uuid, text) from public, anon, authenticated, service_role;

grant execute on function public.get_narrative_memory() to authenticated;
grant execute on function public.set_narrative_memory_enabled(uuid, boolean) to authenticated;
grant execute on function public.correct_narrative_memory(uuid, text, text) to authenticated;
grant execute on function public.get_narrative_schedules() to authenticated;
grant execute on function public.save_narrative_schedule(uuid, text, text, boolean, text, integer, date, integer, text) to authenticated;
grant execute on function public.get_narrative_settings() to authenticated;
grant execute on function public.save_narrative_settings(boolean, text, jsonb, bigint, bigint, integer, integer, integer, numeric, integer) to authenticated;
grant execute on function public.queue_due_narrative_schedule_job(uuid, uuid, timestamptz) to service_role;
grant execute on function public.store_narrative_secret(uuid, text, text) to service_role;
grant execute on function public.read_narrative_secret(uuid, text) to service_role;
