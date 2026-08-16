-- Final generation remediation.
--
-- Transactional lock order for generation policy paths is:
--   schedule (when applicable) -> provider -> budget period (when applicable)
--   -> narrative_admin_settings.
-- A path may skip locks it does not need, but it must not reverse this order.

create function narrative_private.generation_revision_binding_valid(p_job public.generation_jobs)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    case when p_job.payload ->> 'mode' = 'revise_selection' then
      p_job.requested_max_output_tokens is not null
      and p_job.confirmed_maximum_cost_micros is not null
      and p_job.source_draft_version_id is not null
      and case when coalesce(p_job.payload ->> 'requestedMaxOutputTokens', '') ~ '^[0-9]+$'
        then (p_job.payload ->> 'requestedMaxOutputTokens')::integer end = p_job.requested_max_output_tokens
      and case when coalesce(p_job.payload ->> 'confirmedMaximumCostMicros', '') ~ '^[0-9]+$'
        then (p_job.payload ->> 'confirmedMaximumCostMicros')::bigint end = p_job.confirmed_maximum_cost_micros
      and p_job.payload ->> 'sourceVersionId' = p_job.source_draft_version_id::text
      and exists (
        select 1 from public.draft_versions as version
        where version.id = p_job.source_draft_version_id
          and version.owner_id = p_job.owner_id
          and version.draft_id = p_job.draft_id
      )
    else true end,
    false
  );
$$;

create or replace function narrative_private.manual_generation_binding_valid(
  p_job public.generation_jobs,
  p_expected_draft_id uuid,
  p_expected_mode text,
  p_expected_key text,
  p_expected_provider_setting_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    p_job.payload ->> 'source' = 'manual'
    and p_job.draft_id is not null
    and p_job.provider_setting_id is not null
    and nullif(btrim(p_job.payload ->> 'manualRequestKey'), '') is not null
    and nullif(btrim(p_job.payload ->> 'mode'), '') is not null
    and nullif(btrim(p_job.payload ->> 'kind'), '') is not null
    and p_expected_draft_id is not null
    and nullif(btrim(p_expected_mode), '') is not null
    and nullif(btrim(p_expected_key), '') is not null
    and p_expected_provider_setting_id is not null
    and p_job.schedule_key = p_job.payload ->> 'manualRequestKey'
    and p_job.draft_id = p_expected_draft_id
    and p_job.payload ->> 'mode' = p_expected_mode
    and p_job.payload ->> 'manualRequestKey' = p_expected_key
    and p_job.provider_setting_id = p_expected_provider_setting_id
    and narrative_private.generation_revision_binding_valid(p_job)
    and exists (
      select 1 from public.drafts as draft
      where draft.id = p_job.draft_id
        and draft.owner_id = p_job.owner_id
        and draft.kind = p_job.payload ->> 'kind'
    )
    and exists (
      select 1 from public.provider_settings as provider
      where provider.id = p_job.provider_setting_id
        and provider.owner_id = p_job.owner_id
    ),
    false
  );
$$;

