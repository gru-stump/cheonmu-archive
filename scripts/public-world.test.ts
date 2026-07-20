// @vitest-environment node

import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { build } from 'vite';

const outputs: string[] = [];
const FORBIDDEN_PUBLIC_SECRETS = [
  '천령은 인간', '인간 의사', '피를 마시는 흡혈귀',
  '백사', '실제 나이 불명', '과거와 능력으로',
];

async function emittedText(directory: string): Promise<string> {
  const entries = await readdir(directory, { withFileTypes: true });
  const chunks = await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return emittedText(path);
    return ['.html', '.js', '.css', '.map'].includes(extname(entry.name))
      ? readFile(path, 'utf8')
      : '';
  }));
  return chunks.join('\n');
}

afterEach(async () => {
  await Promise.all(outputs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('public world production boundary', () => {
  it('excludes private canon phrases from emitted public assets', async () => {
    const outDir = await mkdtemp(join(tmpdir(), 'cheonmu-public-world-'));
    outputs.push(outDir);
    await build({
      configFile: resolve('vite.config.ts'),
      logLevel: 'silent',
      build: { outDir, emptyOutDir: true },
    });
    const bundle = await emittedText(outDir);

    for (const phrase of FORBIDDEN_PUBLIC_SECRETS) {
      expect(bundle).not.toContain(phrase);
    }
  }, 30_000);
});
