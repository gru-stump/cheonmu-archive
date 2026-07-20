import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { parseMarkdown } from '../src/content/frontmatter';
import {
  documentMetaSchema,
  gallerySchema,
  profileMetaSchema,
  recordMetaSchema,
  worldSchema,
  type ArchiveContent,
  type ArchiveDocument,
  type ArchiveProfile,
  type ArchiveRecord,
  type ArchiveScene,
  type GalleryItem,
  type WorldDocument,
} from '../src/content/schema';
import { validateArchiveContent } from '../src/content/validation';

type MarkdownMutation =
  | { type: 'markdown-write'; kind: 'records'; id: string; value: ArchiveRecord }
  | { type: 'markdown-write'; kind: 'profiles'; id: string; value: ArchiveProfile }
  | { type: 'markdown-write'; kind: 'documents'; id: string; value: ArchiveDocument }
  | { type: 'markdown-delete'; kind: 'records' | 'profiles' | 'documents'; id: string };

type GalleryMutation =
  | { type: 'gallery-write'; item: GalleryItem; futurePublicImagePaths?: readonly string[] }
  | { type: 'gallery-delete'; id: string };

export type ArchiveMutation = MarkdownMutation | GalleryMutation;

export class ArchivePersistenceError extends Error {
  readonly code = 'VALIDATION_ERROR' as const;

  constructor(
    message: string,
    readonly fields: Record<string, string>,
  ) {
    super(message);
    this.name = 'ArchivePersistenceError';
  }
}

const rootQueues = new Map<string, Promise<void>>();

function isWithin(root: string, target: string): boolean {
  const relativePath = relative(root, target);
  return relativePath === ''
    || (!isAbsolute(relativePath) && relativePath !== '..' && !relativePath.startsWith(`..${sep}`));
}

export async function coordinateArchiveMutation<T>(
  rootDir: string,
  operation: () => Promise<T>,
): Promise<T> {
  const key = await realpath(resolve(rootDir));
  const previous = rootQueues.get(key) ?? Promise.resolve();
  const result = previous.then(operation, operation);
  rootQueues.set(key, result.then(() => undefined, () => undefined));
  return result;
}

function skippedByMutation(
  mutation: ArchiveMutation,
  kind: 'records' | 'profiles' | 'documents',
  id: string,
): boolean {
  return (mutation.type === 'markdown-write' || mutation.type === 'markdown-delete')
    && mutation.kind === kind
    && mutation.id === id;
}

async function loadMarkdownCollection<T>(
  contentRoot: string,
  kind: 'records' | 'profiles' | 'documents',
  schema: Parameters<typeof parseMarkdown<T>>[1],
  mutation: ArchiveMutation,
): Promise<Array<T & { body: string }>> {
  const directory = join(contentRoot, kind);
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
      names = [];
    } else {
      throw error;
    }
  }

  return Promise.all(names
    .filter((name) => extname(name).toLowerCase() === '.md')
    .map(async (name) => {
      const id = name.slice(0, -3);
      if (skippedByMutation(mutation, kind, id)) {
        return undefined;
      }
      const parsed = parseMarkdown(await readFile(join(directory, name), 'utf8'), schema);
      return { ...parsed.data, body: parsed.body };
    }))
    .then((items) => items.filter((item): item is T & { body: string } => item !== undefined));
}

async function loadGallery(contentRoot: string, mutation: ArchiveMutation): Promise<GalleryItem[]> {
  const galleryPath = join(contentRoot, 'gallery.yaml');
  let gallery: GalleryItem[];
  try {
    gallery = gallerySchema.parse(parseYaml(await readFile(galleryPath, 'utf8')));
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
      gallery = [];
    } else {
      throw error;
    }
  }

  if (mutation.type === 'gallery-write') {
    gallery = [...gallery.filter((item) => item.id !== mutation.item.id), mutation.item];
  } else if (mutation.type === 'gallery-delete') {
    gallery = gallery.filter((item) => item.id !== mutation.id);
  }

  return gallery;
}

