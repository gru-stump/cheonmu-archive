import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const gatewayUrl = 'http://127.0.0.1:54321/functions/v1/run-generation-worker';
const databaseContainer = 'supabase_db_cheonmu-narrative';
const ownerId = '10000000-0000-0000-0000-000000000001';
const otherOwnerId = randomUUID();
const ownerMemoryId = randomUUID();
const otherOwnerMemoryId = randomUUID();
const ownerMemoryContent = 'OWNER_A_CONTEXT_ONLY';
const otherOwnerMemoryContent = 'OWNER_B_PRIVATE_MUST_NEVER_APPEAR';
const dispatchToken = randomUUID();

function command(name) { return process.platform === 'win32' ? `${name}.cmd` : name; }
function assert(condition, message) { if (!condition) throw new Error(message); }

function localKeys() {
  const output = execFileSync(command('npx'), ['supabase', 'status', '-o', 'env'], { encoding: 'utf8', shell: process.platform === 'win32' });
  const anon = /^ANON_KEY="([^"]+)"$/m.exec(output)?.[1];
  if (!anon) throw new Error('local Supabase anonymous key is unavailable');
  return { anon };
}

function psql(sql) {
  const result = spawnSync('docker', ['exec', '-i', databaseContainer, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1'], {
    input: sql, encoding: 'utf8', windowsHide: true,
  });
  if (result.status !== 0) throw new Error(`local database command failed\n${result.stderr}`);
  return result.stdout.trim();
}

function service(sql) {
  return `begin;
select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;
${sql}
commit;`;
}

function authenticated(sql) {
  return `begin;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', '${ownerId}', true);
set local role authenticated;
${sql}
commit;`;
}

async function waitForGateway(child, logs) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Supabase functions server exited early (${child.exitCode})\n${logs.value}`);
    if (!logs.value.includes('Serving functions on')) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      continue;
    }
    try {
      const beforeProbe = logs.value.length;
      const response = await fetch(gatewayUrl, { headers: { connection: 'close' } });
      const probeDeadline = Date.now() + 500;
      while (Date.now() < probeDeadline
        && !logs.value.slice(beforeProbe).includes('serving the request with supabase/functions/run-generation-worker')) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      if (response.status === 405
        && logs.value.slice(beforeProbe).includes('serving the request with supabase/functions/run-generation-worker')) return;
    } catch { /* startup probe */ }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Supabase function gateway did not become ready\n${logs.value}`);
}

async function dispatch(anonKey, logs) {
  const response = await fetch(gatewayUrl, {
    method: 'POST',
    headers: { apikey: anonKey, connection: 'close', 'content-type': 'application/json', 'x-schedule-dispatch-token': dispatchToken },
    body: JSON.stringify({ action: 'dispatch' }),
  });
  const body = await response.json().catch(() => null);
  if (response.status !== 202) throw new Error(`generation worker returned ${response.status}: ${JSON.stringify(body)}\n${logs.value}`);
  return body;
}

function insertJob(id, source, kind) {
  const budgetPolicy = source === 'schedule' ? 'block_at_warning' : 'block_at_risk';
  psql(`insert into public.generation_jobs (id, owner_id, schedule_key, scheduled_for, payload)
    values ('${id}', '${ownerId}', 'edge:${source}:${id}', clock_timestamp() - interval '1 minute',
      '{"source":"${source}","kind":"${kind}","budgetPolicy":"${budgetPolicy}"}');`);
}

function assertExactlyOnce(jobId, label, expectedAttempts) {
  const value = psql(`select concat_ws('|', job.status,
      (select count(*) from public.draft_versions as version where version.generation_job_id = job.id),
      (select count(*) from public.draft_versions as version where version.generation_job_id = job.id and version.provider_response_id is not null),
      (select count(*) from public.budget_entries as entry where entry.generation_job_id = job.id and entry.entry_type = 'reservation'),
      (select count(*) from public.budget_entries as entry where entry.generation_job_id = job.id and entry.entry_type = 'reconciliation'),
      job.worker_attempt_count)
    from public.generation_jobs as job where job.id = '${jobId}';`);
  assert(value === `completed|1|1|1|1|${expectedAttempts}`, `${label} did not settle exactly once in ${expectedAttempts} worker attempt(s): ${value}`);
}

function invocationCount(logs, kind) {
  return [...logs.value.matchAll(new RegExp(`FAKE_LOCAL_PROVIDER_INVOKED:${kind}`, 'g'))].length;
}

function providerTraces(logs, kind) {
  return [...logs.value.matchAll(new RegExp(`FAKE_LOCAL_PROVIDER_CONTEXT:${kind}:(\\{[^\\r\\n]+\\})`, 'g'))]
    .map((match) => JSON.parse(match[1]));
}

