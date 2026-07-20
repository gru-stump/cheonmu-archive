import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { publicGalleryPlugin } from './scripts/public-gallery';

const rootDir = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig(({ command, isPreview }) => ({
  base: command === 'build' || isPreview ? '/cheonmu-archive/' : '/',
  plugins: [publicGalleryPlugin(rootDir), react()],
  server: {
    proxy: {
      '/api/editor': { target: 'http://127.0.0.1:4174', changeOrigin: true },
    },
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}', 'scripts/**/*.test.ts', 'editor/**/*.test.ts'],
    setupFiles: './src/test/setup.ts',
  },
}));
