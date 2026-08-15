import { defineConfig } from '@playwright/test';
import { execSync } from 'node:child_process';
import path from 'node:path';

const port = 4184;
const localStatus = execSync('npx supabase status -o env', { cwd: path.resolve('..'), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
const localValue = (name: string) => new RegExp(`^${name}="([^"]+)"$`, 'm').exec(localStatus)?.[1] ?? '';
const localUrl = localValue('API_URL');
const localAnonKey = localValue('ANON_KEY');
if (!localUrl || !localAnonKey) throw new Error('Local Supabase is required for the authenticated owner E2E journey.');

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 30_000,
  expect: { timeout: 5_000 },
  outputDir: '../.superpowers/sdd/2026-08-15-cheonmu-narrative-admin/playwright-results',
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    browserName: 'chromium',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: `npm run dev -- --host 127.0.0.1 --port ${port} --strictPort`,
    url: `http://127.0.0.1:${port}/__e2e`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      ...process.env,
      VITE_ENABLE_E2E_FIXTURE: 'true',
      VITE_SUPABASE_URL: localUrl,
      VITE_SUPABASE_ANON_KEY: localAnonKey,
    },
  },
});
