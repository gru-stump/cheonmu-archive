import { createHash, randomUUID } from 'node:crypto';
import { link, lstat, mkdir, readFile, realpath, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parse as parseYaml, stringify } from 'yaml';
import { ZodError } from 'zod';
import { galleryItemSchema, gallerySchema, type GalleryItem } from '../src/content/schema';
import { coordinateArchiveMutation, validateProspectiveArchive } from './archive-persistence';

const contentIdPattern = /^[a-z0-9-]+$/;
const publicImagePattern = /^\/images\/[A-Za-z0-9_-]+\.(?:png|jpe?g|webp)$/i;

type GalleryStorageErrorCode = 'INVALID_PATH' | 'VALIDATION_ERROR' | 'CONFLICT' | 'NOT_FOUND';

export class GalleryStorageError extends Error {
  constructor(
    message: string,
    readonly code: GalleryStorageErrorCode,
    readonly fields?: Record<string, string>,
  ) {
    super(message);
    this.name = 'GalleryStorageError';
  }
}

function invalidPath(): GalleryStorageError {
  return new GalleryStorageError('허용되지 않는 경로입니다.', 'INVALID_PATH');
}

function validationError(error: unknown): GalleryStorageError {
  const fields = error instanceof ZodError
    ? Object.fromEntries(error.issues.map((issue) => [issue.path.join('.') || 'gallery', issue.message]))
    : { gallery: error instanceof Error ? error.message : 'Invalid gallery metadata.' };
  return new GalleryStorageError('Gallery validation failed.', 'VALIDATION_ERROR', fields);
}

function isWithin(root: string, target: string): boolean {
  const relativePath = relative(root, target);
  return relativePath === ''
    || (!isAbsolute(relativePath) && relativePath !== '..' && !relativePath.startsWith(`..${sep}`));
}

function safeTimestamp(date: Date): string {
  return date.toISOString().replaceAll(':', '-');
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String(error.code)
    : undefined;
}

type ImageInfo = { extension: 'png' | 'jpg' | 'webp'; width: number; height: number };
type ImageRootName = 'public' | 'private';
type ConfirmedImageCandidate = { root: ImageRootName; path: string; sha256: string };
type StageManifest = { version: 1; candidates: ConfirmedImageCandidate[] };

function positiveDimensions(extension: ImageInfo['extension'], width: number, height: number): ImageInfo | null {
  return width > 0 && height > 0 ? { extension, width, height } : null;
}

function inspectPng(bytes: Buffer): ImageInfo | null {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(signature) || bytes.toString('ascii', 12, 16) !== 'IHDR') return null;
  return positiveDimensions('png', bytes.readUInt32BE(16), bytes.readUInt32BE(20));
}

function inspectJpeg(bytes: Buffer): ImageInfo | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 3 < bytes.length) {
    while (bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset];
    offset += 1;
    if (marker === undefined || marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > bytes.length) break;
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) break;
    const isStartOfFrame = (marker >= 0xc0 && marker <= 0xc3)
      || (marker >= 0xc5 && marker <= 0xc7)
      || (marker >= 0xc9 && marker <= 0xcb)
      || (marker >= 0xcd && marker <= 0xcf);
    if (isStartOfFrame && length >= 7) {
      return positiveDimensions('jpg', bytes.readUInt16BE(offset + 5), bytes.readUInt16BE(offset + 3));
    }
    offset += length;
  }
  return null;
}

