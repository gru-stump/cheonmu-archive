import { isCalendarDate, isPublicRecordNumber, normalizeArchiveRecordNumber } from './archive-record';

const contentIdPattern = /^[a-z0-9-]+$/;
export interface CanonChangeCandidate {
  id: string;
  resolution: 'resolved' | 'unresolved';
}

/**
 * A repository-supplied, immutable-version snapshot. Task 1 validates that
 * the identities agree; Task 2 must prove this snapshot by a locked database
 * join of the draft, version, public approval, and publication job.
 */
export interface LockedApprovedNarrativeVersion {
  version: {
    id: string;
    draftId: string;
    versionNumber: number;
    immutable: boolean;
  };
  approval: {
    id: string;
    draftId: string;
    versionId: string;
    status: string;
  };
  publicationBinding: {
    id: string;
    draftId: string;
    approvalId: string;
    versionId: string;
    latestVersionId: string;
  };
  content: {
    title: string;
    body: string;
    canonChangeCandidates: readonly CanonChangeCandidate[];
    unresolvedCallbacks: readonly string[];
  };
}

export interface ArchiveCollisionSnapshot {
  recordIds: readonly string[];
  recordNumbers: readonly string[];
}

export interface PublicationDetails {
  id: string;
  recordNumber: string;
  relationshipStage: number;
  date: string;
  summary: string;
  characters: string[];
  tags: string[];
  related: string[];
  quote: string;
  archiveSnapshot: ArchiveCollisionSnapshot;
}

export interface PublishedRecord {
  path: string;
  source: string;
}

function invalid(message: string): never {
  throw new Error(`Cannot publish narrative record: ${message}`);
}

function plainText(value: unknown, field: string): string {
  if (typeof value !== 'string') invalid(`${field} must be text.`);
  const text = value.trim();
  if (!text || /[\r\n\0]/.test(text)) invalid(`${field} contains unsafe YAML text.`);
  return text;
}

function contentId(value: unknown, field: string): string {
  const id = plainText(value, field);
  if (!contentIdPattern.test(id)) invalid(`${field} must use lowercase letters, digits, and hyphens only.`);
  return id;
}

function uniqueItems(values: readonly string[], field: string): void {
  if (new Set(values).size !== values.length) invalid(`${field} must not contain duplicates.`);
}

function textList(value: unknown, field: string, item: (value: unknown, field: string) => string): string[] {
  if (!Array.isArray(value) || value.length === 0) invalid(`${field} must contain at least one item.`);
  const values = value.map((entry, index) => item(entry, `${field}[${index}]`));
  uniqueItems(values, field);
  return values;
}

function recordNumber(value: unknown): string {
  const number = plainText(value, 'recordNumber');
  if (!isPublicRecordNumber(number)) invalid('recordNumber must be a two- or three-digit archive number.');
  return number;
}

function publicationDate(value: unknown): string {
  const date = plainText(value, 'date');
  if (!isCalendarDate(date)) invalid('date must be an ISO calendar date.');
  return date;
}

function bodyText(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) invalid('body must be non-empty Markdown text.');
  return value.replaceAll('\r\n', '\n');
}

function yamlString(value: string): string {
  return JSON.stringify(value);
}

function yamlList(values: readonly string[]): string {
  return `[${values.map(yamlString).join(', ')}]`;
}

