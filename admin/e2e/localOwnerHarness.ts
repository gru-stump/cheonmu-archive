import { execSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import { createNarrativeHandler } from '../src/server/narrativeHandler';

export const seedOwnerId = '10000000-0000-0000-0000-000000000001';
const seedOwnerEmail = 'narrative-seed-owner@local.invalid';
const repoRoot = path.resolve('..');
const adminOrigin = 'http://127.0.0.1:4184';

export interface LocalSupabaseConfig {
  url: string;
  anonKey: string;
  serviceKey: string;
}

export interface LocalOwnerSession {
  accessToken: string;
  config: LocalSupabaseConfig;
}

export function localSupabaseConfig(): LocalSupabaseConfig {
  const output = execSync('npx supabase status -o env', { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  const value = (name: string) => new RegExp(`^${name}="([^"]+)"$`, 'm').exec(output)?.[1] ?? '';
  const config = { url: value('API_URL'), anonKey: value('ANON_KEY'), serviceKey: value('SERVICE_ROLE_KEY') };
  if (!config.url || !config.anonKey || !config.serviceKey) throw new Error('Local Supabase is unavailable.');
  return config;
}

async function checkedJson(response: Response, label: string): Promise<any> {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${label} failed (${response.status}): ${JSON.stringify(body)}`);
  return body;
}

export async function authenticateSeedOwner(page: Page): Promise<LocalOwnerSession> {
  const config = localSupabaseConfig();
  const password = `Local-${randomUUID()}-Aa1!`;
  await checkedJson(await fetch(`${config.url}/auth/v1/admin/users/${seedOwnerId}`, {
    method: 'PUT',
    headers: { apikey: config.serviceKey, authorization: `Bearer ${config.serviceKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ password }),
  }), 'local owner password setup');
  const session = await checkedJson(await fetch(`${config.url}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: config.anonKey, 'content-type': 'application/json' },
    body: JSON.stringify({ email: seedOwnerEmail, password }),
  }), 'local owner authentication');
  if (typeof session.access_token !== 'string') throw new Error('Local owner authentication omitted an access token.');
  const storageKey = `sb-${new URL(config.url).hostname.split('.')[0]}-auth-token`;
  await page.addInitScript(({ key, value }) => localStorage.setItem(key, JSON.stringify(value)), { key: storageKey, value: session });
  return { accessToken: session.access_token, config };
}

export async function routeRealNarrativeApi(page: Page, session: LocalOwnerSession): Promise<void> {
  const handler = createNarrativeHandler({ supabaseUrl: session.config.url, supabaseAnonKey: session.config.anonKey });
  await page.route('**/api/narrative/**', async (route) => {
    const incoming = route.request();
    const body = incoming.postDataBuffer();
    const response = await handler(new Request(incoming.url(), {
      method: incoming.method(),
      headers: incoming.headers(),
      ...(body ? { body } : {}),
    }));
    await route.fulfill({
      status: response.status,
      headers: Object.fromEntries(response.headers.entries()),
      body: Buffer.from(await response.arrayBuffer()),
    });
  });
}

function serviceHeaders(config: LocalSupabaseConfig, prefer?: string) {
  return {
    apikey: config.serviceKey,
    authorization: `Bearer ${config.serviceKey}`,
    'content-type': 'application/json',
    ...(prefer ? { prefer } : {}),
  };
}

export async function serviceGet<T>(config: LocalSupabaseConfig, pathName: string): Promise<T> {
  return checkedJson(await fetch(`${config.url}/rest/v1/${pathName}`, { headers: serviceHeaders(config) }), `service GET ${pathName}`) as Promise<T>;
}

export async function serviceInsert<T>(config: LocalSupabaseConfig, table: string, value: unknown): Promise<T> {
  return checkedJson(await fetch(`${config.url}/rest/v1/${table}`, {
    method: 'POST', headers: serviceHeaders(config, 'return=representation'), body: JSON.stringify(value),
  }), `service INSERT ${table}`) as Promise<T>;
}

export async function serviceRpc<T>(config: LocalSupabaseConfig, name: string, value: unknown): Promise<T> {
  return checkedJson(await fetch(`${config.url}/rest/v1/rpc/${name}`, {
    method: 'POST', headers: serviceHeaders(config), body: JSON.stringify(value),
  }), `service RPC ${name}`) as Promise<T>;
}

export async function servicePatch<T>(config: LocalSupabaseConfig, pathName: string, value: unknown): Promise<T> {
  return checkedJson(await fetch(`${config.url}/rest/v1/${pathName}`, {
    method: 'PATCH', headers: serviceHeaders(config, 'return=representation'), body: JSON.stringify(value),
  }), `service PATCH ${pathName}`) as Promise<T>;
}

export async function serviceDelete(config: LocalSupabaseConfig, pathName: string): Promise<void> {
  const response = await fetch(`${config.url}/rest/v1/${pathName}`, { method: 'DELETE', headers: serviceHeaders(config) });
  if (!response.ok) throw new Error(`service DELETE ${pathName} failed (${response.status})`);
}

export async function edgePost(session: LocalOwnerSession, functionName: string, value: unknown): Promise<Response> {
  return fetch(`${session.config.url}/functions/v1/${functionName}`, {
    method: 'POST',
    headers: {
      origin: adminOrigin,
      apikey: session.config.anonKey,
      authorization: `Bearer ${session.accessToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(value),
  });
}

function command(name: string) {
  return process.platform === 'win32' ? `${name}.cmd` : name;
}

export async function startFakeProviderFunctions(): Promise<{ stop(): Promise<void> }> {
  const temp = await mkdtemp(path.join(tmpdir(), 'cheonmu-owner-e2e-'));
  const envFile = path.join(temp, 'functions.env');
  await writeFile(envFile, [
    'FAKE_PROVIDER_MODE=fixture',
    'NARRATIVE_FAKE_LOCAL_FIXTURE=true',
    `NARRATIVE_ADMIN_ORIGINS=${adminOrigin}`,
    'NARRATIVE_SCHEDULE_DISPATCH_TOKEN=local-owner-e2e',
    '',
  ].join('\n'), 'utf8');
  const child = spawn(command('npx'), ['supabase', 'functions', 'serve', '--env-file', envFile], {
    cwd: repoRoot,
    windowsHide: true,
    shell: process.platform === 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  }) as ChildProcessWithoutNullStreams;
  let logs = '';
  child.stdout.on('data', (chunk) => { logs += chunk.toString(); });
  child.stderr.on('data', (chunk) => { logs += chunk.toString(); });
  const deadline = Date.now() + 30_000;
  const gatewayUrl = localSupabaseConfig().url;
  let ready = false;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Local functions exited early (${child.exitCode}): ${logs.slice(-1000)}`);
    try {
      const response = await fetch(`${gatewayUrl}/functions/v1/run-schedules`, { method: 'OPTIONS' });
      if (response.status !== 502 && response.status !== 503) {
        ready = true;
        break;
      }
    } catch { /* retry until the local gateway is ready */ }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  if (!ready) throw new Error(`Local functions did not become ready: ${logs.slice(-1000)}`);
  return {
    stop: async () => {
      if (child.exitCode === null) {
        if (process.platform === 'win32') {
          try { execSync(`taskkill /pid ${child.pid} /t /f`, { stdio: 'ignore' }); } catch { child.kill(); }
        } else child.kill('SIGTERM');
      }
      child.stdout.destroy();
      child.stderr.destroy();
      await rm(temp, { recursive: true, force: true });
    },
  };
}
