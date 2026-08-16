-- Lease-based generation dispatcher. All provider work remains in the existing
-- generation orchestrator; this migration owns durable selection and fencing.

alter table public.generation_jobs
  add column worker_attempt_token uuid,
  add column worker_attempt_count integer not null default 0,
  add column worker_claimed_at timestamptz,
  add column worker_lease_expires_at timestamptz,
  add column worker_retry_at timestamptz,
  add column worker_completed_at timestamptz,
  add column worker_failure_code text,
  add column worker_policy_class text,
  add column worker_source text,
  add column worker_generation_mode text,
  add column worker_kind text,
  add column worker_draft_id uuid,
  add column worker_provider_setting_id uuid,
  add column worker_schedule_key text,
  add column worker_scheduled_for timestamptz,
  add column worker_idempotency_key text,
  add column provider_dispatch_worker_attempt_token uuid,
  add column provider_dispatch_generation_attempt_token uuid,
  add column provider_dispatch_recorded_at timestamptz,
  add constraint generation_jobs_worker_attempt_count_check check (worker_attempt_count between 0 and 3),
  add constraint generation_jobs_worker_policy_check check (worker_policy_class is null or worker_policy_class in ('manual', 'schedule')),
  add constraint generation_jobs_worker_source_check check (worker_source is null or worker_source in ('manual', 'schedule', 'access')),
  add constraint generation_jobs_worker_mode_check check (worker_generation_mode is null or worker_generation_mode in ('new', 'revise_selection', 'major_event_scene_plan', 'major_event_draft')),
  add constraint generation_jobs_worker_kind_check check (worker_kind is null or worker_kind in ('short_dialogue', 'daily_event', 'major_event_proposal')),
  add constraint generation_jobs_worker_key_check check (
    worker_idempotency_key is null or (length(btrim(worker_idempotency_key)) between 1 and 200 and worker_idempotency_key = btrim(worker_idempotency_key))
  ),
  add constraint generation_jobs_worker_failure_check check (
    worker_failure_code is null or worker_failure_code in (
      'worker_binding_invalid', 'worker_binding_changed', 'worker_policy_disabled',
      'worker_provider_changed', 'worker_pricing_invalid', 'worker_budget_blocked',
      'worker_retry_scheduled', 'worker_attempts_exhausted',
      'worker_reserved_without_dispatch', 'provider_outcome_unknown',
      'worker_legacy_frozen', 'worker_legacy_running'
    )
  ),
  add constraint generation_jobs_worker_draft_fkey
    foreign key (owner_id, worker_draft_id) references public.drafts (owner_id, id) on delete restrict,
  add constraint generation_jobs_worker_provider_fkey
    foreign key (owner_id, worker_provider_setting_id) references public.provider_settings (owner_id, id) on delete restrict,
  add constraint generation_jobs_provider_fence_shape_check check (
    (provider_dispatch_generation_attempt_token is null and provider_dispatch_recorded_at is null)
    or (provider_dispatch_generation_attempt_token is not null and provider_dispatch_recorded_at is not null)
  );

create unique index generation_jobs_worker_attempt_token_idx
  on public.generation_jobs (worker_attempt_token) where worker_attempt_token is not null;
create index generation_jobs_worker_due_idx
  on public.generation_jobs (scheduled_for, worker_retry_at, created_at, id)
  where status = 'queued';

-- Pre-020 frozen/running work has no durable provider-dispatch evidence. It is
-- deliberately terminal instead of being guessed safe or replayed.
insert into public.budget_entries (
  owner_id, budget_period_id, generation_job_id, amount_micros,
  entry_type, daily_bucket_date, description
)
select reservation.owner_id, reservation.budget_period_id, reservation.generation_job_id,
  0, 'failure', reservation.daily_bucket_date, 'legacy generation worker fail-closed settlement'
from public.budget_entries as reservation
join public.generation_jobs as job on job.id = reservation.generation_job_id and job.owner_id = reservation.owner_id
where job.status = 'running' and reservation.entry_type = 'reservation'
  and not exists (
    select 1 from public.budget_entries as settled
    where settled.generation_job_id = reservation.generation_job_id
      and settled.entry_type in ('reconciliation', 'failure')
  );

update public.drafts as draft
set status = 'queued', updated_at = now()
from public.generation_jobs as job
where job.draft_id = draft.id and job.owner_id = draft.owner_id
  and job.status = 'running' and draft.status = 'generating';

update public.generation_jobs
set status = 'failed', failure_code = 'worker_legacy_running', failure_at = now(),
    worker_failure_code = 'worker_legacy_running'
where status = 'running';

update public.generation_jobs
set status = 'failed', failure_code = 'worker_legacy_frozen', failure_at = now(),
    worker_failure_code = 'worker_legacy_frozen'
where status = 'queued' and attempt_token is not null;

