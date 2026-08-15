import { execSync, spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const allowedOrigin = 'https://admin.example.test';
const deniedOrigin = 'https://evil.example.test';
const gatewayUrl = 'http://127.0.0.1:54321/functions/v1';
const standardHeaders = ['authorization', 'apikey', 'x-client-info', 'content-type'];

function command(name) {
  return process.platform === 'win32' ? `${name}.cmd` : name;
}

function localKeys() {
  const output = execSync('npx supabase status -o env', { encoding: 'utf8' });
  const anon = /^ANON_KEY="([^"]+)"$/m.exec(output)?.[1];
  const service = /^SERVICE_ROLE_KEY="([^"]+)"$/m.exec(output)?.[1];
  if (!anon || !service) throw new Error('local Supabase keys are unavailable; run `npx supabase start` first');
  return { anon, service };
}

async function waitForGateway(child, logs) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Supabase functions server exited early (${child.exitCode})\n${logs.value}`);
    try {
      await fetch(`${gatewayUrl}/run-schedules`, { method: 'OPTIONS' });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw new Error(`Supabase function gateway did not become ready\n${logs.value}`);
}

function requestBody(name) {
  if (name === 'generate-draft') return { jobId: 'job-1', draftId: 'draft-1', idempotencyKey: 'gateway-auth-probe', mode: 'new', kind: 'daily_event' };
  if (name === 'review-draft') return { draftId: 'draft-1', expectedVersionId: 'version-1', expectedState: 'reviewing', idempotencyKey: 'gateway-auth-probe', action: 'approve_private' };
  if (name === 'manage-settings') return { kind: 'github', value: 'x' };
  return { action: 'access' };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function verifyFunction(name, anonKey, accessToken) {
  const preflight = await fetch(`${gatewayUrl}/${name}`, {
    method: 'OPTIONS',
    headers: {
      origin: allowedOrigin,
      'access-control-request-method': 'POST',
      'access-control-request-headers': standardHeaders.join(', '),
    },
  });
  assert(preflight.status === 200 || preflight.status === 204, `${name} standard Supabase preflight returned ${preflight.status}`);
  const preflightOrigin = preflight.headers.get('access-control-allow-origin');
  assert(preflightOrigin === allowedOrigin || preflightOrigin === '*', `${name} preflight did not allow the requested origin`);
  assert(preflight.headers.get('access-control-allow-credentials') !== 'true', `${name} preflight unexpectedly enabled credentialed wildcard CORS`);
  const allowed = new Set((preflight.headers.get('access-control-allow-headers') ?? '').split(',').map((value) => value.trim().toLowerCase()).filter(Boolean));
  assert(standardHeaders.every((header) => allowed.has(header)), `${name} preflight omitted standard Supabase headers: ${[...allowed].join(', ')}`);

  const invalidToken = await fetch(`${gatewayUrl}/${name}`, {
    method: 'POST',
    headers: { origin: allowedOrigin, authorization: 'Bearer invalid-token', apikey: anonKey, 'x-client-info': 'cheonmu-gateway-test', 'content-type': 'application/json' },
    body: JSON.stringify(requestBody(name)),
  });
  const body = await invalidToken.json();
  const invalidOrigin = invalidToken.headers.get('access-control-allow-origin');
  assert(invalidToken.status === 401, `${name} invalid-token request returned ${invalidToken.status}, expected handler-owned 401: ${JSON.stringify(body)}`);
  assert(invalidOrigin === allowedOrigin || invalidOrigin === '*', `${name} invalid-token response origin was ${JSON.stringify(invalidOrigin)}: ${JSON.stringify(body)}`);
  assert(invalidToken.headers.get('access-control-allow-credentials') !== 'true', `${name} invalid-token response enabled credentialed wildcard CORS`);
  assert(body?.error === 'authentication_required', `${name} invalid-token response bypassed the handler policy: ${JSON.stringify(body)}`);
  assert(Object.keys(body).length === 1, `${name} invalid-token response exposed application data: ${JSON.stringify(body)}`);

  const unauthenticated = await fetch(`${gatewayUrl}/${name}`, {
    method: 'POST',
    headers: { origin: allowedOrigin, apikey: anonKey, 'content-type': 'application/json' },
    body: JSON.stringify(requestBody(name)),
  });
  assert(unauthenticated.status === 401, `${name} unauthenticated request returned ${unauthenticated.status}, expected 401`);
  const unauthenticatedBody = await unauthenticated.json();
  assert(JSON.stringify(unauthenticatedBody) === JSON.stringify({ error: 'authentication_required' }), `${name} unauthenticated request exposed application data`);

  const valid = await fetch(`${gatewayUrl}/${name}`, {
    method: 'POST',
    headers: { origin: allowedOrigin, authorization: `Bearer ${accessToken}`, apikey: anonKey, 'x-client-info': 'cheonmu-gateway-test', 'content-type': 'application/json' },
    body: JSON.stringify(requestBody(name)),
  });
  const validBody = await valid.json();
  assert(valid.status !== 401, `${name} valid user JWT did not pass handler authentication: ${JSON.stringify(validBody)}`);
  assert([allowedOrigin, '*'].includes(valid.headers.get('access-control-allow-origin')), `${name} gateway did not expose the handler response to the requested origin`);
  assert(typeof validBody?.error === 'string' && validBody.error !== 'authentication_required' && Object.keys(validBody).length === 1, `${name} valid probe unexpectedly returned application data: ${JSON.stringify(validBody)}`);

  const denied = await fetch(`${gatewayUrl}/${name}`, {
    method: 'POST',
    headers: { origin: deniedOrigin, authorization: `Bearer ${accessToken}`, apikey: anonKey, 'x-client-info': 'cheonmu-gateway-test', 'content-type': 'application/json' },
    body: JSON.stringify(requestBody(name)),
  });
  assert(denied.status === 403, `${name} denied-origin actual request returned ${denied.status}, expected 403`);
  assert([null, '*'].includes(denied.headers.get('access-control-allow-origin')), `${name} denied-origin response emitted an unexpected allow-origin header`);
  assert(denied.headers.get('access-control-allow-credentials') !== 'true', `${name} denied-origin response enabled credentialed wildcard CORS`);
  assert((await denied.json())?.error === 'origin_not_allowed', `${name} denied-origin actual request bypassed the handler policy`);
}

async function createTestUser(keys) {
  const email = `gateway-${crypto.randomUUID()}@example.invalid`;
  const password = `Gateway-${crypto.randomUUID()}!`;
  let userId;
  try {
    const created = await fetch('http://127.0.0.1:54321/auth/v1/admin/users', {
      method: 'POST', headers: { apikey: keys.service, authorization: `Bearer ${keys.service}`, 'content-type': 'application/json' },
      body: JSON.stringify({ email, password, email_confirm: true }),
    });
    if (!created.ok) throw new Error(`failed to create local gateway test user (${created.status})`);
    const user = await created.json();
    if (typeof user?.id !== 'string') throw new Error('local gateway test user response omitted id');
    userId = user.id;
    const signedIn = await fetch('http://127.0.0.1:54321/auth/v1/token?grant_type=password', {
      method: 'POST', headers: { apikey: keys.anon, 'content-type': 'application/json' }, body: JSON.stringify({ email, password }),
    });
    if (!signedIn.ok) throw new Error(`failed to authenticate local gateway test user (${signedIn.status})`);
    const session = await signedIn.json();
    if (typeof session?.access_token !== 'string') throw new Error('local gateway session response omitted access token');
    return { id: user.id, accessToken: session.access_token };
  } catch (error) {
    await deleteTestUser(userId, keys.service);
    if (!userId) await deleteTestUserByEmail(email, keys.service);
    throw error;
  }
}

async function deleteTestUser(userId, serviceKey) {
  if (!userId) return;
  await fetch(`http://127.0.0.1:54321/auth/v1/admin/users/${encodeURIComponent(userId)}`, {
    method: 'DELETE', headers: { apikey: serviceKey, authorization: `Bearer ${serviceKey}` },
  });
}

