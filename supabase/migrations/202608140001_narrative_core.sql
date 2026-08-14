create table public.owner_profiles (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null unique references auth.users(id) on delete cascade,
  display_name text not null default 'Owner',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.drafts (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  kind text not null check (kind in ('short_dialogue', 'daily_event', 'major_event_proposal')),
  status text not null default 'queued' check (status in (
    'queued', 'generating', 'generated', 'reviewing', 'rejected', 'archived',
    'approved_private', 'approved', 'publishing', 'published', 'publish_failed'
  )),
  title text not null,
  body text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.draft_versions (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  draft_id uuid not null references public.drafts(id) on delete cascade,
  version_number integer not null check (version_number > 0),
  content jsonb not null,
  created_at timestamptz not null default now(),
  unique (draft_id, version_number)
);

create table public.major_event_workflows (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  draft_id uuid unique references public.drafts(id) on delete set null,
  phase text not null default 'proposal' check (phase in (
    'proposal', 'proposal_approved', 'scene_plan', 'scene_plan_approved', 'draft', 'final_approved'
  )),
  context jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.memory_items (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  memory_type text not null,
  content text not null,
  importance integer not null default 0 check (importance between 0 and 100),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.generation_jobs (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  draft_id uuid references public.drafts(id) on delete set null,
  schedule_key text not null,
  scheduled_for timestamptz not null,
  status text not null default 'queued' check (status in ('queued', 'running', 'completed', 'failed', 'cancelled')),
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (schedule_key, scheduled_for)
);

create table public.schedules (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  schedule_key text not null,
  cron_expression text not null,
  enabled boolean not null default false,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (owner_id, schedule_key)
);

create table public.provider_settings (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  provider_key text not null,
  enabled boolean not null default false,
  configuration jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (owner_id, provider_key)
);

create table public.budget_periods (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  currency text not null check (currency = 'USD'),
  period_start date not null,
  period_end date not null,
  limit_micros bigint not null check (limit_micros >= 0),
  created_at timestamptz not null default now(),
  check (period_end >= period_start),
  unique (owner_id, currency, period_start, period_end)
);

create table public.budget_entries (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  budget_period_id uuid not null references public.budget_periods(id) on delete cascade,
  generation_job_id uuid references public.generation_jobs(id) on delete set null,
  amount_micros bigint not null check (amount_micros >= 0),
  description text not null,
  created_at timestamptz not null default now()
);

create table public.audit_events (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  event_type text not null,
  entity_type text not null,
  entity_id uuid,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create function public.reject_draft_version_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'draft versions are immutable' using errcode = '55000';
end;
$$;
create trigger draft_versions_are_immutable
before update or delete on public.draft_versions
for each row execute function public.reject_draft_version_mutation();

alter table public.owner_profiles enable row level security;
alter table public.drafts enable row level security;
alter table public.draft_versions enable row level security;
alter table public.major_event_workflows enable row level security;
alter table public.memory_items enable row level security;
alter table public.generation_jobs enable row level security;
alter table public.schedules enable row level security;
alter table public.provider_settings enable row level security;
alter table public.budget_periods enable row level security;
alter table public.budget_entries enable row level security;
alter table public.audit_events enable row level security;

create policy "owner can manage owner profiles" on public.owner_profiles for all using (auth.uid() = owner_id) with check (auth.uid() = owner_id);
create policy "owner can manage drafts" on public.drafts for all using (auth.uid() = owner_id) with check (auth.uid() = owner_id);
create policy "owner can read draft versions" on public.draft_versions for select using (auth.uid() = owner_id);
create policy "owner can create draft versions" on public.draft_versions for insert with check (auth.uid() = owner_id);
create policy "owner can manage major event workflows" on public.major_event_workflows for all using (auth.uid() = owner_id) with check (auth.uid() = owner_id);
create policy "owner can manage memory items" on public.memory_items for all using (auth.uid() = owner_id) with check (auth.uid() = owner_id);
create policy "owner can manage generation jobs" on public.generation_jobs for all using (auth.uid() = owner_id) with check (auth.uid() = owner_id);
create policy "owner can manage schedules" on public.schedules for all using (auth.uid() = owner_id) with check (auth.uid() = owner_id);
create policy "owner can manage provider settings" on public.provider_settings for all using (auth.uid() = owner_id) with check (auth.uid() = owner_id);
create policy "owner can manage budget periods" on public.budget_periods for all using (auth.uid() = owner_id) with check (auth.uid() = owner_id);
create policy "owner can manage budget entries" on public.budget_entries for all using (auth.uid() = owner_id) with check (auth.uid() = owner_id);
create policy "owner can manage audit events" on public.audit_events for all using (auth.uid() = owner_id) with check (auth.uid() = owner_id);

create function public.transition_draft(p_draft_id uuid, p_expected text, p_next text)
returns public.drafts
language plpgsql
as $$
declare
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

  update public.drafts
  set status = p_next,
      updated_at = now()
  where id = p_draft_id
    and status = p_expected
  returning * into transitioned_draft;

  if not found then
    raise exception 'draft not found or transition expectation did not match' using errcode = 'P0002';
  end if;

  return transitioned_draft;
end;
$$;
