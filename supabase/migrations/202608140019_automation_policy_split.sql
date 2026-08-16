alter table public.narrative_admin_settings
  add column manual_generation_enabled boolean,
  add column schedule_automation_enabled boolean;

update public.narrative_admin_settings
set manual_generation_enabled = automation_enabled,
    schedule_automation_enabled = automation_enabled;

alter table public.narrative_admin_settings
  alter column manual_generation_enabled set default false,
  alter column manual_generation_enabled set not null,
  alter column schedule_automation_enabled set default false,
  alter column schedule_automation_enabled set not null;

-- Only queued owner revisions are unambiguous legacy manual requests. Other
-- missing or unknown sources remain untouched so reserve/start fails closed.
update public.generation_jobs
set payload = payload || jsonb_build_object('source', 'manual')
where status = 'queued'
  and source_draft_version_id is not null
  and payload ->> 'mode' = 'revise_selection'
  and not (payload ? 'source');

create function narrative_private.generation_budget_state_at(
  p_owner_id uuid,
  p_at timestamptz,
  p_policy text
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  active_period public.budget_periods;
  admin_settings public.narrative_admin_settings;
  active_provider public.provider_settings;
  daily_used numeric;
  period_used numeric;
  usage_percent numeric;
  warning_percent integer := 80;
  risk_percent integer := 95;
  business_date date;
begin
  if p_owner_id is null or p_at is null or p_policy not in ('manual', 'schedule') then return 'risk'; end if;
  business_date := public.narrative_business_date(p_at);
  select provider.* into active_provider from public.provider_settings as provider
  where provider.owner_id = p_owner_id and provider.enabled for share;
  select period.* into active_period
  from public.budget_periods as period
  where period.owner_id = p_owner_id and period.currency = 'USD'
    and business_date between period.period_start and period.period_end
  order by period.period_start desc, period.period_end asc, period.id limit 1 for update;
  select admin.* into admin_settings from public.narrative_admin_settings as admin
  where admin.owner_id = p_owner_id for share;
  if admin_settings.owner_id is null
    or (p_policy = 'manual' and not admin_settings.manual_generation_enabled)
    or (p_policy = 'schedule' and not admin_settings.schedule_automation_enabled)
    or active_provider.id is null
    or active_provider.pricing_verified_at > public.narrative_business_date(current_timestamp)
    or active_provider.pricing_verified_at < business_date - admin_settings.pricing_valid_days then
    return 'risk';
  end if;
  warning_percent := admin_settings.warning_threshold_percent;
  risk_percent := admin_settings.risk_threshold_percent;
  if active_period.id is null then return 'risk'; end if;
  select coalesce(sum(entry.amount_micros), 0) into daily_used from public.budget_entries as entry
  where entry.budget_period_id = active_period.id and entry.daily_bucket_date = business_date;
  select coalesce(sum(entry.amount_micros), 0) into period_used from public.budget_entries as entry
  where entry.budget_period_id = active_period.id;
  usage_percent := greatest(
    case when active_period.daily_limit_micros = 0 then 100 else daily_used * 100 / active_period.daily_limit_micros::numeric end,
    case when active_period.limit_micros = 0 then 100 else period_used * 100 / active_period.limit_micros::numeric end
  );
  if usage_percent >= risk_percent then return 'risk'; end if;
  if usage_percent >= warning_percent then return 'warning'; end if;
  return 'normal';
end;
$$;

create or replace function narrative_private.schedule_budget_state_at(p_owner_id uuid, p_at timestamptz)
returns text
language plpgsql
security definer
set search_path = ''
as $$
begin
  return narrative_private.generation_budget_state_at(p_owner_id, p_at, 'schedule');
end;
$$;

create or replace function public.get_narrative_settings()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  result jsonb;
begin
  perform narrative_private.require_narrative_owner();
  with admin as (
    select * from public.narrative_admin_settings where owner_id = auth.uid()
  ), current_period as (
    select period.* from public.budget_periods as period
    where period.owner_id = auth.uid() and public.narrative_business_date(now()) between period.period_start and period.period_end
    order by period.period_start desc limit 1
  ), totals as (
    select coalesce(sum(entry.amount_micros), 0)::bigint as committed,
      coalesce(sum(entry.amount_micros) filter (where entry.entry_type = 'reservation'
        and not exists (select 1 from public.budget_entries as settlement where settlement.generation_job_id = entry.generation_job_id and settlement.entry_type in ('reconciliation', 'failure'))), 0)::bigint as reserved
    from public.budget_entries as entry join current_period on current_period.id = entry.budget_period_id
  )
  select jsonb_build_object(
    'manualGenerationEnabled', coalesce(admin.manual_generation_enabled, false),
    'scheduleAutomationEnabled', coalesce(admin.schedule_automation_enabled, false),
    'pricingValidDays', coalesce(admin.pricing_valid_days, 30),
    'providers', (select jsonb_agg(jsonb_build_object(
      'providerKey', provider.provider_key, 'enabled', provider.enabled, 'modelKey', provider.model_key,
      'maxInputTokens', provider.max_input_tokens, 'maxOutputTokens', provider.max_output_tokens,
      'maxRevisionOutputTokens', provider.max_revision_output_tokens,
      'inputPriceMicrosPerMillion', provider.input_cost_micros_per_million,
      'outputPriceMicrosPerMillion', provider.output_cost_micros_per_million,
      'pricingVerifiedAt', provider.pricing_verified_at
    ) order by provider.provider_key)
    from (
      select actual.provider_key, actual.enabled, actual.model_key,
        actual.max_input_tokens, actual.max_output_tokens, actual.max_revision_output_tokens,
        actual.input_cost_micros_per_million, actual.output_cost_micros_per_million,
        actual.pricing_verified_at::text
      from public.provider_settings as actual where actual.owner_id = auth.uid()
      union all
      select missing.provider_key, false, '', 4096, 1024, 256, 0::bigint, 0::bigint, ''
      from (values ('openai'), ('anthropic')) as missing(provider_key)
      where not exists (select 1 from public.provider_settings as actual where actual.owner_id = auth.uid() and actual.provider_key = missing.provider_key)
    ) as provider),
    'budget', jsonb_build_object(
      'monthlyLimitMicros', coalesce(current_period.limit_micros, 0),
      'dailyLimitMicros', coalesce(current_period.daily_limit_micros, 0),
      'spentMicros', greatest(coalesce(totals.committed, 0) - coalesce(totals.reserved, 0), 0),
      'reservedMicros', greatest(coalesce(totals.reserved, 0), 0),
      'manualCallLimit', coalesce(admin.manual_call_limit, 3),
      'warningThresholdPercent', coalesce(admin.warning_threshold_percent, 80),
      'riskThresholdPercent', coalesce(admin.risk_threshold_percent, 95),
      'krwPerUsd', coalesce(admin.krw_per_usd, 1350)
    ),
    'secrets', jsonb_build_object(
      'openai', exists(select 1 from vault.decrypted_secrets where name = 'narrative_' || auth.uid()::text || '_openai'),
      'anthropic', exists(select 1 from vault.decrypted_secrets where name = 'narrative_' || auth.uid()::text || '_anthropic'),
      'github', exists(select 1 from vault.decrypted_secrets where name = 'narrative_' || auth.uid()::text || '_github')
    )
  ) into result
  from admin full join current_period on true full join totals on true;
  return coalesce(result, jsonb_build_object(
    'manualGenerationEnabled', false, 'scheduleAutomationEnabled', false, 'pricingValidDays', 30,
    'providers', jsonb_build_array(
      jsonb_build_object('providerKey','openai','enabled',false,'modelKey','','maxInputTokens',4096,'maxOutputTokens',1024,'maxRevisionOutputTokens',256,'inputPriceMicrosPerMillion',0,'outputPriceMicrosPerMillion',0,'pricingVerifiedAt',''),
      jsonb_build_object('providerKey','anthropic','enabled',false,'modelKey','','maxInputTokens',4096,'maxOutputTokens',1024,'maxRevisionOutputTokens',256,'inputPriceMicrosPerMillion',0,'outputPriceMicrosPerMillion',0,'pricingVerifiedAt','')
    ),
    'budget', jsonb_build_object('monthlyLimitMicros',0,'dailyLimitMicros',0,'spentMicros',0,'reservedMicros',0,'manualCallLimit',3,'warningThresholdPercent',80,'riskThresholdPercent',95,'krwPerUsd',1350),
    'secrets', jsonb_build_object('openai',false,'anthropic',false,'github',false)
  ));
end;
$$;

drop function public.save_narrative_settings(boolean, text, jsonb, bigint, bigint, integer, integer, integer, numeric, integer);

create function public.save_narrative_settings(
  p_manual_generation_enabled boolean,
  p_schedule_automation_enabled boolean,
  p_active_provider_key text,
  p_provider_updates jsonb,
  p_monthly_limit_micros bigint,
  p_daily_limit_micros bigint,
  p_manual_call_limit integer,
  p_warning_threshold_percent integer,
  p_risk_threshold_percent integer,
  p_krw_per_usd numeric,
  p_pricing_valid_days integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  provider_update jsonb;
  provider_key_value text;
  current_period public.budget_periods;
  monthly_committed numeric;
  daily_committed numeric;
  selected_provider public.provider_settings;
  update_count integer := 0;
begin
  perform narrative_private.require_narrative_owner();
  if p_manual_generation_enabled is null or p_schedule_automation_enabled is null
    or p_provider_updates is null or jsonb_typeof(p_provider_updates) <> 'array'
    or p_monthly_limit_micros < 0 or p_daily_limit_micros < 0 or p_manual_call_limit < 0
    or p_warning_threshold_percent not between 1 and 99 or p_risk_threshold_percent not between 2 and 100
    or p_warning_threshold_percent >= p_risk_threshold_percent or p_krw_per_usd <= 0
    or p_pricing_valid_days not between 1 and 365
    or ((p_manual_generation_enabled or p_schedule_automation_enabled) and p_active_provider_key is null) then
    raise exception 'invalid_settings_command' using errcode = '22023';
  end if;
  perform 1 from public.provider_settings where owner_id = auth.uid() for update;
  for provider_update in select value from jsonb_array_elements(p_provider_updates)
  loop
    provider_key_value := provider_update ->> 'providerKey';
    if provider_key_value not in ('openai', 'anthropic', 'fake-local-provider')
      or nullif(btrim(provider_update ->> 'modelKey'), '') is null
      or coalesce(provider_update ->> 'maxInputTokens', '') !~ '^[0-9]+$'
      or coalesce(provider_update ->> 'maxOutputTokens', '') !~ '^[0-9]+$'
      or coalesce(provider_update ->> 'maxRevisionOutputTokens', '') !~ '^[0-9]+$'
      or coalesce(provider_update ->> 'inputPriceMicrosPerMillion', '') !~ '^[0-9]+$'
      or coalesce(provider_update ->> 'outputPriceMicrosPerMillion', '') !~ '^[0-9]+$'
      or coalesce(provider_update ->> 'pricingVerifiedAt', '') !~ '^\d{4}-\d{2}-\d{2}$'
      or (provider_update ->> 'pricingVerifiedAt')::date > public.narrative_business_date(now())
      or (provider_update ->> 'maxInputTokens')::integer < 1
      or (provider_update ->> 'maxOutputTokens')::integer < 1
      or (provider_update ->> 'maxRevisionOutputTokens')::integer < 1
      or (provider_update ->> 'maxRevisionOutputTokens')::integer > (provider_update ->> 'maxOutputTokens')::integer then
      raise exception 'invalid_provider_setting' using errcode = '22023';
    end if;
    update_count := update_count + 1;
    insert into public.provider_settings (
      owner_id, provider_key, enabled, configuration, model_key,
      max_input_tokens, max_output_tokens, max_revision_output_tokens,
      input_cost_micros_per_million, output_cost_micros_per_million, pricing_verified_at
    ) values (
      auth.uid(), provider_key_value, false,
      case when provider_key_value = 'fake-local-provider' then jsonb_build_object('mode', 'fixture')
        else jsonb_build_object('vaultSecretName', 'narrative_' || auth.uid()::text || '_' || provider_key_value) end,
      btrim(provider_update ->> 'modelKey'),
      (provider_update ->> 'maxInputTokens')::integer,
      (provider_update ->> 'maxOutputTokens')::integer,
      (provider_update ->> 'maxRevisionOutputTokens')::integer,
      (provider_update ->> 'inputPriceMicrosPerMillion')::bigint,
      (provider_update ->> 'outputPriceMicrosPerMillion')::bigint,
      (provider_update ->> 'pricingVerifiedAt')::date
    ) on conflict (owner_id, provider_key) do update set
      model_key = excluded.model_key,
      max_input_tokens = excluded.max_input_tokens,
      max_output_tokens = excluded.max_output_tokens,
      max_revision_output_tokens = excluded.max_revision_output_tokens,
      input_cost_micros_per_million = excluded.input_cost_micros_per_million,
      output_cost_micros_per_million = excluded.output_cost_micros_per_million,
      pricing_verified_at = excluded.pricing_verified_at,
      updated_at = now();
  end loop;
  if update_count <> (select count(distinct value ->> 'providerKey') from jsonb_array_elements(p_provider_updates)) then
    raise exception 'duplicate_provider_setting' using errcode = '22023';
  end if;

  select period.* into current_period from public.budget_periods as period
  where period.owner_id = auth.uid() and period.currency = 'USD'
    and public.narrative_business_date(now()) between period.period_start and period.period_end
  order by period.period_start desc limit 1 for update;
  if current_period.id is null then
    insert into public.budget_periods (owner_id, currency, period_start, period_end, limit_micros, daily_limit_micros)
    values (auth.uid(), 'USD', date_trunc('month', public.narrative_business_date(now()))::date,
      (date_trunc('month', public.narrative_business_date(now())) + interval '1 month - 1 day')::date,
      p_monthly_limit_micros, p_daily_limit_micros)
    returning * into current_period;
  else
    select coalesce(sum(entry.amount_micros), 0) into monthly_committed
    from public.budget_entries as entry where entry.budget_period_id = current_period.id;
    select coalesce(sum(entry.amount_micros), 0) into daily_committed
    from public.budget_entries as entry where entry.budget_period_id = current_period.id
      and entry.daily_bucket_date = public.narrative_business_date(now());
    if p_monthly_limit_micros < greatest(monthly_committed, 0)
      or p_daily_limit_micros < greatest(daily_committed, 0) then
      raise exception 'budget_limit_below_committed' using errcode = 'P0001';
    end if;
    update public.budget_periods set limit_micros = p_monthly_limit_micros,
      daily_limit_micros = p_daily_limit_micros where id = current_period.id;
  end if;

  insert into public.narrative_admin_settings (
    owner_id, manual_generation_enabled, schedule_automation_enabled,
    pricing_valid_days, manual_call_limit, warning_threshold_percent,
    risk_threshold_percent, krw_per_usd, updated_at
  ) values (
    auth.uid(), p_manual_generation_enabled, p_schedule_automation_enabled,
    p_pricing_valid_days, p_manual_call_limit, p_warning_threshold_percent,
    p_risk_threshold_percent, p_krw_per_usd, now()
  ) on conflict (owner_id) do update set
    manual_generation_enabled = excluded.manual_generation_enabled,
    schedule_automation_enabled = excluded.schedule_automation_enabled,
    pricing_valid_days = excluded.pricing_valid_days,
    manual_call_limit = excluded.manual_call_limit,
    warning_threshold_percent = excluded.warning_threshold_percent,
    risk_threshold_percent = excluded.risk_threshold_percent,
    krw_per_usd = excluded.krw_per_usd,
    updated_at = now();

  if p_active_provider_key is not null then
    select provider.* into selected_provider from public.provider_settings as provider
    where provider.owner_id = auth.uid() and provider.provider_key = p_active_provider_key for update;
    if selected_provider.id is null then raise exception 'active_provider_setting_required' using errcode = 'P0001'; end if;
    if (p_manual_generation_enabled or p_schedule_automation_enabled)
      and (selected_provider.pricing_verified_at > public.narrative_business_date(now())
        or selected_provider.pricing_verified_at < public.narrative_business_date(now()) - p_pricing_valid_days) then
      raise exception 'stale_provider_pricing' using errcode = 'P0001';
    end if;
  end if;
  update public.provider_settings set enabled = false, updated_at = now()
  where owner_id = auth.uid() and enabled and (p_active_provider_key is null or provider_key <> p_active_provider_key);
  if p_active_provider_key is not null then
    update public.provider_settings set enabled = true, updated_at = now() where id = selected_provider.id;
  end if;
  insert into public.audit_events (owner_id, event_type, entity_type, payload)
  values (auth.uid(), 'narrative_settings_saved', 'narrative_settings', jsonb_build_object(
    'manualGenerationEnabled', p_manual_generation_enabled,
    'scheduleAutomationEnabled', p_schedule_automation_enabled,
    'activeProviderKey', p_active_provider_key,
    'monthlyLimitMicros', p_monthly_limit_micros,
    'dailyLimitMicros', p_daily_limit_micros));
  return jsonb_build_object('saved', true);
end;
$$;

create or replace function public.queue_draft_revision(
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
  admin_settings public.narrative_admin_settings;
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
  if locked_draft.id is null or locked_draft.owner_id is distinct from auth.uid() then raise exception 'revision target not found' using errcode = 'P0002'; end if;
  select version.* into locked_version from public.draft_versions as version
  where version.id = p_expected_version_id and version.owner_id = locked_draft.owner_id and version.draft_id = locked_draft.id
    and version.version_number = (select max(latest.version_number) from public.draft_versions as latest where latest.owner_id = locked_draft.owner_id and latest.draft_id = locked_draft.id)
  for update;
  if locked_version.id is null or locked_draft.status <> 'reviewing' then raise exception 'stale_revision' using errcode = 'P0001'; end if;
  if locked_version.continuity_level = 'block' then raise exception 'blocked_version_reject_only' using errcode = 'P0001'; end if;
  if strpos(coalesce(locked_version.content ->> 'body', ''), p_selected_text) = 0 then raise exception 'revision_selection_not_found' using errcode = '22023'; end if;

  select setting.* into locked_setting from public.provider_settings as setting
  where setting.owner_id = locked_draft.owner_id and setting.enabled for share;
  select admin.* into admin_settings from public.narrative_admin_settings as admin
  where admin.owner_id = locked_draft.owner_id for share;
  if admin_settings.owner_id is null or not admin_settings.manual_generation_enabled then raise exception 'manual_generation_disabled' using errcode = 'P0001'; end if;
  if locked_setting.id is null then raise exception 'active_provider_setting_required' using errcode = 'P0001'; end if;
  if locked_setting.pricing_verified_at > public.narrative_business_date(current_timestamp) then raise exception 'invalid_provider_pricing' using errcode = 'P0001'; end if;
  if locked_setting.pricing_verified_at < public.narrative_business_date(current_timestamp) - admin_settings.pricing_valid_days then raise exception 'stale_provider_pricing' using errcode = 'P0001'; end if;
  if p_requested_max_output_tokens > locked_setting.max_revision_output_tokens then raise exception 'revision_token_limit_exceeded' using errcode = '22023'; end if;
  expected_cost := locked_setting.fixed_cost_micros
    + ceil(locked_setting.max_input_tokens::numeric * locked_setting.input_cost_micros_per_million / 1000000)::bigint
    + ceil(p_requested_max_output_tokens::numeric * locked_setting.output_cost_micros_per_million / 1000000)::bigint;
  if expected_cost is distinct from p_confirmed_maximum_cost_micros then raise exception 'revision_cost_changed' using errcode = 'P0001'; end if;

  insert into public.generation_jobs (
    owner_id, draft_id, schedule_key, scheduled_for, status, payload,
    requested_max_output_tokens, confirmed_maximum_cost_micros, source_draft_version_id
  ) values (
    locked_draft.owner_id, locked_draft.id, generation_key, now(), 'queued', jsonb_build_object(
      'mode', 'revise_selection', 'source', 'manual', 'sourceVersionId', locked_version.id,
      'revision', jsonb_build_object('selectedText', p_selected_text, 'instruction', p_instruction),
      'requestedMaxOutputTokens', p_requested_max_output_tokens,
      'confirmedMaximumCostMicros', p_confirmed_maximum_cost_micros),
    p_requested_max_output_tokens, p_confirmed_maximum_cost_micros, locked_version.id
  ) returning * into created_job;
  update public.drafts set status = 'queued', updated_at = now()
  where id = locked_draft.id and owner_id = locked_draft.owner_id and status = 'reviewing';
  insert into public.audit_events (owner_id, event_type, entity_type, entity_id, payload)
  values (locked_draft.owner_id, 'draft_revision_queued', 'draft', locked_draft.id, jsonb_build_object(
    'sourceVersionId', locked_version.id, 'generationJobId', created_job.id,
    'requestedMaxOutputTokens', p_requested_max_output_tokens,
    'confirmedMaximumCostMicros', p_confirmed_maximum_cost_micros));
  return jsonb_build_object('job_id', created_job.id, 'idempotency_key', generation_key, 'draft_id', locked_draft.id, 'kind', locked_draft.kind);
end;
$$;

create function public.queue_manual_generation(
  p_draft_id uuid,
  p_requested_mode text,
  p_kind text,
  p_title text,
  p_seed text,
  p_tags text[]
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  request_owner_id uuid;
  locked_draft public.drafts;
  locked_workflow public.major_event_workflows;
  locked_setting public.provider_settings;
  admin_settings public.narrative_admin_settings;
  created_job public.generation_jobs;
  generation_key text := 'manual-' || gen_random_uuid()::text;
  derived_mode text;
  derived_kind text;
  stored_seed text;
  stored_tags text[];
begin
  perform narrative_private.require_narrative_owner();
  request_owner_id := auth.uid();
  if p_requested_mode is null or p_requested_mode not in ('new', 'major_event_scene_plan', 'major_event_draft') then
    raise exception 'invalid_manual_generation_request' using errcode = '22023';
  end if;

  if p_draft_id is null then
    if p_requested_mode <> 'new' then
      raise exception 'manual_generation_mode_mismatch' using errcode = 'P0001';
    end if;
    if p_kind is null or p_kind not in ('short_dialogue', 'daily_event', 'major_event_proposal')
      or nullif(btrim(p_title), '') is null or length(p_title) > 200
      or (p_seed is not null and length(p_seed) > 2000)
      or coalesce(cardinality(p_tags), 0) > 10
      or exists (select 1 from unnest(coalesce(p_tags, array[]::text[])) as tag where nullif(btrim(tag), '') is null or length(tag) > 64) then
      raise exception 'invalid_manual_generation_request' using errcode = '22023';
    end if;
    derived_mode := 'new';
    derived_kind := p_kind;
    stored_seed := nullif(btrim(p_seed), '');
    select coalesce(array_agg(btrim(tag)), array[]::text[]) into stored_tags
    from unnest(coalesce(p_tags, array[]::text[])) as tag;
  else
    if p_requested_mode not in ('major_event_scene_plan', 'major_event_draft')
      or p_kind is not null or p_title is not null or p_seed is not null or p_tags is not null then
      raise exception 'invalid_manual_generation_request' using errcode = '22023';
    end if;
    select draft.* into locked_draft from public.drafts as draft where draft.id = p_draft_id for update;
    if locked_draft.id is null or locked_draft.owner_id is distinct from request_owner_id
      or locked_draft.kind <> 'major_event_proposal' then
      raise exception 'manual generation target not found' using errcode = 'P0002';
    end if;
    select workflow.* into locked_workflow from public.major_event_workflows as workflow
    where workflow.owner_id = request_owner_id and workflow.draft_id = locked_draft.id for update;
    if locked_workflow.id is null then
      raise exception 'workflow_phase_not_approved' using errcode = 'P0001';
    end if;
    derived_mode := case locked_workflow.phase
      when 'proposal_approved' then 'major_event_scene_plan'
      when 'scene_plan_approved' then 'major_event_draft'
      else null
    end;
    if derived_mode is null or locked_draft.status <> 'approved_private' then
      raise exception 'workflow_phase_not_approved' using errcode = 'P0001';
    end if;
    if p_requested_mode <> derived_mode then
      raise exception 'manual_generation_mode_mismatch' using errcode = 'P0001';
    end if;
    derived_kind := locked_draft.kind;
    stored_seed := locked_draft.metadata ->> 'seed';
    select coalesce(array_agg(tag), array[]::text[]) into stored_tags
    from jsonb_array_elements_text(coalesce(locked_draft.metadata -> 'tags', '[]'::jsonb)) as tag;
  end if;

  select setting.* into locked_setting from public.provider_settings as setting
  where setting.owner_id = request_owner_id and setting.enabled for share;
  select admin.* into admin_settings from public.narrative_admin_settings as admin
  where admin.owner_id = request_owner_id for share;
  if admin_settings.owner_id is null or not admin_settings.manual_generation_enabled then
    raise exception 'manual_generation_disabled' using errcode = 'P0001';
  end if;
  if locked_setting.id is null then
    raise exception 'active_provider_setting_required' using errcode = 'P0001';
  end if;
  if locked_setting.pricing_verified_at > public.narrative_business_date(current_timestamp) then
    raise exception 'invalid_provider_pricing' using errcode = 'P0001';
  end if;
  if locked_setting.pricing_verified_at < public.narrative_business_date(current_timestamp) - admin_settings.pricing_valid_days then
    raise exception 'stale_provider_pricing' using errcode = 'P0001';
  end if;

  if p_draft_id is null then
    insert into public.drafts (owner_id, kind, status, title, metadata)
    values (request_owner_id, derived_kind, 'queued', btrim(p_title), jsonb_build_object('seed', stored_seed, 'tags', stored_tags))
    returning * into locked_draft;
    if derived_kind = 'major_event_proposal' then
      insert into public.major_event_workflows (owner_id, draft_id, phase, context)
      values (request_owner_id, locked_draft.id, 'proposal', jsonb_build_object('source', 'manual', 'seed', stored_seed, 'tags', stored_tags));
    end if;
  else
    perform public.transition_draft(locked_draft.id, 'approved_private', 'archived');
    perform public.transition_draft(locked_draft.id, 'archived', 'queued');
  end if;

  insert into public.generation_jobs (
    owner_id, draft_id, schedule_key, scheduled_for, status, payload, provider_setting_id
  ) values (
    request_owner_id, locked_draft.id, generation_key, now(), 'queued',
    jsonb_strip_nulls(jsonb_build_object(
      'source', 'manual', 'mode', derived_mode, 'kind', derived_kind,
      'manualRequestKey', generation_key, 'seed', stored_seed, 'tags', stored_tags
    )), locked_setting.id
  ) returning * into created_job;
  insert into public.audit_events (owner_id, event_type, entity_type, entity_id, payload)
  values (request_owner_id, 'manual_generation_queued', 'draft', locked_draft.id, jsonb_build_object(
    'generationJobId', created_job.id, 'mode', derived_mode, 'kind', derived_kind));
  return jsonb_build_object(
    'job_id', created_job.id, 'draft_id', locked_draft.id, 'idempotency_key', generation_key,
    'mode', derived_mode, 'kind', derived_kind, 'seed', stored_seed, 'tags', stored_tags
  );
end;
$$;

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
  if locked_job.payload ->> 'source' = 'manual' and locked_job.provider_setting_id is not null
    and (locked_job.draft_id is distinct from p_draft_id
      or locked_job.payload ->> 'mode' is distinct from p_generation_mode
      or locked_job.payload ->> 'manualRequestKey' is distinct from p_idempotency_key
      or locked_job.provider_setting_id is distinct from p_provider_setting_id) then
    raise exception 'manual_generation_binding_changed' using errcode = 'P0001';
  end if;

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

create or replace function public.save_narrative_schedule(
  p_schedule_id uuid,
  p_schedule_key text,
  p_schedule_type text,
  p_enabled boolean,
  p_seoul_time text,
  p_weekday integer,
  p_special_date date,
  p_minimum_interval_minutes integer,
  p_kind text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  parsed_hour integer;
  parsed_minute integer;
  cron_value text;
  settings public.narrative_admin_settings;
  active_provider public.provider_settings;
  stored_schedule public.schedules;
begin
  perform narrative_private.require_narrative_owner();
  if p_schedule_key is null or p_schedule_type is null or p_enabled is null
    or p_seoul_time is null or p_minimum_interval_minutes is null or p_kind is null
    or p_schedule_key !~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$'
    or p_schedule_type not in ('automatic', 'manual', 'special')
    or p_seoul_time !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
    or p_minimum_interval_minutes not between 1 and 525600
    or p_kind not in ('short_dialogue', 'daily_event')
    or (p_schedule_type = 'automatic' and p_weekday is not null and p_weekday not between 0 and 6)
    or (p_schedule_type = 'special' and p_special_date is null)
    or (p_schedule_type <> 'special' and p_special_date is not null) then
    raise exception 'invalid_schedule_command' using errcode = '22023';
  end if;
  parsed_hour := split_part(p_seoul_time, ':', 1)::integer;
  parsed_minute := split_part(p_seoul_time, ':', 2)::integer;
  cron_value := case when p_schedule_type = 'automatic' then parsed_minute::text || ' ' || parsed_hour::text || ' * * ' || coalesce(p_weekday::text, '*') else null end;
  if p_schedule_id is not null then
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('narrative-schedule:' || p_schedule_id::text, 0));
    select schedule.* into stored_schedule from public.schedules as schedule where schedule.id = p_schedule_id and schedule.owner_id = auth.uid() for update;
    if stored_schedule.id is null then raise exception 'schedule not found' using errcode = 'P0002'; end if;
  else
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('narrative-schedule-key:' || auth.uid()::text || ':' || p_schedule_key, 0));
  end if;
  if p_enabled and p_schedule_type in ('automatic', 'special') then
    select provider.* into active_provider from public.provider_settings as provider where provider.owner_id = auth.uid() and provider.enabled for share;
    select admin.* into settings from public.narrative_admin_settings as admin where admin.owner_id = auth.uid() for update;
    if settings.owner_id is null or not settings.schedule_automation_enabled then raise exception 'schedule_automation_disabled' using errcode = 'P0001'; end if;
    if active_provider.id is null
      or active_provider.pricing_verified_at > public.narrative_business_date(current_timestamp)
      or active_provider.pricing_verified_at < public.narrative_business_date(current_timestamp) - settings.pricing_valid_days then
      raise exception 'stale_provider_pricing' using errcode = 'P0001';
    end if;
  end if;
  if p_schedule_id is null then
    insert into public.schedules (owner_id, schedule_key, schedule_type, cron_expression, enabled, payload, special_date, seoul_time, minimum_interval_minutes)
    values (auth.uid(), p_schedule_key, p_schedule_type, cron_value, p_enabled, jsonb_build_object('kind', p_kind), p_special_date, make_time(parsed_hour, parsed_minute, 0), p_minimum_interval_minutes)
    returning * into stored_schedule;
  else
    update public.schedules set schedule_key = p_schedule_key, schedule_type = p_schedule_type,
      cron_expression = cron_value, enabled = p_enabled, payload = jsonb_build_object('kind', p_kind),
      special_date = p_special_date, seoul_time = make_time(parsed_hour, parsed_minute, 0),
      minimum_interval_minutes = p_minimum_interval_minutes, updated_at = now()
    where id = stored_schedule.id returning * into stored_schedule;
  end if;
  insert into public.audit_events (owner_id, event_type, entity_type, entity_id, payload)
  values (auth.uid(), 'narrative_schedule_saved', 'schedule', stored_schedule.id, jsonb_build_object('scheduleType', stored_schedule.schedule_type, 'enabled', stored_schedule.enabled));
  return jsonb_build_object('scheduleId', stored_schedule.id);
exception when unique_violation then
  raise exception 'duplicate_schedule_key' using errcode = 'P0001';
end;
$$;

create or replace function public.queue_narrative_access_job(p_owner_id uuid, p_now timestamptz)
returns public.generation_jobs
language plpgsql
security definer
set search_path = ''
as $$
declare
  active_job public.generation_jobs;
  queued_job public.generation_jobs;
  admin_settings public.narrative_admin_settings;
  last_success timestamptz;
  daily_calls integer;
  manual_limit integer := 3;
  budget_state text;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'schedule access caller is not authorized' using errcode = '42501'; end if;
  if p_owner_id is null or p_now is null then raise exception 'invalid_schedule_access' using errcode = '22023'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('narrative-access:' || p_owner_id::text, 0));
  budget_state := narrative_private.generation_budget_state_at(p_owner_id, p_now, 'schedule');
  select admin.* into admin_settings from public.narrative_admin_settings as admin where admin.owner_id = p_owner_id for share;
  if admin_settings.owner_id is null or not admin_settings.schedule_automation_enabled then raise exception 'schedule_automation_disabled' using errcode = 'P0001'; end if;
  select candidate.* into active_job from public.generation_jobs as candidate
  where candidate.owner_id = p_owner_id and candidate.schedule_key = ('access:' || p_owner_id::text)
    and candidate.status in ('queued', 'running') and candidate.created_at >= p_now - interval '15 minutes'
  order by candidate.created_at desc, candidate.id limit 1;
  if active_job.id is not null then return active_job; end if;
  select max(version.created_at), count(*) filter (where public.narrative_business_date(version.created_at) = public.narrative_business_date(p_now))::integer
  into last_success, daily_calls
  from public.draft_versions as version join public.generation_jobs as job on job.id = version.generation_job_id
  where job.owner_id = p_owner_id and job.schedule_key = ('access:' || p_owner_id::text) and job.status = 'completed';
  if last_success is not null and last_success + interval '1 hour' > p_now then raise exception 'access_interval_not_elapsed' using errcode = 'P0001'; end if;
  manual_limit := admin_settings.manual_call_limit;
  if coalesce(daily_calls, 0) >= manual_limit then raise exception 'daily_access_limit' using errcode = 'P0001'; end if;
  if budget_state = 'risk' then raise exception 'budget_risk' using errcode = 'P0001'; end if;
  queued_job := narrative_private.queue_narrative_schedule_job(
    p_owner_id, 'access:' || p_owner_id::text, date_trunc('minute', p_now),
    jsonb_build_object('kind', 'short_dialogue', 'source', 'access', 'budgetPolicy', 'block_at_risk'));
  return queued_job;
end;
$$;

create or replace function public.queue_due_narrative_schedule_job(
  p_owner_id uuid,
  p_schedule_id uuid,
  p_scheduled_for timestamptz
)
returns public.generation_jobs
language plpgsql
security definer
set search_path = ''
as $$
declare
  locked_schedule public.schedules;
  admin_settings public.narrative_admin_settings;
  active_provider public.provider_settings;
  existing_job public.generation_jobs;
  queued_job public.generation_jobs;
  local_scheduled timestamp without time zone;
  queue_key text;
  budget_state text;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'schedule queue caller is not authorized' using errcode = '42501'; end if;
  if p_owner_id is null or p_schedule_id is null or p_scheduled_for is null or date_trunc('minute', p_scheduled_for) is distinct from p_scheduled_for then
    raise exception 'invalid_schedule_job' using errcode = '22023';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('narrative-schedule:' || p_schedule_id::text, 0));
  select schedule.* into locked_schedule from public.schedules as schedule where schedule.id = p_schedule_id and schedule.owner_id = p_owner_id for update;
  if locked_schedule.id is null or not locked_schedule.enabled or locked_schedule.schedule_type = 'manual' then raise exception 'schedule_not_due' using errcode = 'P0001'; end if;
  local_scheduled := p_scheduled_for at time zone 'Asia/Seoul';
  if locked_schedule.schedule_type = 'special' then
    if locked_schedule.special_date is distinct from local_scheduled::date or locked_schedule.seoul_time is distinct from local_scheduled::time(0) then raise exception 'schedule_not_due' using errcode = 'P0001'; end if;
  elsif extract(minute from local_scheduled)::integer is distinct from split_part(locked_schedule.cron_expression, ' ', 1)::integer
    or extract(hour from local_scheduled)::integer is distinct from split_part(locked_schedule.cron_expression, ' ', 2)::integer
    or (split_part(locked_schedule.cron_expression, ' ', 5) <> '*' and extract(dow from local_scheduled)::integer is distinct from split_part(locked_schedule.cron_expression, ' ', 5)::integer) then
    raise exception 'schedule_not_due' using errcode = 'P0001';
  end if;
  queue_key := p_owner_id::text || ':' || locked_schedule.schedule_key || ':' || public.narrative_business_date(p_scheduled_for)::text;
  budget_state := narrative_private.generation_budget_state_at(p_owner_id, p_scheduled_for, 'schedule');
  select admin.* into admin_settings from public.narrative_admin_settings as admin where admin.owner_id = p_owner_id for share;
  if admin_settings.owner_id is null or not admin_settings.schedule_automation_enabled then raise exception 'schedule_automation_disabled' using errcode = 'P0001'; end if;
  select provider.* into active_provider from public.provider_settings as provider where provider.owner_id = p_owner_id and provider.enabled for share;
  if active_provider.id is null then raise exception 'active_provider_setting_required' using errcode = 'P0001'; end if;
  if active_provider.pricing_verified_at > public.narrative_business_date(current_timestamp) then raise exception 'invalid_provider_pricing' using errcode = 'P0001'; end if;
  if active_provider.pricing_verified_at < public.narrative_business_date(p_scheduled_for) - admin_settings.pricing_valid_days then raise exception 'stale_provider_pricing' using errcode = 'P0001'; end if;
  select job.* into existing_job from public.generation_jobs as job where job.owner_id = p_owner_id and job.schedule_key = queue_key and job.scheduled_for = p_scheduled_for;
  if existing_job.id is not null then return existing_job; end if;
  if locked_schedule.last_queued_at is not null and locked_schedule.last_queued_at + make_interval(mins => locked_schedule.minimum_interval_minutes) > p_scheduled_for then raise exception 'schedule_interval_not_elapsed' using errcode = 'P0001'; end if;
  if budget_state = 'risk' then raise exception 'budget_risk' using errcode = 'P0001'; end if;
  if budget_state = 'warning' and locked_schedule.schedule_type = 'automatic' and split_part(locked_schedule.cron_expression, ' ', 5) <> '*' then raise exception 'budget_warning_long_schedule' using errcode = 'P0001'; end if;
  queued_job := narrative_private.queue_narrative_schedule_job(
    p_owner_id, queue_key, p_scheduled_for, jsonb_build_object(
      'kind', locked_schedule.payload ->> 'kind', 'source', 'schedule',
      'budgetPolicy', case when locked_schedule.schedule_type = 'automatic' and split_part(locked_schedule.cron_expression, ' ', 5) <> '*' then 'block_at_warning' else 'block_at_risk' end));
  update public.schedules set last_queued_at = p_scheduled_for, updated_at = now() where id = locked_schedule.id;
  return queued_job;
end;
$$;

create or replace function public.reserve_and_start_generation(
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
  admin_settings public.narrative_admin_settings;
  active_provider public.provider_settings;
  budget_state text;
  budget_policy text;
  job_source text;
  manual_calls integer;
  result jsonb;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'generation reserve caller is not authorized' using errcode = '42501'; end if;
  if p_attempt_token is null then raise exception 'invalid_attempt_token' using errcode = '22023'; end if;
  select job.* into locked_job from public.generation_jobs as job where job.id = p_job_id for update;
  if locked_job.id is null then raise exception 'generation target not found' using errcode = 'P0002'; end if;
  if locked_job.attempt_token is distinct from p_attempt_token then raise exception 'stale_attempt' using errcode = 'P0001'; end if;
  job_source := locked_job.payload ->> 'source';
  budget_policy := locked_job.payload ->> 'budgetPolicy';
  if job_source is null or job_source not in ('manual', 'schedule', 'access')
    or (job_source = 'schedule' and budget_policy not in ('block_at_risk', 'block_at_warning'))
    or (job_source = 'access' and budget_policy is distinct from 'block_at_risk') then
    raise exception 'invalid_generation_source' using errcode = 'P0001';
  end if;
  budget_state := narrative_private.generation_budget_state_at(
    locked_job.owner_id, current_timestamp, case when job_source = 'manual' then 'manual' else 'schedule' end);
  select admin.* into admin_settings from public.narrative_admin_settings as admin where admin.owner_id = locked_job.owner_id for share;
  select provider.* into active_provider from public.provider_settings as provider
  where provider.id = locked_job.provider_setting_id and provider.owner_id = locked_job.owner_id and provider.enabled for share;
  if job_source = 'manual' and (admin_settings.owner_id is null or not admin_settings.manual_generation_enabled) then raise exception 'manual_generation_disabled' using errcode = 'P0001'; end if;
  if job_source in ('schedule', 'access') and (admin_settings.owner_id is null or not admin_settings.schedule_automation_enabled) then raise exception 'schedule_automation_disabled' using errcode = 'P0001'; end if;
  if active_provider.id is null then raise exception 'active_provider_setting_required' using errcode = 'P0001'; end if;
  if active_provider.pricing_verified_at > public.narrative_business_date(current_timestamp) then raise exception 'invalid_provider_pricing' using errcode = 'P0001'; end if;
  if active_provider.pricing_verified_at < public.narrative_business_date(current_timestamp) - admin_settings.pricing_valid_days then raise exception 'stale_provider_pricing' using errcode = 'P0001'; end if;
  if job_source = 'manual' then
    select count(*)::integer into manual_calls
    from public.budget_entries as entry
    join public.generation_jobs as reserved_job on reserved_job.id = entry.generation_job_id and reserved_job.owner_id = entry.owner_id
    where entry.owner_id = locked_job.owner_id and entry.entry_type = 'reservation'
      and entry.daily_bucket_date = public.narrative_business_date(current_timestamp)
      and reserved_job.payload ->> 'source' = 'manual';
    if manual_calls >= admin_settings.manual_call_limit then raise exception 'manual_call_limit_reached' using errcode = 'P0001'; end if;
  elsif budget_state = 'risk' or (budget_state = 'warning' and budget_policy = 'block_at_warning') then
    update public.generation_jobs set attempt_token = null where id = p_job_id;
    return jsonb_build_object('status', 'blocked', 'budgetStatus', budget_state, 'remainingMicros', 0);
  end if;
  result := public.generation_internal_reserve_start_v1(p_job_id, p_amount_micros);
  if result ->> 'status' = 'blocked' then update public.generation_jobs set attempt_token = null where id = p_job_id; end if;
  return result;
end;
$$;

revoke all on function narrative_private.generation_budget_state_at(uuid, timestamptz, text) from public, anon, authenticated, service_role;
revoke all on function narrative_private.schedule_budget_state_at(uuid, timestamptz) from public, anon, authenticated, service_role;
revoke all on function public.get_narrative_settings() from public, anon, authenticated, service_role;
revoke all on function public.save_narrative_settings(boolean, boolean, text, jsonb, bigint, bigint, integer, integer, integer, numeric, integer) from public, anon, authenticated, service_role;
revoke all on function public.queue_draft_revision(uuid, uuid, text, text, integer, bigint) from public, anon, authenticated, service_role;
revoke all on function public.queue_manual_generation(uuid, text, text, text, text, text[]) from public, anon, authenticated, service_role;
revoke all on function public.save_narrative_schedule(uuid, text, text, boolean, text, integer, date, integer, text) from public, anon, authenticated, service_role;
revoke all on function public.queue_narrative_access_job(uuid, timestamptz) from public, anon, authenticated, service_role;
revoke all on function public.queue_due_narrative_schedule_job(uuid, uuid, timestamptz) from public, anon, authenticated, service_role;
revoke all on function public.reserve_and_start_generation(uuid, uuid, bigint) from public, anon, authenticated, service_role;

grant execute on function public.get_narrative_settings() to authenticated;
grant execute on function public.save_narrative_settings(boolean, boolean, text, jsonb, bigint, bigint, integer, integer, integer, numeric, integer) to authenticated;
grant execute on function public.queue_draft_revision(uuid, uuid, text, text, integer, bigint) to authenticated;
grant execute on function public.queue_manual_generation(uuid, text, text, text, text, text[]) to authenticated;
grant execute on function public.save_narrative_schedule(uuid, text, text, boolean, text, integer, date, integer, text) to authenticated;
grant execute on function public.queue_narrative_access_job(uuid, timestamptz) to service_role;
grant execute on function public.queue_due_narrative_schedule_job(uuid, uuid, timestamptz) to service_role;
grant execute on function public.reserve_and_start_generation(uuid, uuid, bigint) to service_role;
