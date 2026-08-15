-- Server-only GitHub publication queue with immutable approval/version binding.

alter table public.narrative_admin_settings
  add column github_repository_owner text,
  add column github_repository_name text,
  add column github_branch text,
  add constraint narrative_admin_settings_github_owner_check check (
    github_repository_owner is null
    or (length(github_repository_owner) between 1 and 100 and github_repository_owner ~ '^[A-Za-z0-9_.-]+$')
  ),
  add constraint narrative_admin_settings_github_repository_check check (
    github_repository_name is null
    or (length(github_repository_name) between 1 and 100 and github_repository_name ~ '^[A-Za-z0-9_.-]+$')
  ),
  add constraint narrative_admin_settings_github_branch_check check (
    github_branch is null
    or (
      length(github_branch) between 1 and 200
      and github_branch ~ '^[A-Za-z0-9][A-Za-z0-9._/-]*$'
      and github_branch !~ '(\.\.|//|/$)'
    )
  );

alter table public.draft_review_actions
  add constraint draft_review_actions_publication_binding_key
  unique (owner_id, id, draft_id, draft_version_id);

alter table public.publish_jobs
  add column approval_action_id uuid,
  add column publication_details jsonb not null default '{}'::jsonb,
  add column idempotency_key text,
  add column attempt_token uuid,
  add column attempt_count integer not null default 0,
  add column repository_owner text,
  add column repository_name text,
  add column repository_branch text,
  add column commit_sha text,
  add column published_path text,
  add column failure_code text,
  add column claimed_at timestamptz,
  add column commit_created_at timestamptz,
  add constraint publish_jobs_publication_details_object_check check (jsonb_typeof(publication_details) = 'object'),
  add constraint publish_jobs_idempotency_key_check check (
    idempotency_key is null or (length(btrim(idempotency_key)) between 1 and 200 and idempotency_key = btrim(idempotency_key))
  ),
  add constraint publish_jobs_attempt_count_check check (attempt_count >= 0),
  add constraint publish_jobs_repository_owner_check check (
    repository_owner is null or (length(repository_owner) between 1 and 100 and repository_owner ~ '^[A-Za-z0-9_.-]+$')
  ),
  add constraint publish_jobs_repository_name_check check (
    repository_name is null or (length(repository_name) between 1 and 100 and repository_name ~ '^[A-Za-z0-9_.-]+$')
  ),
  add constraint publish_jobs_repository_branch_check check (
    repository_branch is null or (
      length(repository_branch) between 1 and 200
      and repository_branch ~ '^[A-Za-z0-9][A-Za-z0-9._/-]*$'
      and repository_branch !~ '(\.\.|//|/$)'
    )
  ),
  add constraint publish_jobs_commit_sha_check check (commit_sha is null or commit_sha ~ '^[0-9a-fA-F]{40}$'),
  add constraint publish_jobs_published_path_check check (
    published_path is null or published_path ~ '^src/content/records/[0-9]{2,3}-[a-z0-9-]+\.md$'
  ),
  add constraint publish_jobs_failure_code_check check (
    failure_code is null or failure_code in (
      'record_validation_failed', 'github_path_conflict', 'github_conflict', 'github_validation_failed',
      'github_credentials_rejected', 'github_timeout', 'github_network_failure', 'github_response_invalid',
      'publication_completion_failed'
    )
  );

with bindings as (
  select distinct on (job.id)
    job.id as publish_job_id,
    action.id as approval_action_id,
    case when jsonb_typeof(version.content -> 'publication') = 'object'
      then version.content -> 'publication' else '{}'::jsonb end as publication_details
  from public.publish_jobs as job
  join public.draft_review_actions as action
    on action.owner_id = job.owner_id
    and action.draft_id = job.draft_id
    and action.draft_version_id = job.draft_version_id
    and action.action = 'approve_public'
    and action.resulting_state = 'approved'
  join public.draft_versions as version
    on version.owner_id = job.owner_id and version.draft_id = job.draft_id and version.id = job.draft_version_id
  order by job.id, action.created_at desc, action.id desc
)
update public.publish_jobs as job
set approval_action_id = binding.approval_action_id,
    publication_details = binding.publication_details