create or replace function narrative_private.generation_worker_binding_valid(p_job public.generation_jobs)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    p_job.worker_attempt_count between 1 and 3
    and p_job.worker_policy_class in ('manual', 'schedule')
    and p_job.worker_source in ('manual', 'schedule', 'access')
    and p_job.worker_generation_mode in ('new', 'revise_selection', 'major_event_scene_plan', 'major_event_draft')
    and p_job.worker_kind in ('short_dialogue', 'daily_event', 'major_event_proposal')
    and p_job.worker_draft_id is not null
    and p_job.worker_provider_setting_id is not null
    and nullif(btrim(p_job.worker_schedule_key), '') is not null
    and p_job.worker_scheduled_for is not null
    and nullif(btrim(p_job.worker_idempotency_key), '') is not null
    and p_job.owner_id is not null
    and p_job.draft_id = p_job.worker_draft_id
    and p_job.provider_setting_id = p_job.worker_provider_setting_id
    and p_job.schedule_key = p_job.worker_schedule_key
    and p_job.scheduled_for = p_job.worker_scheduled_for
    and p_job.payload ->> 'source' = p_job.worker_source
    and p_job.payload ->> 'kind' = p_job.worker_kind
    and (p_job.generation_mode is null or p_job.generation_mode = p_job.worker_generation_mode)
    and (p_job.idempotency_key is null or p_job.idempotency_key = p_job.worker_idempotency_key)
    and narrative_private.generation_revision_binding_valid(p_job)
    and (
      (p_job.worker_source = 'manual'
        and p_job.worker_policy_class = 'manual'
        and p_job.payload ->> 'mode' = p_job.worker_generation_mode
        and p_job.payload ->> 'manualRequestKey' = p_job.worker_idempotency_key)
      or
      (p_job.worker_source = 'schedule'
        and p_job.worker_policy_class = 'schedule'
        and p_job.worker_generation_mode = 'new'
        and p_job.worker_idempotency_key = 'generation-worker:' || p_job.id::text
        and p_job.payload ->> 'budgetPolicy' in ('block_at_risk', 'block_at_warning'))
      or
      (p_job.worker_source = 'access'
        and p_job.worker_policy_class = 'schedule'
        and p_job.worker_generation_mode = 'new'
        and p_job.worker_idempotency_key = 'generation-worker:' || p_job.id::text
        and p_job.payload ->> 'budgetPolicy' = 'block_at_risk')
    )
    and exists (
      select 1 from public.drafts as draft
      where draft.id = p_job.worker_draft_id
        and draft.owner_id = p_job.owner_id
        and draft.kind = p_job.worker_kind
    )
    and exists (
      select 1 from public.provider_settings as provider
      where provider.id = p_job.worker_provider_setting_id
        and provider.owner_id = p_job.owner_id
    ), false
  );
$$;