async function waitForInvocationCount(logs, kind, expected) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline && invocationCount(logs, kind) < expected) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert(invocationCount(logs, kind) === expected,
    `expected exactly ${expected} ${kind} fake-provider invocation(s), got ${invocationCount(logs, kind)}\n${logs.value}`);
}

function stopServer(child) {
  if (child.exitCode !== null) return;
  if (process.platform === 'win32') {
    try { execFileSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' }); } catch { child.kill(); }
  } else child.kill('SIGTERM');
  child.stdout.destroy();
  child.stderr.destroy();
}

const scheduleJob = randomUUID();
const accessJob = randomUUID();
const revisionDraft = randomUUID();
const revisionSourceVersion = randomUUID();
const revisionWorkerToken = randomUUID();
const revisionGenerationToken = randomUUID();
const lostClaimToken = randomUUID();
const temp = await mkdtemp(join(tmpdir(), 'cheonmu-generation-worker-'));
const envFile = join(temp, 'functions.env');
const fixtureEnv = await readFile(new URL('../.env.test', import.meta.url), 'utf8');
await writeFile(envFile, `${fixtureEnv.trim()}\nNARRATIVE_FAKE_LOCAL_FIXTURE=true\nNARRATIVE_FAKE_LOCAL_CONTEXT_TRACE=true\nNARRATIVE_SCHEDULE_DISPATCH_TOKEN=${dispatchToken}\n`, 'utf8');

psql(`
update public.generation_jobs set scheduled_for = clock_timestamp() + interval '1 day'
where status = 'queued' and worker_attempt_token is null;
update public.narrative_admin_settings set manual_generation_enabled = true, schedule_automation_enabled = true where owner_id = '${ownerId}';
update public.provider_settings set enabled = true, pricing_verified_at = public.narrative_business_date(current_timestamp) where owner_id = '${ownerId}';
insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
values ('${otherOwnerId}', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
  'worker-owner-b-${otherOwnerId}@local.invalid', '', now(), now(), now());
insert into public.owner_profiles (owner_id, display_name) values ('${otherOwnerId}', 'worker owner B');
insert into public.memory_items (id, owner_id, memory_type, content, importance, metadata, status, blocking) values
  ('${ownerMemoryId}', '${ownerId}', 'canon', '${ownerMemoryContent}', 100,
    '{"tokenCount":1,"continuityFacts":{"relationshipStage":7}}', 'approved', false),
  ('${otherOwnerMemoryId}', '${otherOwnerId}', 'canon', '${otherOwnerMemoryContent}', 100,
    '{"tokenCount":1,"continuityFacts":{"relationshipStage":1}}', 'approved', false);
`);
insertJob(scheduleJob, 'schedule', 'daily_event');

const logs = { value: '' };
const child = spawn(command('npx'), ['supabase', 'functions', 'serve', '--env-file', envFile], {
  cwd: process.cwd(), windowsHide: true, shell: process.platform === 'win32', stdio: ['ignore', 'pipe', 'pipe'],
});
child.stdout.on('data', (chunk) => { logs.value += chunk.toString(); });
child.stderr.on('data', (chunk) => { logs.value += chunk.toString(); });

try {
  await waitForGateway(child, logs);
  const { anon } = localKeys();

  const [first, concurrent] = await Promise.all([dispatch(anon, logs), dispatch(anon, logs)]);
  assert([first.outcome, concurrent.outcome].sort().join('|') === 'completed|idle', `concurrent dispatch did not serialize: ${JSON.stringify([first, concurrent])}`);
  assertExactlyOnce(scheduleJob, 'schedule dispatch', 1);
  await waitForInvocationCount(logs, 'daily_event', 1);
  const scheduleTrace = providerTraces(logs, 'daily_event').at(-1);
  assert(scheduleTrace?.contextVersionIds?.includes(ownerMemoryId), `owner A memory id did not reach the fake provider\n${logs.value}`);
  assert(scheduleTrace?.contextMemories?.some((memory) => memory.versionId === ownerMemoryId && memory.content === ownerMemoryContent),
    `owner A memory content did not reach the fake provider\n${logs.value}`);
  assert(!scheduleTrace?.contextVersionIds?.includes(otherOwnerMemoryId)
    && !scheduleTrace?.contextMemories?.some((memory) => memory.versionId === otherOwnerMemoryId || memory.content === otherOwnerMemoryContent),
  `owner B private memory reached owner A's fake provider request\n${logs.value}`);
  const ownerScope = psql(`select concat_ws('|',
      job.context_version_ids @> array['${ownerMemoryId}']::text[],
      not (job.context_version_ids @> array['${otherOwnerMemoryId}']::text[]),
      job.context_snapshot::text like '%${ownerMemoryContent}%',
      job.context_snapshot::text not like '%${otherOwnerMemoryContent}%',
      version.context_version_ids @> array['${ownerMemoryId}']::text[],
      not (version.context_version_ids @> array['${otherOwnerMemoryId}']::text[]))
    from public.generation_jobs as job
    join public.draft_versions as version on version.generation_job_id = job.id and version.owner_id = job.owner_id
    where job.id = '${scheduleJob}';`);
  assert(ownerScope === 't|t|t|t|t|t', `owner scope did not survive frozen snapshot and generated version: ${ownerScope}`);

  insertJob(accessJob, 'access', 'short_dialogue');
  const lostClaim = psql(service(`select public.claim_generation_worker_job('${lostClaimToken}') ->> 'outcome';`));
  assert(lostClaim.includes('claimed'), `lost-claim fixture was not claimed: ${lostClaim}`);
  psql(`update public.generation_jobs set worker_lease_expires_at = clock_timestamp() - interval '1 second' where id = '${accessJob}';`);
  const cleanup = await dispatch(anon, logs);
  assert(cleanup.outcome === 'retry_wait' && cleanup.jobId === accessJob, `expired pre-provider attempt was not safely delayed: ${JSON.stringify(cleanup)}`);
  psql(`update public.generation_jobs set worker_retry_at = clock_timestamp() - interval '1 second' where id = '${accessJob}';`);
  const replacement = await dispatch(anon, logs);
  assert(replacement.outcome === 'completed' && replacement.jobId === accessJob, `replacement attempt did not complete: ${JSON.stringify(replacement)}`);
  assertExactlyOnce(accessJob, 'lost-claim replacement dispatch', 2);
  await waitForInvocationCount(logs, 'short_dialogue', 1);
  assert(invocationCount(logs, 'daily_event') === 1 && invocationCount(logs, 'short_dialogue') === 1,
    `served fake-provider invocation count changed after settlement\n${logs.value}`);

  psql(`
    insert into public.drafts (id, owner_id, kind, status, title)
    values ('${revisionDraft}', '${ownerId}', 'short_dialogue', 'queued', 'revision recovery');
    insert into public.draft_versions (id, owner_id, draft_id, version_number, content, continuity_level)
    values ('${revisionSourceVersion}', '${ownerId}', '${revisionDraft}', 1,
      '{"title":"source","body":"REVISION_SOURCE_SENTENCE remains immutable","canonChangeCandidates":[]}', 'review');
    alter table public.drafts disable trigger drafts_require_transition_rpc;
    update public.drafts set status = 'reviewing' where id = '${revisionDraft}';
    alter table public.drafts enable trigger drafts_require_transition_rpc;
  `);
  const revisionQueued = JSON.parse(psql(authenticated(`select public.queue_draft_revision(
    '${revisionDraft}', '${revisionSourceVersion}', 'REVISION_SOURCE_SENTENCE', 'tighten only this selection', 37, 100
  );`)).split(/\r?\n/).filter((line) => line.startsWith('{')).at(-1));
  const revisionJob = revisionQueued.job_id;
  const revisionKey = revisionQueued.idempotency_key;
  psql(`update public.generation_jobs set direct_dispatch_expires_at = clock_timestamp() - interval '1 second'
    where id = '${revisionJob}';`);
  const revisionClaim = JSON.parse(psql(service(`select public.claim_generation_worker_job('${revisionWorkerToken}');`))
    .split(/\r?\n/).filter((line) => line.startsWith('{')).at(-1));
  assert(revisionClaim.outcome === 'claimed' && revisionClaim.ownerId === ownerId
    && revisionClaim.requestedMaxOutputTokens === 37,
  `revision claim did not derive the immutable owner/cost binding: ${JSON.stringify(revisionClaim)}`);
  const reserveResponses = psql(service(`
    select public.freeze_generation_worker_context(
      '${revisionJob}', '${revisionDraft}', 'revise_selection', '${revisionKey}', array['${ownerMemoryId}'],
      '[{"versionId":"${ownerMemoryId}","memoryType":"canon","content":"${ownerMemoryContent}","tokenCount":1,"continuityFacts":{"relationshipStage":7}}]',
      '12000000-0000-0000-0000-000000000001', '${revisionGenerationToken}', '${revisionWorkerToken}');
    select public.reserve_and_start_worker_generation(
      '${revisionJob}', '${revisionGenerationToken}',
      (select worst_case_cost_micros from public.generation_jobs where id = '${revisionJob}'), '${revisionWorkerToken}');
    -- The committed response is deliberately treated as lost, then recovered by the exact attempt.
    select public.reserve_and_start_worker_generation(
      '${revisionJob}', '${revisionGenerationToken}',
      (select worst_case_cost_micros from public.generation_jobs where id = '${revisionJob}'), '${revisionWorkerToken}');
  `));
  assert((reserveResponses.match(/"status": "reserved"/g) ?? []).length === 2,
    `revision lost-reserve response was not idempotently recovered\n${reserveResponses}`);
  psql(`update public.generation_jobs set worker_lease_expires_at = clock_timestamp() - interval '1 second'
    where id = '${revisionJob}';`);
  const revisionCleanup = await dispatch(anon, logs);
  assert(revisionCleanup.outcome === 'retry_wait' && revisionCleanup.jobId !== revisionJob,
    `reserved revision claim loss did not create one safe replacement: ${JSON.stringify(revisionCleanup)}`);
  const revisionReplacement = revisionCleanup.jobId;
  const relationalSnapshot = psql(`select concat_ws('|', requested_max_output_tokens,
      confirmed_maximum_cost_micros, source_draft_version_id, payload ->> 'sourceVersionId')
    from public.generation_jobs where id = '${revisionReplacement}';`);
  assert(relationalSnapshot === `37|100|${revisionSourceVersion}|${revisionSourceVersion}`,
    `revision replacement dropped its relational snapshot: ${relationalSnapshot}`);
  psql(`update public.generation_jobs
    set worker_retry_at = clock_timestamp() - interval '1 second',
        direct_dispatch_expires_at = clock_timestamp() - interval '1 second',
        scheduled_for = clock_timestamp() - interval '1 second'
    where id = '${revisionReplacement}';`);
  const revisionDispatch = await dispatch(anon, logs);
  assert(revisionDispatch.outcome === 'completed' && revisionDispatch.jobId === revisionReplacement,
    `revision replacement did not complete through the fake provider: ${JSON.stringify(revisionDispatch)}\n${logs.value}`);
  assertExactlyOnce(revisionReplacement, 'revision replacement dispatch', 2);
  await waitForInvocationCount(logs, 'short_dialogue', 2);
  const revisionTrace = providerTraces(logs, 'short_dialogue').find((trace) => trace.revision?.selectedText === 'REVISION_SOURCE_SENTENCE');
  assert(revisionTrace?.maxOutputTokens === 37
    && revisionTrace?.revision?.instruction === 'tighten only this selection',
  `revision provider request did not retain the exact output cap and selection: ${JSON.stringify(revisionTrace)}\n${logs.value}`);
  assert(revisionTrace.contextVersionIds.includes(ownerMemoryId)
    && revisionTrace.contextMemories.some((memory) => memory.versionId === ownerMemoryId && memory.content === ownerMemoryContent)
    && !revisionTrace.contextVersionIds.includes(otherOwnerMemoryId)
    && !revisionTrace.contextMemories.some((memory) => memory.content === otherOwnerMemoryContent),
  `revision provider context crossed owner scope: ${JSON.stringify(revisionTrace)}`);
  const revisionResult = psql(`select concat_ws('|', replacement.requested_max_output_tokens,
      replacement.confirmed_maximum_cost_micros, replacement.source_draft_version_id,
      replacement.max_revision_output_tokens,
      replacement.context_version_ids @> array['${ownerMemoryId}']::text[],
      not (replacement.context_version_ids @> array['${otherOwnerMemoryId}']::text[]),
      generated.context_version_ids @> array['${ownerMemoryId}']::text[],
      not (generated.context_version_ids @> array['${otherOwnerMemoryId}']::text[]),
      source.content ->> 'body')
    from public.generation_jobs as replacement
    join public.draft_versions as generated on generated.generation_job_id = replacement.id
      and generated.owner_id = replacement.owner_id and generated.draft_id = replacement.draft_id
    join public.draft_versions as source on source.id = replacement.source_draft_version_id
      and source.owner_id = replacement.owner_id and source.draft_id = replacement.draft_id
    where replacement.id = '${revisionReplacement}';`);
  assert(revisionResult === `37|100|${revisionSourceVersion}|37|t|t|t|t|REVISION_SOURCE_SENTENCE remains immutable`,
    `revision cost/source/version binding changed across recovery: ${revisionResult}`);

  console.log('PASS: served fake-local generation worker owner-scopes context, preserves revision recovery bindings, counts one provider call per attempt, and safely replaces lost pre-provider claims.');
} finally {
  stopServer(child);
  await rm(temp, { recursive: true, force: true });
}
