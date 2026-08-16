-- Exact-commit Actions and GitHub Pages observation, independent of commit success.

alter table public.publish_jobs
  add column publication_phase text,
  add column tracking_status text,
  add column workflow_status text,
  add column pages_status text,
  add column workflow_run_id bigint,
  add column pages_deployment_id bigint,
  add column pages_url text,
  add column tracking_failure_code text,
  add column tracking_started_at timestamptz,
  add column tracking_expires_at timestamptz,
  add column tracking_next_check_at timestamptz,
  add column tracking_last_checked_at timestamptz,
  add column tracking_check_count integer not null default 0,
  add column tracking_check_token uuid,
  add column tracking_claim_expires_at timestamptz,
  add constraint publish_jobs_publication_phase_check check (
    publication_phase is null or publication_phase in (
      'commit_created', 'workflow_running', 'workflow_succeeded', 'workflow_failed',
      'pages_running', 'pages_failed', 'deployed', 'tracking_timed_out'
    )
  ),
  add constraint publish_jobs_tracking_status_check check (
    tracking_status is null or tracking_status in ('pending', 'observing', 'completed', 'timed_out')
  ),
  add constraint publish_jobs_workflow_status_check check (
    workflow_status is null or workflow_status in ('pending', 'queued', 'in_progress', 'success', 'failure', 'timed_out')
  ),
  add constraint publish_jobs_pages_status_check check (
    pages_status is null or pages_status in ('pending', 'queued', 'in_progress', 'success', 'failure', 'timed_out')
  ),
  add constraint publish_jobs_tracking_ids_check check (
    (workflow_run_id is null or workflow_run_id > 0)
    and (pages_deployment_id is null or pages_deployment_id > 0)
  ),
  add constraint publish_jobs_pages_url_check check (
    pages_url is null or (
      length(pages_url) between 1 and 500
      and pages_url like 'https://%.github.io/%'
      and pages_url !~ '[?#]'
    )
  ),
  add constraint publish_jobs_tracking_failure_check check (
    tracking_failure_code is null or tracking_failure_code in ('workflow_failed', 'pages_deployment_failed', 'tracking_timeout')
  ),
  add constraint publish_jobs_tracking_check_count_check check (tracking_check_count >= 0),
  add constraint publish_jobs_tracking_window_check check (
    tracking_started_at is null or tracking_expires_at is null or tracking_expires_at > tracking_started_at
  );

create index publish_jobs_due_tracking_idx
  on public.publish_jobs (tracking_next_check_at, commit_created_at, id)
  where status = 'published' and tracking_status in ('pending', 'observing');

create function narrative_private.initialize_narrative_publication_tracking()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status = 'published' and new.commit_sha is not null
    and (tg_op = 'INSERT' or old.status is distinct from 'published' or old.commit_sha is null) then
    new.publication_phase := 'commit_created';
    new.tracking_status := 'pending';
    new.workflow_status := 'pending';
    new.pages_status := 'pending';
    new.workflow_run_id := null;
    new.pages_deployment_id := null;
    new.pages_url := null;
    new.tracking_failure_code := null;
    new.tracking_started_at := coalesce(new.commit_created_at, pg_catalog.now());
    new.tracking_expires_at := coalesce(new.commit_created_at, pg_catalog.now()) + interval '6 hours';
    new.tracking_next_check_at := pg_catalog.now();
    new.tracking_last_checked_at := null;
    new.tracking_check_count := 0;
    new.tracking_check_token := null;
    new.tracking_claim_expires_at := null;
  end if;
  return new;
end;
$$;

create trigger publish_jobs_initialize_tracking
before insert or update of status, commit_sha on public.publish_jobs
for each row execute function narrative_private.initialize_narrative_publication_tracking();

update public.publish_jobs
set publication_phase = 'commit_created',
    tracking_status = 'pending',
    workflow_status = 'pending',
    pages_status = 'pending',
    tracking_started_at = coalesce(commit_created_at, updated_at),
    tracking_expires_at = coalesce(commit_created_at, updated_at) + interval '6 hours',
    tracking_next_check_at = pg_catalog.now(),
    tracking_check_count = 0
where status = 'published' and commit_sha is not null and tracking_status is null;

