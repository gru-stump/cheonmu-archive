import type { ArchiveContent, ValidationResult } from './schema';

export interface ValidationOptions {
  publicImagePaths?: readonly string[];
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

  const worldIds = new Set<string>();
  const worldNumbers = new Set<string>();
  for (const document of content.world) {
    if (worldIds.has(document.id)) {
      errors.push(`Duplicate world document ID: ${document.id}`);
    }
    if (worldNumbers.has(document.documentNumber)) {
      errors.push(`Duplicate world document number: ${document.documentNumber}`);
    }
    worldIds.add(document.id);
    worldNumbers.add(document.documentNumber);
    for (const relatedId of document.relatedRecords) {
      if (!recordIds.has(relatedId)) {
        errors.push(`World document ${document.id} references missing record ID: ${relatedId}`);
      }
    }
  }

  for (const scene of content.scenes) {
    if (!scene.body.trim()) {
      errors.push(`Scene ${scene.id} is empty.`);
    }

    const record = content.records.find((item) => item.id === scene.id);
    if (!record) {
      errors.push(`Scene ${scene.id} has no matching record.`);
    } else if (!record.cinematic) {
      errors.push(`Scene ${scene.id} is attached to a non-cinematic record.`);
    }
  }

  const availableImages = new Set(options.publicImagePaths ?? []);
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
