alter table public.generation_jobs
  add column attempt_token uuid;

create unique index generation_jobs_attempt_token_idx
  on public.generation_jobs (attempt_token)
  where attempt_token is not null;

-- Keep the proven transaction bodies private and put an immutable attempt epoch
-- in front of every mutation.  Only the tokenized wrappers are RPC-callable.
alter function public.freeze_generation_context(uuid, uuid, text, text, text[], jsonb, uuid)
  rename to generation_internal_freeze_context_v1;
alter function public.reserve_and_start_generation(uuid, bigint)
  rename to generation_internal_reserve_start_v1;
alter function public.finalize_generation_success(uuid, bigint, jsonb, jsonb, text, jsonb, text, text)
  rename to generation_internal_finalize_success_v1;
alter function public.abort_generation_attempt(uuid, text, text)
  rename to generation_internal_abort_attempt_v1;

revoke all on function public.generation_internal_freeze_context_v1(uuid, uuid, text, text, text[], jsonb, uuid) from public, anon, authenticated, service_role;
revoke all on function public.generation_internal_reserve_start_v1(uuid, bigint) from public, anon, authenticated, service_role;
revoke all on function public.generation_internal_finalize_success_v1(uuid, bigint, jsonb, jsonb, text, jsonb, text, text) from public, anon, authenticated, service_role;
revoke all on function public.generation_internal_abort_attempt_v1(uuid, text, text) from public, anon, authenticated, service_role;
revoke all on function public.finalize_generation_failure(uuid, jsonb, text) from public, anon, authenticated, service_role;
drop function public.finalize_generation_failure(uuid, jsonb, text);

create function public.freeze_generation_context(
  p_job_id uuid,
  p_draft_id uuid,
  p_generation_mode text,
  p_idempotency_key text,
  p_context_version_ids text[],
  p_context_snapshot jsonb,
  p_provider_setting_id uuid,
  p_attempt_token uuid
)
returns public.generation_jobs
language plpgsql
security definer
set search_path = ''
as $$
declare
  locked_job public.generation_jobs;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'generation freeze caller is not authorized' using errcode = '42501';
  end if;
  if p_attempt_token is null then
    raise exception 'invalid_attempt_token' using errcode = '22023';
  end if;
  select job.* into locked_job from public.generation_jobs as job where job.id = p_job_id for update;
  if locked_job.id is null then raise exception 'generation target not found' using errcode = 'P0002'; end if;
  if locked_job.attempt_token is not null then raise exception 'duplicate_generation' using errcode = 'P0001'; end if;

  perform public.generation_internal_freeze_context_v1(
    p_job_id, p_draft_id, p_generation_mode, p_idempotency_key,
    p_context_version_ids, p_context_snapshot, p_provider_setting_id
  );
  update public.generation_jobs set attempt_token = p_attempt_token where id = p_job_id returning * into locked_job;
  return locked_job;
exception when unique_violation then
  raise exception 'duplicate_generation' using errcode = 'P0001';
end;
$$;

create function public.reserve_and_start_generation(
  p_job_id uuid,
  p_attempt_token uuid,
  p_amount_micros bigint
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  locked_job public.generation_jobs;
  result jsonb;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'generation reserve caller is not authorized' using errcode = '42501';
  end if;
  if p_attempt_token is null then raise exception 'invalid_attempt_token' using errcode = '22023'; end if;
  select job.* into locked_job from public.generation_jobs as job where job.id = p_job_id for update;
  if locked_job.id is null then raise exception 'generation target not found' using errcode = 'P0002'; end if;
  if locked_job.attempt_token is distinct from p_attempt_token then raise exception 'stale_attempt' using errcode = 'P0001'; end if;
  result := public.generation_internal_reserve_start_v1(p_job_id, p_amount_micros);
  if result ->> 'status' = 'blocked' then
    update public.generation_jobs set attempt_token = null where id = p_job_id;
  end if;
  return result;
end;
$$;

create function public.finalize_generation_success(
  p_job_id uuid,
  p_attempt_token uuid,
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
  locked_job public.generation_jobs;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'generation finalize caller is not authorized' using errcode = '42501';
  end if;
  if p_attempt_token is null then raise exception 'invalid_attempt_token' using errcode = '22023'; end if;
  select job.* into locked_job from public.generation_jobs as job where job.id = p_job_id for update;
  if locked_job.id is null then raise exception 'generation target not found' using errcode = 'P0002'; end if;
  if locked_job.attempt_token is distinct from p_attempt_token then raise exception 'stale_attempt' using errcode = 'P0001'; end if;
  return public.generation_internal_finalize_success_v1(
    p_job_id, p_actual_micros, p_usage_json, p_content, p_continuity_level,
    p_continuity_findings, p_provider_response_id, p_policy_version
  );
end;
$$;

create function public.abort_generation_attempt(
  p_job_id uuid,
  p_attempt_token uuid,
  p_idempotency_key text,
  p_failure_code text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  locked_job public.generation_jobs;
  result jsonb;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'generation abort caller is not authorized' using errcode = '42501';
  end if;
  if p_attempt_token is null then raise exception 'invalid_attempt_token' using errcode = '22023'; end if;
  select job.* into locked_job from public.generation_jobs as job where job.id = p_job_id for update;
  if locked_job.id is null then raise exception 'generation target not found' using errcode = 'P0002'; end if;
  if locked_job.attempt_token is distinct from p_attempt_token then
    return jsonb_build_object('outcome', 'stale');
  end if;
  result := public.generation_internal_abort_attempt_v1(p_job_id, p_idempotency_key, p_failure_code);
  if result ->> 'outcome' = 'aborted' then
    update public.generation_jobs set attempt_token = null where id = p_job_id;
  end if;
  return result;
end;
$$;

revoke all on function public.freeze_generation_context(uuid, uuid, text, text, text[], jsonb, uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function public.reserve_and_start_generation(uuid, uuid, bigint) from public, anon, authenticated, service_role;
revoke all on function public.finalize_generation_success(uuid, uuid, bigint, jsonb, jsonb, text, jsonb, text, text) from public, anon, authenticated, service_role;
revoke all on function public.abort_generation_attempt(uuid, uuid, text, text) from public, anon, authenticated, service_role;

grant execute on function public.freeze_generation_context(uuid, uuid, text, text, text[], jsonb, uuid, uuid) to service_role;
grant execute on function public.reserve_and_start_generation(uuid, uuid, bigint) to service_role;
grant execute on function public.finalize_generation_success(uuid, uuid, bigint, jsonb, jsonb, text, jsonb, text, text) to service_role;
grant execute on function public.abort_generation_attempt(uuid, uuid, text, text) to service_role;