from bindings as binding
where job.id = binding.publish_job_id;

do $migration$
begin
  if exists (select 1 from public.publish_jobs where approval_action_id is null) then
    raise exception 'existing publish job lacks an exact public approval binding';
  end if;
end;
$migration$;

alter table public.publish_jobs
  alter column approval_action_id set not null,
  add constraint publish_jobs_approval_binding_fkey
    foreign key (owner_id, approval_action_id, draft_id, draft_version_id)
    references public.draft_review_actions (owner_id, id, draft_id, draft_version_id)
    on delete restrict;

create unique index publish_jobs_owner_idempotency_key_idx
  on public.publish_jobs (owner_id, idempotency_key)
  where idempotency_key is not null;

create function narrative_private.bind_narrative_publish_job()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  public_action public.draft_review_actions;
  approved_content jsonb;
begin
  select action.* into public_action
  from public.draft_review_actions as action
  where action.owner_id = new.owner_id
    and action.draft_id = new.draft_id
    and action.draft_version_id = new.draft_version_id
    and action.action = 'approve_public'
    and action.resulting_state = 'approved'
  order by action.created_at desc, action.id desc
  limit 1;
  if public_action.id is null then
    raise exception 'publish_job_public_approval_required' using errcode = 'P0001';
  end if;
  if new.approval_action_id is null then new.approval_action_id := public_action.id; end if;
  if new.approval_action_id is distinct from public_action.id then
    raise exception 'publish_job_public_approval_mismatch' using errcode = 'P0001';
  end if;
  select version.content into approved_content
  from public.draft_versions as version
  where version.owner_id = new.owner_id and version.draft_id = new.draft_id and version.id = new.draft_version_id;
  if approved_content is null then raise exception 'publish_job_version_required' using errcode = 'P0002'; end if;
  if new.publication_details = '{}'::jsonb and jsonb_typeof(approved_content -> 'publication') = 'object' then
    new.publication_details := approved_content -> 'publication';
  end if;
  return new;
end;
$$;

revoke all on function narrative_private.bind_narrative_publish_job()
from public, anon, authenticated, service_role;

create trigger publish_jobs_bind_public_approval
before insert on public.publish_jobs
for each row execute function narrative_private.bind_narrative_publish_job();

create function narrative_private.protect_claimed_narrative_publish_job()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.status <> 'queued' and (
    new.owner_id is distinct from old.owner_id
    or new.draft_id is distinct from old.draft_id
    or new.draft_version_id is distinct from old.draft_version_id
    or new.approval_action_id is distinct from old.approval_action_id
    or new.publication_details is distinct from old.publication_details
    or new.idempotency_key is distinct from old.idempotency_key
    or new.repository_owner is distinct from old.repository_owner
    or new.repository_name is distinct from old.repository_name
    or new.repository_branch is distinct from old.repository_branch
  ) then
    raise exception 'publication binding is immutable after claim' using errcode = '55000';
  end if;
  return new;
end;
$$;

revoke all on function narrative_private.protect_claimed_narrative_publish_job()
from public, anon, authenticated, service_role;

create trigger publish_jobs_protect_claimed_binding
before update on public.publish_jobs
for each row execute function narrative_private.protect_claimed_narrative_publish_job();

revoke all on function public.retry_narrative_publish(uuid, uuid, text)
from public, anon, authenticated, service_role;
drop function public.retry_narrative_publish(uuid, uuid, text);

