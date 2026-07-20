import { z } from 'zod';

const nonEmptyText = z.string().trim().min(1);
const contentId = nonEmptyText.regex(/^[a-z0-9-]+$/);

export const statusSchema = z.enum(['confirmed', 'draft']);

export const creditSchema = z.object({
  creator: nonEmptyText,
  source: z.url().optional(),
});

export const recordMetaSchema = z.object({
  id: contentId,
  recordNumber: nonEmptyText,
  title: nonEmptyText,
  stage: z.number().int().min(1).max(8),
  status: statusSchema,
  characters: z.array(contentId),
  tags: z.array(nonEmptyText),
  related: z.array(contentId),
  quote: nonEmptyText,
  cinematic: z.boolean(),
  credit: creditSchema.optional(),
});

export const profileMetaSchema = z.object({
  id: contentId,
  title: nonEmptyText,
  height: nonEmptyText.optional(),
  credit: creditSchema.optional(),
});

export const documentMetaSchema = z.object({
  id: contentId,
  title: nonEmptyText,
  credit: creditSchema.optional(),
});

export const galleryItemSchema = z.object({
  id: contentId,
  title: nonEmptyText,
  image: nonEmptyText.regex(/^\/images\/[A-Za-z0-9_-]+\.(?:png|jpe?g|webp)$/i),
  alt: nonEmptyText,
  creator: nonEmptyText,
  source: z.url().refine((value) => new URL(value).protocol === 'https:', 'Source URL must use HTTPS.').optional(),
  characters: z.array(contentId).min(1),
  tags: z.array(nonEmptyText).optional(),
  public: z.boolean(),
});

export const gallerySchema = z.array(galleryItemSchema);

export type RecordMeta = z.infer<typeof recordMetaSchema>;
export type ProfileMeta = z.infer<typeof profileMetaSchema>;
export type DocumentMeta = z.infer<typeof documentMetaSchema>;
export type GalleryItem = z.infer<typeof galleryItemSchema>;

export type ArchiveRecord = RecordMeta & { body: string };
export type ArchiveProfile = ProfileMeta & { body: string };
export type ArchiveDocument = DocumentMeta & { body: string };

export interface ArchiveContent {
  records: ArchiveRecord[];
  profiles: ArchiveProfile[];
  documents: ArchiveDocument[];
  gallery: GalleryItem[];
}

export interface ValidationResult {
  errors: string[];
  warnings: string[];
}
