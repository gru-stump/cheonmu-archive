import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig(({ command, isPreview }) => ({
  base: command === 'build' || isPreview ? '/cheonmu-archive/' : '/',
  plugins: [react()],
  server: { proxy: { '/api/editor': 'http://127.0.0.1:4174' } },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}', 'scripts/**/*.test.ts', 'editor/**/*.test.ts'],
    setupFiles: './src/test/setup.ts',
  },
}));