create function public.claim_narrative_publication(
  p_owner_id uuid,
  p_publish_job_id uuid,
  p_expected_version_id uuid,
  p_idempotency_key text,
  p_attempt_token uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  locked_job public.publish_jobs;
  locked_draft public.drafts;
  locked_version public.draft_versions;
  locked_approval public.draft_review_actions;
  publication_settings public.narrative_admin_settings;
  latest_version_id uuid;
  github_credential text;
  frozen_owner text;
  frozen_repository text;
  frozen_branch text;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'publication claim caller is not authorized' using errcode = '42501';
  end if;
  if p_owner_id is null or p_publish_job_id is null or p_expected_version_id is null or p_attempt_token is null
    or p_idempotency_key is null or length(btrim(p_idempotency_key)) not between 1 and 200
    or p_idempotency_key is distinct from btrim(p_idempotency_key) then
    raise exception 'invalid_publication_claim' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('narrative-publication-queue', 0));
  select job.* into locked_job from public.publish_jobs as job
  where job.id = p_publish_job_id and job.owner_id = p_owner_id and job.draft_version_id = p_expected_version_id
  for update;
  if locked_job.id is null then raise exception 'publication_target_not_found' using errcode = 'P0002'; end if;

  if locked_job.status = 'published' then
    if locked_job.idempotency_key is distinct from p_idempotency_key then
      raise exception 'publication_idempotency_mismatch' using errcode = 'P0001';
    end if;
    if locked_job.commit_sha is null or locked_job.published_path is null then
      raise exception 'publication_already_finalized' using errcode = 'P0001';
    end if;
    return jsonb_build_object(
      'outcome', 'already_published', 'publish_job_id', locked_job.id,
      'version_id', locked_job.draft_version_id, 'commit_sha', locked_job.commit_sha,
      'published_path', locked_job.published_path
    );
  end if;
  if locked_job.status = 'publishing' then raise exception 'publication_in_progress' using errcode = 'P0001'; end if;
  if exists (select 1 from public.publish_jobs as active where active.status = 'publishing' and active.id <> locked_job.id) then
    raise exception 'publication_queue_busy' using errcode = 'P0001';
  end if;

  select draft.* into locked_draft from public.drafts as draft
  where draft.id = locked_job.draft_id and draft.owner_id = locked_job.owner_id
  for update;
  select version.* into locked_version from public.draft_versions as version
  where version.id = locked_job.draft_version_id
    and version.owner_id = locked_job.owner_id
    and version.draft_id = locked_job.draft_id
  for share;
  select latest.id into latest_version_id from public.draft_versions as latest
  where latest.owner_id = locked_job.owner_id and latest.draft_id = locked_job.draft_id
  order by latest.version_number desc, latest.id desc limit 1;
  select action.* into locked_approval from public.draft_review_actions as action
  where action.id = locked_job.approval_action_id
    and action.owner_id = locked_job.owner_id
    and action.draft_id = locked_job.draft_id
    and action.draft_version_id = locked_job.draft_version_id
  for share;
  if locked_draft.id is null or locked_version.id is null or locked_approval.id is null
    or latest_version_id is distinct from locked_version.id
    or locked_approval.action is distinct from 'approve_public'
    or locked_approval.resulting_state is distinct from 'approved' then
    raise exception 'publication_not_approved' using errcode = 'P0001';
  end if;

  if locked_job.status = 'queued' then
    if locked_draft.status is distinct from 'approved' or locked_job.idempotency_key is not null then
      raise exception 'publication_not_approved' using errcode = 'P0001';
    end if;
    select settings.* into publication_settings from public.narrative_admin_settings as settings
    where settings.owner_id = locked_job.owner_id for share;
    frozen_owner := publication_settings.github_repository_owner;
    frozen_repository := publication_settings.github_repository_name;
    frozen_branch := publication_settings.github_branch;
  elsif locked_job.status = 'failed' then
    if locked_draft.status is distinct from 'publish_failed' then
      raise exception 'publication_not_approved' using errcode = 'P0001';
    end if;
    if locked_job.idempotency_key is distinct from p_idempotency_key then
      raise exception 'publication_idempotency_mismatch' using errcode = 'P0001';
    end if;
    frozen_owner := locked_job.repository_owner;
    frozen_repository := locked_job.repository_name;
    frozen_branch := locked_job.repository_branch;
  else
    raise exception 'publication_not_approved' using errcode = 'P0001';
  end if;

  select secret.decrypted_secret into github_credential
  from vault.decrypted_secrets as secret
  where secret.name = 'narrative_' || locked_job.owner_id::text || '_github';
  if nullif(btrim(frozen_owner), '') is null or nullif(btrim(frozen_repository), '') is null
    or nullif(btrim(frozen_branch), '') is null or nullif(btrim(github_credential), '') is null then
    raise exception 'publication_not_configured' using errcode = 'P0001';
  end if;

  update public.publish_jobs
  set status = 'publishing',
      idempotency_key = coalesce(idempotency_key, p_idempotency_key),
      attempt_token = p_attempt_token,
      attempt_count = attempt_count + 1,
      repository_owner = frozen_owner,
      repository_name = frozen_repository,
      repository_branch = frozen_branch,
      failure_code = null,
      claimed_at = now(),
      updated_at = now()
  where id = locked_job.id
  returning * into locked_job;
  update public.drafts set status = 'publishing', updated_at = now()
  where id = locked_draft.id and owner_id = locked_draft.owner_id;

  insert into public.audit_events (owner_id, event_type, entity_type, entity_id, payload)
  values (locked_job.owner_id, 'publication_claimed', 'draft', locked_job.draft_id,
    jsonb_build_object('publishJobId', locked_job.id, 'versionId', locked_job.draft_version_id, 'attemptCount', locked_job.attempt_count));

  return jsonb_build_object(
    'outcome', 'claimed',
    'attempt_token', locked_job.attempt_token,
    'publish_job_id', locked_job.id,
    'owner_id', locked_job.owner_id,
    'draft_id', locked_job.draft_id,
    'version_id', locked_version.id,
    'version_number', locked_version.version_number,
    'latest_version_id', latest_version_id,
    'approval_id', locked_approval.id,
    'approval_action', locked_approval.action,
    'approval_resulting_state', locked_approval.resulting_state,
    'content', locked_version.content,
    'publication_details', locked_job.publication_details,
    'repository_owner', locked_job.repository_owner,
    'repository_name', locked_job.repository_name,
    'repository_branch', locked_job.repository_branch,
    'credential', github_credential
  );