create function narrative_private.generation_worker_binding_valid(p_job public.generation_jobs)
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

create function narrative_private.generation_worker_policy_failure(p_job public.generation_jobs)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  settings public.narrative_admin_settings;
  provider public.provider_settings;
begin
  if not narrative_private.generation_worker_binding_valid(p_job) then return 'worker_binding_changed'; end if;
  select value.* into provider from public.provider_settings as value
  where value.id = p_job.worker_provider_setting_id and value.owner_id = p_job.owner_id;
  select value.* into settings from public.narrative_admin_settings as value
  where value.owner_id = p_job.owner_id;
  if settings.owner_id is null
    or (p_job.worker_policy_class = 'manual' and not settings.manual_generation_enabled)
    or (p_job.worker_policy_class = 'schedule' and not settings.schedule_automation_enabled) then
    return 'worker_policy_disabled';
  end if;
  if provider.id is null or not provider.enabled then return 'worker_provider_changed'; end if;
  if provider.pricing_verified_at > public.narrative_business_date(current_timestamp)
    or provider.pricing_verified_at < public.narrative_business_date(current_timestamp) - settings.pricing_valid_days then
    return 'worker_pricing_invalid';
  end if;
  return null;
end;
$$;

create function narrative_private.dead_letter_generation_worker_job(
  p_job_id uuid,
  p_failure_code text,
  p_charge_unknown boolean
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  locked_job public.generation_jobs;
  reservation public.budget_entries;
begin
  if p_failure_code not in (
    'worker_binding_invalid', 'worker_binding_changed', 'worker_policy_disabled',
    'worker_provider_changed', 'worker_pricing_invalid', 'worker_budget_blocked',
    'worker_attempts_exhausted', 'worker_reserved_without_dispatch',
    'provider_outcome_unknown', 'worker_legacy_frozen', 'worker_legacy_running'
  ) then raise exception 'invalid_generation_worker_failure' using errcode = '22023'; end if;
  select job.* into locked_job from public.generation_jobs as job where job.id = p_job_id for update;
  if locked_job.id is null then return jsonb_build_object('outcome', 'stale'); end if;
  if locked_job.status = 'completed' and exists (
    select 1 from public.draft_versions as version
    where version.generation_job_id = locked_job.id
      and version.owner_id = locked_job.owner_id
      and version.draft_id = locked_job.draft_id
  ) then
    update public.generation_jobs set worker_lease_expires_at = null,
      worker_completed_at = coalesce(worker_completed_at, now()), worker_failure_code = null
    where id = locked_job.id;
    return jsonb_build_object('outcome', 'completed', 'jobId', locked_job.id);
  end if;
  if locked_job.status = 'failed' and locked_job.worker_failure_code is not null then
    return jsonb_build_object('outcome', 'dead_lettered', 'jobId', locked_job.id, 'failureCode', locked_job.worker_failure_code);
  end if;
  select entry.* into reservation from public.budget_entries as entry
  where entry.generation_job_id = locked_job.id and entry.owner_id = locked_job.owner_id
    and entry.entry_type = 'reservation';
  if reservation.id is not null then
    perform public.fail_generation_budget(locked_job.id, case when p_charge_unknown then reservation.amount_micros else 0 end);
  end if;
  update public.drafts set status = 'queued', updated_at = now()
  where id = locked_job.draft_id and owner_id = locked_job.owner_id and status = 'generating';
  update public.generation_jobs
  set status = 'failed', failure_code = p_failure_code, failure_at = now(),
      worker_failure_code = p_failure_code, worker_retry_at = null,
      worker_lease_expires_at = null
  where id = locked_job.id;
  insert into public.audit_events (owner_id, event_type, entity_type, entity_id, payload)
  values (locked_job.owner_id, 'generation_worker_dead_lettered', 'generation_job', locked_job.id,
    jsonb_build_object('failureCode', p_failure_code, 'attemptCount', locked_job.worker_attempt_count));
  return jsonb_build_object('outcome', 'dead_lettered', 'jobId', locked_job.id, 'failureCode', p_failure_code);
end;
$$;

create function narrative_private.retry_generation_worker_job(p_job_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  locked_job public.generation_jobs;
  abort_result jsonb;
  retry_time timestamptz;
begin
  select job.* into locked_job from public.generation_jobs as job where job.id = p_job_id for update;
  if locked_job.id is null then return jsonb_build_object('outcome', 'stale'); end if;
  if locked_job.provider_dispatch_recorded_at is not null then
    return narrative_private.dead_letter_generation_worker_job(locked_job.id, 'provider_outcome_unknown', true);
  end if;
  if exists (select 1 from public.budget_entries as entry where entry.generation_job_id = locked_job.id and entry.entry_type = 'reservation')
    or locked_job.status is distinct from 'queued' then
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

create function public.claim_generation_worker_job(p_worker_attempt_token uuid)
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

  -- A legacy/direct generation may have crossed the generation reservation
  -- boundary without a worker lease. The provider fence decides whether its
  -- outcome is unknown; either way it is never replayed.
  select job.* into expired_job from public.generation_jobs as job
  where job.worker_attempt_token is null and job.status = 'running'
    and job.scheduled_for <= pg_catalog.clock_timestamp()
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

  select value.* into settings from public.narrative_admin_settings as value
  where value.owner_id = candidate.owner_id for share;
  if settings.owner_id is null
    or (policy_value = 'manual' and not settings.manual_generation_enabled)
    or (policy_value = 'schedule' and not settings.schedule_automation_enabled) then
    update public.generation_jobs set worker_failure_code = 'worker_policy_disabled' where id = candidate.id;
    return narrative_private.dead_letter_generation_worker_job(candidate.id, 'worker_policy_disabled', false);
  end if;
  select provider.* into active_provider from public.provider_settings as provider
  where provider.owner_id = candidate.owner_id and provider.enabled for share;
  if active_provider.id is null
    or (source_value = 'manual' and candidate.provider_setting_id is distinct from active_provider.id) then
    update public.generation_jobs set worker_failure_code = 'worker_provider_changed' where id = candidate.id;
    return narrative_private.dead_letter_generation_worker_job(candidate.id, 'worker_provider_changed', false);
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

create function public.renew_generation_worker_claim(p_job_id uuid, p_worker_attempt_token uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  locked_job public.generation_jobs;
  policy_failure text;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'generation worker renewal caller is not authorized' using errcode = '42501';
  end if;
  if p_job_id is null or p_worker_attempt_token is null then return jsonb_build_object('outcome', 'stale'); end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('narrative-generation-worker', 0));
  select job.* into locked_job from public.generation_jobs as job where job.id = p_job_id for update;
  if locked_job.id is null or locked_job.worker_attempt_token is distinct from p_worker_attempt_token
    or locked_job.worker_lease_expires_at is null
    or locked_job.worker_lease_expires_at <= pg_catalog.clock_timestamp()
    or locked_job.status in ('completed', 'failed', 'cancelled') then
    return jsonb_build_object('outcome', 'stale');
  end if;
  policy_failure := narrative_private.generation_worker_policy_failure(locked_job);
  if policy_failure is not null then
    return narrative_private.dead_letter_generation_worker_job(locked_job.id, policy_failure, false);
  end if;
  update public.generation_jobs
  set worker_lease_expires_at = least(
    pg_catalog.clock_timestamp() + interval '90 seconds', worker_claimed_at + interval '5 minutes'
  )
  where id = locked_job.id returning * into locked_job;
  return jsonb_build_object('outcome', 'renewed', 'jobId', locked_job.id,
    'leaseExpiresAt', locked_job.worker_lease_expires_at);
end;
$$;

-- Keep the established public signatures for direct/manual orchestration, and
-- add exact worker-token wrappers around the same proven transaction bodies.
alter function public.freeze_generation_context(uuid, uuid, text, text, text[], jsonb, uuid, uuid)
  rename to generation_direct_freeze_context_v2;
alter function public.reserve_and_start_generation(uuid, uuid, bigint)
  rename to generation_direct_reserve_start_v2;
alter function public.finalize_generation_success(uuid, uuid, bigint, jsonb, jsonb, text, jsonb, text, text, text)
  rename to generation_direct_finalize_success_v2;
alter function public.abort_generation_attempt(uuid, uuid, text, text)
  rename to generation_direct_abort_attempt_v2;

create function public.freeze_generation_context(
  p_job_id uuid, p_draft_id uuid, p_generation_mode text, p_idempotency_key text,
  p_context_version_ids text[], p_context_snapshot jsonb, p_provider_setting_id uuid, p_attempt_token uuid
)
returns public.generation_jobs
language plpgsql security definer set search_path = ''
as $$
declare locked_job public.generation_jobs;
begin
  select job.* into locked_job from public.generation_jobs as job where job.id = p_job_id for update;
  if locked_job.worker_attempt_token is not null then
    raise exception 'generation_worker_claim_required' using errcode = 'P0001';
  end if;
  return public.generation_direct_freeze_context_v2(
    p_job_id, p_draft_id, p_generation_mode, p_idempotency_key,
    p_context_version_ids, p_context_snapshot, p_provider_setting_id, p_attempt_token
  );
end;
$$;

create function public.freeze_generation_worker_context(
  p_job_id uuid, p_draft_id uuid, p_generation_mode text, p_idempotency_key text,
  p_context_version_ids text[], p_context_snapshot jsonb, p_provider_setting_id uuid,
  p_attempt_token uuid, p_worker_attempt_token uuid
)
returns public.generation_jobs
language plpgsql security definer set search_path = ''
as $$
declare locked_job public.generation_jobs;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'generation worker freeze caller is not authorized' using errcode = '42501'; end if;
  select job.* into locked_job from public.generation_jobs as job where job.id = p_job_id for update;
  if locked_job.id is null or locked_job.worker_attempt_token is distinct from p_worker_attempt_token
    or locked_job.worker_lease_expires_at is null or locked_job.worker_lease_expires_at <= pg_catalog.clock_timestamp()
    or not narrative_private.generation_worker_binding_valid(locked_job)
    or locked_job.worker_draft_id is distinct from p_draft_id
    or locked_job.worker_generation_mode is distinct from p_generation_mode
    or locked_job.worker_idempotency_key is distinct from p_idempotency_key
    or locked_job.worker_provider_setting_id is distinct from p_provider_setting_id then
    raise exception 'generation_worker_attempt_mismatch' using errcode = 'P0001';
  end if;
  return public.generation_direct_freeze_context_v2(
    p_job_id, p_draft_id, p_generation_mode, p_idempotency_key,
    p_context_version_ids, p_context_snapshot, p_provider_setting_id, p_attempt_token
  );
end;
$$;

create function public.reserve_and_start_generation(p_job_id uuid, p_attempt_token uuid, p_amount_micros bigint)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare locked_job public.generation_jobs;
begin
  select job.* into locked_job from public.generation_jobs as job where job.id = p_job_id for update;
  if locked_job.worker_attempt_token is not null then raise exception 'generation_worker_claim_required' using errcode = 'P0001'; end if;
  return public.generation_direct_reserve_start_v2(p_job_id, p_attempt_token, p_amount_micros);
end;
$$;

create function public.reserve_and_start_worker_generation(
  p_job_id uuid, p_attempt_token uuid, p_amount_micros bigint, p_worker_attempt_token uuid
)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare locked_job public.generation_jobs;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'generation worker reserve caller is not authorized' using errcode = '42501'; end if;
  select job.* into locked_job from public.generation_jobs as job where job.id = p_job_id for update;
  if locked_job.id is null or locked_job.worker_attempt_token is distinct from p_worker_attempt_token
    or locked_job.worker_lease_expires_at is null or locked_job.worker_lease_expires_at <= pg_catalog.clock_timestamp()
    or locked_job.attempt_token is distinct from p_attempt_token
    or not narrative_private.generation_worker_binding_valid(locked_job) then
    raise exception 'generation_worker_attempt_mismatch' using errcode = 'P0001';
  end if;
  return public.generation_direct_reserve_start_v2(p_job_id, p_attempt_token, p_amount_micros);
end;
$$;

create function public.fence_generation_provider_dispatch(
  p_job_id uuid, p_generation_attempt_token uuid, p_worker_attempt_token uuid
)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  locked_job public.generation_jobs;
  locked_draft public.drafts;
  current_provider public.provider_settings;
  settings public.narrative_admin_settings;
  source_value text;
  policy_value text;
  policy_failure text;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'generation provider fence caller is not authorized' using errcode = '42501'; end if;
  if p_job_id is null or p_generation_attempt_token is null then
    raise exception 'invalid_generation_provider_fence' using errcode = '22023';
  end if;
  select job.* into locked_job from public.generation_jobs as job where job.id = p_job_id for update;
  if locked_job.id is null then return jsonb_build_object('outcome', 'rejected', 'failureCode', 'generation_target_not_found'); end if;
  if locked_job.provider_dispatch_recorded_at is not null then
    return jsonb_build_object('outcome', 'already_dispatched');
  end if;
  if locked_job.attempt_token is distinct from p_generation_attempt_token or locked_job.status is distinct from 'running'
    or locked_job.provider_setting_id is null or locked_job.generation_mode is null or locked_job.idempotency_key is null then
    return jsonb_build_object('outcome', 'rejected', 'failureCode', 'generation_attempt_mismatch');
  end if;
  select draft.* into locked_draft from public.drafts as draft
  where draft.id = locked_job.draft_id and draft.owner_id = locked_job.owner_id for share;
  if locked_draft.id is null or locked_draft.status is distinct from 'generating'
    or locked_draft.kind is distinct from locked_job.payload ->> 'kind' then
    return jsonb_build_object('outcome', 'rejected', 'failureCode', 'generation_binding_changed');
  end if;
  source_value := locked_job.payload ->> 'source';
  policy_value := case when source_value = 'manual' then 'manual' when source_value in ('schedule', 'access') then 'schedule' else null end;
  if policy_value is null or (source_value = 'schedule' and locked_job.payload ->> 'budgetPolicy' not in ('block_at_risk', 'block_at_warning'))
    or (source_value = 'access' and locked_job.payload ->> 'budgetPolicy' is distinct from 'block_at_risk') then
    return jsonb_build_object('outcome', 'rejected', 'failureCode', 'generation_binding_changed');
  end if;
  if locked_job.worker_attempt_token is not null then
    if p_worker_attempt_token is null or locked_job.worker_attempt_token is distinct from p_worker_attempt_token
      or locked_job.worker_lease_expires_at is null or locked_job.worker_lease_expires_at <= pg_catalog.clock_timestamp() then
      return jsonb_build_object('outcome', 'rejected', 'failureCode', 'generation_worker_attempt_mismatch');
    end if;
    policy_failure := narrative_private.generation_worker_policy_failure(locked_job);
    if policy_failure is not null then
      return narrative_private.dead_letter_generation_worker_job(locked_job.id, policy_failure, false);
    end if;
  elsif p_worker_attempt_token is not null or source_value is distinct from 'manual' then
    return jsonb_build_object('outcome', 'rejected', 'failureCode', 'generation_worker_claim_required');
  end if;
  select provider.* into current_provider from public.provider_settings as provider
  where provider.id = locked_job.provider_setting_id and provider.owner_id = locked_job.owner_id and provider.enabled for share;
  select value.* into settings from public.narrative_admin_settings as value where value.owner_id = locked_job.owner_id for share;
  if current_provider.id is null
    or current_provider.model_key is distinct from locked_job.model_key
    or current_provider.max_input_tokens is distinct from locked_job.max_input_tokens
    or current_provider.max_output_tokens is distinct from locked_job.max_output_tokens
    or current_provider.max_revision_output_tokens < locked_job.max_revision_output_tokens
    or current_provider.input_cost_micros_per_million is distinct from locked_job.input_cost_micros_per_million
    or current_provider.output_cost_micros_per_million is distinct from locked_job.output_cost_micros_per_million
    or current_provider.fixed_cost_micros is distinct from locked_job.fixed_cost_micros
    or settings.owner_id is null
    or (policy_value = 'manual' and not settings.manual_generation_enabled)
    or (policy_value = 'schedule' and not settings.schedule_automation_enabled)
    or current_provider.pricing_verified_at > public.narrative_business_date(current_timestamp)
    or current_provider.pricing_verified_at < public.narrative_business_date(current_timestamp) - settings.pricing_valid_days then
    return jsonb_build_object('outcome', 'rejected', 'failureCode', 'generation_policy_changed');
  end if;
  update public.generation_jobs
  set provider_dispatch_worker_attempt_token = p_worker_attempt_token,
      provider_dispatch_generation_attempt_token = p_generation_attempt_token,
      provider_dispatch_recorded_at = pg_catalog.clock_timestamp()
  where id = locked_job.id;
  return jsonb_build_object('outcome', 'fenced');
end;
$$;

create function public.finalize_generation_success(
  p_job_id uuid, p_attempt_token uuid, p_actual_micros bigint, p_usage_json jsonb,
  p_content jsonb, p_continuity_level text, p_continuity_findings jsonb,
  p_provider_response_id text, p_provider_response_model text, p_policy_version text
)
returns public.draft_versions language plpgsql security definer set search_path = ''
as $$
declare locked_job public.generation_jobs;
begin
  select job.* into locked_job from public.generation_jobs as job where job.id = p_job_id for update;
  if locked_job.worker_attempt_token is not null then raise exception 'generation_worker_claim_required' using errcode = 'P0001'; end if;
  if locked_job.attempt_token is distinct from p_attempt_token then
    raise exception 'stale_attempt' using errcode = 'P0001';
  end if;
  if locked_job.provider_dispatch_generation_attempt_token is distinct from p_attempt_token then
    raise exception 'provider_dispatch_not_fenced' using errcode = 'P0001';
  end if;
  return public.generation_direct_finalize_success_v2(
    p_job_id, p_attempt_token, p_actual_micros, p_usage_json, p_content,
    p_continuity_level, p_continuity_findings, p_provider_response_id,
    p_provider_response_model, p_policy_version
  );
end;
$$;

create function public.finalize_worker_generation_success(
  p_job_id uuid, p_attempt_token uuid, p_actual_micros bigint, p_usage_json jsonb,
  p_content jsonb, p_continuity_level text, p_continuity_findings jsonb,
  p_provider_response_id text, p_provider_response_model text, p_policy_version text,
  p_worker_attempt_token uuid
)
returns public.draft_versions language plpgsql security definer set search_path = ''
as $$
declare locked_job public.generation_jobs;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'generation worker finalize caller is not authorized' using errcode = '42501'; end if;
  select job.* into locked_job from public.generation_jobs as job where job.id = p_job_id for update;
  if locked_job.id is null or locked_job.worker_attempt_token is distinct from p_worker_attempt_token
    or locked_job.worker_lease_expires_at is null or locked_job.worker_lease_expires_at <= pg_catalog.clock_timestamp()
    or locked_job.provider_dispatch_worker_attempt_token is distinct from p_worker_attempt_token
    or locked_job.provider_dispatch_generation_attempt_token is distinct from p_attempt_token
    or not narrative_private.generation_worker_binding_valid(locked_job) then
    raise exception 'generation_worker_attempt_mismatch' using errcode = 'P0001';
  end if;
  return public.generation_direct_finalize_success_v2(
    p_job_id, p_attempt_token, p_actual_micros, p_usage_json, p_content,
    p_continuity_level, p_continuity_findings, p_provider_response_id,
    p_provider_response_model, p_policy_version
  );
end;
$$;

create function public.abort_generation_attempt(
  p_job_id uuid, p_attempt_token uuid, p_idempotency_key text, p_failure_code text
)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare locked_job public.generation_jobs;
begin
  select job.* into locked_job from public.generation_jobs as job where job.id = p_job_id for update;
  if locked_job.worker_attempt_token is not null then return jsonb_build_object('outcome', 'stale'); end if;
  if locked_job.status = 'completed' then
    return public.generation_direct_abort_attempt_v2(p_job_id, p_attempt_token, p_idempotency_key, p_failure_code);
  end if;
  if locked_job.provider_dispatch_recorded_at is not null then
    return narrative_private.dead_letter_generation_worker_job(locked_job.id, 'provider_outcome_unknown', true);
  end if;
  return public.generation_direct_abort_attempt_v2(p_job_id, p_attempt_token, p_idempotency_key, p_failure_code);
end;
$$;

create function public.abort_worker_generation_attempt(
  p_job_id uuid, p_attempt_token uuid, p_idempotency_key text, p_failure_code text,
  p_worker_attempt_token uuid
)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare locked_job public.generation_jobs; result jsonb;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'generation worker abort caller is not authorized' using errcode = '42501'; end if;
  select job.* into locked_job from public.generation_jobs as job where job.id = p_job_id for update;
  if locked_job.id is null or locked_job.worker_attempt_token is distinct from p_worker_attempt_token
    or locked_job.worker_lease_expires_at is null or locked_job.worker_lease_expires_at <= pg_catalog.clock_timestamp()
    or locked_job.attempt_token is distinct from p_attempt_token
    or not narrative_private.generation_worker_binding_valid(locked_job) then
    return jsonb_build_object('outcome', 'stale');
  end if;
  result := public.generation_direct_abort_attempt_v2(p_job_id, p_attempt_token, p_idempotency_key, p_failure_code);
  if result ->> 'outcome' = 'aborted' then
    update public.generation_jobs set provider_setting_id = worker_provider_setting_id where id = p_job_id;
  end if;
  return result;
end;
$$;

create function public.complete_generation_worker_attempt(p_job_id uuid, p_worker_attempt_token uuid)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare locked_job public.generation_jobs;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'generation worker completion caller is not authorized' using errcode = '42501'; end if;
  if p_job_id is null or p_worker_attempt_token is null then return jsonb_build_object('outcome', 'stale'); end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('narrative-generation-worker', 0));
  select job.* into locked_job from public.generation_jobs as job where job.id = p_job_id for update;
  if locked_job.id is null or locked_job.worker_attempt_token is distinct from p_worker_attempt_token then
    return jsonb_build_object('outcome', 'stale');
  end if;
  if locked_job.status = 'failed' and locked_job.worker_failure_code is not null then
    return jsonb_build_object('outcome', 'dead_lettered', 'jobId', locked_job.id, 'failureCode', locked_job.worker_failure_code);
  end if;
  if locked_job.status is distinct from 'completed' or not exists (
    select 1 from public.draft_versions as version
    where version.generation_job_id = locked_job.id and version.owner_id = locked_job.owner_id
      and version.draft_id = locked_job.worker_draft_id
  ) or not exists (
    select 1 from public.budget_entries as entry
    where entry.generation_job_id = locked_job.id and entry.owner_id = locked_job.owner_id
      and entry.entry_type in ('reconciliation', 'failure')
  ) then return jsonb_build_object('outcome', 'stale'); end if;
  update public.generation_jobs
  set worker_lease_expires_at = null, worker_retry_at = null,
      worker_completed_at = coalesce(worker_completed_at, now()), worker_failure_code = null
  where id = locked_job.id;
  return jsonb_build_object('outcome', 'completed', 'jobId', locked_job.id);
end;
$$;

create function public.fail_generation_worker_attempt(
  p_job_id uuid, p_worker_attempt_token uuid, p_failure_code text
)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare locked_job public.generation_jobs; policy_failure text;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'generation worker failure caller is not authorized' using errcode = '42501'; end if;
  if p_job_id is null or p_worker_attempt_token is null then return jsonb_build_object('outcome', 'stale'); end if;
  if p_failure_code is null or length(p_failure_code) > 100 or p_failure_code !~ '^[a-z0-9_]+$' then
    raise exception 'invalid_generation_worker_failure' using errcode = '22023';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('narrative-generation-worker', 0));
  select job.* into locked_job from public.generation_jobs as job where job.id = p_job_id for update;
  if locked_job.id is null or locked_job.worker_attempt_token is distinct from p_worker_attempt_token then
    return jsonb_build_object('outcome', 'stale');
  end if;
  if locked_job.status = 'completed' then return public.complete_generation_worker_attempt(p_job_id, p_worker_attempt_token); end if;
  if locked_job.status = 'failed' and locked_job.worker_failure_code is not null then
    return jsonb_build_object('outcome', 'dead_lettered', 'jobId', locked_job.id, 'failureCode', locked_job.worker_failure_code);
  end if;
  if locked_job.worker_lease_expires_at is null or locked_job.worker_lease_expires_at <= pg_catalog.clock_timestamp() then
    return jsonb_build_object('outcome', 'stale');
  end if;
  if locked_job.provider_dispatch_recorded_at is not null then
    return narrative_private.dead_letter_generation_worker_job(locked_job.id, 'provider_outcome_unknown', true);
  end if;
  policy_failure := narrative_private.generation_worker_policy_failure(locked_job);
  if policy_failure is not null then
    return narrative_private.dead_letter_generation_worker_job(locked_job.id, policy_failure, false);
  end if;
  if p_failure_code in (
    'manual_generation_disabled', 'schedule_automation_disabled', 'active_provider_setting_required',
    'stale_provider_pricing', 'invalid_provider_pricing', 'budget_blocked', 'manual_call_limit_reached',
    'generation_worker_attempt_mismatch', 'generation_binding_changed'
  ) then
    return narrative_private.dead_letter_generation_worker_job(
      locked_job.id,
      case
        when p_failure_code in ('manual_generation_disabled', 'schedule_automation_disabled') then 'worker_policy_disabled'
        when p_failure_code in ('active_provider_setting_required') then 'worker_provider_changed'
        when p_failure_code in ('stale_provider_pricing', 'invalid_provider_pricing') then 'worker_pricing_invalid'
        when p_failure_code in ('budget_blocked', 'manual_call_limit_reached') then 'worker_budget_blocked'
        else 'worker_binding_changed' end,
      false
    );
  end if;
  return narrative_private.retry_generation_worker_job(locked_job.id);