export function toPublishedRecord(
  approvedVersion: LockedApprovedNarrativeVersion,
  publication: PublicationDetails,
): PublishedRecord {
  const versionId = plainText(approvedVersion.version.id, 'version.id');
  const draftId = plainText(approvedVersion.version.draftId, 'version.draftId');
  if (!Number.isInteger(approvedVersion.version.versionNumber) || approvedVersion.version.versionNumber < 1) invalid('version.versionNumber must be a positive integer.');
  if (approvedVersion.version.immutable !== true) invalid('version is not immutable.');
  const approvalId = plainText(approvedVersion.approval.id, 'approval.id');
  const publicationId = plainText(approvedVersion.publicationBinding.id, 'publicationBinding.id');
  if (approvedVersion.approval.status !== 'approved_for_publication') invalid('version does not have a public approval.');
  if (approvedVersion.approval.draftId !== draftId || approvedVersion.publicationBinding.draftId !== draftId) invalid('approval and publication draft IDs must match the version.');
  if (approvedVersion.approval.versionId !== versionId || approvedVersion.publicationBinding.versionId !== versionId) invalid('approval and publication version IDs must match the version.');
  if (approvedVersion.publicationBinding.latestVersionId !== versionId) invalid('version is stale and no longer latest.');
  if (approvedVersion.publicationBinding.approvalId !== approvalId) invalid('publication approval ID must match the public approval.');
  // Keep these identities live in the contract even though rendering never emits them.
  void publicationId;
  if (!Array.isArray(approvedVersion.content.canonChangeCandidates) || approvedVersion.content.canonChangeCandidates.some((candidate) => (
    !candidate || typeof candidate !== 'object' || plainText(candidate.id, 'canonChangeCandidate.id') === '' || candidate.resolution !== 'resolved'
  ))) {
    invalid('version has unresolved canon-change candidates.');
  }
  if (!Array.isArray(approvedVersion.content.unresolvedCallbacks) || approvedVersion.content.unresolvedCallbacks.length > 0) {
    invalid('version has unresolved callbacks.');
  }

  const id = contentId(publication.id, 'id');
  const number = recordNumber(publication.recordNumber);
  const archiveNumber = normalizeArchiveRecordNumber(number);
  const title = plainText(approvedVersion.content.title, 'title');
  const summary = plainText(publication.summary, 'summary');
  const date = publicationDate(publication.date);
  const quote = plainText(publication.quote, 'quote');
  const body = bodyText(approvedVersion.content.body);
  if (!Number.isInteger(publication.relationshipStage) || publication.relationshipStage < 0 || publication.relationshipStage > 8) {
    invalid('relationshipStage must be an integer from 0 to 8.');
  }
  const characters = textList(publication.characters, 'characters', contentId);
  const tags = textList(publication.tags, 'tags', plainText);
  const related = Array.isArray(publication.related)
    ? publication.related.map((entry, index) => contentId(entry, `related[${index}]`))
    : invalid('related must be a list.');
  uniqueItems(related, 'related');
  if (related.includes(id)) invalid('related must not include the record itself.');

  const snapshot = publication.archiveSnapshot;
  if (!snapshot || !Array.isArray(snapshot.recordIds) || !Array.isArray(snapshot.recordNumbers)) invalid('a complete archive collision snapshot is required.');
  const knownIds = snapshot.recordIds.map((knownId, index) => contentId(knownId, `archiveSnapshot.recordIds[${index}]`));
  uniqueItems(knownIds, 'archiveSnapshot.recordIds');
  const knownNumbers = snapshot.recordNumbers.map((knownNumber, index) => normalizeArchiveRecordNumber(plainText(knownNumber, `archiveSnapshot.recordNumbers[${index}]`)));
  uniqueItems(knownNumbers, 'archiveSnapshot.recordNumbers');
  if (knownIds.includes(id)) invalid(`record ID already exists: ${id}.`);
  if (related.some((relatedId) => !knownIds.includes(relatedId))) invalid('related contains a missing archive record.');
  if (knownNumbers.includes(archiveNumber)) invalid(`record number already exists: ${number}.`);

  const frontmatter = [
    `id: ${yamlString(id)}`,
    `recordNumber: ${yamlString(archiveNumber)}`,
    `title: ${yamlString(title)}`,
    `summary: ${yamlString(summary)}`,
    `stage: ${publication.relationshipStage}`,
    `date: ${yamlString(date)}`,
    'status: confirmed',
    `characters: ${yamlList(characters)}`,
    `tags: ${yamlList(tags)}`,
    `related: ${yamlList(related)}`,
    `quote: ${yamlString(quote)}`,
    'cinematic: false',
  ].join('\n');

  return {
    path: `src/content/records/${number}-${id}.md`,
    source: `---\n${frontmatter}\n---\n${body}\n`,
  };
}