exception when unique_violation then
  raise exception 'publication_idempotency_mismatch' using errcode = 'P0001';
end;
$$;

create function public.complete_narrative_publication(
  p_publish_job_id uuid,
  p_attempt_token uuid,
  p_commit_sha text,
  p_published_path text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  locked_job public.publish_jobs;
  locked_draft public.drafts;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'publication completion caller is not authorized' using errcode = '42501';
  end if;
  if p_publish_job_id is null or p_attempt_token is null or p_commit_sha !~ '^[0-9a-fA-F]{40}$'
    or p_published_path !~ '^src/content/records/[0-9]{2,3}-[a-z0-9-]+\.md$' then
    raise exception 'invalid_publication_completion' using errcode = '22023';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('narrative-publication-queue', 0));
  select job.* into locked_job from public.publish_jobs as job where job.id = p_publish_job_id for update;
  if locked_job.id is null then raise exception 'publication_target_not_found' using errcode = 'P0002'; end if;
  if locked_job.status = 'published' then
    if locked_job.attempt_token is distinct from p_attempt_token
      or locked_job.commit_sha is distinct from lower(p_commit_sha)
      or locked_job.published_path is distinct from p_published_path then
      raise exception 'publication_already_finalized' using errcode = 'P0001';
    end if;
    return jsonb_build_object('publishJobId', locked_job.id, 'versionId', locked_job.draft_version_id,
      'status', 'published', 'commitSha', locked_job.commit_sha, 'path', locked_job.published_path);
  end if;
  select draft.* into locked_draft from public.drafts as draft
  where draft.id = locked_job.draft_id and draft.owner_id = locked_job.owner_id for update;
  if locked_job.status is distinct from 'publishing' or locked_job.attempt_token is distinct from p_attempt_token
    or locked_draft.status is distinct from 'publishing' then
    raise exception 'publication_attempt_mismatch' using errcode = 'P0001';
  end if;
  update public.publish_jobs
  set status = 'published', commit_sha = lower(p_commit_sha), published_path = p_published_path,
      failure_code = null, commit_created_at = now(), updated_at = now()
  where id = locked_job.id returning * into locked_job;
  update public.drafts set status = 'published', updated_at = now()
  where id = locked_draft.id and owner_id = locked_draft.owner_id;
  insert into public.audit_events (owner_id, event_type, entity_type, entity_id, payload)
  values (locked_job.owner_id, 'publication_commit_created', 'draft', locked_job.draft_id,
    jsonb_build_object('publishJobId', locked_job.id, 'versionId', locked_job.draft_version_id,
      'commitSha', locked_job.commit_sha, 'path', locked_job.published_path));
  return jsonb_build_object('publishJobId', locked_job.id, 'versionId', locked_job.draft_version_id,
    'status', 'published', 'commitSha', locked_job.commit_sha, 'path', locked_job.published_path);
