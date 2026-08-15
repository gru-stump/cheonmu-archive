alter table public.generation_jobs
  add column requested_max_output_tokens integer check (requested_max_output_tokens is null or requested_max_output_tokens > 0),
  add column confirmed_maximum_cost_micros bigint check (confirmed_maximum_cost_micros is null or confirmed_maximum_cost_micros >= 0),
  add column source_draft_version_id uuid,
  add constraint generation_jobs_owner_source_version_fkey
    foreign key (owner_id, source_draft_version_id)
    references public.draft_versions (owner_id, id)
    on delete restrict;

create function public.save_manual_draft_version(
  p_draft_id uuid,
  p_expected_version_id uuid,
  p_expected_state text,
  p_content jsonb
)
returns public.draft_versions
language plpgsql
security definer
set search_path = ''
as $$
declare
  locked_draft public.drafts;
  locked_version public.draft_versions;
  created_version public.draft_versions;
begin
  if auth.role() is distinct from 'authenticated' or auth.uid() is null then
    raise exception 'manual version caller is not authorized' using errcode = '42501';
  end if;
  if p_draft_id is null or p_expected_version_id is null or p_expected_state is distinct from 'reviewing'
    or p_content is null or jsonb_typeof(p_content) <> 'object'
    or nullif(btrim(p_content ->> 'title'), '') is null
    or nullif(btrim(p_content ->> 'body'), '') is null
    or jsonb_typeof(p_content -> 'canonChangeCandidates') is distinct from 'array' then
    raise exception 'invalid_manual_version' using errcode = '22023';
  end if;

  select draft.* into locked_draft from public.drafts as draft where draft.id = p_draft_id for update;
  if locked_draft.id is null or locked_draft.owner_id is distinct from auth.uid() then
    raise exception 'manual version target not found' using errcode = 'P0002';
  end if;
  select version.* into locked_version
  from public.draft_versions as version
  where version.id = p_expected_version_id
    and version.owner_id = locked_draft.owner_id
    and version.draft_id = locked_draft.id
    and version.version_number = (
      select max(latest.version_number) from public.draft_versions as latest
      where latest.owner_id = locked_draft.owner_id and latest.draft_id = locked_draft.id
    )
  for update;
  if locked_version.id is null or locked_draft.status is distinct from p_expected_state then
    raise exception 'stale_manual_version' using errcode = 'P0001';
  end if;
  if locked_version.continuity_level = 'block' then
    raise exception 'blocked_version_reject_only' using errcode = 'P0001';
  end if;

  insert into public.draft_versions (
    owner_id, draft_id, version_number, content, context_version_ids, context_snapshot,
    continuity_level, continuity_findings, continuity_policy_version
  ) values (
    locked_draft.owner_id, locked_draft.id, locked_version.version_number + 1, p_content,
    locked_version.context_version_ids, locked_version.context_snapshot, 'review',
    jsonb_build_array(jsonb_build_object(
      'code', 'manual_edit_requires_review', 'level', 'review',
      'message', '직접 수정된 버전은 사용자 최종 검토가 필요합니다.',
      'sourceIds', to_jsonb(locked_version.context_version_ids)
    )),
    'cheonmu-continuity-v1'
  ) returning * into created_version;

  update public.drafts
  set title = p_content ->> 'title', body = p_content ->> 'body', updated_at = now()
  where id = locked_draft.id and owner_id = locked_draft.owner_id;
  insert into public.audit_events (owner_id, event_type, entity_type, entity_id, payload)
  values (locked_draft.owner_id, 'manual_draft_version_created', 'draft', locked_draft.id,
    jsonb_build_object('sourceVersionId', locked_version.id, 'createdVersionId', created_version.id));
  return created_version;
end;
$$;

