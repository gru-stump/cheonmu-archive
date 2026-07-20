import { parse as parseYaml } from 'yaml';
import publicGallerySource from 'virtual:public-gallery';
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
} from './schema';
import { validateArchiveContent as validateArchiveContentBase, type ValidationOptions } from './validation';

type RawContentModules = Record<string, string>;

function markdownModules(): RawContentModules {
  return import.meta.glob('./**/*.md', {
    query: '?raw',
    import: 'default',
    eager: true,
  }) as RawContentModules;
}

function publicImagePaths(): string[] {
  return gallerySchema.parse(parseYaml(publicGallerySource)).map((item) => item.image);
}

export function loadContentFromSources(
  markdown: RawContentModules,
  gallerySource?: string,
  includePrivateGallery = true,
): ArchiveContent {
  const content: ArchiveContent = {
    records: [],
    profiles: [],
    documents: [],
    gallery: [],
  };

  for (const [path, source] of Object.entries(markdown)) {
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

  if (gallerySource) {
    const gallery = gallerySchema.parse(parseYaml(gallerySource));
    content.gallery = includePrivateGallery ? gallery : gallery.filter((item) => item.public);
  }

  content.records.sort((left, right) => left.stage - right.stage);
  return content;
}

function loadContent(includePrivateGallery: boolean): ArchiveContent {
  return loadContentFromSources(
    markdownModules(),
    publicGallerySource,
    includePrivateGallery,
  );
}

export function loadAllContent(): ArchiveContent {
  return loadContent(false);
}

export function validateArchiveContent(
  content: ArchiveContent,
  options: ValidationOptions = {},
): ReturnType<typeof validateArchiveContentBase> {
  return validateArchiveContentBase(content, {
    publicImagePaths: options.publicImagePaths ?? publicImagePaths(),
  });
}

export function validateContent(
  content: ArchiveContent = loadContent(true),
  options?: ValidationOptions,
): ReturnType<typeof validateArchiveContent> {
  return validateArchiveContent(content, options);
}