end;
$$;

-- Owner/operator dashboard projection. Tokens, command payload, context,
-- provider response metadata, and provider bindings never enter this JSON.
alter function public.get_narrative_dashboard() rename to get_narrative_dashboard_v1;
create function public.get_narrative_dashboard()
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare base jsonb; recent_queue jsonb;
begin
  perform narrative_private.require_narrative_owner();
  base := public.get_narrative_dashboard_v1();
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', item.id,
    'source', case when item.payload ->> 'source' in ('manual', 'schedule', 'access') then item.payload ->> 'source' else 'unknown' end,
    'state', case
      when item.status = 'completed' then 'completed'
      when item.status in ('failed', 'cancelled') then 'failed/dead-letter'
      when item.worker_retry_at is not null and item.worker_retry_at > pg_catalog.clock_timestamp() then 'retry-wait'
      when item.worker_attempt_token is not null and item.worker_lease_expires_at > pg_catalog.clock_timestamp() then 'running'
      when item.status = 'running' then 'running'
      else 'queued' end,
    'attemptCount', item.worker_attempt_count,
    'retryAt', item.worker_retry_at,
    'leaseExpiresAt', item.worker_lease_expires_at,
    'failureCode', coalesce(item.worker_failure_code, item.failure_code),
    'scheduledFor', item.scheduled_for
  ) order by item.created_at desc, item.id desc), '[]'::jsonb)
  into recent_queue
  from (
    select job.* from public.generation_jobs as job
    where job.owner_id = auth.uid()
    order by job.created_at desc, job.id desc limit 25
  ) as item;
  return coalesce(base, '{}'::jsonb) || jsonb_build_object('queue', recent_queue);
