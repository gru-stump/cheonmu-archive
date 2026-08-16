alter table public.provider_settings
  add column model_key text not null default 'fake-local-model',
  add column max_input_tokens integer not null default 4096 check (max_input_tokens > 0),
  add column max_output_tokens integer not null default 1024 check (max_output_tokens > 0),
  add column max_revision_output_tokens integer not null default 256 check (max_revision_output_tokens > 0 and max_revision_output_tokens <= max_output_tokens),
  add column input_cost_micros_per_million bigint not null default 0 check (input_cost_micros_per_million >= 0),
  add column output_cost_micros_per_million bigint not null default 0 check (output_cost_micros_per_million >= 0),
  add column fixed_cost_micros bigint not null default 0 check (fixed_cost_micros >= 0),
  add constraint provider_settings_owner_id_id_key unique (owner_id, id);

with ranked_active as (
  select id, row_number() over (partition by owner_id order by updated_at desc, id) as owner_rank
  from public.provider_settings
  where enabled
)
update public.provider_settings as setting
set enabled = false
from ranked_active
where setting.id = ranked_active.id and ranked_active.owner_rank > 1;

create unique index provider_settings_one_active_per_owner_idx
  on public.provider_settings (owner_id)
  where enabled;

alter table public.generation_jobs
  add column context_snapshot jsonb not null default '[]'::jsonb check (jsonb_typeof(context_snapshot) = 'array'),
  add column provider_setting_id uuid,
  add column model_key text,
  add column max_input_tokens integer check (max_input_tokens > 0),
  add column max_output_tokens integer check (max_output_tokens > 0),
  add column max_revision_output_tokens integer check (max_revision_output_tokens > 0),
  add column input_cost_micros_per_million bigint check (input_cost_micros_per_million >= 0),
  add column output_cost_micros_per_million bigint check (output_cost_micros_per_million >= 0),
  add column fixed_cost_micros bigint check (fixed_cost_micros >= 0),
  add column worst_case_cost_micros bigint check (worst_case_cost_micros >= 0),
  add column failure_code text,
  add column failure_at timestamptz,
  add constraint generation_jobs_owner_provider_setting_fkey
    foreign key (owner_id, provider_setting_id)
    references public.provider_settings (owner_id, id)
    on delete restrict;

alter table public.draft_versions
  add column continuity_policy_version text,
  add column context_snapshot jsonb not null default '[]'::jsonb check (jsonb_typeof(context_snapshot) = 'array');

-- The old writer split storage from budget settlement.  Removing it makes the
-- transaction boundary below the only authenticated path to a generated draft.
revoke all on function public.store_generation_result(uuid, jsonb, text, jsonb, text)
  from public, anon, authenticated, service_role;
drop function public.store_generation_result(uuid, jsonb, text, jsonb, text);

drop function public.freeze_generation_context(uuid, uuid, text, text, text[]);

