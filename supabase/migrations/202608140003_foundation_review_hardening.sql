create extension if not exists btree_gist with schema extensions;

create function public.narrative_business_date(p_timestamp timestamptz)
returns date
language sql
immutable
strict
set search_path = ''
as $$
  select (p_timestamp at time zone 'Asia/Seoul')::date;
$$;

revoke all on function public.narrative_business_date(timestamptz)
  from public, anon, authenticated, service_role;

update public.budget_entries as entry
set daily_bucket_date = public.narrative_business_date(entry.created_at)
where entry.entry_type = 'reservation';

update public.budget_entries as settlement
set daily_bucket_date = coalesce(
  (
    select reservation.daily_bucket_date
    from public.budget_entries as reservation
    where reservation.generation_job_id = settlement.generation_job_id
      and reservation.entry_type = 'reservation'
  ),
  public.narrative_business_date(settlement.created_at)
)
where settlement.entry_type in ('reconciliation', 'failure');

alter table public.budget_periods
  add constraint budget_periods_no_overlap
  exclude using gist (
    owner_id with =,
    currency with =,
    daterange(period_start, period_end, '[]') with &&
  );

alter table public.budget_entries
  add constraint budget_entries_amount_sign_check check (
    (entry_type = 'reservation' and amount_micros >= 0)
    or (entry_type in ('reconciliation', 'failure') and amount_micros <= 0)
  );

alter table public.drafts
  add constraint drafts_owner_id_id_key unique (owner_id, id);

alter table public.budget_periods
  add constraint budget_periods_owner_id_id_key unique (owner_id, id);

alter table public.generation_jobs
  add constraint generation_jobs_owner_id_id_key unique (owner_id, id);

alter table public.draft_versions
  add constraint draft_versions_owner_draft_fkey
  foreign key (owner_id, draft_id)
  references public.drafts (owner_id, id)
  on delete cascade;

alter table public.major_event_workflows
  add constraint major_event_workflows_owner_draft_fkey
  foreign key (owner_id, draft_id)
  references public.drafts (owner_id, id)
  on delete set null (draft_id);

alter table public.generation_jobs
  add constraint generation_jobs_owner_draft_fkey
  foreign key (owner_id, draft_id)
  references public.drafts (owner_id, id)
  on delete set null (draft_id);

alter table public.budget_entries
  add constraint budget_entries_owner_period_fkey
  foreign key (owner_id, budget_period_id)
  references public.budget_periods (owner_id, id)
  on delete cascade,
  add constraint budget_entries_owner_job_fkey
  foreign key (owner_id, generation_job_id)
  references public.generation_jobs (owner_id, id)
  on delete set null (generation_job_id);

create function public.require_queued_draft_insert()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.status <> 'queued' then
    raise exception 'new drafts must begin queued' using errcode = 'P0001';
  end if;

  return new;
end;
$$;

create trigger drafts_begin_queued
before insert on public.drafts
for each row execute function public.require_queued_draft_insert();

create or replace function public.reject_direct_draft_status_change()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.status is distinct from new.status
    and current_user in ('authenticated', 'service_role') then
    raise exception 'illegal draft status change' using errcode = 'P0001';
  end if;

  return new;
end;
$$;

drop policy if exists "owner can manage owner profiles" on public.owner_profiles;
drop policy if exists "owner can manage drafts" on public.drafts;
drop policy if exists "owner can read draft versions" on public.draft_versions;
drop policy if exists "owner can create draft versions" on public.draft_versions;
drop policy if exists "owner can manage major event workflows" on public.major_event_workflows;
drop policy if exists "owner can manage memory items" on public.memory_items;
drop policy if exists "owner can manage generation jobs" on public.generation_jobs;
drop policy if exists "owner can manage schedules" on public.schedules;
drop policy if exists "owner can manage provider settings" on public.provider_settings;
drop policy if exists "owner can manage budget periods" on public.budget_periods;
drop policy if exists "owner can manage budget entries" on public.budget_entries;
drop policy if exists "owner can manage audit events" on public.audit_events;

