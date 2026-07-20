import { defineConfig } from 'playwright/test';

export default defineConfig({
  testDir: './e2e',
  testMatch: 'editor-layout.spec.ts',
  outputDir: 'test-results/editor-layout',
  workers: 1,
  use: {
    baseURL: 'http://127.0.0.1:5173/editor/',
    trace: 'on-first-retry',
  },
  webServer: [
    {
      command: 'npx tsx editor/server.ts',
      url: 'http://127.0.0.1:4174/api/editor/records',
      reuseExistingServer: !process.env.CI,
    },
    {
      command: 'npx vite --host 127.0.0.1 --port 5173 --strictPort',
      url: 'http://127.0.0.1:5173/editor/',
      reuseExistingServer: !process.env.CI,
    },
  ],
});
