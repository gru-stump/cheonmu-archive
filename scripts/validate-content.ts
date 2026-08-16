import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
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

type MarkdownSources = Record<string, string>;

export interface ContentValidationSources {
  records?: MarkdownSources;
  scenes?: MarkdownSources;
  profiles?: MarkdownSources;
  documents?: MarkdownSources;
  gallerySource?: string;
  worldSource?: string;
  publicImagePaths?: readonly string[];
}

function parseMarkdownCollection<T>(sources: MarkdownSources, schema: ZodType<T>): Array<T & { body: string }> {
  return Object.values(sources)
    .map((source) => parseMarkdown(source, schema))
    .map(({ data, body }) => ({ ...data, body }));
}

function parseScenes(sources: MarkdownSources): ArchiveScene[] {
  return Object.entries(sources)
    .map(([fileName, source]) => ({
      id: fileName.replace(/\.md$/, ''),
      body: source.trim(),
    }));
}

function readMarkdownSources(directory: string): MarkdownSources {
  if (!existsSync(directory)) return {};
  return Object.fromEntries(readdirSync(directory)
    .filter((fileName) => fileName.endsWith('.md'))
    .map((fileName) => [fileName, readFileSync(join(directory, fileName), 'utf8')]));
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

export function validateContentSources(sources: ContentValidationSources) {
  const content: ArchiveContent = {
    records: parseMarkdownCollection(sources.records ?? {}, recordMetaSchema),
    scenes: parseScenes(sources.scenes ?? {}),
    profiles: parseMarkdownCollection(sources.profiles ?? {}, profileMetaSchema),
    documents: parseMarkdownCollection(sources.documents ?? {}, documentMetaSchema),
    gallery: sources.gallerySource ? gallerySchema.parse(parseYaml(sources.gallerySource)) : [],
    world: sources.worldSource ? worldSchema.parse(parseYaml(sources.worldSource)) : [],
  };
  return validateArchiveContent(content, { publicImagePaths: sources.publicImagePaths ?? [] });
}

function runValidation(): void {
  const galleryPath = join(contentDirectory, 'gallery.yaml');
  const result = validateContentSources({
    records: readMarkdownSources(join(contentDirectory, 'records')),
    scenes: readMarkdownSources(join(contentDirectory, 'scenes')),
    profiles: readMarkdownSources(join(contentDirectory, 'profiles')),
    documents: readMarkdownSources(join(contentDirectory, 'documents')),
    gallerySource: existsSync(galleryPath) ? readFileSync(galleryPath, 'utf8') : undefined,
    worldSource: existsSync(join(contentDirectory, 'world.yaml')) ? readFileSync(join(contentDirectory, 'world.yaml'), 'utf8') : undefined,
    publicImagePaths: allPublicImages(publicDirectory),
  });
  for (const warning of result.warnings) console.warn(`Warning: ${warning}`);
  for (const error of result.errors) console.error(`Error: ${error}`);
  if (result.errors.length > 0) process.exitCode = 1;
  else console.info('Content validation passed.');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) runValidation();