create function public.claim_narrative_publication_check(p_check_token uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  locked_job public.publish_jobs;
  github_credential text;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'publication check caller is not authorized' using errcode = '42501';
  end if;
  if p_check_token is null then
    raise exception 'invalid_publication_check' using errcode = '22023';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('narrative-publication-tracking', 0));

  update public.publish_jobs
  set tracking_status = 'pending', tracking_check_token = null, tracking_claim_expires_at = null,
      tracking_next_check_at = pg_catalog.now(), updated_at = pg_catalog.now()
  where status = 'published' and tracking_status = 'observing'
    and tracking_claim_expires_at <= pg_catalog.clock_timestamp();

  select job.* into locked_job
  from public.publish_jobs as job
  where job.status = 'published'
    and job.commit_sha is not null
    and job.tracking_status = 'pending'
    and job.tracking_next_check_at <= pg_catalog.clock_timestamp()
  order by job.tracking_next_check_at, job.commit_created_at, job.id
  for update skip locked
  limit 1;

  if locked_job.id is null then
    return jsonb_build_object('outcome', 'idle');
  end if;
  if locked_job.tracking_expires_at <= pg_catalog.clock_timestamp() then
    update public.publish_jobs
    set publication_phase = 'tracking_timed_out', tracking_status = 'timed_out',
        workflow_status = case when workflow_status in ('success', 'failure') then workflow_status else 'timed_out' end,
        pages_status = case when pages_status in ('success', 'failure') then pages_status else 'timed_out' end,
        tracking_failure_code = 'tracking_timeout', tracking_next_check_at = null,
        tracking_check_token = null, tracking_claim_expires_at = null,
        tracking_last_checked_at = pg_catalog.now(), updated_at = pg_catalog.now()
    where id = locked_job.id returning * into locked_job;
    insert into public.audit_events (owner_id, event_type, entity_type, entity_id, payload)
    values (locked_job.owner_id, 'publication_tracking_timed_out', 'draft', locked_job.draft_id,
      jsonb_build_object('publishJobId', locked_job.id, 'versionId', locked_job.draft_version_id, 'commitSha', locked_job.commit_sha));
    return jsonb_build_object('outcome', 'timed_out', 'publish_job_id', locked_job.id);
  end if;

  select secret.decrypted_secret into github_credential
  from vault.decrypted_secrets as secret
  where secret.name = 'narrative_' || locked_job.owner_id::text || '_github';
  if nullif(btrim(locked_job.repository_owner), '') is null
    or nullif(btrim(locked_job.repository_name), '') is null
    or nullif(btrim(locked_job.repository_branch), '') is null
    or nullif(btrim(github_credential), '') is null then
    raise exception 'publication_tracking_not_configured' using errcode = 'P0001';
  end if;

  update public.publish_jobs
  set tracking_status = 'observing', tracking_check_token = p_check_token,
      tracking_claim_expires_at = pg_catalog.clock_timestamp() + interval '30 seconds',
      tracking_check_count = tracking_check_count + 1,
      tracking_last_checked_at = pg_catalog.now(), updated_at = pg_catalog.now()
  where id = locked_job.id returning * into locked_job;

  return jsonb_build_object(
    'outcome', 'claimed', 'check_token', locked_job.tracking_check_token,
    'publish_job_id', locked_job.id, 'commit_sha', locked_job.commit_sha,
    'repository_owner', locked_job.repository_owner, 'repository_name', locked_job.repository_name,
    'repository_branch', locked_job.repository_branch, 'credential', github_credential
  );
end;
$$;

