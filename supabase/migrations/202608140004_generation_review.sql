alter table public.generation_jobs
  add column idempotency_key text,
  add column generation_mode text,
  add column context_version_ids text[] not null default '{}'::text[],
  add constraint generation_jobs_generation_mode_check check (
    generation_mode is null or generation_mode in ('new', 'revise_selection', 'major_event_scene_plan', 'major_event_draft')
  );

create unique index generation_jobs_owner_idempotency_key_idx
  on public.generation_jobs (owner_id, idempotency_key)
  where idempotency_key is not null;

alter table public.draft_versions
  add column generation_job_id uuid,
  add column context_version_ids text[] not null default '{}'::text[],
  add column continuity_level text,
  add column continuity_findings jsonb not null default '[]'::jsonb,
  add column provider_response_id text,
  add constraint draft_versions_owner_id_id_key unique (owner_id, id),
  add constraint draft_versions_generation_job_fkey
    foreign key (owner_id, generation_job_id)
    references public.generation_jobs (owner_id, id)
    on delete restrict,
  add constraint draft_versions_continuity_level_check check (
    continuity_level is null or continuity_level in ('pass', 'review', 'block')
  ),
  add constraint draft_versions_continuity_findings_array_check check (
    jsonb_typeof(continuity_findings) = 'array'
  );

create unique index draft_versions_one_version_per_generation_job_idx
  on public.draft_versions (generation_job_id)
  where generation_job_id is not null;

alter table public.memory_items
  add column source_draft_version_id uuid,
  add column status text not null default 'active',
  add column blocking boolean not null default false,
  add constraint memory_items_memory_type_check check (
    memory_type in ('canon', 'feedback', 'continuity', 'summary')
  ),
  add constraint memory_items_status_check check (
    status in ('active', 'approved', 'inactive')
  ),
  add constraint memory_items_owner_source_version_fkey
    foreign key (owner_id, source_draft_version_id)
    references public.draft_versions (owner_id, id)
    on delete restrict;

create table public.draft_review_actions (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  draft_id uuid not null,
  draft_version_id uuid not null,
  idempotency_key text not null,
  action text not null check (action in ('reject', 'approve_private', 'approve_public')),
  expected_state text not null,
  resulting_state text not null,
  reason text,
  created_at timestamptz not null default now(),
  unique (owner_id, idempotency_key),
  foreign key (owner_id, draft_id)
    references public.drafts (owner_id, id)
    on delete restrict,
  foreign key (owner_id, draft_version_id)
    references public.draft_versions (owner_id, id)
    on delete restrict
);