end;
$$;

-- Vault names only. Provisioning supplies both values outside source control.
create function narrative_private.generation_worker_dispatch_material()
returns table(url text, body jsonb, headers jsonb)
language plpgsql security definer set search_path = ''
as $$
declare worker_url text; dispatch_token text;
begin
  select decrypted_secret into worker_url from vault.decrypted_secrets
  where name = 'narrative_generation_worker_url';
  select decrypted_secret into dispatch_token from vault.decrypted_secrets
  where name = 'narrative_schedule_dispatch_token';
  if nullif(btrim(worker_url), '') is null or nullif(btrim(dispatch_token), '') is null then
    raise exception 'generation_worker_runtime_not_configured' using errcode = 'P0001';
  end if;
  return query select worker_url, jsonb_build_object('action', 'dispatch'),
    jsonb_build_object('content-type', 'application/json', 'x-schedule-dispatch-token', dispatch_token);
end;
$$;

create function narrative_private.invoke_generation_worker()
returns void language plpgsql security definer set search_path = ''
as $$
declare request record;
begin
  select material.* into request from narrative_private.generation_worker_dispatch_material() as material;
  perform net.http_post(url := request.url, body := request.body, headers := request.headers);
end;
$$;

select cron.schedule(
  'narrative-generation-worker', '* * * * *',
  $$select narrative_private.invoke_generation_worker()$$
) where not exists (select 1 from cron.job where jobname = 'narrative-generation-worker');

