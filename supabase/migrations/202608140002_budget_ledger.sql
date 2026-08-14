alter table public.budget_periods
  add column daily_limit_micros bigint;

update public.budget_periods
set daily_limit_micros = limit_micros
where daily_limit_micros is null;

alter table public.budget_periods
  alter column daily_limit_micros set not null,
  add constraint budget_periods_daily_limit_micros_check check (daily_limit_micros >= 0);

alter table public.budget_entries
  add column entry_type text not null default 'reservation',
  add column usage_json jsonb not null default '{}'::jsonb,
  drop constraint budget_entries_amount_micros_check,
  add constraint budget_entries_entry_type_check check (entry_type in ('reservation', 'reconciliation', 'failure'));

create index budget_entries_period_created_at_idx
  on public.budget_entries (budget_period_id, created_at);

create unique index budget_entries_one_reservation_per_job_idx
  on public.budget_entries (generation_job_id)
  where entry_type = 'reservation';

create unique index budget_entries_one_settlement_per_job_idx
  on public.budget_entries (generation_job_id)
  where entry_type in ('reconciliation', 'failure');

create function public.reserve_generation_budget(job_id uuid, amount_micros bigint)
returns public.budget_entries
language plpgsql
security definer
set search_path = ''
as $$
declare
  job_owner_id uuid;
  active_period public.budget_periods;
  existing_reservation public.budget_entries;
  created_entry public.budget_entries;
  daily_total_micros bigint;
  period_total_micros bigint;
begin
  if amount_micros < 0 then
    raise exception 'amount_micros must be non-negative' using errcode = '22023';
  end if;

  select job.owner_id
  into job_owner_id
  from public.generation_jobs as job
  where job.id = reserve_generation_budget.job_id
    and job.owner_id = auth.uid()
  for update;

  if not found then
    raise exception 'generation job not found' using errcode = 'P0002';
  end if;

  select entry.*
  into existing_reservation
  from public.budget_entries as entry
  where entry.generation_job_id = reserve_generation_budget.job_id
    and entry.entry_type = 'reservation';

  if found then
    return existing_reservation;
  end if;

  select period.*
  into active_period
  from public.budget_periods as period
  where period.owner_id = job_owner_id
    and period.currency = 'USD'
    and current_date between period.period_start and period.period_end
  order by period.period_start desc, period.created_at desc
  limit 1
  for update;

  if not found then
    raise exception 'active budget period not found' using errcode = 'P0002';
  end if;

  select coalesce(sum(entry.amount_micros), 0)
  into daily_total_micros
  from public.budget_entries as entry
  where entry.budget_period_id = active_period.id
    and entry.created_at >= current_date
    and entry.created_at < current_date + interval '1 day';

  select coalesce(sum(entry.amount_micros), 0)
  into period_total_micros
  from public.budget_entries as entry
  where entry.budget_period_id = active_period.id;

  if daily_total_micros + amount_micros > active_period.daily_limit_micros
    or period_total_micros + amount_micros > active_period.limit_micros then
    raise exception 'budget_limit_exceeded' using errcode = 'P0001';
  end if;

  insert into public.budget_entries (
    owner_id,
    budget_period_id,
    generation_job_id,
    amount_micros,
    entry_type,
    description
  )
  values (
    job_owner_id,
    active_period.id,
    reserve_generation_budget.job_id,
    amount_micros,
    'reservation',
    'generation budget reservation'
  )
  returning * into created_entry;

  return created_entry;
end;
$$;

create function public.reconcile_generation_budget(job_id uuid, actual_micros bigint, usage_json jsonb)
returns public.budget_entries
language plpgsql
security definer
set search_path = ''
as $$
declare
  job_owner_id uuid;
  reservation_entry public.budget_entries;
  existing_settlement public.budget_entries;
  created_entry public.budget_entries;
begin
  if actual_micros < 0 then
    raise exception 'actual_micros must be non-negative' using errcode = '22023';
  end if;

  select job.owner_id
  into job_owner_id
  from public.generation_jobs as job
  where job.id = reconcile_generation_budget.job_id
    and job.owner_id = auth.uid()
  for update;

  if not found then
    raise exception 'generation job not found' using errcode = 'P0002';
  end if;

  select entry.*
  into existing_settlement
  from public.budget_entries as entry
  where entry.generation_job_id = reconcile_generation_budget.job_id
    and entry.entry_type in ('reconciliation', 'failure');

  if found then
    return existing_settlement;
  end if;

  select entry.*
  into reservation_entry
  from public.budget_entries as entry
  where entry.generation_job_id = reconcile_generation_budget.job_id
    and entry.entry_type = 'reservation';

  if not found then
    raise exception 'budget reservation not found' using errcode = 'P0002';
  end if;

  insert into public.budget_entries (
    owner_id,
    budget_period_id,
    generation_job_id,
    amount_micros,
    entry_type,
    description,
    usage_json
  )
  values (
    job_owner_id,
    reservation_entry.budget_period_id,
    reconcile_generation_budget.job_id,
    actual_micros - reservation_entry.amount_micros,
    'reconciliation',
    'generation budget reconciliation',
    coalesce(usage_json, '{}'::jsonb)
  )
  returning * into created_entry;

  return created_entry;
end;
$$;

create function public.fail_generation_budget(job_id uuid, charged_micros bigint)
returns public.budget_entries
language plpgsql
security definer
set search_path = ''
as $$
declare
  job_owner_id uuid;
  reservation_entry public.budget_entries;
  existing_settlement public.budget_entries;
  created_entry public.budget_entries;
begin
  if charged_micros < 0 then
    raise exception 'charged_micros must be non-negative' using errcode = '22023';
  end if;

  select job.owner_id
  into job_owner_id
  from public.generation_jobs as job
  where job.id = fail_generation_budget.job_id
    and job.owner_id = auth.uid()
  for update;

  if not found then
    raise exception 'generation job not found' using errcode = 'P0002';
  end if;

  select entry.*
  into existing_settlement
  from public.budget_entries as entry
  where entry.generation_job_id = fail_generation_budget.job_id
    and entry.entry_type in ('reconciliation', 'failure');

  if found then
    return existing_settlement;
  end if;

  select entry.*
  into reservation_entry
  from public.budget_entries as entry
  where entry.generation_job_id = fail_generation_budget.job_id
    and entry.entry_type = 'reservation';

  if not found then
    raise exception 'budget reservation not found' using errcode = 'P0002';
  end if;

  insert into public.budget_entries (
    owner_id,
    budget_period_id,
    generation_job_id,
    amount_micros,
    entry_type,
    description
  )
  values (
    job_owner_id,
    reservation_entry.budget_period_id,
    fail_generation_budget.job_id,
    charged_micros - reservation_entry.amount_micros,
    'failure',
    'generation budget failure settlement'
  )
  returning * into created_entry;

  return created_entry;
end;
$$;

revoke all on function public.reserve_generation_budget(uuid, bigint) from public;
revoke all on function public.reconcile_generation_budget(uuid, bigint, jsonb) from public;
revoke all on function public.fail_generation_budget(uuid, bigint) from public;

grant execute on function public.reserve_generation_budget(uuid, bigint) to authenticated;
grant execute on function public.reconcile_generation_budget(uuid, bigint, jsonb) to authenticated;
grant execute on function public.fail_generation_budget(uuid, bigint) to authenticated;
grant select on public.budget_entries to authenticated;
