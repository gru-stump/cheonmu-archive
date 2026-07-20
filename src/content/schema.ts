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

export const WORLD_PUBLIC_STAGE = 6;

export const worldCategorySchema = z.enum([
  'organization',
  'field-response',
  'medical',
  'anomaly',
  'observation',
  'classified',
]);

export const worldStatusSchema = z.enum(['public', 'partial', 'locked']);

export const worldSectionSchema = z.object({
  revealStage: z.number().int().min(1).max(8),
  paragraphs: z.array(nonEmptyText).min(1),
});

export const worldDocumentSchema = z.object({
  id: contentId,
  documentNumber: nonEmptyText,
  title: nonEmptyText,
  categories: z.array(worldCategorySchema).min(1),
  status: worldStatusSchema,
  clearance: nonEmptyText,
  basisStage: z.number().int().min(1).max(8),
  summary: nonEmptyText,
  explanation: nonEmptyText,
  sections: z.array(worldSectionSchema),
  relatedRecords: z.array(contentId),
  lockLabel: nonEmptyText.optional(),
});

export const worldSchema = z.array(worldDocumentSchema);

export type RecordMeta = z.infer<typeof recordMetaSchema>;
export type ProfileMeta = z.infer<typeof profileMetaSchema>;
export type DocumentMeta = z.infer<typeof documentMetaSchema>;
export type GalleryItem = z.infer<typeof galleryItemSchema>;
export type WorldCategory = z.infer<typeof worldCategorySchema>;
export type WorldDocument = z.infer<typeof worldDocumentSchema>;
export type WorldSection = z.infer<typeof worldSectionSchema>;

export function visibleWorldSections(
  document: WorldDocument,
  stage = WORLD_PUBLIC_STAGE,
): WorldSection[] {
  return document.sections.filter((section) => section.revealStage <= stage);
}

export type ArchiveScene = { id: string; body: string };
export type ArchiveRecord = RecordMeta & { body: string; cinematicBody?: string };
export type ArchiveProfile = ProfileMeta & { body: string };
export type ArchiveDocument = DocumentMeta & { body: string };

export interface ArchiveContent {
  records: ArchiveRecord[];
  scenes: ArchiveScene[];
  profiles: ArchiveProfile[];
  documents: ArchiveDocument[];
  gallery: GalleryItem[];
  world: WorldDocument[];
}

export interface ValidationResult {
  errors: string[];
  warnings: string[];
}