revoke all on function narrative_private.generation_worker_binding_valid(public.generation_jobs) from public, anon, authenticated, service_role;
revoke all on function narrative_private.generation_worker_policy_failure(public.generation_jobs) from public, anon, authenticated, service_role;
revoke all on function narrative_private.dead_letter_generation_worker_job(uuid, text, boolean) from public, anon, authenticated, service_role;
revoke all on function narrative_private.retry_generation_worker_job(uuid) from public, anon, authenticated, service_role;
revoke all on function narrative_private.generation_worker_dispatch_material() from public, anon, authenticated, service_role;
revoke all on function narrative_private.invoke_generation_worker() from public, anon, authenticated, service_role;
revoke all on function public.generation_direct_freeze_context_v2(uuid, uuid, text, text, text[], jsonb, uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function public.generation_direct_reserve_start_v2(uuid, uuid, bigint) from public, anon, authenticated, service_role;
revoke all on function public.generation_direct_finalize_success_v2(uuid, uuid, bigint, jsonb, jsonb, text, jsonb, text, text, text) from public, anon, authenticated, service_role;
revoke all on function public.generation_direct_abort_attempt_v2(uuid, uuid, text, text) from public, anon, authenticated, service_role;

revoke all on function public.claim_generation_worker_job(uuid) from public, anon, authenticated, service_role;
revoke all on function public.renew_generation_worker_claim(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function public.freeze_generation_context(uuid, uuid, text, text, text[], jsonb, uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function public.freeze_generation_worker_context(uuid, uuid, text, text, text[], jsonb, uuid, uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function public.reserve_and_start_generation(uuid, uuid, bigint) from public, anon, authenticated, service_role;
revoke all on function public.reserve_and_start_worker_generation(uuid, uuid, bigint, uuid) from public, anon, authenticated, service_role;
revoke all on function public.fence_generation_provider_dispatch(uuid, uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function public.finalize_generation_success(uuid, uuid, bigint, jsonb, jsonb, text, jsonb, text, text, text) from public, anon, authenticated, service_role;
revoke all on function public.finalize_worker_generation_success(uuid, uuid, bigint, jsonb, jsonb, text, jsonb, text, text, text, uuid) from public, anon, authenticated, service_role;
revoke all on function public.abort_generation_attempt(uuid, uuid, text, text) from public, anon, authenticated, service_role;
revoke all on function public.abort_worker_generation_attempt(uuid, uuid, text, text, uuid) from public, anon, authenticated, service_role;
revoke all on function public.complete_generation_worker_attempt(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function public.fail_generation_worker_attempt(uuid, uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.get_narrative_dashboard_v1() from public, anon, authenticated, service_role;
revoke all on function public.get_narrative_dashboard() from public, anon, authenticated, service_role;

grant execute on function public.claim_generation_worker_job(uuid) to service_role;
grant execute on function public.renew_generation_worker_claim(uuid, uuid) to service_role;
grant execute on function public.freeze_generation_context(uuid, uuid, text, text, text[], jsonb, uuid, uuid) to service_role;
grant execute on function public.freeze_generation_worker_context(uuid, uuid, text, text, text[], jsonb, uuid, uuid, uuid) to service_role;
grant execute on function public.reserve_and_start_generation(uuid, uuid, bigint) to service_role;
grant execute on function public.reserve_and_start_worker_generation(uuid, uuid, bigint, uuid) to service_role;
grant execute on function public.fence_generation_provider_dispatch(uuid, uuid, uuid) to service_role;
grant execute on function public.finalize_generation_success(uuid, uuid, bigint, jsonb, jsonb, text, jsonb, text, text, text) to service_role;
grant execute on function public.finalize_worker_generation_success(uuid, uuid, bigint, jsonb, jsonb, text, jsonb, text, text, text, uuid) to service_role;
grant execute on function public.abort_generation_attempt(uuid, uuid, text, text) to service_role;
grant execute on function public.abort_worker_generation_attempt(uuid, uuid, text, text, uuid) to service_role;
grant execute on function public.complete_generation_worker_attempt(uuid, uuid) to service_role;
grant execute on function public.fail_generation_worker_attempt(uuid, uuid, text) to service_role;
grant execute on function public.get_narrative_dashboard() to authenticated;
