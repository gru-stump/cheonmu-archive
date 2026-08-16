import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

const container = 'supabase_db_cheonmu-narrative';
const trueOwner = '99000000-0000-0000-0000-000000000001';
const falseOwner = '99000000-0000-0000-0000-000000000002';
const revisionDraft = '99000000-0000-0000-0000-000000000011';
const revisionVersion = '99000000-0000-0000-0000-000000000012';
const revisionJob = '99000000-0000-0000-0000-000000000013';
const ambiguousJob = '99000000-0000-0000-0000-000000000014';
const backfillableRevisionJob = '99000000-0000-0000-0000-000000000015';
const legacyAttemptToken = '99000000-0000-4000-8000-000000000099';
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';

interface ProcessResult { code: number | null; stdout: string; stderr: string }

function runProcess(command: string, args: string[], input?: string): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: process.cwd(), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
      shell: process.platform === 'win32' && command === npx,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}

function runPsql(sql: string): Promise<ProcessResult> {
  return runProcess('docker', ['exec', '-i', container, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1'], sql);
}

async function success(label: string, promise: Promise<ProcessResult>): Promise<ProcessResult> {
  const result = await promise;
  if (result.code !== 0) throw new Error(`${label} (exit ${String(result.code)})\n${result.stdout}\n${result.stderr}`);
  return result;
}

async function scalar(sql: string): Promise<string> {
  return (await success('automation policy upgrade query failed', runPsql(sql))).stdout.trim();
}

let headApplied = false;
let primaryError: unknown;
try {
  await success('database reset to migration 018 failed', runProcess(npx, [
    'supabase', 'db', 'reset', '--local', '--version', '202608140018', '--no-seed', '--yes',
  ]));
  assert.equal(await scalar('select max(version) from supabase_migrations.schema_migrations;'), '202608140018');
  assert.equal(
    await scalar("select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'narrative_admin_settings' and column_name in ('manual_generation_enabled', 'schedule_automation_enabled');"),
    '0', 'migration 018 must not already contain split policy flags',
  );

  await success('migration-018 policy fixture setup failed', runPsql(`
insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values
  ('00000000-0000-0000-0000-000000000000', '${trueOwner}', 'authenticated', 'authenticated', 'policy-true@local.invalid', '$2a$10$testfixturesonlynotarealcredential0000000000000000000000000', current_timestamp, '{"provider":"email","providers":["email"]}', '{}', current_timestamp, current_timestamp),
  ('00000000-0000-0000-0000-000000000000', '${falseOwner}', 'authenticated', 'authenticated', 'policy-false@local.invalid', '$2a$10$testfixturesonlynotarealcredential0000000000000000000000000', current_timestamp, '{"provider":"email","providers":["email"]}', '{}', current_timestamp, current_timestamp);
insert into public.owner_profiles (owner_id, display_name) values
  ('${trueOwner}', 'Legacy true policy'), ('${falseOwner}', 'Legacy false policy');
insert into public.narrative_admin_settings (owner_id, automation_enabled) values
  ('${trueOwner}', true), ('${falseOwner}', false);
insert into public.provider_settings (
  id, owner_id, provider_key, enabled, configuration, model_key,
  max_input_tokens, max_output_tokens, max_revision_output_tokens,
  input_cost_micros_per_million, output_cost_micros_per_million, fixed_cost_micros,
  pricing_verified_at
) values
  ('99000000-0000-0000-0000-000000000021', '${trueOwner}', 'openai', false, '{}', 'legacy-off', 4096, 1024, 256, 0, 0, 0, current_date),
  ('99000000-0000-0000-0000-000000000022', '${falseOwner}', 'anthropic', true, '{}', 'legacy-on', 4096, 1024, 256, 0, 0, 0, current_date);
insert into public.budget_periods (id, owner_id, period_start, period_end, limit_micros, daily_limit_micros, currency)
values ('99000000-0000-0000-0000-000000000031', '${trueOwner}', current_date - 1, current_date + 1, 1000000, 1000000, 'USD');
insert into public.drafts (id, owner_id, kind, title)
values ('${revisionDraft}', '${trueOwner}', 'daily_event', 'legacy revision');
insert into public.draft_versions (id, owner_id, draft_id, version_number, content)
values ('${revisionVersion}', '${trueOwner}', '${revisionDraft}', 1, '{"body":"legacy"}');
insert into public.generation_jobs (id, owner_id, draft_id, source_draft_version_id, schedule_key, scheduled_for, payload)
values
  ('${revisionJob}', '${trueOwner}', '${revisionDraft}', '${revisionVersion}', 'legacy-revision', current_timestamp, '{"mode":"revise_selection"}'),
  ('${backfillableRevisionJob}', '${trueOwner}', '${revisionDraft}', '${revisionVersion}', 'legacy-backfillable-revision', current_timestamp, '{"mode":"revise_selection"}'),
  ('${ambiguousJob}', '${trueOwner}', '${revisionDraft}', null, 'legacy-ambiguous', current_timestamp, '{"kind":"daily_event"}');
`));

  await success('migration-018 substituted revision freeze failed', runPsql(`
begin;
update public.provider_settings set enabled = true where id = '99000000-0000-0000-0000-000000000021';
select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;
select public.freeze_generation_context(
  '${revisionJob}', '${revisionDraft}', 'new', 'browser-substituted-key',
  array['legacy-context'], '[{"versionId":"legacy-context","memoryType":"canon","content":"frozen","tokenCount":1}]',
  '99000000-0000-0000-0000-000000000021', '${legacyAttemptToken}'
);
reset role;
update public.provider_settings set enabled = false where id = '99000000-0000-0000-0000-000000000021';
commit;
`));
  assert.equal(
    await scalar(`select concat(generation_mode, '|', idempotency_key, '|', attempt_token, '|', worst_case_cost_micros)
      from public.generation_jobs where id = '${revisionJob}';`),
    `new|browser-substituted-key|${legacyAttemptToken}|0`,
    'migration 018 must contain the queued browser-substituted frozen attempt before 019 is applied',
  );

  await success('migration 019 failed over migration 018 data', runProcess(npx, ['supabase', 'migration', 'up', '--local', '--yes']));
  headApplied = true;
  assert.equal(await scalar('select max(version) from supabase_migrations.schema_migrations;'), '202608140021');
  assert.equal(
    await scalar(`select string_agg(concat(automation_enabled, '|', manual_generation_enabled, '|', schedule_automation_enabled), ',' order by owner_id)
      from public.narrative_admin_settings where owner_id in ('${trueOwner}', '${falseOwner}');`),
    't|t|t,f|f|f', 'legacy true/false values must deterministically backfill both new policies while the legacy column remains',
  );
  assert.equal(
    await scalar(`select string_agg(concat(provider_key, '|', enabled), ',' order by owner_id)
      from public.provider_settings where owner_id in ('${trueOwner}', '${falseOwner}');`),
    'openai|f,anthropic|t', 'policy migration must not select, clear, or otherwise mutate providers',
  );
  await success('enable frozen legacy provider for reserve-bypass proof failed', runPsql(
    `update public.provider_settings set enabled = true where id = '99000000-0000-0000-0000-000000000021';`,
  ));
  const frozenLegacyReserve = await runPsql(`
begin;
select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;
select public.reserve_and_start_generation('${revisionJob}', '${legacyAttemptToken}', 0);
`);
  assert.notEqual(frozenLegacyReserve.code, 0,
    'an 018 browser-substituted frozen revision must not reserve or start after migration 019');
  assert.match(frozenLegacyReserve.stderr, /invalid_generation_source|manual_generation_binding_changed/);
  assert.equal(
    await scalar(`select concat(status, '|', attempt_token, '|',
      (select count(*) from public.budget_entries where generation_job_id = '${revisionJob}'))
      from public.generation_jobs where id = '${revisionJob}';`),
    `failed|${legacyAttemptToken}|0`,
    'migration 020 fail-closes frozen legacy work while preserving attempt evidence and creating no budget entry',
  );
  await success('restore provider independence fixture after reserve proof failed', runPsql(
    `update public.provider_settings set enabled = false where id = '99000000-0000-0000-0000-000000000021';`,
  ));
  assert.equal(
    await scalar(`select string_agg(concat(id, '|', coalesce(payload ->> 'source', '<missing>')), ',' order by id)
      from public.generation_jobs where id in ('${revisionJob}', '${ambiguousJob}', '${backfillableRevisionJob}');`),
    `${revisionJob}|<missing>,${ambiguousJob}|<missing>,${backfillableRevisionJob}|manual`,
    'only unfrozen unambiguous queued legacy revisions may receive the server-owned manual source',
  );
  const substitutedLegacyRevision = await runPsql(`
begin;
select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;
select public.freeze_generation_context(
  '${backfillableRevisionJob}', '${revisionDraft}', 'new', 'browser-substituted-key',
  array['legacy-context'], '[{"versionId":"legacy-context","memoryType":"canon","content":"frozen","tokenCount":1}]',
  '99000000-0000-0000-0000-000000000022', '99000000-0000-4000-8000-000000000099'
);
`);
  assert.notEqual(substitutedLegacyRevision.code, 0);
  assert.match(substitutedLegacyRevision.stderr, /generation_direct_claim_expired/,
    'an incomplete backfilled legacy revision without a direct lease must fail closed before accepting substituted mode, key, or provider');
  assert.equal(
    await scalar("select concat(to_regprocedure('public.save_narrative_settings(boolean,boolean,text,jsonb,bigint,bigint,integer,integer,integer,numeric,integer)') is not null, '|', to_regprocedure('public.save_narrative_settings(boolean,text,jsonb,bigint,bigint,integer,integer,integer,numeric,integer)') is null, '|', has_function_privilege('authenticated', 'public.save_narrative_settings(boolean,boolean,text,jsonb,bigint,bigint,integer,integer,integer,numeric,integer)', 'EXECUTE'), '|', not has_function_privilege('anon', 'public.save_narrative_settings(boolean,boolean,text,jsonb,bigint,bigint,integer,integer,integer,numeric,integer)', 'EXECUTE'));"),
    't|t|t|t', 'upgrade must replace the combined policy command with the narrow authenticated split signature',
  );
  assert.equal(
    await scalar("select concat(to_regprocedure('public.queue_manual_generation(uuid,text,text,text,text,text[])') is not null, '|', has_function_privilege('authenticated', 'public.queue_manual_generation(uuid,text,text,text,text,text[])', 'EXECUTE'), '|', not has_function_privilege('anon', 'public.queue_manual_generation(uuid,text,text,text,text,text[])', 'EXECUTE'), '|', not has_function_privilege('service_role', 'public.queue_manual_generation(uuid,text,text,text,text,text[])', 'EXECUTE'));") ,
    't|t|t|t', 'upgrade must expose the new manual queue only to authenticated owners',
  );
  const enabledPolicyWithoutProvider = await runPsql(`
begin;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', '${trueOwner}', true);
set local role authenticated;
select public.queue_manual_generation(null, 'new', 'daily_event', 'upgrade owner request', null, array[]::text[]);
`);
  assert.notEqual(enabledPolicyWithoutProvider.code, 0);
  assert.match(enabledPolicyWithoutProvider.stderr, /active_provider_setting_required/);
  const disabledPolicyWithProvider = await runPsql(`
begin;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', '${falseOwner}', true);
set local role authenticated;
select public.queue_manual_generation(null, 'new', 'daily_event', 'upgrade disabled request', null, array[]::text[]);
`);
  assert.notEqual(disabledPolicyWithProvider.code, 0);
  assert.match(disabledPolicyWithProvider.stderr, /manual_generation_disabled/);
  assert.equal(
    await scalar(`select string_agg(concat(provider_key, '|', enabled), ',' order by owner_id)
      from public.provider_settings where owner_id in ('${trueOwner}', '${falseOwner}');`),
    'openai|f,anthropic|t', 'new owner queue checks must not couple policy migration to provider selection',
  );
} catch (error) {
  primaryError = error;
} finally {
  try {
    await success('database restoration after automation policy upgrade test failed', runProcess(npx, [
      'supabase', 'db', 'reset', '--local', '--yes', ...(headApplied ? [] : ['--version', '202608140018', '--no-seed']),
    ]));
  } catch (restoreError) {
    primaryError = new AggregateError([primaryError, restoreError].filter((value) => value !== undefined), 'automation policy upgrade and restoration failed');
  }
}

if (primaryError) throw primaryError;
console.log('PASS: migration 019 upgrades legacy true/false policies, preserves provider selection, installs the authenticated manual queue, backfills only unambiguous revisions, and replaces the settings RPC safely.');
