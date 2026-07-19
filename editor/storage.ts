import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
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

export interface EditorStorageOptions {
  rootDir: string;
  now?: () => Date;
}

export function createEditorStorage({ rootDir, now = () => new Date() }: EditorStorageOptions) {
  const resolvedRoot = resolve(rootDir);
  const contentRoot = join(resolvedRoot, 'src', 'content');

  function kindRoot(kind: string): { kind: ContentKind; path: string } {
    if (!isContentKind(kind)) {
      throw invalidPath();
    }

    return { kind, path: resolve(contentRoot, kindDirectories[kind]) };
  }

  function entryPath(kind: string, id: string): { kind: ContentKind; path: string } {
    const directory = kindRoot(kind);
    if (!contentIdPattern.test(id)) {
      throw invalidPath();
    }

    const path = resolve(directory.path, `${id}.md`);
    const relativePath = relative(directory.path, path);

    if (relativePath.startsWith('..') || isAbsolute(relativePath)) {
      throw invalidPath();
    }

    return { kind: directory.kind, path };
  }

  async function listEntries(kind: string): Promise<Array<{ id: string; source: string }>> {
    const directory = kindRoot(kind);
    const ids = (await readdir(directory.path))
      .filter((fileName) => fileName.endsWith('.md'))
      .map((fileName) => fileName.slice(0, -3))
      .filter((id) => contentIdPattern.test(id))
      .sort((left, right) => left.localeCompare(right));

    return Promise.all(ids.map(async (id) => ({
      id,
      source: await readFile(entryPath(kind, id).path, 'utf8'),
    })));
  }

  async function readEntry(kind: string, id: string): Promise<string> {
    return readFile(entryPath(kind, id).path, 'utf8');
  }

  async function writeEntry(kind: string, id: string, source: string): Promise<string> {
    const entry = entryPath(kind, id);
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

    const directory = kindRoot(kind);
    const temporaryPath = join(directory.path, `.${id}.${randomUUID()}.tmp`);
    await mkdir(directory.path, { recursive: true });

    try {
      await writeFile(temporaryPath, source, { encoding: 'utf8', flag: 'wx' });
      await rename(temporaryPath, entry.path);
    } catch (error) {
      await rm(temporaryPath, { force: true });
      throw error;
    }

    return source;
  }

  async function trashEntry(kind: string, id: string): Promise<string> {
    const entry = entryPath(kind, id);
    const trashDirectory = join(resolvedRoot, '.trash', entry.kind);
    const trashPath = join(trashDirectory, `${safeTimestamp(now())}-${id}.md`);
    await mkdir(trashDirectory, { recursive: true });
    await rename(entry.path, trashPath);
    return trashPath;
  }

  return { listEntries, readEntry, writeEntry, trashEntry };
}

export const createContentStorage = createEditorStorage;

export type EditorStorage = ReturnType<typeof createEditorStorage>;
