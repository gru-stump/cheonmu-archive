import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const gatewayUrl = 'http://127.0.0.1:54321/functions/v1/run-generation-worker';
const databaseContainer = 'supabase_db_cheonmu-narrative';
const ownerId = '10000000-0000-0000-0000-000000000001';
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
const lostClaimToken = randomUUID();
const temp = await mkdtemp(join(tmpdir(), 'cheonmu-generation-worker-'));
const envFile = join(temp, 'functions.env');
const fixtureEnv = await readFile(new URL('../.env.test', import.meta.url), 'utf8');
await writeFile(envFile, `${fixtureEnv.trim()}\nNARRATIVE_FAKE_LOCAL_FIXTURE=true\nNARRATIVE_SCHEDULE_DISPATCH_TOKEN=${dispatchToken}\n`, 'utf8');

psql(`update public.narrative_admin_settings set manual_generation_enabled = true, schedule_automation_enabled = true where owner_id = '${ownerId}';
update public.provider_settings set enabled = true, pricing_verified_at = public.narrative_business_date(current_timestamp) where owner_id = '${ownerId}';`);
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

  console.log('PASS: served fake-local generation worker made exactly one counted provider call per scenario, serialized concurrent schedule dispatch, and safely replaced a lost pre-provider access claim.');
} finally {
  stopServer(child);
  await rm(temp, { recursive: true, force: true });
}