create policy "owner can read owner profiles"
on public.owner_profiles for select
using (auth.uid() = owner_id);

create policy "owner can read drafts"
on public.drafts for select
using (auth.uid() = owner_id);

create policy "owner can read draft versions"
on public.draft_versions for select
using (auth.uid() = owner_id);

create policy "owner can read major event workflows"
on public.major_event_workflows for select
using (auth.uid() = owner_id);

create policy "owner can read memory items"
on public.memory_items for select
using (auth.uid() = owner_id);

create policy "owner can read generation jobs"
on public.generation_jobs for select
using (auth.uid() = owner_id);

create policy "owner can read schedules"
on public.schedules for select
using (auth.uid() = owner_id);

create policy "owner can read provider settings"
on public.provider_settings for select
using (auth.uid() = owner_id);

create policy "owner can read budget periods"
on public.budget_periods for select
using (auth.uid() = owner_id);

create policy "owner can read budget entries"
on public.budget_entries for select
using (auth.uid() = owner_id);

create policy "owner can read audit events"
on public.audit_events for select
using (auth.uid() = owner_id);

revoke all privileges on table
  public.owner_profiles,
  public.drafts,
  public.draft_versions,
  public.major_event_workflows,
  public.memory_items,
  public.generation_jobs,
  public.schedules,
  public.provider_settings,
  public.budget_periods,
  public.budget_entries,
  public.audit_events
from public, anon, authenticated, service_role;

grant select on table
  public.owner_profiles,
  public.drafts,
  public.draft_versions,
  public.major_event_workflows,
  public.memory_items,
  public.generation_jobs,
  public.schedules,
  public.provider_settings,
  public.budget_periods,
  public.budget_entries,
  public.audit_events
to authenticated;

grant select, insert, update, delete on table
  public.owner_profiles,
  public.drafts,
  public.draft_versions,
  public.major_event_workflows,
  public.memory_items,
  public.generation_jobs,
  public.schedules,
  public.provider_settings,
  public.budget_periods,
  public.budget_entries,
  public.audit_events
to service_role;

create or replace function public.transition_draft(
  p_draft_id uuid,
  p_expected text,
  p_next text
)
returns public.drafts
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_role text := auth.role();
  locked_draft public.drafts;
  transitioned_draft public.drafts;
  transition_is_legal boolean := false;
begin
  transition_is_legal := case p_expected
    when 'queued' then p_next in ('generating', 'archived')
    when 'generating' then p_next in ('generated', 'queued', 'archived')
    when 'generated' then p_next in ('reviewing', 'rejected', 'archived')
    when 'reviewing' then p_next in ('approved_private', 'rejected', 'archived')
    when 'rejected' then p_next in ('queued', 'archived')
    when 'archived' then p_next = 'queued'
    when 'approved_private' then p_next in ('approved', 'rejected', 'archived')
    when 'approved' then p_next in ('publishing', 'archived')
    when 'publishing' then p_next in ('published', 'publish_failed')
    when 'published' then p_next = 'archived'
    when 'publish_failed' then p_next in ('publishing', 'archived')
    else false
  end;

  if transition_is_legal is not true then
    raise exception 'illegal draft transition' using errcode = 'P0001';
  end if;

  select draft.*
  into locked_draft
  from public.drafts as draft
  where draft.id = p_draft_id
  for update;

  if not found
    or locked_draft.status <> p_expected
    or (caller_role = 'authenticated' and auth.uid() is distinct from locked_draft.owner_id) then
    raise exception 'draft not found or transition expectation did not match' using errcode = 'P0002';
  end if;

  if caller_role is null or caller_role not in ('authenticated', 'service_role') then
    raise exception 'draft transition caller is not authorized' using errcode = '42501';
  end if;

  update public.drafts
  set status = p_next,
      updated_at = now()
  where id = locked_draft.id
  returning * into transitioned_draft;

  return transitioned_draft;
