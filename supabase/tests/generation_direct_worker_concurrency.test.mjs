import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const container = 'supabase_db_cheonmu-narrative';
const ownerId = '10000000-0000-0000-0000-000000000001';
const providerId = '12000000-0000-0000-0000-000000000001';
const contextId = '15000000-0000-0000-0000-000000000001';

function runPsql(sql, onStdout) {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', ['exec', '-i', container, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; onStdout?.(stdout); });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(sql);
  });
}

function service(sql) {
  return `begin;
select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;
${sql}
commit;`;
}

function owner(sql) {
  return `begin;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', '${ownerId}', true);
set local role authenticated;
${sql}
commit;`;
}

function requireSuccess(label, result) {
  if (result.code !== 0) throw new Error(`${label} (exit ${String(result.code)})\n${result.stdout}\n${result.stderr}`);
  return result;
}

function parseQueued(result) {
  requireSuccess('manual queue failed', result);
  const line = result.stdout.split(/\r?\n/).find((value) => value.trim().startsWith('{'));
  if (!line) throw new Error(`manual queue omitted its result\n${result.stdout}`);
  return JSON.parse(line);
}

const setup = await runPsql(`
update public.generation_jobs set scheduled_for = clock_timestamp() + interval '1 day'
where status = 'queued' and worker_attempt_token is null;
update public.narrative_admin_settings set manual_generation_enabled = true, schedule_automation_enabled = true
where owner_id = '${ownerId}';
update public.provider_settings set enabled = true, pricing_verified_at = public.narrative_business_date(current_timestamp)
where id = '${providerId}';
`);
requireSuccess('direct/worker race setup failed', setup);

const failures = [];

const queued = parseQueued(await runPsql(owner(
  `select public.queue_manual_generation(null, 'new', 'short_dialogue', 'direct queue claim race', null, array[]::text[])::text;`,
)));
const queueClaimToken = randomUUID();
let claimSignal;
const claimReady = new Promise((resolve) => { claimSignal = resolve; });
const queueClaim = runPsql(service(`
select public.claim_generation_worker_job('${queueClaimToken}') ->> 'outcome';
\\echo WORKER_CLAIM_FINISHED
select pg_sleep(2);
`), (stdout) => { if (stdout.includes('WORKER_CLAIM_FINISHED')) claimSignal(); });
await Promise.race([
  claimReady,
  queueClaim.then((result) => { throw new Error(`worker claim exited before its barrier\n${result.stdout}\n${result.stderr}`); }),
]);
const directAttemptToken = randomUUID();
const directFreeze = runPsql(service(`select public.freeze_generation_context(
  '${queued.job_id}', '${queued.draft_id}', 'new', '${queued.idempotency_key}',
  array['${contextId}'],
  '[{"versionId":"${contextId}","memoryType":"canon","content":"direct race","tokenCount":1}]',
  '${providerId}', '${directAttemptToken}');`));
const [queueClaimResult, directFreezeResult] = await Promise.all([queueClaim, directFreeze]);
requireSuccess('worker claim during direct queue failed unexpectedly', queueClaimResult);
if (!queueClaimResult.stdout.includes('idle')) {
  failures.push(`worker seized a freshly queued direct manual job: ${queueClaimResult.stdout.trim()}`);
  requireSuccess('could not release incorrectly claimed direct job', await runPsql(service(
    `select public.fail_generation_worker_attempt('${queued.job_id}', '${queueClaimToken}', 'context_selection_failed');`,
  )));
}
if (directFreezeResult.code !== 0) failures.push(`direct freeze lost the queue/worker race: ${directFreezeResult.stderr.trim()}`);
if (directFreezeResult.code === 0) {
  requireSuccess('could not abort the direct freeze fixture', await runPsql(service(
    `select public.abort_generation_attempt('${queued.job_id}', '${directAttemptToken}', '${queued.idempotency_key}', 'freeze_failed');`,
  )));
}
requireSuccess('could not park first direct fixture', await runPsql(
  `update public.generation_jobs set scheduled_for = clock_timestamp() + interval '1 day' where id = '${queued.job_id}';`,
));

const fenced = parseQueued(await runPsql(owner(
  `select public.queue_manual_generation(null, 'new', 'short_dialogue', 'direct provider fence race', null, array[]::text[])::text;`,
)));
const generationToken = randomUUID();
const directResult = await runPsql(service(`
select public.freeze_generation_context(
  '${fenced.job_id}', '${fenced.draft_id}', 'new', '${fenced.idempotency_key}',
  array['${contextId}'],
  '[{"versionId":"${contextId}","memoryType":"canon","content":"direct race","tokenCount":1}]',
  '${providerId}', '${generationToken}');
select public.reserve_and_start_generation('${fenced.job_id}', '${generationToken}',
  (select worst_case_cost_micros from public.generation_jobs where id = '${fenced.job_id}'));
select public.fence_generation_provider_dispatch('${fenced.job_id}', '${generationToken}', null);
`));
requireSuccess('direct provider-fence transaction failed', directResult);
// The direct request is now waiting on its provider while the database fence
// is committed. A separate worker connection must not treat it as abandoned.
const fencedClaim = runPsql(service(`select public.claim_generation_worker_job('${randomUUID()}') ->> 'outcome';`));
const fencedClaimResult = await fencedClaim;
requireSuccess('worker claim during fenced direct generation failed unexpectedly', fencedClaimResult);
if (!fencedClaimResult.stdout.includes('idle')) {
  failures.push(`worker cleaned/dead-lettered a live fenced direct request: ${fencedClaimResult.stdout.trim()}`);
}
const fencedState = requireSuccess('direct fenced-state verification failed', await runPsql(`select concat(
  status, '|', worker_attempt_token is null, '|', worker_failure_code is null, '|',
  (select count(*) from public.budget_entries where generation_job_id = '${fenced.job_id}' and entry_type in ('reconciliation','failure'))
) from public.generation_jobs where id = '${fenced.job_id}';`)).stdout.trim();
if (fencedState !== 'running|t|t|0') failures.push(`worker interfered with direct fenced state: ${fencedState}`);

if (failures.length) throw new Error(failures.join('\n'));
console.log('PASS: a database-owned direct lease excludes worker claim/cleanup both immediately after manual queueing and after the direct provider fence.');
