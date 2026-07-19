// @vitest-environment node

import { mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createEditorStorage } from './storage';

const temporaryRoots: string[] = [];

function recordSource(id: string, related: string[] = []): string {
  return [
    '---',
    `id: ${id}`,
    'recordNumber: CM-09',
    'title: Draft event',
    'stage: 8',
    'status: draft',
    'characters: [cheonryeong, muyeong]',
    'tags: [draft]',
    `related: [${related.join(', ')}]`,
    'quote: Return safely.',
    'cinematic: false',
    '---',
    '',
    'Draft body',
  ].join('\n');
}

async function makeRoot(): Promise<string> {
  const rootDir = await mkdtemp(join(tmpdir(), 'cheonmu-editor-'));
  temporaryRoots.push(rootDir);
  await Promise.all([
    mkdir(join(rootDir, 'src', 'content', 'records'), { recursive: true }),
    mkdir(join(rootDir, 'src', 'content', 'profiles'), { recursive: true }),
    mkdir(join(rootDir, 'src', 'content', 'documents'), { recursive: true }),
  ]);
  return rootDir;
}

afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(temporaryRoots.splice(0).map((rootDir) => rm(rootDir, { recursive: true })));
});

describe('editor storage safety', () => {
  it('lists safe Markdown entries in deterministic order', async () => {
    const rootDir = await makeRoot();
    const recordsDirectory = join(rootDir, 'src', 'content', 'records');
    await Promise.all([
      writeFile(join(recordsDirectory, 'second.md'), 'second source', 'utf8'),
      writeFile(join(recordsDirectory, 'first.md'), 'first source', 'utf8'),
      writeFile(join(recordsDirectory, 'notes.txt'), 'ignored', 'utf8'),
    ]);
    const storage = createEditorStorage({ rootDir });

    await expect(storage.listEntries('records')).resolves.toEqual([
      { id: 'first', source: 'first source' },
      { id: 'second', source: 'second source' },
    ]);
  });

  it('rejects traversal outside the content root', async () => {
    const rootDir = await makeRoot();
    const storage = createEditorStorage({ rootDir });

    await expect(storage.readEntry('records', '../profiles/muyeong'))
      .rejects.toThrow('허용되지 않은 경로입니다.');
  });

  it('atomically writes Markdown that passes the shared schema', async () => {
    const rootDir = await makeRoot();
    const storage = createEditorStorage({ rootDir });
    const source = recordSource('draft-event');

    await expect(storage.writeEntry('records', 'draft-event', source)).resolves.toBe(source);

    const recordsDirectory = join(rootDir, 'src', 'content', 'records');
    await expect(readFile(join(recordsDirectory, 'draft-event.md'), 'utf8')).resolves.toBe(source);
    expect(await readdir(recordsDirectory)).toEqual(['draft-event.md']);
  });

  it('reports field errors without replacing existing content', async () => {
    const rootDir = await makeRoot();
    const path = join(rootDir, 'src', 'content', 'records', 'draft-event.md');
    await writeFile(path, recordSource('draft-event'), 'utf8');
    const storage = createEditorStorage({ rootDir });
    const invalidSource = recordSource('draft-event').replace('status: draft\n', '');

    await expect(storage.writeEntry('records', 'draft-event', invalidSource)).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      fields: { status: expect.any(String) },
    });
    await expect(readFile(path, 'utf8')).resolves.toBe(recordSource('draft-event'));
  });

  it('moves deleted content into trash', async () => {
    const rootDir = await makeRoot();
    const sourcePath = join(rootDir, 'src', 'content', 'records', 'draft-event.md');
    await writeFile(sourcePath, 'draft source', 'utf8');
    const storage = createEditorStorage({ rootDir });

    const trashPath = await storage.trashEntry('records', 'draft-event');

    await expect(readFile(sourcePath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    expect(trashPath).toMatch(/\.trash[\\/]records[\\/]\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z-draft-event\.md$/);
    await expect(readFile(trashPath, 'utf8')).resolves.toBe('draft source');
  });
});
