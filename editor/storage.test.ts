// @vitest-environment node

import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
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

function simpleSource(id: string, title = 'Entry'): string {
  return ['---', `id: ${id}`, `title: ${title}`, '---', '', 'Body'].join('\n');
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

  it('lists regular Markdown while omitting a reparse-point entry', async (context) => {
    const rootDir = await makeRoot();
    const recordsDirectory = join(rootDir, 'src', 'content', 'records');
    await writeFile(join(recordsDirectory, 'safe.md'), 'safe source', 'utf8');
    const externalDirectory = await mkdtemp(join(tmpdir(), 'cheonmu-editor-list-junction-'));
    temporaryRoots.push(externalDirectory);
    try {
      await symlink(
        externalDirectory,
        join(recordsDirectory, 'unsafe.md'),
        process.platform === 'win32' ? 'junction' : 'dir',
      );
    } catch (error) {
      if (
        typeof error === 'object'
        && error !== null
        && 'code' in error
        && ['EPERM', 'EACCES', 'UNKNOWN'].includes(String(error.code))
      ) {
        context.skip(`Reparse links are not permitted on this platform: ${String(error.code)}`);
      }
      throw error;
    }
    const storage = createEditorStorage({ rootDir });

    await expect(storage.listEntries('records')).resolves.toEqual([
      { id: 'safe', source: 'safe source' },
    ]);
  });

  it('rejects traversal outside the content root', async () => {
    const rootDir = await makeRoot();
    const storage = createEditorStorage({ rootDir });

    await expect(storage.readEntry('records', '../profiles/muyeong'))
      .rejects.toThrow('허용되지 않은 경로입니다.');
  });

  it.each([
    ['unknown kind', 'unknown', 'entry'],
    ['backslash traversal', 'records', '..\\profiles\\muyeong'],
    ['drive path', 'records', 'C:\\outside'],
    ['UNC path', 'records', '\\\\server\\share'],
  ])('rejects %s selectors', async (_label, kind, id) => {
    const rootDir = await makeRoot();
    const storage = createEditorStorage({ rootDir });

    await expect(storage.readEntry(kind, id)).rejects.toMatchObject({ code: 'INVALID_PATH' });
  });

  it('rejects a mapped content directory that is a junction outside the root', async (context) => {
    const rootDir = await makeRoot();
    const externalDirectory = await mkdtemp(join(tmpdir(), 'cheonmu-editor-external-'));
    temporaryRoots.push(externalDirectory);
    await writeFile(join(externalDirectory, 'escaped.md'), 'outside source', 'utf8');
    const recordsDirectory = join(rootDir, 'src', 'content', 'records');
    await rm(recordsDirectory, { recursive: true });
    try {
      await symlink(
        externalDirectory,
        recordsDirectory,
        process.platform === 'win32' ? 'junction' : 'dir',
      );
    } catch (error) {
      if (
        typeof error === 'object'
        && error !== null
        && 'code' in error
        && ['EPERM', 'EACCES', 'UNKNOWN'].includes(String(error.code))
      ) {
        context.skip(`Directory links are not permitted on this platform: ${String(error.code)}`);
      }
      throw error;
    }
    const storage = createEditorStorage({ rootDir });

    await expect(storage.readEntry('records', 'escaped'))
      .rejects.toMatchObject({ code: 'INVALID_PATH' });
  });

  it('rejects a Markdown entry that is a symbolic link', async (context) => {
    const rootDir = await makeRoot();
    const externalDirectory = await mkdtemp(join(tmpdir(), 'cheonmu-editor-file-link-'));
    temporaryRoots.push(externalDirectory);
    const externalPath = join(externalDirectory, 'outside.md');
    await writeFile(externalPath, 'outside source', 'utf8');
    try {
      await symlink(
        externalPath,
        join(rootDir, 'src', 'content', 'records', 'linked.md'),
        'file',
      );
    } catch (error) {
      if (
        typeof error === 'object'
        && error !== null
        && 'code' in error
        && ['EPERM', 'EACCES', 'UNKNOWN'].includes(String(error.code))
      ) {
        context.skip(`File links are not permitted on this platform: ${String(error.code)}`);
      }
      throw error;
    }
    const storage = createEditorStorage({ rootDir });

    await expect(storage.readEntry('records', 'linked'))
      .rejects.toMatchObject({ code: 'INVALID_PATH' });
  });

  it('rejects a Markdown entry that is a junction reparse point', async (context) => {
    const rootDir = await makeRoot();
    const externalDirectory = await mkdtemp(join(tmpdir(), 'cheonmu-editor-entry-junction-'));
    temporaryRoots.push(externalDirectory);
    try {
      await symlink(
        externalDirectory,
        join(rootDir, 'src', 'content', 'records', 'linked.md'),
        process.platform === 'win32' ? 'junction' : 'dir',
      );
    } catch (error) {
      if (
        typeof error === 'object'
        && error !== null
        && 'code' in error
        && ['EPERM', 'EACCES', 'UNKNOWN'].includes(String(error.code))
      ) {
        context.skip(`Directory links are not permitted on this platform: ${String(error.code)}`);
      }
      throw error;
    }
    const storage = createEditorStorage({ rootDir });

    await expect(storage.readEntry('records', 'linked'))
      .rejects.toMatchObject({ code: 'INVALID_PATH' });
  });

  it('does not replace an existing reparse-point entry', async (context) => {
    const rootDir = await makeRoot();
    const externalDirectory = await mkdtemp(join(tmpdir(), 'cheonmu-editor-write-junction-'));
    temporaryRoots.push(externalDirectory);
    const linkedPath = join(rootDir, 'src', 'content', 'records', 'linked.md');
    try {
      await symlink(
        externalDirectory,
        linkedPath,
        process.platform === 'win32' ? 'junction' : 'dir',
      );
    } catch (error) {
      if (
        typeof error === 'object'
        && error !== null
        && 'code' in error
        && ['EPERM', 'EACCES', 'UNKNOWN'].includes(String(error.code))
      ) {
        context.skip(`Directory links are not permitted on this platform: ${String(error.code)}`);
      }
      throw error;
    }
    const storage = createEditorStorage({ rootDir });

    await expect(storage.writeEntry('records', 'linked', recordSource('linked')))
      .rejects.toMatchObject({ code: 'INVALID_PATH' });
    await expect(readdir(externalDirectory)).resolves.toEqual([]);
  });

  it('atomically replaces an existing file with Markdown that passes the shared schema', async () => {
    const rootDir = await makeRoot();
    const storage = createEditorStorage({ rootDir });
    const source = recordSource('draft-event');
    const recordsDirectory = join(rootDir, 'src', 'content', 'records');
    await writeFile(join(recordsDirectory, 'draft-event.md'), 'old source', 'utf8');

    await expect(storage.writeEntry('records', 'draft-event', source)).resolves.toBe(source);

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

  it('rejects a prospective record with a missing related ID before writing any file', async () => {
    const rootDir = await makeRoot();
    const storage = createEditorStorage({ rootDir });
    const target = join(rootDir, 'src', 'content', 'records', 'draft-event.md');

    await expect(storage.writeEntry('records', 'draft-event', recordSource('draft-event', ['missing-record'])))
      .rejects.toMatchObject({ code: 'VALIDATION_ERROR', fields: { related: expect.stringContaining('missing-record') } });

    await expect(readFile(target, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await readdir(join(rootDir, 'src', 'content', 'records')))
      .filter((name) => name.includes('draft-event'))).toEqual([]);
  });

  it('loads existing scene sidecars when validating a prospective record change', async () => {
    const rootDir = await makeRoot();
    const recordsDirectory = join(rootDir, 'src', 'content', 'records');
    const scenesDirectory = join(rootDir, 'src', 'content', 'scenes');
    const existingSource = recordSource('draft-event').replace('cinematic: false', 'cinematic: true');
    await mkdir(scenesDirectory, { recursive: true });
    await Promise.all([
      writeFile(join(recordsDirectory, 'draft-event.md'), existingSource, 'utf8'),
      writeFile(join(scenesDirectory, 'draft-event.md'), 'Existing cinematic prose', 'utf8'),
    ]);
    const storage = createEditorStorage({ rootDir });

    await expect(storage.writeEntry('records', 'draft-event', recordSource('draft-event')))
      .rejects.toMatchObject({
        code: 'VALIDATION_ERROR',
        fields: { archive: expect.stringContaining('attached to a non-cinematic record') },
      });

    await expect(readFile(join(recordsDirectory, 'draft-event.md'), 'utf8')).resolves.toBe(existingSource);
  });

  it('rejects a cross-kind duplicate ID before replacing disk content', async () => {
    const rootDir = await makeRoot();
    await writeFile(join(rootDir, 'src', 'content', 'profiles', 'shared-id.md'), simpleSource('shared-id'));
    const storage = createEditorStorage({ rootDir });

    await expect(storage.writeEntry('documents', 'shared-id', simpleSource('shared-id')))
      .rejects.toMatchObject({ code: 'VALIDATION_ERROR', fields: { id: expect.stringContaining('shared-id') } });

    await expect(readFile(join(rootDir, 'src', 'content', 'documents', 'shared-id.md'), 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects deleting a record referenced by another record without creating trash', async () => {
    const rootDir = await makeRoot();
    const records = join(rootDir, 'src', 'content', 'records');
    await writeFile(join(records, 'first.md'), recordSource('first', ['second']));
    await writeFile(join(records, 'second.md'), recordSource('second'));
    const storage = createEditorStorage({ rootDir });

    await expect(storage.trashEntry('records', 'second'))
      .rejects.toMatchObject({ code: 'VALIDATION_ERROR', fields: { related: expect.stringContaining('second') } });

    await expect(readFile(join(records, 'second.md'), 'utf8')).resolves.toBe(recordSource('second'));
    await expect(readdir(join(rootDir, '.trash', 'records'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('serializes prospective validation across separate storage instances', async () => {
    const rootDir = await makeRoot();
    const profileStorage = createEditorStorage({ rootDir });
    const documentStorage = createEditorStorage({ rootDir });

    const results = await Promise.allSettled([
      profileStorage.writeEntry('profiles', 'shared-id', simpleSource('shared-id', 'Profile')),
      documentStorage.writeEntry('documents', 'shared-id', simpleSource('shared-id', 'Document')),
    ]);

    expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(({ status }) => status === 'rejected')).toHaveLength(1);
    const persisted = await Promise.all([
      readFile(join(rootDir, 'src', 'content', 'profiles', 'shared-id.md'), 'utf8').then(() => true, () => false),
      readFile(join(rootDir, 'src', 'content', 'documents', 'shared-id.md'), 'utf8').then(() => true, () => false),
    ]);
    expect(persisted.filter(Boolean)).toHaveLength(1);
  });

  it('moves deleted content into trash', async () => {
    const rootDir = await makeRoot();
    const sourcePath = join(rootDir, 'src', 'content', 'records', 'draft-event.md');
    await writeFile(sourcePath, 'draft source', 'utf8');
    const storage = createEditorStorage({ rootDir });

    const trashPath = await storage.trashEntry('records', 'draft-event');

    await expect(readFile(sourcePath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    expect(trashPath).toMatch(/\.trash[\\/]records[\\/]\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z-[a-f0-9-]{36}-draft-event\.md$/);
    await expect(readFile(trashPath, 'utf8')).resolves.toBe('draft source');
  });

  it('preserves both trash entries when the same ID is deleted in one millisecond', async () => {
    const rootDir = await makeRoot();
    const sourcePath = join(rootDir, 'src', 'content', 'records', 'draft-event.md');
    const storage = createEditorStorage({
      rootDir,
      now: () => new Date('2026-07-19T14:00:00.000Z'),
    });
    await writeFile(sourcePath, 'first draft', 'utf8');
    const firstTrashPath = await storage.trashEntry('records', 'draft-event');
    await writeFile(sourcePath, 'second draft', 'utf8');
    const secondTrashPath = await storage.trashEntry('records', 'draft-event');

    expect(secondTrashPath).not.toBe(firstTrashPath);
    await expect(readFile(firstTrashPath, 'utf8')).resolves.toBe('first draft');
    await expect(readFile(secondTrashPath, 'utf8')).resolves.toBe('second draft');
  });
});