function inspectWebp(bytes: Buffer): ImageInfo | null {
  if (bytes.length < 20 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WEBP') return null;
  const chunk = bytes.toString('ascii', 12, 16);
  if (chunk === 'VP8X' && bytes.length >= 30) {
    return positiveDimensions('webp', bytes.readUIntLE(24, 3) + 1, bytes.readUIntLE(27, 3) + 1);
  }
  if (chunk === 'VP8L' && bytes.length >= 25 && bytes[20] === 0x2f) {
    const first = bytes[21] ?? 0;
    const second = bytes[22] ?? 0;
    const third = bytes[23] ?? 0;
    const fourth = bytes[24] ?? 0;
    return positiveDimensions(
      'webp',
      1 + first + ((second & 0x3f) << 8),
      1 + (second >> 6) + (third << 2) + ((fourth & 0x0f) << 10),
    );
  }
  if (chunk === 'VP8 ' && bytes.length >= 30 && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
    return positiveDimensions('webp', bytes.readUInt16LE(26) & 0x3fff, bytes.readUInt16LE(28) & 0x3fff);
  }
  return null;
}

export function inspectImage(bytes: Buffer): ImageInfo {
  const result = inspectPng(bytes) ?? inspectJpeg(bytes) ?? inspectWebp(bytes);
  if (!result) throw new GalleryStorageError('지원하지 않는 이미지 파일입니다.', 'VALIDATION_ERROR', { image: 'PNG, JPEG, WebP 파일만 사용할 수 있습니다.' });
  return result;
}

export interface GalleryStorageOptions {
  rootDir: string;
  now?: () => Date;
  filesystem?: {
    unlink?: (path: string) => Promise<void>;
  };
}

export interface RegisterImageRequest {
  id: string;
  originalName: string;
  bytes: Buffer;
  overwrite: boolean;
}

export interface RegisteredImage {
  path: string;
  width: number;
  height: number;
}

export interface PrivateGalleryImage {
  bytes: Buffer;
  contentType: 'image/png' | 'image/jpeg' | 'image/webp';
}

export interface GalleryChangePlan {
  item: GalleryItem;
  changes: GalleryChange[];
}

export type GalleryChange =
  | { action: 'metadata'; path: string; visibility: 'metadata' }
  | { action: 'stage'; path: string; visibility: 'stage' }
  | { action: 'write'; path: string; visibility: 'public' | 'private' }
  | { action: 'move'; path: string; destination: string; visibility: 'public' | 'private' }
  | { action: 'trash'; path: string; visibility: 'trash' };

export function createGalleryStorage({ rootDir, now = () => new Date(), filesystem }: GalleryStorageOptions) {
  const resolvedRoot = resolve(rootDir);
  const unlinkPath = filesystem?.unlink ?? unlink;
  function enqueue<T>(operation: () => Promise<T>): Promise<T> {
    return coordinateArchiveMutation(resolvedRoot, operation);
  }

  function checkedId(id: string): string {
    if (!contentIdPattern.test(id)) throw invalidPath();
    return id;
  }

  async function checkedDirectory(path: string, parent: string): Promise<string> {
    const stats = await lstat(path);
    if (stats.isSymbolicLink() || !stats.isDirectory()) throw invalidPath();
    const canonical = await realpath(path);
    if (!isWithin(parent, canonical)) throw invalidPath();
    return canonical;
  }

  async function roots(createAuxiliaryDirectories = true): Promise<{
    workspace: string;
    content: string;
    gallery: string;
    images: string;
    privateImages: string;
    stagedImages: string;
  }> {
    const workspace = await realpath(resolvedRoot);
    const content = await checkedDirectory(join(workspace, 'src', 'content'), workspace);
    const privateImagesPath = join(content, 'private-images');
    if (createAuxiliaryDirectories) await mkdir(privateImagesPath, { recursive: true });
    const privateImages = createAuxiliaryDirectories
      ? await checkedDirectory(privateImagesPath, content)
      : privateImagesPath;
    const stagedImagesPath = join(content, 'staged-images');
    if (createAuxiliaryDirectories) await mkdir(stagedImagesPath, { recursive: true });
    const stagedImages = createAuxiliaryDirectories
      ? await checkedDirectory(stagedImagesPath, content)
      : stagedImagesPath;
    const publicRoot = await checkedDirectory(join(workspace, 'public'), workspace);
    const images = await checkedDirectory(join(publicRoot, 'images'), publicRoot);
    const gallery = join(content, 'gallery.yaml');
    const stats = await lstat(gallery);
    if (stats.isSymbolicLink() || !stats.isFile()) throw invalidPath();
    const canonicalGallery = await realpath(gallery);
    if (!isWithin(content, canonicalGallery)) throw invalidPath();
    return { workspace, content, gallery: canonicalGallery, images, privateImages, stagedImages };
  }

  async function trashDirectory(workspace: string, kind: 'images' | 'gallery'): Promise<string> {
    const trash = join(workspace, '.trash');
    await mkdir(trash, { recursive: true });
    const canonicalTrash = await checkedDirectory(trash, workspace);
    const directory = join(canonicalTrash, kind);
    await mkdir(directory, { recursive: true });
    return checkedDirectory(directory, canonicalTrash);
  }

  async function checkedImagePath(images: string, publicPath: string, mustExist: boolean): Promise<string> {
    if (!publicImagePattern.test(publicPath)) throw invalidPath();
    const path = join(images, publicPath.slice('/images/'.length));
    if (!isWithin(images, path)) throw invalidPath();
    try {
      const stats = await lstat(path);
      if (stats.isSymbolicLink() || !stats.isFile()) throw invalidPath();
      const canonical = await realpath(path);
      if (!isWithin(images, canonical)) throw invalidPath();
      return canonical;
    } catch (error) {
      if (!mustExist && errorCode(error) === 'ENOENT') return path;
      throw error;
    }
  }

  async function checkedStageManifestPath(stagedImages: string, id: string, mustExist: boolean): Promise<string> {
    const path = join(stagedImages, `${checkedId(id)}.json`);
    if (!isWithin(stagedImages, path)) throw invalidPath();
    try {
      const stats = await lstat(path);
      if (stats.isSymbolicLink() || !stats.isFile()) throw invalidPath();
      const canonical = await realpath(path);
      if (!isWithin(stagedImages, canonical)) throw invalidPath();
      return canonical;
    } catch (error) {
      if (!mustExist && errorCode(error) === 'ENOENT') return path;
      throw error;
    }
  }

  function imageFingerprint(bytes: Buffer): string {
    return createHash('sha256').update(bytes).digest('hex');
  }

  function parseStageManifest(source: string): StageManifest {
    let value: unknown;
    try {
      value = JSON.parse(source);
    } catch (error) {
      throw validationError(error);
    }
    if (typeof value !== 'object' || value === null || !('version' in value) || value.version !== 1
      || !('candidates' in value) || !Array.isArray(value.candidates)) {
      throw new GalleryStorageError('Gallery validation failed.', 'VALIDATION_ERROR', { image: 'Invalid staged image manifest.' });
    }
    const candidates: ConfirmedImageCandidate[] = [];
    for (const candidate of value.candidates) {
      if (typeof candidate !== 'object' || candidate === null
        || !('root' in candidate) || (candidate.root !== 'public' && candidate.root !== 'private')
        || !('path' in candidate) || typeof candidate.path !== 'string' || !publicImagePattern.test(candidate.path)
        || !('sha256' in candidate) || typeof candidate.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(candidate.sha256)) {
        throw new GalleryStorageError('Gallery validation failed.', 'VALIDATION_ERROR', { image: 'Invalid staged image manifest.' });
      }
      candidates.push({ root: candidate.root, path: candidate.path, sha256: candidate.sha256 });
    }
    return { version: 1, candidates };
  }

  async function readItemsUnsafe(locations?: Awaited<ReturnType<typeof roots>>): Promise<GalleryItem[]> {
    const current = locations ?? await roots();
    try {
      return gallerySchema.parse(parseYaml(await readFile(current.gallery, 'utf8')));
    } catch (error) {
      if (error instanceof GalleryStorageError) throw error;
      throw validationError(error);
    }
  }

  async function allocateBackup(source: string, directory: string, suffix: string): Promise<string> {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const destination = join(directory, `${safeTimestamp(now())}-${randomUUID()}-${suffix}`);
      try {
        if (!isWithin(directory, destination)) throw invalidPath();
        await link(source, destination);
        const stats = await lstat(destination);
        if (stats.isSymbolicLink() || !stats.isFile()) throw invalidPath();
        return destination;
      } catch (error) {
        if (errorCode(error) === 'EEXIST') continue;
        await rm(destination, { force: true });
        throw error;
      }
    }
    throw new Error('Unable to allocate a unique gallery backup path.');
  }

  async function writeItemsUnsafe(items: GalleryItem[], locations: Awaited<ReturnType<typeof roots>>): Promise<void> {
    try {
      gallerySchema.parse(items);
    } catch (error) {
      throw validationError(error);
    }
    if (new Set(items.map(({ id }) => id)).size !== items.length) {
      throw new GalleryStorageError('Gallery validation failed.', 'VALIDATION_ERROR', { id: 'Gallery IDs must be unique.' });
    }
    if (new Set(items.map(({ image }) => image.toLowerCase())).size !== items.length) {
      throw new GalleryStorageError('Gallery validation failed.', 'VALIDATION_ERROR', { image: 'Gallery image paths must be unique.' });
    }

    const temporary = join(locations.content, `.gallery.${randomUUID()}.tmp`);
    const trash = await trashDirectory(locations.workspace, 'gallery');
    try {
      await writeFile(temporary, stringify(items), { encoding: 'utf8', flag: 'wx' });
      await roots();
      await allocateBackup(locations.gallery, trash, 'gallery.yaml');
      await rename(temporary, locations.gallery);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  }

  async function moveImageToTrash(path: string, locations: Awaited<ReturnType<typeof roots>>): Promise<string> {
    const trash = await trashDirectory(locations.workspace, 'images');
    const backup = await allocateBackup(path, trash, basename(path));
    await unlinkPath(path);
    return backup;
  }

  async function restoreImage(backup: string, destination: string): Promise<void> {
    try {
      await link(backup, destination);
    } catch (error) {
      if (errorCode(error) !== 'EEXIST') throw error;
    }
  }

  async function storedImagePath(
    locations: Awaited<ReturnType<typeof roots>>,
    item: GalleryItem,
  ): Promise<string> {
    const preferred = item.public ? locations.images : locations.privateImages;
    const alternate = item.public ? locations.privateImages : locations.images;
    try {
      return await checkedImagePath(preferred, item.image, true);
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error;
      return checkedImagePath(alternate, item.image, true);
    }
  }

  async function optionalImagePath(imageRoot: string, publicPath: string): Promise<string | undefined> {
    try {
      return await checkedImagePath(imageRoot, publicPath, true);
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return undefined;
      throw error;
    }
  }

  async function optionalStoredImagePath(
    locations: Awaited<ReturnType<typeof roots>>,
    item: GalleryItem,
  ): Promise<string | undefined> {
    try {
      return await storedImagePath(locations, item);
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return undefined;
      throw error;
    }
  }

  function validateImageExtension(path: string, info: ImageInfo): void {
    const actualExtension = extname(path).slice(1).toLowerCase().replace('jpeg', 'jpg');
    if (actualExtension !== info.extension) {
      throw new GalleryStorageError('Gallery validation failed.', 'VALIDATION_ERROR', { image: 'Image extension does not match its contents.' });
    }
  }

  async function replacementCandidates(
    locations: Awaited<ReturnType<typeof roots>>,
    items: GalleryItem[],
    id: string,
    existingItem?: GalleryItem,
  ): Promise<Set<string>> {
    const candidates = new Set<string>();
    if (existingItem) {
      try {
        candidates.add(await storedImagePath(locations, existingItem));
      } catch (error) {
        if (errorCode(error) !== 'ENOENT') throw error;
      }
    }
    for (const imageRoot of [locations.images, locations.privateImages]) {
      for (const extension of ['png', 'jpg', 'jpeg', 'webp']) {
        const publicPath = `/images/${id}.${extension}`;
        if (referencedByAnotherItem(items, id, publicPath)) continue;
        try {
          candidates.add(await checkedImagePath(imageRoot, publicPath, true));
        } catch (error) {
          if (errorCode(error) !== 'ENOENT') throw error;
        }
      }
    }
    return candidates;
  }

  async function normalizedImageCandidates(imageRoot: string, id: string): Promise<Set<string>> {
    const candidates = new Set<string>();
    for (const extension of ['png', 'jpg', 'jpeg', 'webp']) {
      try {
        candidates.add(await checkedImagePath(imageRoot, `/images/${id}.${extension}`, true));
      } catch (error) {
        if (errorCode(error) !== 'ENOENT') throw error;
      }
    }
    return candidates;
  }

  function referencedByAnotherItem(items: GalleryItem[], id: string, publicPath: string): boolean {
    return items.some((entry) => entry.id !== id && entry.image.toLowerCase() === publicPath.toLowerCase());
  }

  async function confirmedActiveCandidates(
    locations: Awaited<ReturnType<typeof roots>>,
    items: GalleryItem[],
    id: string,
    existingItem?: GalleryItem,
  ): Promise<ConfirmedImageCandidate[]> {
    const candidates = new Map<string, ConfirmedImageCandidate>();
    const addCandidate = async (root: ImageRootName, publicPath: string, owned: boolean): Promise<void> => {
      if (!owned && referencedByAnotherItem(items, id, publicPath)) return;
      const imageRoot = root === 'public' ? locations.images : locations.privateImages;
      const imagePath = await optionalImagePath(imageRoot, publicPath);
      if (!imagePath) return;
      try {
        const sha256 = imageFingerprint(await readFile(imagePath));
        candidates.set(`${root}:${publicPath.toLowerCase()}`, { root, path: publicPath, sha256 });
      } catch (error) {
        if (errorCode(error) !== 'ENOENT') throw error;
      }
    };

    if (existingItem) {
      const existingPath = await optionalStoredImagePath(locations, existingItem);
      if (existingPath) {
        const root: ImageRootName = isWithin(locations.images, existingPath) ? 'public' : 'private';
        await addCandidate(root, existingItem.image, true);
      }
    }
    for (const extension of ['png', 'jpg', 'jpeg', 'webp']) {
      const publicPath = `/images/${id}.${extension}`;
      await addCandidate('public', publicPath, false);
      await addCandidate('private', publicPath, false);
    }
    return [...candidates.values()];
  }

  async function optionalStageManifestPath(stagedImages: string, id: string): Promise<string | undefined> {
    try {
      return await checkedStageManifestPath(stagedImages, id, true);
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return undefined;
      throw error;
    }
  }

  async function confirmedCandidatePaths(
    locations: Awaited<ReturnType<typeof roots>>,
    items: GalleryItem[],
    id: string,
    manifest: StageManifest,
    previousPublicPath?: string,
  ): Promise<Set<string>> {
    const paths = new Set<string>();
    for (const candidate of manifest.candidates) {
      const normalized = ['png', 'jpg', 'jpeg', 'webp']
        .some((extension) => candidate.path.toLowerCase() === `/images/${id}.${extension}`);
      const exactPrevious = previousPublicPath?.toLowerCase() === candidate.path.toLowerCase();
      if (!normalized && !exactPrevious) continue;
      if (referencedByAnotherItem(items, id, candidate.path)) continue;
      const imageRoot = candidate.root === 'public' ? locations.images : locations.privateImages;
      const imagePath = await optionalImagePath(imageRoot, candidate.path);
      if (!imagePath) continue;
      const sha256 = imageFingerprint(await readFile(imagePath));
      if (sha256 === candidate.sha256) paths.add(imagePath);
    }
    return paths;
  }

  type Locations = Awaited<ReturnType<typeof roots>>;

  type PreparedMetadataPlan = {
    kind: 'metadata';
    item: GalleryItem;
    items: GalleryItem[];
    locations: Locations;
    source: string;
    destination: string;
    stagedPath?: string;
    manifestPath?: string;
    candidates: Set<string>;
    changes: GalleryChange[];
  };

  type PreparedCombinedPlan = {
    kind: 'combined';
    item: GalleryItem;
    items: GalleryItem[];
    locations: Locations;
    destination: string;
    candidates: Set<string>;
    info: ImageInfo;
    bytes: Buffer;
    changes: GalleryChange[];
  };

  type PreparedDeletePlan = {
    kind: 'delete';
    item: GalleryItem;
    items: GalleryItem[];
    locations: Locations;
    image: string;
    changes: GalleryChange[];
  };

  function workspacePath(locations: Locations, path: string): string {
    return relative(locations.workspace, path).split(sep).join('/');
  }

  function auditTrash(locations: Locations, paths: Iterable<string>): GalleryChange[] {
    return [...paths].map((path) => ({
      action: 'trash',
      path: workspacePath(locations, path),
      visibility: 'trash',
    }));
  }

  async function prepareMetadataPlan(input: GalleryItem): Promise<PreparedMetadataPlan> {
    let item: GalleryItem;
    try {
      item = galleryItemSchema.parse(input);
    } catch (error) {
      throw validationError(error);
    }
    await validateProspectiveArchive(resolvedRoot, {
      type: 'gallery-write',
      item,
      futurePublicImagePaths: item.public ? [item.image] : [],
    });
    const locations = await roots(false);
    const items = await readItemsUnsafe(locations);
    const index = items.findIndex(({ id }) => id === item.id);
    const previous = index >= 0 ? items[index] : undefined;
    if (index >= 0) items[index] = item;
    else items.push(item);
    const destinationRoot = item.public ? locations.images : locations.privateImages;
    const destination = await checkedImagePath(destinationRoot, item.image, false);
    const normalizedSubmittedPath = ['png', 'jpg', 'jpeg', 'webp']
      .some((extension) => item.image === `/images/${item.id}.${extension}`);
    const stagedPath = normalizedSubmittedPath
      ? await optionalImagePath(locations.stagedImages, item.image)
      : undefined;
    const changes: GalleryChange[] = [
      { action: 'metadata', path: 'src/content/gallery.yaml', visibility: 'metadata' },
    ];

    if (stagedPath) {
      const imageInfo = inspectImage(await readFile(stagedPath));
      validateImageExtension(item.image, imageInfo);
      const manifestPath = await optionalStageManifestPath(locations.stagedImages, item.id);
      const manifest = manifestPath
        ? parseStageManifest(await readFile(manifestPath, 'utf8'))
        : { version: 1, candidates: [] } satisfies StageManifest;
      const candidates = await confirmedCandidatePaths(locations, items, item.id, manifest, previous?.image);
      const previousPath = previous ? await optionalStoredImagePath(locations, previous) : undefined;
      if (previousPath) candidates.add(previousPath);
      const existingDestination = await optionalImagePath(destinationRoot, item.image);
      if (existingDestination && !candidates.has(existingDestination)) {
        throw new GalleryStorageError('Gallery validation failed.', 'CONFLICT', { image: 'Destination image already exists.' });
      }
      changes.push(
        { action: 'stage', path: workspacePath(locations, stagedPath), visibility: 'stage' },
        { action: 'write', path: workspacePath(locations, destination), visibility: item.public ? 'public' : 'private' },
        ...auditTrash(locations, candidates),
      );
      return {
        kind: 'metadata', item, items, locations, source: stagedPath, destination,
        stagedPath, manifestPath, candidates, changes,
      };
    }

    const previousItem = previous ?? item;
    let source = await optionalStoredImagePath(locations, previousItem);
    if (!source && index >= 0) {
      const preferred = item.public ? locations.images : locations.privateImages;
      const alternate = item.public ? locations.privateImages : locations.images;
      source = await optionalImagePath(preferred, item.image)
        ?? await optionalImagePath(alternate, item.image);
    }
    if (!source) source = await storedImagePath(locations, previousItem);
    const imageInfo = inspectImage(await readFile(source));
    validateImageExtension(item.image, imageInfo);
    if (destination !== source) {
      changes.push({
        action: 'move',
        path: workspacePath(locations, source),
        destination: workspacePath(locations, destination),
        visibility: item.public ? 'public' : 'private',
      });
    }
    return {
      kind: 'metadata', item, items, locations, source, destination,
      candidates: new Set(), changes,
    };
  }

  async function prepareCombinedPlan(input: GalleryItem, bytes: Buffer): Promise<PreparedCombinedPlan> {
    let parsedItem: GalleryItem;
    try {
      parsedItem = galleryItemSchema.parse(input);
    } catch (error) {
      throw validationError(error);
    }
    const safeId = checkedId(parsedItem.id);
    const info = inspectImage(bytes);
    const publicPath = `/images/${safeId}.${info.extension}`;
    const item = { ...parsedItem, image: publicPath };
    await validateProspectiveArchive(resolvedRoot, {
      type: 'gallery-write', item,
      futurePublicImagePaths: item.public ? [item.image] : [],
    });
    const locations = await roots(false);
    const items = await readItemsUnsafe(locations);
    const existingItem = items.find((entry) => entry.id === safeId);
    const destinationRoot = item.public ? locations.images : locations.privateImages;
    const destination = await checkedImagePath(destinationRoot, publicPath, false);
    if (referencedByAnotherItem(items, safeId, publicPath)) {
      throw new GalleryStorageError('Gallery validation failed.', 'VALIDATION_ERROR', { image: 'Gallery image paths must be unique.' });
    }
    const candidates = await replacementCandidates(locations, items, safeId, existingItem);
    const changes: GalleryChange[] = [
      { action: 'metadata', path: 'src/content/gallery.yaml', visibility: 'metadata' },
      { action: 'write', path: workspacePath(locations, destination), visibility: item.public ? 'public' : 'private' },
      ...auditTrash(locations, candidates),
    ];
    return { kind: 'combined', item, items, locations, destination, candidates, info, bytes, changes };
  }

  async function prepareDeletePlan(id: string): Promise<PreparedDeletePlan> {
    const safeId = checkedId(id);
    await validateProspectiveArchive(resolvedRoot, { type: 'gallery-delete', id: safeId });
    const locations = await roots(false);
    const items = await readItemsUnsafe(locations);
    const index = items.findIndex((item) => item.id === safeId);
    if (index < 0) throw new GalleryStorageError('Gallery item not found.', 'NOT_FOUND');
    const [item] = items.splice(index, 1);
    const image = await storedImagePath(locations, item);
    return {
      kind: 'delete', item, items, locations, image,
      changes: [
        { action: 'metadata', path: 'src/content/gallery.yaml', visibility: 'metadata' },
        { action: 'trash', path: workspacePath(locations, image), visibility: 'trash' },
      ],
    };
  }

  function publicPlan(plan: PreparedMetadataPlan | PreparedCombinedPlan | PreparedDeletePlan): GalleryChangePlan {
    return { item: plan.item, changes: plan.changes };
  }

  async function executeMetadataPlan(plan: PreparedMetadataPlan): Promise<GalleryItem> {
    await roots();
    if (plan.stagedPath) {
      const moved: Array<{ backup: string; destination: string }> = [];
      let destinationLinked = false;
      let stagedRemoved = false;
      try {
        for (const candidate of plan.candidates) {
          moved.push({ backup: await moveImageToTrash(candidate, plan.locations), destination: candidate });
        }
        await link(plan.stagedPath, plan.destination);
        destinationLinked = true;
        await unlinkPath(plan.stagedPath);
        stagedRemoved = true;
        await writeItemsUnsafe(plan.items, plan.locations);
      } catch (error) {
        if (destinationLinked) {
          if (stagedRemoved) await restoreImage(plan.destination, plan.stagedPath);
          await unlinkPath(plan.destination);
        }
        for (const entry of moved.reverse()) await restoreImage(entry.backup, entry.destination);
        throw error;
      }
      if (plan.manifestPath) await rm(plan.manifestPath, { force: true }).catch(() => undefined);
      return plan.item;
    }

    const moving = plan.destination !== plan.source;
    let destinationLinked = false;
    let sourceRemoved = false;
    try {
      if (moving) {
        try {
          await link(plan.source, plan.destination);
        } catch (error) {
          if (errorCode(error) === 'EEXIST') {
            throw new GalleryStorageError('Gallery validation failed.', 'CONFLICT', { image: 'Destination image already exists.' });
          }
          throw error;
        }
        destinationLinked = true;
        await unlinkPath(plan.source);
        sourceRemoved = true;
      }
      await writeItemsUnsafe(plan.items, plan.locations);
    } catch (error) {
      if (moving && destinationLinked) {
        if (sourceRemoved) await restoreImage(plan.destination, plan.source);
        await unlinkPath(plan.destination);
      }
      throw error;
    }
    return plan.item;
  }

  async function executeCombinedPlan(
    plan: PreparedCombinedPlan,
    overwrite: boolean,
  ): Promise<{ item: GalleryItem; image: RegisteredImage }> {
    if (plan.candidates.size > 0 && !overwrite) {
      throw new GalleryStorageError('이미지가 이미 존재합니다. 덮어쓰기를 확인해 주세요.', 'CONFLICT', { image: 'Explicit overwrite confirmation is required.' });
    }
    await roots();
    const temporary = join(
      plan.item.public ? plan.locations.images : plan.locations.privateImages,
      `.${plan.item.id}.${randomUUID()}.tmp`,
    );
    const moved: Array<{ backup: string; destination: string }> = [];
    let targetInstalled = false;
    try {
      await writeFile(temporary, plan.bytes, { flag: 'wx' });
      await roots();
      for (const candidate of plan.candidates) {
        moved.push({ backup: await moveImageToTrash(candidate, plan.locations), destination: candidate });
      }
      await rename(temporary, plan.destination);
      targetInstalled = true;
      const index = plan.items.findIndex((entry) => entry.id === plan.item.id);
      if (index >= 0) plan.items[index] = plan.item;
      else plan.items.push(plan.item);
      await writeItemsUnsafe(plan.items, plan.locations);
    } catch (error) {
      await rm(temporary, { force: true });
      if (targetInstalled) await rm(plan.destination, { force: true });
      for (const entry of moved.reverse()) await restoreImage(entry.backup, entry.destination);
      throw error;
    }
    return {
      item: plan.item,
      image: { path: plan.item.image, width: plan.info.width, height: plan.info.height },
    };
  }

  async function executeDeletePlan(plan: PreparedDeletePlan): Promise<void> {
    await roots();
    const backup = await moveImageToTrash(plan.image, plan.locations);
    try {
      await writeItemsUnsafe(plan.items, plan.locations);
    } catch (error) {
      await restoreImage(backup, plan.image);
      throw error;
    }
  }

  function listItems(): Promise<GalleryItem[]> {
    return enqueue(async () => readItemsUnsafe());
  }

  function planItem(input: GalleryItem): Promise<GalleryChangePlan> {
    return enqueue(async () => publicPlan(await prepareMetadataPlan(input)));
  }

  function planTrashItem(id: string): Promise<GalleryChangePlan> {
    return enqueue(async () => publicPlan(await prepareDeletePlan(id)));
  }

  function readPrivateImage(id: string): Promise<PrivateGalleryImage> {
    return enqueue(async () => {
      const safeId = checkedId(id);
      const locations = await roots(false);
      const items = await readItemsUnsafe(locations);
      const item = items.find((entry) => entry.id === safeId);
      if (!item || item.public) throw new GalleryStorageError('Gallery item not found.', 'NOT_FOUND');
      const imagePath = await checkedImagePath(locations.privateImages, item.image, true);
      const bytes = await readFile(imagePath);
      const info = inspectImage(bytes);
      const contentType = info.extension === 'jpg' ? 'image/jpeg' : `image/${info.extension}` as const;
      return { bytes, contentType };
    });
  }

  function writeItem(input: GalleryItem): Promise<GalleryItem> {
    return enqueue(async () => executeMetadataPlan(await prepareMetadataPlan(input)));
  }

  function registerImage({ id, bytes, overwrite }: RegisterImageRequest): Promise<RegisteredImage> {
    return enqueue(async () => {
      const safeId = checkedId(id);
      const info = inspectImage(bytes);
      const locations = await roots();
      const items = await readItemsUnsafe(locations);
      const existingItem = items.find((entry) => entry.id === safeId);
      const publicPath = `/images/${safeId}.${info.extension}`;
      const target = await checkedImagePath(locations.stagedImages, publicPath, false);
      const manifestTarget = await checkedStageManifestPath(locations.stagedImages, safeId, false);
      const activeCandidates = await confirmedActiveCandidates(locations, items, safeId, existingItem);
      const stagedCandidates = await normalizedImageCandidates(locations.stagedImages, safeId);
      const stagedManifest = await optionalStageManifestPath(locations.stagedImages, safeId);
      if ((activeCandidates.length > 0 || stagedCandidates.size > 0 || stagedManifest) && !overwrite) {
        throw new GalleryStorageError('이미지가 이미 존재합니다. 덮어쓰기를 확인해 주세요.', 'CONFLICT', { image: 'Explicit overwrite confirmation is required.' });
      }

      const temporary = join(locations.stagedImages, `.${safeId}.${randomUUID()}.tmp`);
      const manifestTemporary = join(locations.stagedImages, `.${safeId}.${randomUUID()}.json.tmp`);
      const moved: Array<{ backup: string; destination: string }> = [];
      let targetInstalled = false;
      let manifestInstalled = false;
      try {
        await writeFile(temporary, bytes, { flag: 'wx' });
        await writeFile(manifestTemporary, JSON.stringify({ version: 1, candidates: activeCandidates } satisfies StageManifest), { flag: 'wx' });
        await roots();
        for (const candidate of stagedCandidates) {
          moved.push({ backup: await moveImageToTrash(candidate, locations), destination: candidate });
        }
        if (stagedManifest) moved.push({ backup: await moveImageToTrash(stagedManifest, locations), destination: stagedManifest });
        await rename(temporary, target);
        targetInstalled = true;
        await rename(manifestTemporary, manifestTarget);
        manifestInstalled = true;
      } catch (error) {
        await rm(temporary, { force: true });
        await rm(manifestTemporary, { force: true });
        if (targetInstalled) await rm(target, { force: true });
        if (manifestInstalled) await rm(manifestTarget, { force: true });
        for (const entry of moved.reverse()) await restoreImage(entry.backup, entry.destination);
        throw error;
      }
      return { path: publicPath, width: info.width, height: info.height };
    });
  }

  function planItemWithImage(input: GalleryItem, bytes: Buffer): Promise<GalleryChangePlan> {
    return enqueue(async () => publicPlan(await prepareCombinedPlan(input, bytes)));
  }

  function writeItemWithImage(
    input: GalleryItem,
    bytes: Buffer,
    overwrite: boolean,
  ): Promise<{ item: GalleryItem; image: RegisteredImage }> {
    return enqueue(async () => executeCombinedPlan(await prepareCombinedPlan(input, bytes), overwrite));
  }

  function trashItem(id: string): Promise<void> {
    return enqueue(async () => executeDeletePlan(await prepareDeletePlan(id)));
  }

  return {
    listItems, readPrivateImage,
    planItem, planItemWithImage, planTrashItem,
    writeItem, writeItemWithImage, registerImage, trashItem,
  };
}

export type GalleryStorage = ReturnType<typeof createGalleryStorage>;