async function deleteTestUserByEmail(email, serviceKey) {
  const response = await fetch('http://127.0.0.1:54321/auth/v1/admin/users?page=1&per_page=1000', {
    headers: { apikey: serviceKey, authorization: `Bearer ${serviceKey}` },
  });
  if (!response.ok) return;
  const body = await response.json().catch(() => null);
  const users = Array.isArray(body?.users) ? body.users : Array.isArray(body) ? body : [];
  const user = users.find((candidate) => candidate?.email === email);
  if (typeof user?.id === 'string') await deleteTestUser(user.id, serviceKey);
}

function stopServer(child) {
  if (child.exitCode !== null) return;
  if (process.platform === 'win32') {
    try { execSync(`taskkill /pid ${child.pid} /t /f`, { stdio: 'ignore' }); } catch { child.kill(); }
  } else {
    child.kill('SIGTERM');
  }
  child.stdout.destroy();
  child.stderr.destroy();
}

const temp = await mkdtemp(join(tmpdir(), 'cheonmu-gateway-'));
const envFile = join(temp, 'functions.env');
const fixtureEnv = await readFile(new URL('../.env.test', import.meta.url), 'utf8');
await writeFile(envFile, `${fixtureEnv.trim()}\nNARRATIVE_ADMIN_ORIGINS=${allowedOrigin}\nNARRATIVE_SCHEDULE_DISPATCH_TOKEN=local-gateway-test\n`, 'utf8');

const logs = { value: '' };
const child = spawn(command('npx'), ['supabase', 'functions', 'serve', '--env-file', envFile], {
  cwd: process.cwd(), windowsHide: true, shell: process.platform === 'win32', stdio: ['ignore', 'pipe', 'pipe'],
});
child.stdout.on('data', (chunk) => { logs.value += chunk.toString(); });
child.stderr.on('data', (chunk) => { logs.value += chunk.toString(); });

try {
  await waitForGateway(child, logs);
  const keys = localKeys();
  const user = await createTestUser(keys);
  try {
    for (const name of ['generate-draft', 'review-draft', 'run-schedules', 'manage-settings']) await verifyFunction(name, keys.anon, user.accessToken);
  } finally {
    await deleteTestUser(user.id, keys.service);
  }
  console.log('Actual local Supabase gateway CORS/auth probes passed for 4 functions.');
} finally {
  stopServer(child);
  await rm(temp, { recursive: true, force: true });
}