create or replace function narrative_private.retry_generation_worker_job(p_job_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  locked_job public.generation_jobs;
  abort_result jsonb;
  retry_time timestamptz;
  reservation public.budget_entries;
  replacement public.generation_jobs;
begin
  select job.* into locked_job from public.generation_jobs as job where job.id = p_job_id for update;
  if locked_job.id is null then return jsonb_build_object('outcome', 'stale'); end if;
  if locked_job.provider_dispatch_recorded_at is not null then
    return narrative_private.dead_letter_generation_worker_job(locked_job.id, 'provider_outcome_unknown', true);
  end if;
  select entry.* into reservation from public.budget_entries as entry
  where entry.generation_job_id = locked_job.id and entry.entry_type = 'reservation';
  if reservation.id is not null then
    if locked_job.worker_attempt_count >= 3 then
      return narrative_private.dead_letter_generation_worker_job(locked_job.id, 'worker_attempts_exhausted', false);
    end if;
    perform public.fail_generation_budget(locked_job.id, 0);
    retry_time := pg_catalog.clock_timestamp() + case locked_job.worker_attempt_count
      when 1 then interval '1 minute' else interval '5 minutes' end;
    update public.drafts set status = 'queued', updated_at = now()
    where id = locked_job.worker_draft_id and owner_id = locked_job.owner_id and status = 'generating';
    update public.generation_jobs
    set status = 'failed', failure_code = 'worker_pre_dispatch_retried', failure_at = now(),
        worker_failure_code = 'worker_pre_dispatch_retried', worker_retry_at = null,
        worker_lease_expires_at = null,
        -- Transfer the immutable manual key to the replacement at its next
        -- exact freeze; retaining it here would make that freeze collide.
        idempotency_key = null
    where id = locked_job.id;
    insert into public.generation_jobs (
      owner_id, draft_id, schedule_key, scheduled_for, status, payload,
      provider_setting_id, requested_max_output_tokens,
      confirmed_maximum_cost_micros, source_draft_version_id,
      worker_attempt_count, worker_retry_at, worker_failure_code
    ) values (
      locked_job.owner_id, locked_job.worker_draft_id, locked_job.schedule_key,
      pg_catalog.clock_timestamp(), 'queued', locked_job.payload,
      locked_job.worker_provider_setting_id, locked_job.requested_max_output_tokens,
      locked_job.confirmed_maximum_cost_micros, locked_job.source_draft_version_id,
      locked_job.worker_attempt_count, retry_time, 'worker_retry_scheduled'
    ) returning * into replacement;
    insert into public.audit_events (owner_id, event_type, entity_type, entity_id, payload)
    values (locked_job.owner_id, 'generation_worker_pre_dispatch_retried', 'generation_job', locked_job.id,
      jsonb_build_object('replacementJobId', replacement.id, 'attemptCount', locked_job.worker_attempt_count));
    return jsonb_build_object('outcome', 'retry_wait', 'jobId', replacement.id, 'retryAt', retry_time);
  end if;
  if locked_job.status is distinct from 'queued' then
    return narrative_private.dead_letter_generation_worker_job(locked_job.id, 'worker_reserved_without_dispatch', false);
  end if;
  if locked_job.attempt_token is not null then
    abort_result := public.generation_internal_abort_attempt_v1(
      locked_job.id, locked_job.worker_idempotency_key, 'freeze_failed'
    );
    if abort_result ->> 'outcome' not in ('aborted', 'stale') then
      return narrative_private.dead_letter_generation_worker_job(locked_job.id, 'worker_binding_changed', false);
    end if;
  end if;
  if locked_job.worker_attempt_count >= 3 then
    return narrative_private.dead_letter_generation_worker_job(locked_job.id, 'worker_attempts_exhausted', false);
  end if;
  retry_time := pg_catalog.clock_timestamp() + case locked_job.worker_attempt_count
    when 1 then interval '1 minute' else interval '5 minutes' end;
  update public.generation_jobs
  set status = 'queued', attempt_token = null, provider_setting_id = worker_provider_setting_id,
      worker_attempt_token = null, worker_claimed_at = null, worker_lease_expires_at = null,
      worker_retry_at = retry_time, worker_failure_code = 'worker_retry_scheduled',
      failure_code = null, failure_at = null
  where id = locked_job.id;
  update public.drafts set status = 'queued', updated_at = now()
  where id = locked_job.worker_draft_id and owner_id = locked_job.owner_id and status = 'generating';
  return jsonb_build_object('outcome', 'retry_wait', 'jobId', locked_job.id, 'retryAt', retry_time);
end;
$$;

create or replace function public.claim_generation_worker_job(p_worker_attempt_token uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  expired_job public.generation_jobs;
  candidate public.generation_jobs;
  active_provider public.provider_settings;
  settings public.narrative_admin_settings;
  bound_draft public.drafts;
  source_value text;
  kind_value text;
  mode_value text;
  policy_value text;
  key_value text;
  title_value text;
  policy_failure text;
  claim_time timestamptz;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'generation worker claim caller is not authorized' using errcode = '42501';
  end if;
  if p_worker_attempt_token is null then
    raise exception 'invalid_generation_worker_claim' using errcode = '22023';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('narrative-generation-worker', 0));

  select job.* into expired_job from public.generation_jobs as job
  where job.worker_attempt_token is not null
    and job.worker_lease_expires_at is not null
    and job.worker_lease_expires_at <= pg_catalog.clock_timestamp()
    and job.status not in ('completed', 'failed', 'cancelled')
  order by job.worker_lease_expires_at, job.id limit 1 for update;
  if expired_job.id is not null then
    if expired_job.provider_dispatch_recorded_at is not null then
      return narrative_private.dead_letter_generation_worker_job(expired_job.id, 'provider_outcome_unknown', true);
    end if;
    return narrative_private.retry_generation_worker_job(expired_job.id);
  end if;

  select job.* into expired_job from public.generation_jobs as job
  where job.worker_attempt_token is null and job.status = 'running'
    and job.scheduled_for <= pg_catalog.clock_timestamp()
    and (job.direct_dispatch_expires_at is null
      or job.direct_dispatch_expires_at <= pg_catalog.clock_timestamp())
  order by job.scheduled_for, job.created_at, job.id limit 1 for update;
  if expired_job.id is not null then
    return narrative_private.dead_letter_generation_worker_job(
      expired_job.id,
      case when expired_job.provider_dispatch_recorded_at is null
        then 'worker_reserved_without_dispatch' else 'provider_outcome_unknown' end,
      expired_job.provider_dispatch_recorded_at is not null
    );
  end if;

  if exists (
    select 1 from public.generation_jobs as active
    where active.worker_attempt_token is not null
      and active.worker_lease_expires_at > pg_catalog.clock_timestamp()
      and active.status not in ('completed', 'failed', 'cancelled')
  ) then return jsonb_build_object('outcome', 'idle'); end if;

  select job.* into candidate from public.generation_jobs as job
  where job.status = 'queued'
    and job.scheduled_for <= pg_catalog.clock_timestamp()
    and (job.worker_retry_at is null or job.worker_retry_at <= pg_catalog.clock_timestamp())
    and job.worker_attempt_token is null
    and job.attempt_token is null
    and (job.direct_dispatch_expires_at is null
      or job.direct_dispatch_expires_at <= pg_catalog.clock_timestamp())
    and job.worker_attempt_count < 3
  order by job.scheduled_for, job.created_at, job.id limit 1 for update;
  if candidate.id is null then return jsonb_build_object('outcome', 'idle'); end if;

  source_value := candidate.payload ->> 'source';
  kind_value := candidate.payload ->> 'kind';
  if source_value is null or source_value not in ('manual', 'schedule', 'access')
    or kind_value is null or kind_value not in ('short_dialogue', 'daily_event', 'major_event_proposal') then
    update public.generation_jobs set worker_failure_code = 'worker_binding_invalid' where id = candidate.id;
    return narrative_private.dead_letter_generation_worker_job(candidate.id, 'worker_binding_invalid', false);
  end if;
  policy_value := case when source_value = 'manual' then 'manual' else 'schedule' end;
  mode_value := case when source_value = 'manual' then candidate.payload ->> 'mode' else 'new' end;
  key_value := case when source_value = 'manual' then candidate.payload ->> 'manualRequestKey'
    else 'generation-worker:' || candidate.id::text end;
  if mode_value not in ('new', 'revise_selection', 'major_event_scene_plan', 'major_event_draft')
    or nullif(btrim(key_value), '') is null or length(key_value) > 200
    or (source_value = 'schedule' and candidate.payload ->> 'budgetPolicy' not in ('block_at_risk', 'block_at_warning'))
    or (source_value = 'access' and candidate.payload ->> 'budgetPolicy' is distinct from 'block_at_risk')
    or (source_value = 'manual' and candidate.schedule_key is distinct from key_value) then
    update public.generation_jobs set worker_failure_code = 'worker_binding_invalid' where id = candidate.id;
    return narrative_private.dead_letter_generation_worker_job(candidate.id, 'worker_binding_invalid', false);
  end if;

  -- This path skips the budget-period lock, so the shared total order is
  -- provider -> narrative_admin_settings. Settings save uses provider -> budget
  -- -> narrative_admin_settings and therefore cannot form a lock cycle here.
  select provider.* into active_provider from public.provider_settings as provider
  where provider.owner_id = candidate.owner_id and provider.enabled for share;
  if active_provider.id is null
    or (source_value = 'manual' and candidate.provider_setting_id is distinct from active_provider.id) then
    update public.generation_jobs set worker_failure_code = 'worker_provider_changed' where id = candidate.id;
    return narrative_private.dead_letter_generation_worker_job(candidate.id, 'worker_provider_changed', false);
  end if;
  select value.* into settings from public.narrative_admin_settings as value
  where value.owner_id = candidate.owner_id for share;
  if settings.owner_id is null
    or (policy_value = 'manual' and not settings.manual_generation_enabled)
    or (policy_value = 'schedule' and not settings.schedule_automation_enabled) then
    update public.generation_jobs set worker_failure_code = 'worker_policy_disabled' where id = candidate.id;
    return narrative_private.dead_letter_generation_worker_job(candidate.id, 'worker_policy_disabled', false);
  end if;
  if active_provider.pricing_verified_at > public.narrative_business_date(current_timestamp)
    or active_provider.pricing_verified_at < public.narrative_business_date(current_timestamp) - settings.pricing_valid_days then
    update public.generation_jobs set worker_failure_code = 'worker_pricing_invalid' where id = candidate.id;
    return narrative_private.dead_letter_generation_worker_job(candidate.id, 'worker_pricing_invalid', false);
  end if;

  if candidate.draft_id is null then
    if source_value = 'manual' then
      update public.generation_jobs set worker_failure_code = 'worker_binding_invalid' where id = candidate.id;
      return narrative_private.dead_letter_generation_worker_job(candidate.id, 'worker_binding_invalid', false);
    end if;
    title_value := case source_value when 'access' then '접속 자동 생성 ' else '일정 자동 생성 ' end
      || to_char(candidate.scheduled_for at time zone 'Asia/Seoul', 'YYYY-MM-DD HH24:MI');
    insert into public.drafts (owner_id, kind, status, title, metadata)
    values (candidate.owner_id, kind_value, 'queued', title_value,
      jsonb_build_object('source', source_value, 'scheduleKey', candidate.schedule_key, 'scheduledFor', candidate.scheduled_for))
    returning * into bound_draft;
  else
    select draft.* into bound_draft from public.drafts as draft
    where draft.id = candidate.draft_id and draft.owner_id = candidate.owner_id for update;
    if bound_draft.id is null or bound_draft.kind is distinct from kind_value or bound_draft.status is distinct from 'queued' then
      update public.generation_jobs set worker_failure_code = 'worker_binding_invalid' where id = candidate.id;
      return narrative_private.dead_letter_generation_worker_job(candidate.id, 'worker_binding_invalid', false);
    end if;
  end if;

  claim_time := pg_catalog.clock_timestamp();
  update public.generation_jobs
  set draft_id = bound_draft.id,
      provider_setting_id = active_provider.id,
      worker_attempt_token = p_worker_attempt_token,
      worker_attempt_count = worker_attempt_count + 1,
      worker_claimed_at = claim_time,
      worker_lease_expires_at = claim_time + interval '90 seconds',
      worker_retry_at = null,
      worker_completed_at = null,
      worker_failure_code = null,
      worker_policy_class = coalesce(worker_policy_class, policy_value),
      worker_source = coalesce(worker_source, source_value),
      worker_generation_mode = coalesce(worker_generation_mode, mode_value),
      worker_kind = coalesce(worker_kind, kind_value),
      worker_draft_id = coalesce(worker_draft_id, bound_draft.id),
      worker_provider_setting_id = coalesce(worker_provider_setting_id, active_provider.id),
      worker_schedule_key = coalesce(worker_schedule_key, candidate.schedule_key),
      worker_scheduled_for = coalesce(worker_scheduled_for, candidate.scheduled_for),
      worker_idempotency_key = coalesce(worker_idempotency_key, key_value)
  where id = candidate.id returning * into candidate;
  policy_failure := narrative_private.generation_worker_policy_failure(candidate);
  if policy_failure is not null then
    return narrative_private.dead_letter_generation_worker_job(candidate.id, policy_failure, false);
  end if;
  insert into public.audit_events (owner_id, event_type, entity_type, entity_id, payload)
  values (candidate.owner_id, 'generation_worker_claimed', 'generation_job', candidate.id,
    jsonb_build_object('source', candidate.worker_source, 'attemptCount', candidate.worker_attempt_count));
  return jsonb_strip_nulls(jsonb_build_object(
    'outcome', 'claimed', 'jobId', candidate.id, 'ownerId', candidate.owner_id,
    'draftId', candidate.worker_draft_id, 'idempotencyKey', candidate.worker_idempotency_key,
    'providerSettingId', candidate.worker_provider_setting_id,
    'mode', candidate.worker_generation_mode, 'kind', candidate.worker_kind,
    'source', candidate.worker_source, 'policyClass', candidate.worker_policy_class,
    'seed', candidate.payload ->> 'seed', 'tags', candidate.payload -> 'tags',
    'revision', candidate.payload -> 'revision',
    'requestedMaxOutputTokens', candidate.payload -> 'requestedMaxOutputTokens'
  ));
exception when unique_violation then
  raise exception 'generation_worker_claim_conflict' using errcode = 'P0001';
end;
$$;

revoke all on function narrative_private.generation_revision_binding_valid(public.generation_jobs)
  from public, anon, authenticated, service_role;

comment on function public.save_narrative_settings(boolean, boolean, text, jsonb, bigint, bigint, integer, integer, integer, numeric, integer)
  is 'Locks provider -> budget period -> narrative_admin_settings; generation policy paths must preserve the shared total order.';
comment on function public.claim_generation_worker_job(uuid)
  is 'Claims one generation job and locks provider -> narrative_admin_settings, preserving the shared generation-policy lock order.';