create function public.freeze_generation_context(
  p_job_id uuid,
  p_draft_id uuid,
  p_generation_mode text,
  p_idempotency_key text,
  p_context_version_ids text[],
  p_context_snapshot jsonb,
  p_provider_setting_id uuid
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
  locked_setting public.provider_settings;
  snapshot_ids text[];
  snapshot_tokens bigint;
  effective_output_tokens bigint;
begin
  if p_idempotency_key is null or btrim(p_idempotency_key) = ''
    or p_generation_mode not in ('new', 'revise_selection', 'major_event_scene_plan', 'major_event_draft')
    or p_context_version_ids is null or cardinality(p_context_version_ids) = 0
    or p_context_snapshot is null or jsonb_typeof(p_context_snapshot) <> 'array' then
    raise exception 'invalid_generation_context' using errcode = '22023';
  end if;

  select array_agg(item.value ->> 'versionId' order by item.ordinality),
         coalesce(sum((item.value ->> 'tokenCount')::bigint), 0)
  into snapshot_ids, snapshot_tokens
  from jsonb_array_elements(p_context_snapshot) with ordinality as item(value, ordinality);
  if snapshot_ids is distinct from p_context_version_ids
    or exists (select 1 from unnest(snapshot_ids) as source_id where source_id is null or btrim(source_id) = '') then
    raise exception 'context_snapshot_version_mismatch' using errcode = '22023';
  end if;

  select job.* into locked_job from public.generation_jobs as job where job.id = p_job_id for update;
  select draft.* into locked_draft from public.drafts as draft where draft.id = p_draft_id for update;
  if locked_job.id is null or locked_draft.id is null or locked_job.owner_id is distinct from locked_draft.owner_id
    or (caller_role = 'authenticated' and auth.uid() is distinct from locked_job.owner_id) then
    raise exception 'generation target not found' using errcode = 'P0002';
  end if;
  if caller_role is null or caller_role not in ('authenticated', 'service_role') then
    raise exception 'generation caller is not authorized' using errcode = '42501';
  end if;
  if locked_job.idempotency_key is not null then raise exception 'duplicate_generation' using errcode = 'P0001'; end if;
  if locked_draft.status <> 'queued' or locked_job.status <> 'queued' then raise exception 'stale_transition' using errcode = 'P0001'; end if;
  if p_generation_mode in ('major_event_scene_plan', 'major_event_draft') and locked_draft.kind <> 'major_event_proposal' then
    raise exception 'mode_kind_mismatch' using errcode = 'P0001';
  end if;

  select setting.* into locked_setting
  from public.provider_settings as setting
  where setting.id = p_provider_setting_id and setting.owner_id = locked_job.owner_id and setting.enabled
  for update;
  if locked_setting.id is null then raise exception 'active_provider_setting_required' using errcode = 'P0001'; end if;
  if snapshot_tokens > locked_setting.max_input_tokens then raise exception 'context_budget_too_small' using errcode = 'P0001'; end if;

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
  end if;

  effective_output_tokens := case when p_generation_mode = 'revise_selection'
    then least(locked_setting.max_output_tokens, locked_setting.max_revision_output_tokens)
    else locked_setting.max_output_tokens end;

  update public.generation_jobs
  set draft_id = locked_draft.id,
      idempotency_key = p_idempotency_key,
      generation_mode = p_generation_mode,
      context_version_ids = p_context_version_ids,
      context_snapshot = p_context_snapshot,
      provider_setting_id = locked_setting.id,
      model_key = locked_setting.model_key,
      max_input_tokens = locked_setting.max_input_tokens,
      max_output_tokens = locked_setting.max_output_tokens,
      max_revision_output_tokens = locked_setting.max_revision_output_tokens,
      input_cost_micros_per_million = locked_setting.input_cost_micros_per_million,
      output_cost_micros_per_million = locked_setting.output_cost_micros_per_million,
      fixed_cost_micros = locked_setting.fixed_cost_micros,
      worst_case_cost_micros = locked_setting.fixed_cost_micros
        + ceil(locked_setting.max_input_tokens::numeric * locked_setting.input_cost_micros_per_million / 1000000)::bigint
        + ceil(effective_output_tokens::numeric * locked_setting.output_cost_micros_per_million / 1000000)::bigint,
      failure_code = null,
      failure_at = null
  where id = locked_job.id
  returning * into locked_job;
  return locked_job;
exception when unique_violation then
  raise exception 'duplicate_generation' using errcode = 'P0001';
end;
$$;

create function public.reserve_and_start_generation(p_job_id uuid, p_amount_micros bigint)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_role text := auth.role();
  locked_job public.generation_jobs;
  locked_draft public.drafts;
  reservation public.budget_entries;
  active_period public.budget_periods;
  daily_used numeric;
  period_used numeric;
  remaining bigint;
  blocked_status text;
begin
  select job.* into locked_job from public.generation_jobs as job where job.id = p_job_id for update;
  select draft.* into locked_draft from public.drafts as draft where draft.id = locked_job.draft_id for update;
  if locked_job.id is null or locked_draft.id is null or (caller_role = 'authenticated' and auth.uid() is distinct from locked_job.owner_id) then
    raise exception 'generation target not found' using errcode = 'P0002';
  end if;
  if caller_role is null or caller_role not in ('authenticated', 'service_role') then raise exception 'generation caller is not authorized' using errcode = '42501'; end if;
  if locked_job.status <> 'queued' or locked_draft.status <> 'queued' or locked_job.idempotency_key is null
    or p_amount_micros is distinct from locked_job.worst_case_cost_micros then
    raise exception 'stale_transition' using errcode = 'P0001';
  end if;

  begin
    reservation := public.reserve_generation_budget(locked_job.id, p_amount_micros);
  exception
    when sqlstate 'P0001' then
      if sqlerrm <> 'budget_limit_exceeded' then raise; end if;
      blocked_status := 'limit_reached';
    when sqlstate 'P0002' then
      if sqlerrm <> 'active budget period not found' then raise; end if;
      blocked_status := 'unconfigured';
  end;

  if blocked_status is not null then
    select period.* into active_period from public.budget_periods as period
    where period.owner_id = locked_job.owner_id and period.currency = 'USD'
      and public.narrative_business_date(current_timestamp) between period.period_start and period.period_end
    order by period.period_start desc limit 1;
    if active_period.id is not null then
      select coalesce(sum(amount_micros), 0) into daily_used from public.budget_entries
      where budget_period_id = active_period.id and daily_bucket_date = public.narrative_business_date(current_timestamp);
      select coalesce(sum(amount_micros), 0) into period_used from public.budget_entries where budget_period_id = active_period.id;
      remaining := greatest(0, least(active_period.daily_limit_micros - daily_used, active_period.limit_micros - period_used))::bigint;
    end if;
    update public.generation_jobs set idempotency_key = null, generation_mode = null, context_version_ids = '{}'::text[], context_snapshot = '[]'::jsonb,
      provider_setting_id = null, model_key = null, max_input_tokens = null, max_output_tokens = null, max_revision_output_tokens = null,
      input_cost_micros_per_million = null, output_cost_micros_per_million = null, fixed_cost_micros = null, worst_case_cost_micros = null
    where id = locked_job.id;
    return jsonb_build_object('status', 'blocked', 'budgetStatus', blocked_status, 'remainingMicros', remaining);
  end if;

  perform public.transition_draft(locked_draft.id, 'queued', 'generating');
  update public.generation_jobs set status = 'running' where id = locked_job.id;

  select period.* into active_period from public.budget_periods as period where period.id = reservation.budget_period_id;
  select coalesce(sum(amount_micros), 0) into daily_used from public.budget_entries where budget_period_id = active_period.id and daily_bucket_date = reservation.daily_bucket_date;
  select coalesce(sum(amount_micros), 0) into period_used from public.budget_entries where budget_period_id = active_period.id;
  remaining := greatest(0, least(active_period.daily_limit_micros - daily_used, active_period.limit_micros - period_used))::bigint;
  return jsonb_build_object('status', 'reserved', 'budgetStatus', 'normal', 'remainingMicros', remaining);
end;
$$;

create function public.finalize_generation_success(
  p_job_id uuid,
  p_actual_micros bigint,
  p_usage_json jsonb,
  p_content jsonb,
  p_continuity_level text,
  p_continuity_findings jsonb,
  p_provider_response_id text,
  p_policy_version text
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
  locked_workflow public.major_event_workflows;
  created_version public.draft_versions;
  next_version integer;
  usage_input_tokens numeric;
  usage_output_tokens numeric;
  effective_output_tokens bigint;
  trusted_actual_micros numeric;
begin
  if p_actual_micros is null or p_actual_micros < 0 or p_content is null or jsonb_typeof(p_content) <> 'object'
    or p_usage_json is null or jsonb_typeof(p_usage_json) <> 'object'
    or p_continuity_level not in ('pass', 'review', 'block') or p_continuity_findings is null or jsonb_typeof(p_continuity_findings) <> 'array'
    or p_provider_response_id is null or btrim(p_provider_response_id) = '' or p_policy_version is distinct from 'cheonmu-continuity-v1' then
    raise exception 'invalid_generation_result' using errcode = '22023';
  end if;
  select job.* into locked_job from public.generation_jobs as job where job.id = p_job_id for update;
  select draft.* into locked_draft from public.drafts as draft where draft.id = locked_job.draft_id for update;
  if locked_job.id is null or locked_draft.id is null or (caller_role = 'authenticated' and auth.uid() is distinct from locked_job.owner_id) then raise exception 'generation target not found' using errcode = 'P0002'; end if;
  if caller_role is null or caller_role not in ('authenticated', 'service_role') then raise exception 'generation caller is not authorized' using errcode = '42501'; end if;
  if locked_job.status <> 'running' or locked_draft.status <> 'generating' then raise exception 'stale_transition' using errcode = 'P0001'; end if;
  if p_content ->> 'kind' is distinct from locked_draft.kind then raise exception 'provider_result_kind_mismatch' using errcode = 'P0001'; end if;

  if coalesce(p_usage_json ->> 'inputTokens', '') !~ '^[0-9]+$'
    or coalesce(p_usage_json ->> 'outputTokens', '') !~ '^[0-9]+$' then
    raise exception 'invalid_generation_usage' using errcode = '22023';
  end if;
  usage_input_tokens := (p_usage_json ->> 'inputTokens')::numeric;
  usage_output_tokens := (p_usage_json ->> 'outputTokens')::numeric;
  effective_output_tokens := case when locked_job.generation_mode = 'revise_selection'
    then least(locked_job.max_output_tokens, locked_job.max_revision_output_tokens)
    else locked_job.max_output_tokens end;
  if usage_input_tokens > locked_job.max_input_tokens or usage_output_tokens > effective_output_tokens then
    raise exception 'provider_usage_exceeds_reservation' using errcode = 'P0001';
  end if;
  trusted_actual_micros := locked_job.fixed_cost_micros
    + ceil(usage_input_tokens * locked_job.input_cost_micros_per_million / 1000000)
    + ceil(usage_output_tokens * locked_job.output_cost_micros_per_million / 1000000);
  if trusted_actual_micros > locked_job.worst_case_cost_micros then raise exception 'actual_micros_exceeds_reservation' using errcode = 'P0001'; end if;
  if p_actual_micros::numeric is distinct from trusted_actual_micros then raise exception 'actual_micros_mismatch' using errcode = 'P0001'; end if;

  perform public.reconcile_generation_budget(locked_job.id, p_actual_micros, p_usage_json);
  select coalesce(max(version_number), 0) + 1 into next_version from public.draft_versions where draft_id = locked_draft.id;
  insert into public.draft_versions (owner_id, draft_id, generation_job_id, version_number, content, context_version_ids, context_snapshot, continuity_level, continuity_findings, provider_response_id, continuity_policy_version)
  values (locked_job.owner_id, locked_draft.id, locked_job.id, next_version, p_content, locked_job.context_version_ids, locked_job.context_snapshot, p_continuity_level, p_continuity_findings, p_provider_response_id, p_policy_version)
  returning * into created_version;

  if locked_job.generation_mode in ('major_event_scene_plan', 'major_event_draft') then
    select workflow.* into locked_workflow from public.major_event_workflows as workflow
    where workflow.owner_id = locked_job.owner_id and workflow.draft_id = locked_draft.id for update;
    if locked_workflow.id is null
      or (locked_job.generation_mode = 'major_event_scene_plan' and locked_workflow.phase <> 'proposal_approved')
      or (locked_job.generation_mode = 'major_event_draft' and locked_workflow.phase <> 'scene_plan_approved') then
      raise exception 'workflow_phase_not_approved' using errcode = 'P0001';
    end if;
    update public.major_event_workflows set phase = case locked_job.generation_mode when 'major_event_scene_plan' then 'scene_plan' else 'draft' end, updated_at = now()
    where id = locked_workflow.id;
  end if;
  update public.drafts set title = coalesce(nullif(p_content ->> 'title', ''), title), body = coalesce(p_content ->> 'body', body), updated_at = now() where id = locked_draft.id;
  perform public.transition_draft(locked_draft.id, 'generating', 'generated');
  update public.generation_jobs set status = 'completed', failure_code = null, failure_at = null where id = locked_job.id;
  return created_version;
end;
$$;

create function public.finalize_generation_failure(p_job_id uuid, p_usage_json jsonb, p_failure_code text)
returns public.generation_jobs
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_role text := auth.role();
  locked_job public.generation_jobs;
  locked_draft public.drafts;
  reservation public.budget_entries;
  charge bigint;
  usage_input_tokens numeric;
  usage_output_tokens numeric;
  effective_output_tokens bigint;
  trusted_charge numeric;
begin
  if p_failure_code not in ('provider_generation_failed', 'provider_response_invalid', 'provider_result_kind_mismatch', 'provider_usage_exceeds_reservation', 'continuity_check_failed', 'finalization_failed') then
    raise exception 'invalid_failure_code' using errcode = '22023';
  end if;
  select job.* into locked_job from public.generation_jobs as job where job.id = p_job_id for update;
  if locked_job.id is null or (caller_role = 'authenticated' and auth.uid() is distinct from locked_job.owner_id) then raise exception 'generation target not found' using errcode = 'P0002'; end if;
  if caller_role is null or caller_role not in ('authenticated', 'service_role') then raise exception 'generation caller is not authorized' using errcode = '42501'; end if;
  if locked_job.status in ('completed', 'failed') then return locked_job; end if;
  select draft.* into locked_draft from public.drafts as draft where draft.id = locked_job.draft_id for update;
  select entry.* into reservation from public.budget_entries as entry where entry.generation_job_id = locked_job.id and entry.entry_type = 'reservation';
  if reservation.id is null then raise exception 'budget reservation not found' using errcode = 'P0002'; end if;
  charge := reservation.amount_micros;
  if p_usage_json is not null and jsonb_typeof(p_usage_json) = 'object'
    and coalesce(p_usage_json ->> 'inputTokens', '') ~ '^[0-9]+$'
    and coalesce(p_usage_json ->> 'outputTokens', '') ~ '^[0-9]+$' then
    usage_input_tokens := (p_usage_json ->> 'inputTokens')::numeric;
    usage_output_tokens := (p_usage_json ->> 'outputTokens')::numeric;
    effective_output_tokens := case when locked_job.generation_mode = 'revise_selection'
      then least(locked_job.max_output_tokens, locked_job.max_revision_output_tokens)
      else locked_job.max_output_tokens end;
    trusted_charge := locked_job.fixed_cost_micros
      + ceil(usage_input_tokens * locked_job.input_cost_micros_per_million / 1000000)
      + ceil(usage_output_tokens * locked_job.output_cost_micros_per_million / 1000000);
    if usage_input_tokens <= locked_job.max_input_tokens and usage_output_tokens <= effective_output_tokens
      and trusted_charge <= reservation.amount_micros then
      charge := trusted_charge::bigint;
    end if;
  end if;
  perform public.fail_generation_budget(locked_job.id, charge);
  if locked_draft.status = 'generating' then perform public.transition_draft(locked_draft.id, 'generating', 'queued'); end if;
  update public.generation_jobs
  set status = 'failed', idempotency_key = null, failure_code = p_failure_code, failure_at = now()
  where id = locked_job.id
  returning * into locked_job;
  return locked_job;
end;
$$;

revoke all on function public.review_draft_atomic(uuid, uuid, text, text, text, text) from public, anon, authenticated, service_role;
drop function public.review_draft_atomic(uuid, uuid, text, text, text, text);

create function public.review_draft_atomic(
  p_draft_id uuid, p_expected_version_id uuid, p_expected_state text, p_action text,
  p_reason text, p_idempotency_key text, p_policy_version text
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
  if p_action not in ('reject', 'approve_private', 'approve_public') or p_expected_state <> 'reviewing'
    or p_idempotency_key is null or btrim(p_idempotency_key) = '' or p_policy_version is distinct from 'cheonmu-continuity-v1'
    or (p_action = 'reject' and (p_reason is null or btrim(p_reason) = '')) then
    raise exception 'invalid_review_action' using errcode = '22023';
  end if;
  select draft.* into locked_draft from public.drafts as draft where draft.id = p_draft_id for update;
  if locked_draft.id is null or (caller_role = 'authenticated' and auth.uid() is distinct from locked_draft.owner_id) then raise exception 'review target not found' using errcode = 'P0002'; end if;
  if caller_role is null or caller_role not in ('authenticated', 'service_role') then raise exception 'review caller is not authorized' using errcode = '42501'; end if;
  if exists (select 1 from public.draft_review_actions where owner_id = locked_draft.owner_id and idempotency_key = p_idempotency_key) then raise exception 'duplicate_review' using errcode = 'P0001'; end if;
  select version.* into locked_version from public.draft_versions as version
  where version.id = p_expected_version_id and version.owner_id = locked_draft.owner_id and version.draft_id = locked_draft.id
    and version.version_number = (select max(latest.version_number) from public.draft_versions as latest where latest.draft_id = locked_draft.id)
  for update;
  if locked_version.id is null or locked_draft.status <> p_expected_state then raise exception 'stale_review' using errcode = 'P0001'; end if;
  if p_action <> 'reject' and (locked_version.continuity_level is distinct from 'review' or locked_version.continuity_policy_version is distinct from p_policy_version) then
    raise exception 'version_not_approvable' using errcode = 'P0001';
  end if;
  resulting_state := case p_action when 'reject' then 'rejected' when 'approve_private' then 'approved_private' else 'approved' end;
  insert into public.draft_review_actions (owner_id, draft_id, draft_version_id, idempotency_key, action, expected_state, resulting_state, reason)
  values (locked_draft.owner_id, locked_draft.id, locked_version.id, p_idempotency_key, p_action, p_expected_state, resulting_state, nullif(btrim(p_reason), ''));
  if p_action = 'reject' then
    insert into public.memory_items (owner_id, memory_type, content, source_draft_version_id, status, blocking)
    values (locked_draft.owner_id, 'feedback', btrim(p_reason), locked_version.id, 'active', true);
    reviewed_draft := public.transition_draft(locked_draft.id, 'reviewing', 'rejected');
  else
    insert into public.memory_items (owner_id, memory_type, content, source_draft_version_id, status, blocking)
    values (locked_draft.owner_id, 'continuity', coalesce(nullif(locked_version.content ->> 'body', ''), locked_version.content::text), locked_version.id, 'approved', false);
    reviewed_draft := public.transition_draft(locked_draft.id, 'reviewing', 'approved_private');
    if p_action = 'approve_public' then
      reviewed_draft := public.transition_draft(locked_draft.id, 'approved_private', 'approved');
      insert into public.publish_jobs (owner_id, draft_id, draft_version_id, status) values (locked_draft.owner_id, locked_draft.id, locked_version.id, 'queued');
    end if;
    select job.generation_mode into generation_mode from public.generation_jobs as job where job.id = locked_version.generation_job_id;
    update public.major_event_workflows set phase = case when generation_mode = 'major_event_scene_plan' then 'scene_plan_approved' when generation_mode = 'major_event_draft' then 'final_approved' else 'proposal_approved' end, updated_at = now()
    where owner_id = locked_draft.owner_id and draft_id = locked_draft.id and (generation_mode in ('major_event_scene_plan', 'major_event_draft') or locked_draft.kind = 'major_event_proposal');
  end if;
  return reviewed_draft;
exception when unique_violation then raise exception 'duplicate_review' using errcode = 'P0001';
end;
$$;

revoke all on function public.freeze_generation_context(uuid, uuid, text, text, text[], jsonb, uuid) from public, anon, authenticated, service_role;
revoke all on function public.reserve_and_start_generation(uuid, bigint) from public, anon, authenticated, service_role;
revoke all on function public.finalize_generation_success(uuid, bigint, jsonb, jsonb, text, jsonb, text, text) from public, anon, authenticated, service_role;
revoke all on function public.finalize_generation_failure(uuid, jsonb, text) from public, anon, authenticated, service_role;
revoke all on function public.review_draft_atomic(uuid, uuid, text, text, text, text, text) from public, anon, authenticated, service_role;
grant execute on function public.freeze_generation_context(uuid, uuid, text, text, text[], jsonb, uuid) to authenticated, service_role;
grant execute on function public.reserve_and_start_generation(uuid, bigint) to authenticated, service_role;
grant execute on function public.finalize_generation_success(uuid, bigint, jsonb, jsonb, text, jsonb, text, text) to authenticated, service_role;
grant execute on function public.finalize_generation_failure(uuid, jsonb, text) to authenticated, service_role;
grant execute on function public.review_draft_atomic(uuid, uuid, text, text, text, text, text) to authenticated, service_role;