create function public.record_narrative_publication_check(
  p_publish_job_id uuid,
  p_check_token uuid,
  p_commit_sha text,
  p_workflow_status text,
  p_pages_status text,
  p_workflow_run_id bigint,
  p_pages_deployment_id bigint,
  p_pages_url text,
  p_failure_code text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  locked_job public.publish_jobs;
  next_phase text;
  next_tracking_status text;
  next_check timestamptz;
  expected_pages_prefix text;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'publication check recorder is not authorized' using errcode = '42501';
  end if;
  if p_publish_job_id is null or p_check_token is null or p_commit_sha !~ '^[0-9a-fA-F]{40}$'
    or p_workflow_status not in ('pending', 'queued', 'in_progress', 'success', 'failure')
    or p_pages_status not in ('pending', 'queued', 'in_progress', 'success', 'failure')
    or (p_workflow_run_id is not null and p_workflow_run_id <= 0)
    or (p_pages_deployment_id is not null and p_pages_deployment_id <= 0)
    or (p_failure_code is not null and p_failure_code not in ('workflow_failed', 'pages_deployment_failed')) then
    raise exception 'invalid_publication_check_result' using errcode = '22023';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('narrative-publication-tracking', 0));
  select job.* into locked_job from public.publish_jobs as job where job.id = p_publish_job_id for update;
  if locked_job.id is null then raise exception 'publication_target_not_found' using errcode = 'P0002'; end if;
  if locked_job.status is distinct from 'published'
    or locked_job.tracking_status is distinct from 'observing'
    or locked_job.tracking_check_token is distinct from p_check_token
    or locked_job.tracking_claim_expires_at is null
    or locked_job.tracking_claim_expires_at <= pg_catalog.clock_timestamp() then
    raise exception 'publication_check_attempt_mismatch' using errcode = 'P0001';
  end if;
  if locked_job.commit_sha is distinct from lower(p_commit_sha) then
    raise exception 'publication_check_commit_mismatch' using errcode = 'P0001';
  end if;

  expected_pages_prefix := 'https://' || lower(locked_job.repository_owner) || '.github.io/' ||
    case when lower(locked_job.repository_name) = lower(locked_job.repository_owner) || '.github.io' then '' else locked_job.repository_name || '/' end;
  if p_pages_url is not null and (
    length(p_pages_url) > 500 or left(lower(p_pages_url), length(lower(expected_pages_prefix))) <> lower(expected_pages_prefix)
    or p_pages_url ~ '[?#]'
  ) then raise exception 'invalid_publication_pages_url' using errcode = '22023'; end if;

  if p_workflow_status = 'failure' then
    if p_pages_status <> 'pending' or p_failure_code <> 'workflow_failed' or p_workflow_run_id is null then
      raise exception 'invalid_publication_check_result' using errcode = '22023';
    end if;
    next_phase := 'workflow_failed'; next_tracking_status := 'completed';
  elsif p_workflow_status = 'success' and p_pages_status = 'success' then
    if p_workflow_run_id is null or p_pages_deployment_id is null or p_failure_code is not null then
      raise exception 'invalid_publication_check_result' using errcode = '22023';
    end if;
    next_phase := 'deployed'; next_tracking_status := 'completed';
  elsif p_workflow_status = 'success' and p_pages_status = 'failure' then
    if p_workflow_run_id is null or p_pages_deployment_id is null or p_failure_code <> 'pages_deployment_failed' then
      raise exception 'invalid_publication_check_result' using errcode = '22023';
    end if;
    next_phase := 'pages_failed'; next_tracking_status := 'completed';
  elsif p_workflow_status = 'success' then
    if p_workflow_run_id is null or p_failure_code is not null then
      raise exception 'invalid_publication_check_result' using errcode = '22023';
    end if;
    next_phase := case when p_pages_deployment_id is null and p_pages_status = 'pending' then 'workflow_succeeded' else 'pages_running' end;
    next_tracking_status := 'pending';
  else
    if p_pages_status <> 'pending' or p_pages_deployment_id is not null or p_failure_code is not null then
      raise exception 'invalid_publication_check_result' using errcode = '22023';
    end if;
    next_phase := case when p_workflow_status = 'pending' then 'commit_created' else 'workflow_running' end;
    next_tracking_status := 'pending';
  end if;

  next_check := case when next_tracking_status = 'pending' then
    pg_catalog.clock_timestamp() + pg_catalog.make_interval(secs => least(900, (60 * power(2, least(greatest(locked_job.tracking_check_count - 1, 0), 4)))::integer))
    else null end;
  update public.publish_jobs
  set publication_phase = next_phase, tracking_status = next_tracking_status,
      workflow_status = p_workflow_status, pages_status = p_pages_status,
      workflow_run_id = coalesce(p_workflow_run_id, workflow_run_id),
      pages_deployment_id = coalesce(p_pages_deployment_id, pages_deployment_id),
      pages_url = coalesce(p_pages_url, pages_url), tracking_failure_code = p_failure_code,
      tracking_next_check_at = next_check, tracking_check_token = null,
      tracking_claim_expires_at = null, tracking_last_checked_at = pg_catalog.now(), updated_at = pg_catalog.now()
  where id = locked_job.id returning * into locked_job;

  insert into public.audit_events (owner_id, event_type, entity_type, entity_id, payload)
  values (locked_job.owner_id, 'publication_tracking_updated', 'draft', locked_job.draft_id,
    jsonb_strip_nulls(jsonb_build_object(
      'publishJobId', locked_job.id, 'versionId', locked_job.draft_version_id,
      'commitSha', locked_job.commit_sha, 'phase', locked_job.publication_phase,
      'workflowRunId', locked_job.workflow_run_id, 'pagesDeploymentId', locked_job.pages_deployment_id,
      'failureCode', locked_job.tracking_failure_code
    )));
  return jsonb_build_object('status', 'recorded', 'publishJobId', locked_job.id, 'phase', locked_job.publication_phase);
