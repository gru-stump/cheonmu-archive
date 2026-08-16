create function public.abort_generation_attempt(
  p_job_id uuid,
  p_idempotency_key text,
  p_failure_code text
)
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
  completed_version public.draft_versions;
  terminal_status text;
begin
  if caller_role is distinct from 'service_role' then
    raise exception 'generation abort caller is not authorized' using errcode = '42501';
  end if;
  if p_idempotency_key is null or btrim(p_idempotency_key) = ''
    or p_failure_code not in (
      'freeze_failed', 'frozen_validation_failed', 'reservation_failed', 'budget_blocked',
      'provider_generation_failed', 'provider_response_invalid', 'provider_result_kind_mismatch',
      'provider_usage_exceeds_reservation', 'continuity_check_failed', 'finalization_failed'
    ) then
    raise exception 'invalid_generation_abort' using errcode = '22023';
  end if;

  select job.* into locked_job
  from public.generation_jobs as job
  where job.id = p_job_id
  for update;
  if locked_job.id is null then
    raise exception 'generation target not found' using errcode = 'P0002';
  end if;

  if locked_job.status = 'completed' then
    if locked_job.idempotency_key is distinct from p_idempotency_key then
      raise exception 'duplicate_generation' using errcode = 'P0001';
    end if;
    select version.* into completed_version
    from public.draft_versions as version
    where version.generation_job_id = locked_job.id
    for share;
    if completed_version.id is null then
      raise exception 'stale_version' using errcode = 'P0001';
    end if;
    return jsonb_build_object(
      'outcome', 'completed',
      'result', jsonb_build_object(
        'draftId', completed_version.draft_id,
        'versionId', completed_version.id,
        'status', 'generated',
        'continuityLevel', completed_version.continuity_level
      )
    );
  end if;

  if locked_job.idempotency_key is not null and locked_job.idempotency_key is distinct from p_idempotency_key then
    raise exception 'duplicate_generation' using errcode = 'P0001';
  end if;

  select draft.* into locked_draft
  from public.drafts as draft
  where draft.id = locked_job.draft_id
  for update;
  select entry.* into reservation
  from public.budget_entries as entry
  where entry.generation_job_id = locked_job.id and entry.entry_type = 'reservation';

  if reservation.id is not null then
    perform public.fail_generation_budget(locked_job.id, reservation.amount_micros);
  end if;
  if locked_draft.id is not null and locked_draft.status = 'generating' then
    perform public.transition_draft(locked_draft.id, 'generating', 'queued');
  end if;

  if locked_job.status in ('failed', 'cancelled') then
    update public.generation_jobs
    set idempotency_key = null
    where id = locked_job.id;
    terminal_status := locked_job.status;
  elsif reservation.id is not null then
    update public.generation_jobs
    set status = 'failed', idempotency_key = null, failure_code = p_failure_code, failure_at = now()
    where id = locked_job.id;
    terminal_status := 'failed';
  else
    update public.generation_jobs
    set status = 'queued', idempotency_key = null, generation_mode = null,
        context_version_ids = '{}'::text[], context_snapshot = '[]'::jsonb,
        provider_setting_id = null, model_key = null,
        max_input_tokens = null, max_output_tokens = null, max_revision_output_tokens = null,
        input_cost_micros_per_million = null, output_cost_micros_per_million = null,
        fixed_cost_micros = null, worst_case_cost_micros = null,
        failure_code = p_failure_code, failure_at = now()
    where id = locked_job.id;
    terminal_status := 'queued';
  end if;

  return jsonb_build_object('outcome', 'aborted', 'jobStatus', terminal_status);
end;
$$;

revoke all on function public.freeze_generation_context(uuid, uuid, text, text, text[], jsonb, uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.reserve_and_start_generation(uuid, bigint)
  from public, anon, authenticated, service_role;
revoke all on function public.finalize_generation_success(uuid, bigint, jsonb, jsonb, text, jsonb, text, text)
  from public, anon, authenticated, service_role;
revoke all on function public.finalize_generation_failure(uuid, jsonb, text)
  from public, anon, authenticated, service_role;
revoke all on function public.abort_generation_attempt(uuid, text, text)
  from public, anon, authenticated, service_role;

grant execute on function public.freeze_generation_context(uuid, uuid, text, text, text[], jsonb, uuid) to service_role;
grant execute on function public.reserve_and_start_generation(uuid, bigint) to service_role;
grant execute on function public.finalize_generation_success(uuid, bigint, jsonb, jsonb, text, jsonb, text, text) to service_role;
grant execute on function public.finalize_generation_failure(uuid, jsonb, text) to service_role;
grant execute on function public.abort_generation_attempt(uuid, text, text) to service_role;
