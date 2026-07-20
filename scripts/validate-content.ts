import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { ZodType } from 'zod';
import { resolveValidationRoot } from './content-validation-path';
import { parseMarkdown } from '../src/content/frontmatter';
import { validateArchiveContent } from '../src/content/validation';
import {
  documentMetaSchema,
  gallerySchema,
  profileMetaSchema,
  recordMetaSchema,
  worldSchema,
  type ArchiveContent,
  type ArchiveScene,
} from '../src/content/schema';

const rootDirectory = resolveValidationRoot(import.meta.url);
const contentDirectory = join(rootDirectory, 'src', 'content');
const publicDirectory = join(rootDirectory, 'public');

function readMarkdownCollection<T>(
  directory: string,
  schema: ZodType<T>,
): Array<T & { body: string }> {
  if (!existsSync(directory)) {
    return [];
  }

  return readdirSync(directory)
    .filter((fileName) => fileName.endsWith('.md'))
    .map((fileName) => parseMarkdown(readFileSync(join(directory, fileName), 'utf8'), schema))
    .map(({ data, body }) => ({ ...data, body }));
}

function readScenes(directory: string): ArchiveScene[] {
  if (!existsSync(directory)) {
    return [];
  }

  return readdirSync(directory)
    .filter((fileName) => fileName.endsWith('.md'))
    .map((fileName) => ({
      id: fileName.replace(/\.md$/, ''),
      body: readFileSync(join(directory, fileName), 'utf8').trim(),
    }));
}

function allPublicImages(directory: string, current = ''): string[] {
  if (!existsSync(directory)) {
    return [];
  }

  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const relativePath = join(current, entry.name).replaceAll('\\', '/');
    return entry.isDirectory()
      ? allPublicImages(join(directory, entry.name), relativePath)
      : [`/${relativePath}`];
  });
}

const galleryPath = join(contentDirectory, 'gallery.yaml');
const gallery = existsSync(galleryPath)
  ? gallerySchema.parse(parseYaml(readFileSync(galleryPath, 'utf8')))
  : [];
const content: ArchiveContent = {
  records: readMarkdownCollection(join(contentDirectory, 'records'), recordMetaSchema),
  scenes: readScenes(join(contentDirectory, 'scenes')),
  profiles: readMarkdownCollection(join(contentDirectory, 'profiles'), profileMetaSchema),
  documents: readMarkdownCollection(join(contentDirectory, 'documents'), documentMetaSchema),
  gallery,
  world: existsSync(join(contentDirectory, 'world.yaml'))
    ? worldSchema.parse(parseYaml(readFileSync(join(contentDirectory, 'world.yaml'), 'utf8')))
    : [],
};
const result = validateArchiveContent(content, { publicImagePaths: allPublicImages(publicDirectory) });

for (const warning of result.warnings) {
  console.warn(`Warning: ${warning}`);
}
for (const error of result.errors) {
  console.error(`Error: ${error}`);
}

if (result.errors.length > 0) {
  process.exitCode = 1;
} else {
  console.info('Content validation passed.');
}