end;
$$;

create function public.retry_narrative_publication_check(p_publish_job_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare locked_job public.publish_jobs;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'publication check retry caller is not authorized' using errcode = '42501';
  end if;
  if p_publish_job_id is null then raise exception 'invalid_publication_check_retry' using errcode = '22023'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('narrative-publication-tracking', 0));
  select job.* into locked_job from public.publish_jobs as job where job.id = p_publish_job_id for update;
  if locked_job.id is null then raise exception 'publication_target_not_found' using errcode = 'P0002'; end if;
  if locked_job.status is distinct from 'published' or locked_job.commit_sha is null or locked_job.tracking_status is distinct from 'timed_out' then
    raise exception 'publication_tracking_not_retriable' using errcode = 'P0001';
  end if;
  update public.publish_jobs
  set publication_phase = 'commit_created', tracking_status = 'pending', workflow_status = 'pending', pages_status = 'pending',
      workflow_run_id = null, pages_deployment_id = null, pages_url = null, tracking_failure_code = null,
      tracking_started_at = pg_catalog.now(), tracking_expires_at = pg_catalog.now() + interval '6 hours',
      tracking_next_check_at = pg_catalog.now(), tracking_last_checked_at = null, tracking_check_count = 0,
      tracking_check_token = null, tracking_claim_expires_at = null, updated_at = pg_catalog.now()
  where id = locked_job.id returning * into locked_job;
  insert into public.audit_events (owner_id, event_type, entity_type, entity_id, payload)
  values (locked_job.owner_id, 'publication_tracking_retried', 'draft', locked_job.draft_id,
    jsonb_build_object('publishJobId', locked_job.id, 'versionId', locked_job.draft_version_id, 'commitSha', locked_job.commit_sha));
  return jsonb_build_object('status', 'retry_scheduled', 'publishJobId', locked_job.id);
end;
$$;

revoke all on function public.claim_narrative_publication_check(uuid) from public, anon, authenticated, service_role;
revoke all on function public.record_narrative_publication_check(uuid, uuid, text, text, text, bigint, bigint, text, text) from public, anon, authenticated, service_role;
revoke all on function public.retry_narrative_publication_check(uuid) from public, anon, authenticated, service_role;
grant execute on function public.claim_narrative_publication_check(uuid) to service_role;
grant execute on function public.record_narrative_publication_check(uuid, uuid, text, text, text, bigint, bigint, text, text) to service_role;
grant execute on function public.retry_narrative_publication_check(uuid) to service_role;

create function narrative_private.publication_check_dispatch_material()
returns table(url text, body jsonb, headers jsonb)
language plpgsql
security definer
set search_path = ''
as $$
declare dispatcher_url text; dispatcher_token text;
begin
  select decrypted_secret into dispatcher_url from vault.decrypted_secrets where name = 'narrative_publication_check_url';
  select decrypted_secret into dispatcher_token from vault.decrypted_secrets where name = 'narrative_schedule_dispatch_token';
  if dispatcher_url is null or dispatcher_token is null then
    raise exception 'publication_check_runtime_not_configured' using errcode = 'P0001';
  end if;
  return query select dispatcher_url, jsonb_build_object('action', 'poll'),
    jsonb_build_object('content-type', 'application/json', 'x-schedule-dispatch-token', dispatcher_token);
end;
$$;

create function narrative_private.invoke_publication_checker()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare dispatch_request record;
begin
  select material.* into dispatch_request from narrative_private.publication_check_dispatch_material() material;
  perform net.http_post(url := dispatch_request.url, body := dispatch_request.body, headers := dispatch_request.headers);
end;
$$;

revoke all on function narrative_private.publication_check_dispatch_material() from public, anon, authenticated, service_role;
revoke all on function narrative_private.invoke_publication_checker() from public, anon, authenticated, service_role;

select cron.schedule(
  'narrative-publication-checker', '* * * * *',
  $$select narrative_private.invoke_publication_checker()$$
)
where not exists (select 1 from cron.job where jobname = 'narrative-publication-checker');
