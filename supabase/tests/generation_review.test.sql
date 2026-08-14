begin;

select plan(18);

select has_column('public', 'generation_jobs', 'idempotency_key', 'generation jobs persist an idempotency key');
select has_column('public', 'generation_jobs', 'generation_mode', 'generation jobs persist the generation mode');
select has_column('public', 'generation_jobs', 'context_version_ids', 'generation jobs freeze selected context version IDs');
select has_column('public', 'draft_versions', 'context_version_ids', 'draft versions preserve selected context version IDs');
select has_column('public', 'draft_versions', 'continuity_findings', 'draft versions preserve continuity findings');
select has_column('public', 'draft_versions', 'continuity_level', 'draft versions preserve the continuity level');
select has_column('public', 'draft_versions', 'provider_response_id', 'draft versions preserve the provider response ID');
select has_column('public', 'memory_items', 'source_draft_version_id', 'promoted memory names its source draft version');
select has_column('public', 'memory_items', 'status', 'memory approval status is relational state');
select has_column('public', 'memory_items', 'blocking', 'feedback blocking state is relational state');
select has_table('public', 'draft_review_actions', 'review idempotency has a durable table');
select has_table('public', 'publish_jobs', 'publishing has a durable queue');
select has_function('public', 'freeze_generation_context', array['uuid', 'uuid', 'text', 'text', 'text[]'], 'context freezing is an atomic RPC');
select has_function('public', 'store_generation_result', array['uuid', 'jsonb', 'text', 'jsonb', 'text'], 'generation completion is an atomic RPC');
select has_function('public', 'review_draft_atomic', array['uuid', 'uuid', 'text', 'text', 'text', 'text'], 'review actions are an atomic RPC');

select col_is_unique('public', 'publish_jobs', 'draft_version_id', 'a draft version queues at most one publish job');
select col_not_null('public', 'draft_versions', 'context_version_ids', 'frozen context IDs cannot be null');
select col_not_null('public', 'draft_versions', 'continuity_findings', 'continuity findings cannot be null');

select * from finish();

rollback;