end;
$$;

create or replace function public.reserve_generation_budget(job_id uuid, amount_micros bigint)
returns public.budget_entries
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_role text := auth.role();
  job_owner_id uuid;
  active_period public.budget_periods;
  existing_reservation public.budget_entries;
  created_entry public.budget_entries;
  daily_total_micros numeric;
  period_total_micros numeric;
  seoul_today date;
begin
  if amount_micros is null or amount_micros < 0 then
    raise exception 'amount_micros must be non-negative' using errcode = '22023';
  end if;

  seoul_today := public.narrative_business_date(current_timestamp);

  select job.owner_id
  into job_owner_id
  from public.generation_jobs as job
  where job.id = reserve_generation_budget.job_id
  for update;

  if not found
    or (caller_role = 'authenticated' and auth.uid() is distinct from job_owner_id) then
    raise exception 'generation job not found' using errcode = 'P0002';
  end if;

  if caller_role is null or caller_role not in ('authenticated', 'service_role') then
    raise exception 'generation budget caller is not authorized' using errcode = '42501';
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
    and seoul_today between period.period_start and period.period_end
  order by period.period_start desc, period.period_end asc, period.id
  limit 1
  for update;

  if not found then
    raise exception 'active budget period not found' using errcode = 'P0002';
  end if;

  select coalesce(sum(entry.amount_micros), 0)
  into daily_total_micros
  from public.budget_entries as entry
  where entry.budget_period_id = active_period.id
    and entry.daily_bucket_date = seoul_today;

  select coalesce(sum(entry.amount_micros), 0)
  into period_total_micros
  from public.budget_entries as entry
  where entry.budget_period_id = active_period.id;

  if amount_micros::numeric > active_period.daily_limit_micros::numeric - daily_total_micros
    or amount_micros::numeric > active_period.limit_micros::numeric - period_total_micros then
    raise exception 'budget_limit_exceeded' using errcode = 'P0001';
  end if;

  insert into public.budget_entries (
    owner_id,
    budget_period_id,
    generation_job_id,
    amount_micros,
    entry_type,
    daily_bucket_date,
    description
  )
  values (
    job_owner_id,
    active_period.id,
    reserve_generation_budget.job_id,
    amount_micros,
    'reservation',
    seoul_today,
    'generation budget reservation'
  )
  returning * into created_entry;

  return created_entry;
end;
$$;

create or replace function public.reconcile_generation_budget(
  job_id uuid,
  actual_micros bigint,
  usage_json jsonb
)
returns public.budget_entries
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_role text := auth.role();
  job_owner_id uuid;
  reservation_entry public.budget_entries;
  existing_settlement public.budget_entries;
  created_entry public.budget_entries;
begin
  if actual_micros is null or actual_micros < 0 then
    raise exception 'actual_micros must be non-negative' using errcode = '22023';
  end if;

  select job.owner_id
  into job_owner_id
  from public.generation_jobs as job
  where job.id = reconcile_generation_budget.job_id
  for update;

  if not found
    or (caller_role = 'authenticated' and auth.uid() is distinct from job_owner_id) then
    raise exception 'generation job not found' using errcode = 'P0002';
  end if;

  if caller_role is null or caller_role not in ('authenticated', 'service_role') then
    raise exception 'generation budget caller is not authorized' using errcode = '42501';
  end if;

  select entry.*
  into reservation_entry
  from public.budget_entries as entry
  where entry.generation_job_id = reconcile_generation_budget.job_id
    and entry.entry_type = 'reservation';

  if not found then
    raise exception 'budget reservation not found' using errcode = 'P0002';
  end if;

  if actual_micros > reservation_entry.amount_micros then
    raise exception 'actual_micros_exceeds_reservation' using errcode = 'P0001';
  end if;

  select entry.*
  into existing_settlement
  from public.budget_entries as entry
  where entry.generation_job_id = reconcile_generation_budget.job_id
    and entry.entry_type in ('reconciliation', 'failure');

  if found then
    return existing_settlement;
  end if;

  insert into public.budget_entries (
    owner_id,
    budget_period_id,
    generation_job_id,
    amount_micros,
    entry_type,
    daily_bucket_date,
    description,
    usage_json
  )
  values (
    job_owner_id,
    reservation_entry.budget_period_id,
    reconcile_generation_budget.job_id,
    actual_micros - reservation_entry.amount_micros,
    'reconciliation',
    reservation_entry.daily_bucket_date,
    'generation budget reconciliation',
    coalesce(usage_json, '{}'::jsonb)
  )
  returning * into created_entry;

  return created_entry;
