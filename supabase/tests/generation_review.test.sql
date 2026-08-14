begin;

select plan(32);

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
select has_column('public', 'provider_settings', 'max_input_tokens', 'input limits are server-side settings');
select has_column('public', 'provider_settings', 'max_output_tokens', 'output limits are server-side settings');
select has_column('public', 'provider_settings', 'max_revision_output_tokens', 'revision limits are server-side settings');
select has_column('public', 'provider_settings', 'input_cost_micros_per_million', 'input pricing is server-side');
select has_column('public', 'provider_settings', 'output_cost_micros_per_million', 'output pricing is server-side');
select has_function('public', 'freeze_generation_context', array['uuid', 'uuid', 'text', 'text', 'text[]', 'jsonb', 'uuid'], 'context and trusted setting freezing is atomic');
select has_function('public', 'reserve_and_start_generation', array['uuid', 'bigint'], 'reservation and draft claim are atomic');
select has_function('public', 'finalize_generation_success', array['uuid', 'bigint', 'jsonb', 'jsonb', 'text', 'jsonb', 'text', 'text'], 'success reconciliation and storage are atomic');
select has_function('public', 'finalize_generation_failure', array['uuid', 'jsonb', 'text'], 'failure settlement and cleanup are atomic');
select has_function('public', 'review_draft_atomic', array['uuid', 'uuid', 'text', 'text', 'text', 'text', 'text'], 'review actions enforce server policy atomically');
select hasnt_function('public', 'store_generation_result', array['uuid', 'jsonb', 'text', 'jsonb', 'text'], 'the old non-atomic result writer is removed');

select col_is_unique('public', 'publish_jobs', 'draft_version_id', 'a draft version queues at most one publish job');
select col_not_null('public', 'draft_versions', 'context_version_ids', 'frozen context IDs cannot be null');
select col_not_null('public', 'draft_versions', 'continuity_findings', 'continuity findings cannot be null');

select * from finish();

rollback;
