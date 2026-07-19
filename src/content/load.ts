import { parse as parseYaml } from 'yaml';
import { parseMarkdown } from './frontmatter';
import {
  documentMetaSchema,
  gallerySchema,
  profileMetaSchema,
  recordMetaSchema,
  type ArchiveContent,
  type ArchiveDocument,
  type ArchiveProfile,
  type ArchiveRecord,
  type ValidationResult,
} from './schema';

type RawContentModules = Record<string, string>;

export interface ValidationOptions {
  publicImagePaths?: readonly string[];
}

function markdownModules(): RawContentModules {
  return import.meta.glob('./**/*.md', {
    query: '?raw',
    import: 'default',
    eager: true,
  }) as RawContentModules;
}

function galleryModules(): RawContentModules {
  return import.meta.glob('./gallery.yaml', {
    query: '?raw',
    import: 'default',
    eager: true,
  }) as RawContentModules;
}

function publicImagePaths(): string[] {
  return Object.keys(import.meta.glob('/public/images/**/*', { eager: true }))
    .map((path) => path.replace(/^\/public/, ''));
}

export function loadAllContent(): ArchiveContent {
  const content: ArchiveContent = {
    records: [],
    profiles: [],
    documents: [],
    gallery: [],
  };

  for (const [path, source] of Object.entries(markdownModules())) {
    if (path.includes('/records/')) {
      const parsed = parseMarkdown(source, recordMetaSchema);
      content.records.push({ ...parsed.data, body: parsed.body } satisfies ArchiveRecord);
    } else if (path.includes('/profiles/')) {
      const parsed = parseMarkdown(source, profileMetaSchema);
      content.profiles.push({ ...parsed.data, body: parsed.body } satisfies ArchiveProfile);
    } else if (path.includes('/documents/')) {
      const parsed = parseMarkdown(source, documentMetaSchema);
      content.documents.push({ ...parsed.data, body: parsed.body } satisfies ArchiveDocument);
    }
  }

  const gallerySource = Object.values(galleryModules())[0];
  if (gallerySource) {
    content.gallery = gallerySchema.parse(parseYaml(gallerySource)).filter((item) => item.public);
  }

  content.records.sort((left, right) => left.stage - right.stage);
  return content;
}

export function validateArchiveContent(
  content: ArchiveContent,
  options: ValidationOptions = {},
): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const ids = new Set<string>();
  const recordIds = new Set(content.records.map((record) => record.id));

  for (const item of [...content.records, ...content.profiles, ...content.documents, ...content.gallery]) {
    if (ids.has(item.id)) {
      errors.push(`Duplicate content ID: ${item.id}`);
    }
    ids.add(item.id);
  }

  for (const record of content.records) {
    if (!Number.isInteger(record.stage) || record.stage < 1 || record.stage > 8) {
      errors.push(`Record ${record.id} has invalid stage: ${record.stage}`);
    }
    for (const relatedId of record.related) {
      if (!recordIds.has(relatedId)) {
        errors.push(`Record ${record.id} references missing related ID: ${relatedId}`);
      }
    }
  }

  const availableImages = new Set(options.publicImagePaths ?? publicImagePaths());
  for (const item of content.gallery) {
    if (item.public && !availableImages.has(item.image)) {
      errors.push(`Public gallery image is missing: ${item.image}`);
    }
  }

  const muyeongDetails = content.profiles
    .filter((profile) => profile.id.includes('muyeong') || profile.title.includes('\uBB34\uC601'))
    .map((profile) => JSON.stringify(profile))
    .join('\n');
  if (muyeongDetails.includes('185cm') && muyeongDetails.includes('189cm')) {
    errors.push('\uBB34\uC601 \uC2E0\uC7A5\uC774 185cm\uC640 189cm\uB85C \uCDA9\uB3CC\uD569\uB2C8\uB2E4.');
  }

  return { errors, warnings };
}

export function validateContent(
  content: ArchiveContent = loadAllContent(),
  options?: ValidationOptions,
): ValidationResult {
  return validateArchiveContent(content, options);
}