create table public.publish_jobs (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  draft_id uuid not null,
  draft_version_id uuid not null unique,
  status text not null default 'queued' check (status in ('queued', 'publishing', 'published', 'failed', 'cancelled')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (owner_id, draft_id)
    references public.drafts (owner_id, id)
    on delete restrict,
  foreign key (owner_id, draft_version_id)
    references public.draft_versions (owner_id, id)
    on delete restrict
);

alter table public.draft_review_actions enable row level security;
alter table public.publish_jobs enable row level security;

create policy "owner can read draft review actions"
on public.draft_review_actions for select
using (auth.uid() = owner_id);

create policy "owner can read publish jobs"
on public.publish_jobs for select
using (auth.uid() = owner_id);

revoke all privileges on table public.draft_review_actions, public.publish_jobs
from public, anon, authenticated, service_role;

grant select on table public.draft_review_actions, public.publish_jobs to authenticated;
grant select, insert, update, delete on table public.draft_review_actions, public.publish_jobs to service_role;

create function public.freeze_generation_context(
  p_job_id uuid,
  p_draft_id uuid,
  p_generation_mode text,
  p_idempotency_key text,
  p_context_version_ids text[]
)
returns public.generation_jobs
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_role text := auth.role();
  locked_job public.generation_jobs;
  locked_draft public.drafts;
  locked_workflow public.major_event_workflows;
begin
  if p_idempotency_key is null or btrim(p_idempotency_key) = ''
    or p_generation_mode not in ('new', 'revise_selection', 'major_event_scene_plan', 'major_event_draft')
    or p_context_version_ids is null or cardinality(p_context_version_ids) = 0 then
    raise exception 'invalid_generation_context' using errcode = '22023';
  end if;

  select job.* into locked_job
  from public.generation_jobs as job
  where job.id = p_job_id
  for update;

  select draft.* into locked_draft
  from public.drafts as draft
  where draft.id = p_draft_id
  for update;

  if locked_job.id is null or locked_draft.id is null
    or locked_job.owner_id is distinct from locked_draft.owner_id
    or (caller_role = 'authenticated' and auth.uid() is distinct from locked_job.owner_id) then
    raise exception 'generation target not found' using errcode = 'P0002';
  end if;
  if caller_role is null or caller_role not in ('authenticated', 'service_role') then
    raise exception 'generation caller is not authorized' using errcode = '42501';
  end if;

  if locked_job.idempotency_key is not null then
    if locked_job.idempotency_key = p_idempotency_key
      and locked_job.draft_id = p_draft_id
      and locked_job.generation_mode = p_generation_mode
      and locked_job.context_version_ids = p_context_version_ids then
      return locked_job;
    end if;
    raise exception 'duplicate_generation' using errcode = 'P0001';
  end if;
  if locked_draft.status <> 'queued' or locked_job.status <> 'queued' then
    raise exception 'stale_transition' using errcode = 'P0001';
  end if;

  if p_generation_mode in ('major_event_scene_plan', 'major_event_draft') then
    select workflow.* into locked_workflow
    from public.major_event_workflows as workflow
    where workflow.owner_id = locked_job.owner_id and workflow.draft_id = locked_draft.id
    for update;

    if locked_workflow.id is null
      or (p_generation_mode = 'major_event_scene_plan' and locked_workflow.phase <> 'proposal_approved')
      or (p_generation_mode = 'major_event_draft' and locked_workflow.phase <> 'scene_plan_approved') then
      raise exception 'workflow_phase_not_approved' using errcode = 'P0001';
    end if;

    update public.major_event_workflows
    set phase = case p_generation_mode when 'major_event_scene_plan' then 'scene_plan' else 'draft' end,
        updated_at = now()
    where id = locked_workflow.id;
  end if;

  update public.generation_jobs
  set draft_id = locked_draft.id,
      idempotency_key = p_idempotency_key,
      generation_mode = p_generation_mode,
      context_version_ids = p_context_version_ids
  where id = locked_job.id
  returning * into locked_job;

  return locked_job;
exception
  when unique_violation then
    raise exception 'duplicate_generation' using errcode = 'P0001';
end;
$$;

create function public.store_generation_result(
  p_job_id uuid,
  p_content jsonb,
  p_continuity_level text,
  p_continuity_findings jsonb,
  p_provider_response_id text
)
returns public.draft_versions
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_role text := auth.role();
  locked_job public.generation_jobs;
  locked_draft public.drafts;
  created_version public.draft_versions;
  next_version integer;
begin
  if p_content is null or jsonb_typeof(p_content) <> 'object'
    or p_continuity_level not in ('pass', 'review', 'block')
    or p_continuity_findings is null or jsonb_typeof(p_continuity_findings) <> 'array'
    or p_provider_response_id is null or btrim(p_provider_response_id) = '' then
    raise exception 'invalid_generation_result' using errcode = '22023';
  end if;

  select job.* into locked_job
  from public.generation_jobs as job
  where job.id = p_job_id
  for update;

  select draft.* into locked_draft
  from public.drafts as draft
  where draft.id = locked_job.draft_id
  for update;

  if locked_job.id is null or locked_draft.id is null
    or (caller_role = 'authenticated' and auth.uid() is distinct from locked_job.owner_id) then
    raise exception 'generation target not found' using errcode = 'P0002';
  end if;
  if caller_role is null or caller_role not in ('authenticated', 'service_role') then
    raise exception 'generation caller is not authorized' using errcode = '42501';
  end if;
  if locked_draft.status <> 'generating' or locked_job.idempotency_key is null
    or cardinality(locked_job.context_version_ids) = 0 then
    raise exception 'stale_transition' using errcode = 'P0001';
  end if;

  select coalesce(max(version_number), 0) + 1 into next_version
  from public.draft_versions
  where draft_id = locked_draft.id;

  insert into public.draft_versions (
    owner_id, draft_id, generation_job_id, version_number, content,
    context_version_ids, continuity_level, continuity_findings, provider_response_id
  ) values (
    locked_job.owner_id, locked_draft.id, locked_job.id, next_version, p_content,
    locked_job.context_version_ids, p_continuity_level, p_continuity_findings, p_provider_response_id
  ) returning * into created_version;

  update public.drafts
  set title = coalesce(nullif(p_content ->> 'title', ''), title),
      body = coalesce(p_content ->> 'body', body),
      updated_at = now()
  where id = locked_draft.id;

  perform public.transition_draft(locked_draft.id, 'generating', 'generated');
  update public.generation_jobs set status = 'completed' where id = locked_job.id;

  return created_version;
end;
$$;

create function public.review_draft_atomic(
  p_draft_id uuid,
  p_expected_version_id uuid,
  p_expected_state text,
  p_action text,
  p_reason text,
  p_idempotency_key text
)
returns public.drafts
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_role text := auth.role();
  locked_draft public.drafts;
  locked_version public.draft_versions;
  generation_mode text;
  resulting_state text;
  reviewed_draft public.drafts;
begin
  if p_action not in ('reject', 'approve_private', 'approve_public')
    or p_expected_state <> 'reviewing'
    or p_idempotency_key is null or btrim(p_idempotency_key) = ''
    or (p_action = 'reject' and (p_reason is null or btrim(p_reason) = '')) then
    raise exception 'invalid_review_action' using errcode = '22023';
  end if;

  select draft.* into locked_draft
  from public.drafts as draft
  where draft.id = p_draft_id
  for update;

  if locked_draft.id is null
    or (caller_role = 'authenticated' and auth.uid() is distinct from locked_draft.owner_id) then
    raise exception 'review target not found' using errcode = 'P0002';
  end if;
  if caller_role is null or caller_role not in ('authenticated', 'service_role') then
    raise exception 'review caller is not authorized' using errcode = '42501';
  end if;
  if exists (
    select 1 from public.draft_review_actions
    where owner_id = locked_draft.owner_id and idempotency_key = p_idempotency_key
  ) then
    raise exception 'duplicate_review' using errcode = 'P0001';
  end if;

  select version.* into locked_version
  from public.draft_versions as version
  where version.id = p_expected_version_id
    and version.owner_id = locked_draft.owner_id
    and version.draft_id = locked_draft.id
    and version.version_number = (
      select max(latest.version_number) from public.draft_versions as latest where latest.draft_id = locked_draft.id
    )
  for update;

  if locked_version.id is null or locked_draft.status <> p_expected_state then
    raise exception 'stale_review' using errcode = 'P0001';
  end if;

  resulting_state := case p_action
    when 'reject' then 'rejected'
    when 'approve_private' then 'approved_private'
    else 'approved'
  end;

  insert into public.draft_review_actions (
    owner_id, draft_id, draft_version_id, idempotency_key, action,
    expected_state, resulting_state, reason
  ) values (
    locked_draft.owner_id, locked_draft.id, locked_version.id, p_idempotency_key,
    p_action, p_expected_state, resulting_state, nullif(btrim(p_reason), '')
  );

  if p_action = 'reject' then
    insert into public.memory_items (
      owner_id, memory_type, content, source_draft_version_id, status, blocking
    ) values (
      locked_draft.owner_id, 'feedback', btrim(p_reason), locked_version.id, 'active', true
    );
    reviewed_draft := public.transition_draft(locked_draft.id, 'reviewing', 'rejected');
  else
    insert into public.memory_items (
      owner_id, memory_type, content, source_draft_version_id, status, blocking
    ) values (
      locked_draft.owner_id,
      'continuity',
      coalesce(nullif(locked_version.content ->> 'body', ''), locked_version.content::text),
      locked_version.id,
      'approved',
      false
    );

    reviewed_draft := public.transition_draft(locked_draft.id, 'reviewing', 'approved_private');
    if p_action = 'approve_public' then
      reviewed_draft := public.transition_draft(locked_draft.id, 'approved_private', 'approved');
      insert into public.publish_jobs (owner_id, draft_id, draft_version_id, status)
      values (locked_draft.owner_id, locked_draft.id, locked_version.id, 'queued');
    end if;

    select job.generation_mode into generation_mode
    from public.generation_jobs as job
    where job.id = locked_version.generation_job_id;

    update public.major_event_workflows
    set phase = case
          when generation_mode = 'major_event_scene_plan' then 'scene_plan_approved'
          when generation_mode = 'major_event_draft' then 'final_approved'
          else 'proposal_approved'
        end,
        updated_at = now()
    where owner_id = locked_draft.owner_id
      and draft_id = locked_draft.id
      and (
        generation_mode in ('major_event_scene_plan', 'major_event_draft')
        or locked_draft.kind = 'major_event_proposal'
      );
  end if;

  return reviewed_draft;
exception
  when unique_violation then
    raise exception 'duplicate_review' using errcode = 'P0001';
end;
$$;

revoke all on function public.freeze_generation_context(uuid, uuid, text, text, text[])
  from public, anon, authenticated, service_role;
revoke all on function public.store_generation_result(uuid, jsonb, text, jsonb, text)
  from public, anon, authenticated, service_role;
revoke all on function public.review_draft_atomic(uuid, uuid, text, text, text, text)
  from public, anon, authenticated, service_role;

grant execute on function public.freeze_generation_context(uuid, uuid, text, text, text[])
  to authenticated, service_role;
grant execute on function public.store_generation_result(uuid, jsonb, text, jsonb, text)
  to authenticated, service_role;
grant execute on function public.review_draft_atomic(uuid, uuid, text, text, text, text)
  to authenticated, service_role;
