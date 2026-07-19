import { randomUUID } from 'node:crypto';
import { link, lstat, mkdir, readFile, readdir, realpath, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { ZodError, type ZodType } from 'zod';
import { parseMarkdown } from '../src/content/frontmatter';
import {
  documentMetaSchema,
  profileMetaSchema,
  recordMetaSchema,
} from '../src/content/schema';

export const CONTENT_KINDS = ['records', 'profiles', 'documents'] as const;

export type ContentKind = (typeof CONTENT_KINDS)[number];

const kindDirectories: Record<ContentKind, ContentKind> = {
  records: 'records',
  profiles: 'profiles',
  documents: 'documents',
};

const schemasByKind: Record<ContentKind, ZodType<{ id: string }>> = {
  records: recordMetaSchema,
  profiles: profileMetaSchema,
  documents: documentMetaSchema,
};

const contentIdPattern = /^[a-z0-9-]+$/;

export class EditorStorageError extends Error {
  constructor(
    message: string,
    readonly code: 'INVALID_PATH' | 'VALIDATION_ERROR',
    readonly fields?: Record<string, string>,
  ) {
    super(message);
    this.name = 'EditorStorageError';
  }
}

function invalidPath(): EditorStorageError {
  return new EditorStorageError('허용되지 않은 경로입니다.', 'INVALID_PATH');
}

function isContentKind(value: string): value is ContentKind {
  return Object.hasOwn(kindDirectories, value);
}

function safeTimestamp(date: Date): string {
  return date.toISOString().replaceAll(':', '-');
}

function isWithin(root: string, target: string): boolean {
  const relativePath = relative(root, target);
  return relativePath === ''
    || (!isAbsolute(relativePath) && relativePath !== '..' && !relativePath.startsWith(`..${sep}`));
}

export interface EditorStorageOptions {
  rootDir: string;
  now?: () => Date;
}

export function createEditorStorage({ rootDir, now = () => new Date() }: EditorStorageOptions) {
  const resolvedRoot = resolve(rootDir);

  function checkedKind(kind: string): ContentKind {
    if (!isContentKind(kind)) {
      throw invalidPath();
    }

    return kind;
  }

  function checkedEntry(kind: string, id: string): { kind: ContentKind; id: string } {
    const checked = checkedKind(kind);
    if (!contentIdPattern.test(id)) {
      throw invalidPath();
    }

    return { kind: checked, id };
  }

  async function kindRoot(kind: string): Promise<{
    kind: ContentKind;
    path: string;
    workspaceRoot: string;
  }> {
    const checked = checkedKind(kind);
    const workspaceRoot = await realpath(resolvedRoot);
    const contentRoot = await realpath(join(workspaceRoot, 'src', 'content'));
    if (!isWithin(workspaceRoot, contentRoot)) {
      throw invalidPath();
    }

    const path = join(contentRoot, kindDirectories[checked]);
    const stats = await lstat(path);
    if (stats.isSymbolicLink()) {
      throw invalidPath();
    }

    const canonicalPath = await realpath(path);
    if (!isWithin(contentRoot, canonicalPath)) {
      throw invalidPath();
    }

    return { kind: checked, path: canonicalPath, workspaceRoot };
  }

  async function existingEntryPath(directory: { path: string }, id: string): Promise<string> {
    const path = join(directory.path, `${id}.md`);
    const stats = await lstat(path);
    if (stats.isSymbolicLink() || !stats.isFile()) {
      throw invalidPath();
    }

    const canonicalPath = await realpath(path);
    if (!isWithin(directory.path, canonicalPath)) {
      throw invalidPath();
    }

    return canonicalPath;
  }

  async function writableEntryPath(directory: { path: string }, id: string): Promise<string> {
    const canonicalParent = await realpath(directory.path);
    if (!isWithin(directory.path, canonicalParent)) {
      throw invalidPath();
    }

    const path = join(canonicalParent, `${id}.md`);
    if (!isWithin(directory.path, path)) {
      throw invalidPath();
    }

    try {
      await existingEntryPath(directory, id);
    } catch (error) {
      if (!(typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT')) {
        throw error;
      }
    }

    return path;
  }

  async function trashRoot(workspaceRoot: string, kind: ContentKind): Promise<string> {
    const trashPath = join(workspaceRoot, '.trash');
    await mkdir(trashPath, { recursive: true });
    const trashStats = await lstat(trashPath);
    if (trashStats.isSymbolicLink() || !trashStats.isDirectory()) {
      throw invalidPath();
    }
    const canonicalTrashPath = await realpath(trashPath);
    if (!isWithin(workspaceRoot, canonicalTrashPath)) {
      throw invalidPath();
    }

    const kindPath = join(canonicalTrashPath, kind);
    await mkdir(kindPath, { recursive: true });
    const kindStats = await lstat(kindPath);
    if (kindStats.isSymbolicLink() || !kindStats.isDirectory()) {
      throw invalidPath();
    }
    const canonicalKindPath = await realpath(kindPath);
    if (!isWithin(canonicalTrashPath, canonicalKindPath)) {
      throw invalidPath();
    }

    return canonicalKindPath;
  }

  async function listEntries(kind: string): Promise<Array<{ id: string; source: string }>> {
    const directory = await kindRoot(kind);
    const ids = (await readdir(directory.path))
      .filter((fileName) => fileName.endsWith('.md'))
      .map((fileName) => fileName.slice(0, -3))
      .filter((id) => contentIdPattern.test(id))
      .sort((left, right) => left.localeCompare(right));

    return Promise.all(ids.map(async (id) => ({
      id,
      source: await readFile(await existingEntryPath(directory, id), 'utf8'),
    })));
  }

  async function readEntry(kind: string, id: string): Promise<string> {
    const entry = checkedEntry(kind, id);
    const directory = await kindRoot(entry.kind);
    return readFile(await existingEntryPath(directory, entry.id), 'utf8');
  }

  async function writeEntry(kind: string, id: string, source: string): Promise<string> {
    const entry = checkedEntry(kind, id);
    let parsed: { data: { id: string }; body: string };
    try {
      parsed = parseMarkdown(source, schemasByKind[entry.kind]);
    } catch (error) {
      const fields = error instanceof ZodError
        ? Object.fromEntries(error.issues.map((issue) => [issue.path.join('.') || 'source', issue.message]))
        : { source: error instanceof Error ? error.message : 'Invalid Markdown source.' };
      throw new EditorStorageError(
        'Content validation failed.',
        'VALIDATION_ERROR',
        fields,
      );
    }
    if (parsed.data.id !== id) {
      throw new EditorStorageError(
        'Content validation failed.',
        'VALIDATION_ERROR',
        { id: 'Markdown ID must match the requested entry ID.' },
      );
    }

    const directory = await kindRoot(entry.kind);
    const entryPath = await writableEntryPath(directory, entry.id);
    const temporaryPath = join(directory.path, `.${id}.${randomUUID()}.tmp`);
    await mkdir(directory.path, { recursive: true });

    try {
      await writeFile(temporaryPath, source, { encoding: 'utf8', flag: 'wx' });
      await writableEntryPath(directory, entry.id);
      await rename(temporaryPath, entryPath);
    } catch (error) {
      await rm(temporaryPath, { force: true });
      throw error;
    }

    return source;
  }

  async function trashEntry(kind: string, id: string): Promise<string> {
    const entry = checkedEntry(kind, id);
    const directory = await kindRoot(entry.kind);
    const entryPath = await existingEntryPath(directory, entry.id);
    const trashDirectory = await trashRoot(directory.workspaceRoot, entry.kind);

    for (let attempt = 0; attempt < 10; attempt += 1) {
      const trashPath = join(
        trashDirectory,
        `${safeTimestamp(now())}-${randomUUID()}-${entry.id}.md`,
      );
      try {
        if (!isWithin(trashDirectory, trashPath)) {
          throw invalidPath();
        }
        await link(entryPath, trashPath);
        const trashStats = await lstat(trashPath);
        const canonicalTrashPath = await realpath(trashPath);
        if (
          trashStats.isSymbolicLink()
          || !trashStats.isFile()
          || !isWithin(trashDirectory, canonicalTrashPath)
        ) {
          throw invalidPath();
        }
        await unlink(entryPath);
        return trashPath;
      } catch (error) {
        if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST') {
          continue;
        }
        await rm(trashPath, { force: true });
        throw error;
      }
    }

    throw new Error('Unable to allocate a unique trash path.');
  }

  return { listEntries, readEntry, writeEntry, trashEntry };
}

export const createContentStorage = createEditorStorage;

export type EditorStorage = ReturnType<typeof createEditorStorage>;