async function loadWorld(contentRoot: string): Promise<WorldDocument[]> {
  const path = join(contentRoot, 'world.yaml');
  let stats: Awaited<ReturnType<typeof lstat>>;
  try {
    stats = await lstat(path);
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new Error('World content must be a regular file.');
  }
  const canonicalPath = await realpath(path);
  if (!isWithin(contentRoot, canonicalPath)) {
    throw new Error('World content must be within the content root.');
  }
  return worldSchema.parse(parseYaml(await readFile(canonicalPath, 'utf8')));
}

async function loadScenes(contentRoot: string): Promise<ArchiveScene[]> {
  const directory = join(contentRoot, 'scenes');
  let directoryStats: Awaited<ReturnType<typeof lstat>>;
  try {
    directoryStats = await lstat(directory);
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }

  if (directoryStats.isSymbolicLink() || !directoryStats.isDirectory()) {
    throw new Error('Scene directory must be a regular directory.');
  }
  const canonicalDirectory = await realpath(directory);
  if (!isWithin(contentRoot, canonicalDirectory)) {
    throw new Error('Scene directory must be within the content root.');
  }
  const names = await readdir(canonicalDirectory);

  return Promise.all(names
    .filter((name) => extname(name) === '.md')
    .map(async (name) => {
      const path = join(canonicalDirectory, name);
      const stats = await lstat(path);
      if (stats.isSymbolicLink() || !stats.isFile()) {
        throw new Error('Scene file must be a regular file.');
      }
      const canonicalPath = await realpath(path);
      if (!isWithin(canonicalDirectory, canonicalPath)) {
        throw new Error('Scene file must be within the scene directory.');
      }
      return {
        id: name.slice(0, -3),
        body: (await readFile(canonicalPath, 'utf8')).trim(),
      };
    }));
}

async function listPublicImages(publicRoot: string, directory = publicRoot): Promise<string[]> {
  const paths: string[] = [];
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
      return paths;
    }
    throw error;
  }
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      paths.push(...await listPublicImages(publicRoot, path));
    } else if (entry.isFile()) {
      paths.push(`/${relative(publicRoot, path).split(sep).join('/')}`);
    }
  }
  return paths;
}

function validationFields(errors: readonly string[]): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const error of errors) {
    const field = error.includes('Duplicate content ID:')
      ? 'id'
      : error.includes('references missing related ID:')
        ? 'related'
        : error.includes('Public gallery image is missing:')
          ? 'image'
          : 'archive';
    fields[field] = fields[field] ? `${fields[field]} ${error}` : error;
  }
  return fields;
}

export async function validateProspectiveArchive(
  rootDir: string,
  mutation: ArchiveMutation,
): Promise<void> {
  try {
    const workspaceRoot = await realpath(resolve(rootDir));
    const contentRoot = await realpath(join(workspaceRoot, 'src', 'content'));
    const [records, scenes, profiles, documents, gallery, world, publicImagePaths] = await Promise.all([
      loadMarkdownCollection(contentRoot, 'records', recordMetaSchema, mutation),
      loadScenes(contentRoot),
      loadMarkdownCollection(contentRoot, 'profiles', profileMetaSchema, mutation),
      loadMarkdownCollection(contentRoot, 'documents', documentMetaSchema, mutation),
      loadGallery(contentRoot, mutation),
      loadWorld(contentRoot),
      listPublicImages(join(workspaceRoot, 'public')),
    ]);

    const content: ArchiveContent = { records, scenes, profiles, documents, gallery, world };
    if (mutation.type === 'markdown-write') {
      content[mutation.kind].push(mutation.value as never);
    }
    const futurePublicImagePaths = mutation.type === 'gallery-write'
      ? mutation.futurePublicImagePaths ?? []
      : [];
    const result = validateArchiveContent(content, {
      publicImagePaths: [...publicImagePaths, ...futurePublicImagePaths],
    });
    if (result.errors.length > 0) {
      throw new ArchivePersistenceError('Archive validation failed.', validationFields(result.errors));
    }
  } catch (error) {
    if (error instanceof ArchivePersistenceError) {
      throw error;
    }
    throw new ArchivePersistenceError('Archive validation failed.', {
      archive: error instanceof Error ? error.message : 'Unable to validate archive content.',
    });
  }
}