end;
$$;

create or replace function public.fail_generation_budget(job_id uuid, charged_micros bigint)
returns public.budget_entries
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_role text := auth.role();
  job_owner_id uuid;
  reservation_entry public.budget_entries;
  existing_settlement public.budget_entries;
  created_entry public.budget_entries;
begin
  if charged_micros is null or charged_micros < 0 then
    raise exception 'charged_micros must be non-negative' using errcode = '22023';
  end if;

  select job.owner_id
  into job_owner_id
  from public.generation_jobs as job
  where job.id = fail_generation_budget.job_id
  for update;

  if not found
    or (caller_role = 'authenticated' and auth.uid() is distinct from job_owner_id) then
    raise exception 'generation job not found' using errcode = 'P0002';
  end if;

  if caller_role is null or caller_role not in ('authenticated', 'service_role') then
    raise exception 'generation budget caller is not authorized' using errcode = '42501';
  end if;

  select entry.*
  into reservation_entry
  from public.budget_entries as entry
  where entry.generation_job_id = fail_generation_budget.job_id
    and entry.entry_type = 'reservation';

  if not found then
    raise exception 'budget reservation not found' using errcode = 'P0002';
  end if;

  if charged_micros > reservation_entry.amount_micros then
    raise exception 'charged_micros_exceeds_reservation' using errcode = 'P0001';
  end if;

  select entry.*
  into existing_settlement
  from public.budget_entries as entry
  where entry.generation_job_id = fail_generation_budget.job_id
    and entry.entry_type in ('reconciliation', 'failure');

  if found then
    return existing_settlement;
  end if;

  insert into public.budget_entries (
    owner_id,
    budget_period_id,
    generation_job_id,
    amount_micros,
    entry_type,
    daily_bucket_date,
    description
  )
  values (
    job_owner_id,
    reservation_entry.budget_period_id,
    fail_generation_budget.job_id,
    charged_micros - reservation_entry.amount_micros,
    'failure',
    reservation_entry.daily_bucket_date,
    'generation budget failure settlement'
  )
  returning * into created_entry;

  return created_entry;
end;
$$;

revoke all on function public.transition_draft(uuid, text, text)
  from public, anon, authenticated, service_role;
revoke all on function public.reserve_generation_budget(uuid, bigint)
  from public, anon, authenticated, service_role;
revoke all on function public.reconcile_generation_budget(uuid, bigint, jsonb)
  from public, anon, authenticated, service_role;
revoke all on function public.fail_generation_budget(uuid, bigint)
  from public, anon, authenticated, service_role;

grant execute on function public.transition_draft(uuid, text, text)
  to authenticated, service_role;
grant execute on function public.reserve_generation_budget(uuid, bigint)
  to authenticated, service_role;
grant execute on function public.reconcile_generation_budget(uuid, bigint, jsonb)
  to authenticated, service_role;
grant execute on function public.fail_generation_budget(uuid, bigint)
  to authenticated, service_role;

comment on trigger draft_versions_are_immutable on public.draft_versions is
  'Draft versions are immutable, so cascading hard delete remains intentionally blocked. A later admin task must add a tightly controlled service-role purge RPC before exposing confirmed hard delete; archive is the foundation default.';
