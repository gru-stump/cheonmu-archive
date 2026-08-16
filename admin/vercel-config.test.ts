import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('Vercel routing', () => {
  it('serves API functions before the SPA fallback', () => {
    const config = JSON.parse(readFileSync('vercel.json', 'utf8'));
    const ignore = readFileSync('.vercelignore', 'utf8');
    const adapter = readFileSync('api/narrative/[...path].ts', 'utf8');

    expect(config.rewrites).toBeUndefined();
    expect(config.routes).toEqual([
      { src: '/api/narrative/(.*)', dest: '/api/narrative/[...path]' },
      { handle: 'filesystem' },
      { src: '/.*', dest: '/index.html' },
    ]);
    expect(ignore).toContain('**/*.test.ts');
    expect(adapter).toContain("from '../../src/server/narrativeHandler.js'");
  });
});