create function public.queue_draft_revision(
  p_draft_id uuid,
  p_expected_version_id uuid,
  p_selected_text text,
  p_instruction text,
  p_requested_max_output_tokens integer,
  p_confirmed_maximum_cost_micros bigint
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  locked_draft public.drafts;
  locked_version public.draft_versions;
  locked_setting public.provider_settings;
  active_settings integer;
  expected_cost bigint;
  created_job public.generation_jobs;
  generation_key text := 'revision-' || gen_random_uuid()::text;
begin
  if auth.role() is distinct from 'authenticated' or auth.uid() is null then
    raise exception 'revision caller is not authorized' using errcode = '42501';
  end if;
  if p_draft_id is null or p_expected_version_id is null or nullif(btrim(p_selected_text), '') is null
    or nullif(btrim(p_instruction), '') is null or length(p_selected_text) > 4000 or length(p_instruction) > 1000
    or p_requested_max_output_tokens is null or p_requested_max_output_tokens < 1
    or p_confirmed_maximum_cost_micros is null or p_confirmed_maximum_cost_micros < 0 then
    raise exception 'invalid_revision_request' using errcode = '22023';
  end if;
  select draft.* into locked_draft from public.drafts as draft where draft.id = p_draft_id for update;
  if locked_draft.id is null or locked_draft.owner_id is distinct from auth.uid() then
    raise exception 'revision target not found' using errcode = 'P0002';
  end if;
  select version.* into locked_version
  from public.draft_versions as version
  where version.id = p_expected_version_id and version.owner_id = locked_draft.owner_id and version.draft_id = locked_draft.id
    and version.version_number = (select max(latest.version_number) from public.draft_versions as latest where latest.owner_id = locked_draft.owner_id and latest.draft_id = locked_draft.id)
  for update;
  if locked_version.id is null or locked_draft.status <> 'reviewing' then
    raise exception 'stale_revision' using errcode = 'P0001';
  end if;
  if locked_version.continuity_level = 'block' then
    raise exception 'blocked_version_reject_only' using errcode = 'P0001';
  end if;
  if strpos(coalesce(locked_version.content ->> 'body', ''), p_selected_text) = 0 then
    raise exception 'revision_selection_not_found' using errcode = '22023';
  end if;

  select count(*) into active_settings
  from public.provider_settings as setting where setting.owner_id = locked_draft.owner_id and setting.enabled;
  if active_settings <> 1 then raise exception 'active_provider_setting_required' using errcode = 'P0001'; end if;
  select setting.* into locked_setting from public.provider_settings as setting where setting.owner_id = locked_draft.owner_id and setting.enabled for share;
  if p_requested_max_output_tokens > locked_setting.max_revision_output_tokens then
    raise exception 'revision_token_limit_exceeded' using errcode = '22023';
  end if;
  expected_cost := locked_setting.fixed_cost_micros
    + ceil(locked_setting.max_input_tokens::numeric * locked_setting.input_cost_micros_per_million / 1000000)::bigint
    + ceil(p_requested_max_output_tokens::numeric * locked_setting.output_cost_micros_per_million / 1000000)::bigint;
  if expected_cost is distinct from p_confirmed_maximum_cost_micros then
    raise exception 'revision_cost_changed' using errcode = 'P0001';
  end if;

  insert into public.generation_jobs (
    owner_id, draft_id, schedule_key, scheduled_for, status, payload,
    requested_max_output_tokens, confirmed_maximum_cost_micros, source_draft_version_id
  ) values (
    locked_draft.owner_id, locked_draft.id, generation_key, now(), 'queued',
    jsonb_build_object(
      'mode', 'revise_selection', 'sourceVersionId', locked_version.id,
      'revision', jsonb_build_object('selectedText', p_selected_text, 'instruction', p_instruction),
      'requestedMaxOutputTokens', p_requested_max_output_tokens,
      'confirmedMaximumCostMicros', p_confirmed_maximum_cost_micros
    ),
    p_requested_max_output_tokens, p_confirmed_maximum_cost_micros, locked_version.id
  ) returning * into created_job;
  update public.drafts set status = 'queued', updated_at = now()
  where id = locked_draft.id and owner_id = locked_draft.owner_id and status = 'reviewing';
  insert into public.audit_events (owner_id, event_type, entity_type, entity_id, payload)
  values (locked_draft.owner_id, 'draft_revision_queued', 'draft', locked_draft.id,
    jsonb_build_object('sourceVersionId', locked_version.id, 'generationJobId', created_job.id,
      'requestedMaxOutputTokens', p_requested_max_output_tokens, 'confirmedMaximumCostMicros', p_confirmed_maximum_cost_micros));
  return jsonb_build_object('job_id', created_job.id, 'idempotency_key', generation_key, 'draft_id', locked_draft.id, 'kind', locked_draft.kind);
end;
$$;

-- The existing service-only freeze remains the generation authority. For a
-- revision prepared by the owner RPC, narrow its frozen output ceiling and
-- reservation to the exact confirmed values retained on the job.
create or replace function public.freeze_generation_context(
  p_job_id uuid, p_draft_id uuid, p_generation_mode text, p_idempotency_key text,
  p_context_version_ids text[], p_context_snapshot jsonb, p_provider_setting_id uuid, p_attempt_token uuid
)
returns public.generation_jobs
language plpgsql
security definer
set search_path = ''
as $$
declare
  locked_job public.generation_jobs;
  frozen_job public.generation_jobs;
  confirmed_cost bigint;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'generation freeze caller is not authorized' using errcode = '42501'; end if;
  if p_attempt_token is null then raise exception 'invalid_attempt_token' using errcode = '22023'; end if;
  select job.* into locked_job from public.generation_jobs as job where job.id = p_job_id for update;
  if locked_job.id is null then raise exception 'generation target not found' using errcode = 'P0002'; end if;
  if locked_job.attempt_token is not null then raise exception 'duplicate_generation' using errcode = 'P0001'; end if;

  perform public.generation_internal_freeze_context_v1(
    p_job_id, p_draft_id, p_generation_mode, p_idempotency_key,
    p_context_version_ids, p_context_snapshot, p_provider_setting_id
  );
  if p_generation_mode = 'revise_selection' and locked_job.requested_max_output_tokens is not null then
    update public.generation_jobs
    set max_revision_output_tokens = least(max_output_tokens, max_revision_output_tokens, locked_job.requested_max_output_tokens),
        worst_case_cost_micros = fixed_cost_micros
          + ceil(max_input_tokens::numeric * input_cost_micros_per_million / 1000000)::bigint
          + ceil(least(max_output_tokens, max_revision_output_tokens, locked_job.requested_max_output_tokens)::numeric * output_cost_micros_per_million / 1000000)::bigint
    where id = p_job_id returning * into frozen_job;
    confirmed_cost := frozen_job.worst_case_cost_micros;
    if confirmed_cost is distinct from locked_job.confirmed_maximum_cost_micros then
      raise exception 'revision_cost_changed' using errcode = 'P0001';
    end if;
  end if;
  update public.generation_jobs set attempt_token = p_attempt_token where id = p_job_id returning * into frozen_job;
  return frozen_job;
exception when unique_violation then
  raise exception 'duplicate_generation' using errcode = 'P0001';
end;
$$;

create function public.archive_narrative_draft(p_draft_id uuid, p_expected_version_id uuid, p_expected_state text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare locked_draft public.drafts; locked_version public.draft_versions;
begin
  if auth.role() is distinct from 'authenticated' or auth.uid() is null then raise exception 'archive caller is not authorized' using errcode = '42501'; end if;
  select draft.* into locked_draft from public.drafts as draft where draft.id = p_draft_id for update;
  if locked_draft.id is null or locked_draft.owner_id is distinct from auth.uid() then raise exception 'archive target not found' using errcode = 'P0002'; end if;
  select version.* into locked_version from public.draft_versions as version where version.id = p_expected_version_id and version.owner_id = locked_draft.owner_id and version.draft_id = locked_draft.id and version.version_number = (select max(latest.version_number) from public.draft_versions as latest where latest.owner_id = locked_draft.owner_id and latest.draft_id = locked_draft.id) for update;
  if locked_version.id is null or locked_draft.status is distinct from p_expected_state or p_expected_state = 'archived' then raise exception 'stale_archive' using errcode = 'P0001'; end if;
  if locked_version.continuity_level = 'block' then raise exception 'blocked_version_reject_only' using errcode = 'P0001'; end if;
  update public.drafts set status = 'archived', updated_at = now() where id = locked_draft.id;
  insert into public.audit_events (owner_id, event_type, entity_type, entity_id, payload) values (locked_draft.owner_id, 'draft_archived', 'draft', locked_draft.id, jsonb_build_object('previousState', p_expected_state, 'versionId', locked_version.id));
  return jsonb_build_object('status', 'archived');
end; $$;

create function public.retry_narrative_publish(p_draft_id uuid, p_expected_version_id uuid, p_expected_state text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare locked_draft public.drafts; locked_version public.draft_versions; locked_publish public.publish_jobs;
begin
  if auth.role() is distinct from 'authenticated' or auth.uid() is null then raise exception 'publish retry caller is not authorized' using errcode = '42501'; end if;
  if p_expected_state is distinct from 'publish_failed' then raise exception 'invalid_publish_retry' using errcode = '22023'; end if;
  select draft.* into locked_draft from public.drafts as draft where draft.id = p_draft_id for update;
  if locked_draft.id is null or locked_draft.owner_id is distinct from auth.uid() then raise exception 'publish retry target not found' using errcode = 'P0002'; end if;
  select version.* into locked_version from public.draft_versions as version where version.id = p_expected_version_id and version.owner_id = locked_draft.owner_id and version.draft_id = locked_draft.id and version.version_number = (select max(latest.version_number) from public.draft_versions as latest where latest.owner_id = locked_draft.owner_id and latest.draft_id = locked_draft.id) for update;
  select job.* into locked_publish from public.publish_jobs as job where job.owner_id = locked_draft.owner_id and job.draft_id = locked_draft.id and job.draft_version_id = p_expected_version_id for update;
  if locked_version.id is null or locked_draft.status <> 'publish_failed' or locked_publish.id is null or locked_publish.status <> 'failed' then raise exception 'stale_publish_retry' using errcode = 'P0001'; end if;
  if locked_version.continuity_level = 'block' then raise exception 'blocked_version_reject_only' using errcode = 'P0001'; end if;
  update public.publish_jobs set status = 'queued', updated_at = now() where id = locked_publish.id;
  update public.drafts set status = 'publishing', updated_at = now() where id = locked_draft.id;
  insert into public.audit_events (owner_id, event_type, entity_type, entity_id, payload) values (locked_draft.owner_id, 'publish_retried', 'draft', locked_draft.id, jsonb_build_object('versionId', locked_version.id, 'publishJobId', locked_publish.id));
  return jsonb_build_object('status', 'publishing');
end; $$;

create function narrative_private.next_enabled_schedule(p_owner_id uuid, p_after timestamptz)
returns timestamptz
language sql
stable
security definer
set search_path = ''
as $$
  select min(candidate.local_minute at time zone 'Asia/Seoul')
  from public.schedules as schedule
  cross join lateral generate_series(
    date_trunc('minute', p_after at time zone 'Asia/Seoul') + interval '1 minute',
    date_trunc('minute', p_after at time zone 'Asia/Seoul') + interval '8 days',
    interval '1 minute'
  ) as candidate(local_minute)
  where schedule.owner_id = p_owner_id
    and schedule.enabled
    and schedule.schedule_type = 'automatic'
    and extract(minute from candidate.local_minute)::integer = split_part(schedule.cron_expression, ' ', 1)::integer
    and extract(hour from candidate.local_minute)::integer = split_part(schedule.cron_expression, ' ', 2)::integer
    and (
      split_part(schedule.cron_expression, ' ', 5) = '*'
      or extract(dow from candidate.local_minute)::integer = split_part(schedule.cron_expression, ' ', 5)::integer
    );
$$;

revoke all on function narrative_private.next_enabled_schedule(uuid, timestamptz)
  from public, anon, authenticated, service_role;

create function public.get_narrative_dashboard()
returns jsonb language plpgsql security definer set search_path = '' stable as $$
declare result jsonb;
begin
  if auth.role() is distinct from 'authenticated' or auth.uid() is null then raise exception 'dashboard caller is not authorized' using errcode = '42501'; end if;
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
      select min(candidate.at)
      from (
        select job.scheduled_for as at from public.generation_jobs as job
        where job.owner_id = auth.uid() and job.status = 'queued' and job.scheduled_for >= now()
        union all
        select narrative_private.next_enabled_schedule(auth.uid(), now())
      ) as candidate
    ),
    'lastSuccessAt', (select max(version.created_at) from public.draft_versions as version where version.owner_id = auth.uid()),
    'failures', coalesce((select jsonb_agg(jsonb_build_object('id', failed.id, 'occurredAt', coalesce(failed.failure_at, failed.created_at), 'code', coalesce(failed.failure_code, 'generation_failed')) order by coalesce(failed.failure_at, failed.created_at) desc) from (select job.* from public.generation_jobs as job where job.owner_id = auth.uid() and job.status = 'failed' order by coalesce(job.failure_at, job.created_at) desc limit 10) as failed), '[]'::jsonb)
  ) into result from current_period right join totals on true;
  return coalesce(result, jsonb_build_object('budget', jsonb_build_object('dailySpentMicros',0,'monthlySpentMicros',0,'reservedMicros',0,'dailyRemainingMicros',0,'monthlyRemainingMicros',0),'nextScheduleAt',null,'lastSuccessAt',null,'failures','[]'::jsonb));
end; $$;

revoke all on function public.save_manual_draft_version(uuid, uuid, text, jsonb), public.queue_draft_revision(uuid, uuid, text, text, integer, bigint), public.archive_narrative_draft(uuid, uuid, text), public.retry_narrative_publish(uuid, uuid, text), public.get_narrative_dashboard() from public, anon, authenticated, service_role;
grant execute on function public.save_manual_draft_version(uuid, uuid, text, jsonb), public.queue_draft_revision(uuid, uuid, text, text, integer, bigint), public.archive_narrative_draft(uuid, uuid, text), public.retry_narrative_publish(uuid, uuid, text), public.get_narrative_dashboard() to authenticated;
