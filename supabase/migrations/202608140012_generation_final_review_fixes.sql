-- Trusted generation mutations are never browser-callable.  Enumerating the
-- catalog closes every extant overload, including signatures retained by an
-- older deployment during a rolling upgrade.
do $migration$
declare
  function_name text;
begin
  for function_name in
    select format('%I.%I(%s)', namespace.nspname, procedure.proname, pg_get_function_identity_arguments(procedure.oid))
    from pg_proc as procedure
    join pg_namespace as namespace on namespace.oid = procedure.pronamespace
    where namespace.nspname = 'public'
      and procedure.proname in (
        'reserve_generation_budget', 'reconcile_generation_budget', 'fail_generation_budget',
        'transition_draft', 'transition_narrative_draft'
      )
  loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role', function_name);
    execute format('grant execute on function %s to service_role', function_name);
  end loop;
end;
$migration$;

-- The configured alias remains frozen on generation_jobs.model_key.  The
-- provider-reported canonical model is separate immutable version audit data.
alter table public.draft_versions
  add column provider_response_model text,
  add constraint draft_versions_provider_response_model_check check (
    provider_response_model is null or btrim(provider_response_model) <> ''
  );

create function narrative_private.require_provider_response_model()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  response_model text;
begin
  if new.generation_job_id is null or new.provider_response_id is null then
    return new;
  end if;
  response_model := nullif(btrim(current_setting('narrative.provider_response_model', true)), '');
  if response_model is null then
    raise exception 'invalid_generation_result' using errcode = '22023';
  end if;
  new.provider_response_model := response_model;
  return new;
end;
$$;

revoke all on function narrative_private.require_provider_response_model()
  from public, anon, authenticated, service_role;

create trigger draft_versions_require_provider_response_model
before insert on public.draft_versions
for each row execute function narrative_private.require_provider_response_model();

revoke all on function public.finalize_generation_success(uuid, uuid, bigint, jsonb, jsonb, text, jsonb, text, text)
  from public, anon, authenticated, service_role;
drop function public.finalize_generation_success(uuid, uuid, bigint, jsonb, jsonb, text, jsonb, text, text);

create function public.finalize_generation_success(
  p_job_id uuid,
  p_attempt_token uuid,
  p_actual_micros bigint,
  p_usage_json jsonb,
  p_content jsonb,
  p_continuity_level text,
  p_continuity_findings jsonb,
  p_provider_response_id text,
  p_provider_response_model text,
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
  if p_attempt_token is null then
    raise exception 'invalid_attempt_token' using errcode = '22023';
  end if;
  if p_provider_response_model is null or btrim(p_provider_response_model) = '' then
    raise exception 'invalid_generation_result' using errcode = '22023';
  end if;
  select job.* into locked_job
  from public.generation_jobs as job
  where job.id = p_job_id
  for update;
  if locked_job.id is null then
    raise exception 'generation target not found' using errcode = 'P0002';
  end if;
  if locked_job.attempt_token is distinct from p_attempt_token then
    raise exception 'stale_attempt' using errcode = 'P0001';
  end if;
  perform set_config('narrative.provider_response_model', btrim(p_provider_response_model), true);
  return public.generation_internal_finalize_success_v1(
    p_job_id, p_actual_micros, p_usage_json, p_content, p_continuity_level,
    p_continuity_findings, p_provider_response_id, p_policy_version
  );
end;
$$;

revoke all on function public.finalize_generation_success(uuid, uuid, bigint, jsonb, jsonb, text, jsonb, text, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.finalize_generation_success(uuid, uuid, bigint, jsonb, jsonb, text, jsonb, text, text, text)
  to service_role;

-- Approval metadata is deterministic and bounded.  Tags intentionally come
-- only from structured result fields, never from unbounded prose extraction.
create function narrative_private.approved_continuity_metadata(p_version_id uuid, p_content jsonb)
returns jsonb
language plpgsql
immutable
strict
set search_path = ''
as $$
declare
  candidate text;
  normalized text;
  tags text[] := '{}'::text[];
  source_text text;
begin
  if jsonb_typeof(p_content) <> 'object' then
    raise exception 'invalid continuity source content' using errcode = '22023';
  end if;
  for candidate in
    select value
    from (
      values
        (1::bigint, p_content #>> '{setting,place}'),
        (2::bigint, p_content #>> '{setting,time}')
      union all
      select 100 + ordinality, value
      from jsonb_array_elements_text(case when jsonb_typeof(p_content -> 'continuityUsed') = 'array' then p_content -> 'continuityUsed' else '[]'::jsonb end)
        with ordinality as used(value, ordinality)
      union all
      select 10000 + ordinality, value
      from jsonb_array_elements_text(case when jsonb_typeof(p_content -> 'continuityCandidates') = 'array' then p_content -> 'continuityCandidates' else '[]'::jsonb end)
        with ordinality as candidate(value, ordinality)
    ) as candidates(ordinality, value)
    order by ordinality
  loop
    normalized := left(btrim(candidate), 100);
    if normalized <> '' and not normalized = any(tags) then
      tags := array_append(tags, normalized);
      exit when cardinality(tags) >= 20;
    end if;
  end loop;
  source_text := coalesce(nullif(p_content ->> 'body', ''), p_content::text);
  return jsonb_build_object(
    'tokenCount', greatest(1, ceil(length(source_text) / 4.0)::integer),
    'tags', to_jsonb(tags),
    'continuityFacts', jsonb_build_object('continuityId', p_version_id::text)
  );
end;
$$;

revoke all on function narrative_private.approved_continuity_metadata(uuid, jsonb)
  from public, anon, authenticated, service_role;

create function narrative_private.populate_approved_continuity_metadata()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  source_content jsonb;
  generated jsonb;
begin
  if new.memory_type <> 'continuity' or new.status <> 'approved' or new.source_draft_version_id is null then
    return new;
  end if;
  select version.content into source_content
  from public.draft_versions as version
  where version.id = new.source_draft_version_id
    and version.owner_id = new.owner_id;
  if source_content is null then
    raise exception 'approved continuity source not found' using errcode = 'P0002';
  end if;
  generated := narrative_private.approved_continuity_metadata(new.source_draft_version_id, source_content);
  new.metadata := coalesce(new.metadata, '{}'::jsonb)
    || (generated - 'continuityFacts')
    || jsonb_build_object(
      'continuityFacts',
      coalesce(new.metadata -> 'continuityFacts', '{}'::jsonb) || generated -> 'continuityFacts'
    );
  return new;
end;
$$;

revoke all on function narrative_private.populate_approved_continuity_metadata()
  from public, anon, authenticated, service_role;

create trigger memory_items_populate_approved_continuity_metadata
before insert or update of memory_type, status, source_draft_version_id, metadata on public.memory_items
for each row execute function narrative_private.populate_approved_continuity_metadata();

update public.memory_items as memory
set metadata = memory.metadata
  || (generated.value - 'continuityFacts')
  || jsonb_build_object(
    'continuityFacts',
    coalesce(memory.metadata -> 'continuityFacts', '{}'::jsonb) || generated.value -> 'continuityFacts'
  )
from public.draft_versions as version
cross join lateral (
  select narrative_private.approved_continuity_metadata(version.id, version.content) as value
) as generated
where memory.source_draft_version_id = version.id
  and memory.owner_id = version.owner_id
  and memory.memory_type = 'continuity'
  and memory.status = 'approved';

-- Exact-minute matching requires an every-minute queue-only dispatcher.
select cron.schedule(
  'narrative-schedule-dispatcher',
  '* * * * *',
  $$select narrative_private.invoke_schedule_dispatcher()$$
);
