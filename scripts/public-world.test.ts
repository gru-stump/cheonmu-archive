// @vitest-environment node

import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { build } from 'vite';

const outputs: string[] = [];
const FORBIDDEN_PUBLIC_SECRETS = [
  '천령은 인외', '인외 의사', '피는 독이자 약',
  '흰 백사', '실제 나이 불명', '독과 약으로',
];

const FORBIDDEN_FUTURE_RECORD_MARKERS = ['CM-07', 'promise-to-return', '귀환의 약속'];

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

    expect(bundle).toContain('특수재난관리청');
    expect(bundle).toContain('신원 기록 일부 불일치');
    expect(bundle).toContain('추가 기록 확인 후 해금');

    for (const phrase of FORBIDDEN_PUBLIC_SECRETS) {
      expect(bundle).not.toContain(phrase);
    }
    for (const marker of FORBIDDEN_FUTURE_RECORD_MARKERS) {
      expect(bundle).not.toContain(marker);
    }
  }, 30_000);
});