end;
$$;

create function public.fail_narrative_publication(
  p_publish_job_id uuid,
  p_attempt_token uuid,
  p_failure_code text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  locked_job public.publish_jobs;
  locked_draft public.drafts;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'publication failure caller is not authorized' using errcode = '42501';
  end if;
  if p_publish_job_id is null or p_attempt_token is null or p_failure_code not in (
    'record_validation_failed', 'github_path_conflict', 'github_conflict', 'github_validation_failed',
    'github_credentials_rejected', 'github_timeout', 'github_network_failure', 'github_response_invalid',
    'publication_completion_failed'
  ) then raise exception 'invalid_publication_failure' using errcode = '22023'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('narrative-publication-queue', 0));
  select job.* into locked_job from public.publish_jobs as job where job.id = p_publish_job_id for update;
  if locked_job.id is null then raise exception 'publication_target_not_found' using errcode = 'P0002'; end if;
  if locked_job.status = 'published' then
    return jsonb_build_object('publishJobId', locked_job.id, 'versionId', locked_job.draft_version_id, 'status', 'published');
  end if;
  if locked_job.status = 'failed' and locked_job.attempt_token = p_attempt_token and locked_job.failure_code = p_failure_code then
    return jsonb_build_object('publishJobId', locked_job.id, 'versionId', locked_job.draft_version_id, 'status', 'publish_failed');
  end if;
  select draft.* into locked_draft from public.drafts as draft
  where draft.id = locked_job.draft_id and draft.owner_id = locked_job.owner_id for update;
  if locked_job.status is distinct from 'publishing' or locked_job.attempt_token is distinct from p_attempt_token
    or locked_draft.status is distinct from 'publishing' then
    raise exception 'publication_attempt_mismatch' using errcode = 'P0001';
  end if;
  update public.publish_jobs set status = 'failed', failure_code = p_failure_code, updated_at = now()
  where id = locked_job.id returning * into locked_job;
  update public.drafts set status = 'publish_failed', updated_at = now()
  where id = locked_draft.id and owner_id = locked_draft.owner_id;
  insert into public.audit_events (owner_id, event_type, entity_type, entity_id, payload)
  values (locked_job.owner_id, 'publication_failed', 'draft', locked_job.draft_id,
    jsonb_build_object('publishJobId', locked_job.id, 'versionId', locked_job.draft_version_id, 'failureCode', p_failure_code));
  return jsonb_build_object('publishJobId', locked_job.id, 'versionId', locked_job.draft_version_id, 'status', 'publish_failed');
end;
$$;

revoke all on function public.claim_narrative_publication(uuid, uuid, uuid, text, uuid)
from public, anon, authenticated, service_role;
revoke all on function public.complete_narrative_publication(uuid, uuid, text, text)
from public, anon, authenticated, service_role;
revoke all on function public.fail_narrative_publication(uuid, uuid, text)
from public, anon, authenticated, service_role;

grant execute on function public.claim_narrative_publication(uuid, uuid, uuid, text, uuid) to service_role;
grant execute on function public.complete_narrative_publication(uuid, uuid, text, text) to service_role;
grant execute on function public.fail_narrative_publication(uuid, uuid, text) to service_role;
