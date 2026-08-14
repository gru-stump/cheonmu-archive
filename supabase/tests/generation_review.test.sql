begin;

select plan(39);

select has_column('public', 'generation_jobs', 'idempotency_key', 'generation jobs persist an idempotency key');
select has_column('public', 'generation_jobs', 'generation_mode', 'generation jobs persist the generation mode');
select has_column('public', 'generation_jobs', 'context_version_ids', 'generation jobs freeze selected context version IDs');
select has_column('public', 'draft_versions', 'context_version_ids', 'draft versions preserve selected context version IDs');
select has_column('public', 'draft_versions', 'continuity_findings', 'draft versions preserve continuity findings');
select has_column('public', 'draft_versions', 'continuity_level', 'draft versions preserve the continuity level');
select has_column('public', 'draft_versions', 'provider_response_id', 'draft versions preserve the provider response ID');
select has_column('public', 'draft_versions', 'continuity_policy_version', 'draft versions persist the continuity policy version');
select has_column('public', 'draft_versions', 'context_snapshot', 'immutable versions preserve the frozen selected content');
select has_column('public', 'memory_items', 'source_draft_version_id', 'promoted memory names its source draft version');
select has_column('public', 'memory_items', 'status', 'memory approval status is relational state');
select has_column('public', 'memory_items', 'blocking', 'feedback blocking state is relational state');
select has_table('public', 'draft_review_actions', 'review idempotency has a durable table');
select has_table('public', 'publish_jobs', 'publishing has a durable queue');
select has_column('public', 'generation_jobs', 'context_snapshot', 'generation jobs freeze selected content');
select has_column('public', 'generation_jobs', 'provider_setting_id', 'generation jobs freeze the trusted provider setting');
select has_column('public', 'generation_jobs', 'worst_case_cost_micros', 'generation jobs persist the trusted estimate');
select has_column('public', 'generation_jobs', 'failure_code', 'generation failures have a sanitized code');
select has_column('public', 'generation_jobs', 'attempt_token', 'generation mutations are scoped to an immutable attempt epoch');
select has_column('public', 'provider_settings', 'max_input_tokens', 'input limits are server-side settings');
select has_column('public', 'provider_settings', 'max_output_tokens', 'output limits are server-side settings');
select has_column('public', 'provider_settings', 'max_revision_output_tokens', 'revision limits are server-side settings');
select has_column('public', 'provider_settings', 'input_cost_micros_per_million', 'input pricing is server-side');
select has_column('public', 'provider_settings', 'output_cost_micros_per_million', 'output pricing is server-side');
select has_function('public', 'freeze_generation_context', array['uuid', 'uuid', 'text', 'text', 'text[]', 'jsonb', 'uuid', 'uuid'], 'context and trusted setting freezing is attempt-scoped');
select has_function('public', 'reserve_and_start_generation', array['uuid', 'uuid', 'bigint'], 'reservation and draft claim are attempt-scoped');
select has_function('public', 'finalize_generation_success', array['uuid', 'uuid', 'bigint', 'jsonb', 'jsonb', 'text', 'jsonb', 'text', 'text'], 'success reconciliation and storage are attempt-scoped');
select hasnt_function('public', 'finalize_generation_failure', array['uuid', 'jsonb', 'text'], 'the tokenless failure writer is removed');
select has_function('public', 'abort_generation_attempt', array['uuid', 'uuid', 'text', 'text'], 'uncertain attempts have one token-scoped abort RPC');
select has_function('public', 'review_draft_atomic', array['uuid', 'uuid', 'text', 'text', 'text', 'text', 'text'], 'review actions enforce server policy atomically');
select hasnt_function('public', 'store_generation_result', array['uuid', 'jsonb', 'text', 'jsonb', 'text'], 'the old non-atomic result writer is removed');

select ok(
  not exists (
    select 1 from unnest(array[
      'public.freeze_generation_context(uuid,uuid,text,text,text[],jsonb,uuid,uuid)',
      'public.reserve_and_start_generation(uuid,uuid,bigint)',
      'public.finalize_generation_success(uuid,uuid,bigint,jsonb,jsonb,text,jsonb,text,text)',
      'public.abort_generation_attempt(uuid,uuid,text,text)'
    ]) as signature where has_function_privilege('authenticated', signature, 'EXECUTE')
  ),
  'authenticated callers cannot execute generation mutation RPCs'
);
select ok(
  (select bool_and(has_function_privilege('service_role', signature, 'EXECUTE')) from unnest(array[
    'public.freeze_generation_context(uuid,uuid,text,text,text[],jsonb,uuid,uuid)',
    'public.reserve_and_start_generation(uuid,uuid,bigint)',
    'public.finalize_generation_success(uuid,uuid,bigint,jsonb,jsonb,text,jsonb,text,text)',
    'public.abort_generation_attempt(uuid,uuid,text,text)'
  ]) as signature),
  'service_role can execute every generation mutation RPC'
);
select ok(
  not exists (
    select 1 from unnest(array[
      'public.generation_internal_freeze_context_v1(uuid,uuid,text,text,text[],jsonb,uuid)',
      'public.generation_internal_reserve_start_v1(uuid,bigint)',
      'public.generation_internal_finalize_success_v1(uuid,bigint,jsonb,jsonb,text,jsonb,text,text)',
      'public.generation_internal_abort_attempt_v1(uuid,text,text)'
    ]) as signature where has_function_privilege('service_role', signature, 'EXECUTE')
  ),
  'service_role cannot bypass attempt tokens through private transaction bodies'
);
select ok(
  not exists (
    select 1 from information_schema.routine_privileges
    where routine_schema = 'public' and routine_name in (
      'freeze_generation_context', 'reserve_and_start_generation', 'finalize_generation_success',
      'finalize_generation_failure', 'abort_generation_attempt'
    ) and grantee in ('PUBLIC', 'anon', 'authenticated') and privilege_type = 'EXECUTE'
  ),
  'PUBLIC, anon, and authenticated have no generation mutation grants'
);
select ok(
  has_function_privilege('authenticated', 'public.review_draft_atomic(uuid,uuid,text,text,text,text,text)', 'EXECUTE'),
  'authenticated owners retain the guarded review RPC'
);

select col_is_unique('public', 'publish_jobs', 'draft_version_id', 'a draft version queues at most one publish job');
select col_not_null('public', 'draft_versions', 'context_version_ids', 'frozen context IDs cannot be null');
select col_not_null('public', 'draft_versions', 'continuity_findings', 'continuity findings cannot be null');

select * from finish();

rollback;
