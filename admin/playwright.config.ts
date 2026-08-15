import { defineConfig } from '@playwright/test';

const port = 4184;

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
    env: { ...process.env, VITE_ENABLE_E2E_FIXTURE: 'true' },
  },
});
