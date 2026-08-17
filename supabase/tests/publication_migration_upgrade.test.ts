import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

const container = 'supabase_db_cheonmu-narrative';
const ownerId = '98000000-0000-0000-0000-000000000001';
const draftId = '98000000-0000-0000-0000-000000000002';
const versionId = '98000000-0000-0000-0000-000000000003';
const approvalId = '98000000-0000-0000-0000-000000000004';
const publishJobId = '98000000-0000-0000-0000-000000000005';
const attemptId = '98000000-0000-4000-8000-000000000006';
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
  return (await success('publication upgrade query failed', runPsql(sql))).stdout.trim();
}

let headApplied = false;
let primaryError: unknown;
try {
  await success('database reset to pre-publication migration 016 failed', runProcess(npx, [
    'supabase', 'db', 'reset', '--local', '--version', '202608140016', '--no-seed', '--yes',
  ]));
  assert.equal(await scalar('select max(version) from supabase_migrations.schema_migrations;'), '202608140016');
  assert.equal(
    await scalar("select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'publish_jobs' and column_name = 'approval_action_id';"),
    '0', 'pre-Task-2 schema must not contain the new binding column',
  );

  await success('legacy publication fixture setup failed', runPsql(`
insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values (
  '00000000-0000-0000-0000-000000000000', '${ownerId}', 'authenticated', 'authenticated',
  'publication-upgrade@local.invalid', '$2a$10$testfixturesonlynotarealcredential0000000000000000000000000',
  current_timestamp, '{"provider":"email","providers":["email"]}'::jsonb, '{}', current_timestamp, current_timestamp
);
insert into public.owner_profiles (owner_id, display_name) values ('${ownerId}', 'Publication upgrade owner');
insert into public.narrative_admin_settings (owner_id, automation_enabled) values ('${ownerId}', false);
insert into public.drafts (id, owner_id, kind, title)
values ('${draftId}', '${ownerId}', 'daily_event', 'legacy approved publication');
insert into public.draft_versions (id, owner_id, draft_id, version_number, content, continuity_level, continuity_policy_version)
values ('${versionId}', '${ownerId}', '${draftId}', 1,
  '{"title":"legacy","body":"legacy public body","canonChangeCandidates":[],"unresolvedCallbacks":[],"publication":{"id":"legacy-record","recordNumber":"77","relationshipStage":7,"date":"2026-08-15","summary":"legacy summary","characters":["cheonryeong","muyeong"],"tags":["legacy"],"related":[],"quote":"legacy quote","archiveSnapshot":{"recordIds":[],"recordNumbers":[]}}}'::jsonb,
  'review', 'cheonmu-continuity-v1');
insert into public.draft_review_actions (id, owner_id, draft_id, draft_version_id, idempotency_key, action, expected_state, resulting_state)
values ('${approvalId}', '${ownerId}', '${draftId}', '${versionId}', 'legacy-approval', 'approve_public', 'reviewing', 'approved');
update public.drafts set status = 'approved' where id = '${draftId}';
insert into public.publish_jobs (id, owner_id, draft_id, draft_version_id, status)
values ('${publishJobId}', '${ownerId}', '${draftId}', '${versionId}', 'queued');
`));

  await success('publication migration failed over the pre-Task-2 schema', runProcess(npx, ['supabase', 'migration', 'up', '--local', '--yes']));
  headApplied = true;
  assert.equal(await scalar('select max(version) from supabase_migrations.schema_migrations;'), '202608140023');
  assert.equal(
    await scalar(`select concat(approval_action_id, '|', publication_details ->> 'id', '|', status, '|', attempt_count)
      from public.publish_jobs where id = '${publishJobId}';`),
    `${approvalId}|legacy-record|queued|0`,
    'additive migration must backfill the immutable approval and publication snapshot without changing queue state',
  );
  assert.equal(
    await scalar("select concat(count(*) filter (where column_name = 'publication_phase'), '|', count(*) filter (where column_name = 'workflow_status'), '|', count(*) filter (where column_name = 'pages_status')) from information_schema.columns where table_schema = 'public' and table_name = 'publish_jobs';"),
    '1|1|1', 'upgrade adds independent commit/workflow/Pages tracking columns without rebuilding the queue',
  );
  assert.equal(
    await scalar("select concat(has_function_privilege('service_role', 'public.claim_narrative_publication(uuid,uuid,uuid,text,uuid)', 'EXECUTE'), '|', not has_function_privilege('authenticated', 'public.claim_narrative_publication(uuid,uuid,uuid,text,uuid)', 'EXECUTE'), '|', has_function_privilege('service_role', 'public.renew_narrative_publication_claim(uuid,uuid)', 'EXECUTE'), '|', not has_function_privilege('authenticated', 'public.renew_narrative_publication_claim(uuid,uuid)', 'EXECUTE'), '|', to_regprocedure('public.retry_narrative_publish(uuid,uuid,text)') is null);"),
    't|t|t|t|t',
    'upgrade installs claim and exact-attempt renewal only at the service publication boundary and removes browser retry',
  );

  await success('upgraded publication configuration failed', runPsql(`
update public.narrative_admin_settings
set github_repository_owner = 'cheonmu-owner', github_repository_name = 'cheonmu-archive', github_branch = 'main'
where owner_id = '${ownerId}';
select set_config('request.jwt.claim.role', 'service_role', false);
set role service_role;
select public.store_narrative_secret('${ownerId}', 'github', 'publication-upgrade-fixture-value');
select public.claim_narrative_publication('${ownerId}', '${publishJobId}', '${versionId}', 'legacy-publish-key', '${attemptId}') ->> 'outcome';
select public.renew_narrative_publication_claim('${publishJobId}', '${attemptId}') ->> 'status';
select public.complete_narrative_publication('${publishJobId}', '${attemptId}', '${'1'.repeat(40)}', 'src/content/records/77-legacy-record.md') ->> 'status';
reset role;
`));
  assert.equal(
    await scalar(`select concat(job.status, '|', draft.status, '|', job.repository_owner, '/', job.repository_name, '@', job.repository_branch, '|', job.idempotency_key, '|', job.publication_phase, '|', job.tracking_status)
      from public.publish_jobs as job join public.drafts as draft on draft.id = job.draft_id where job.id = '${publishJobId}';`),
    'published|published|cheonmu-owner/cheonmu-archive@main|legacy-publish-key|commit_created|pending',
    'a migrated queued row remains publishable and initializes independent observation without changing commit success',
  );
} catch (error) {
  primaryError = error;
} finally {
  try {
    await success('database restoration after publication upgrade test failed', runProcess(npx, [
      'supabase', 'db', 'reset', '--local', '--yes', ...(headApplied ? [] : ['--version', '202608140016', '--no-seed']),
    ]));
  } catch (restoreError) {
    primaryError = new AggregateError([primaryError, restoreError].filter((value) => value !== undefined), 'publication upgrade and restoration failed');
  }
}

if (primaryError) throw primaryError;
console.log('PASS: migrations 017-019 upgrade a pre-publication queue additively and initialize exact-commit deployment observation.');
