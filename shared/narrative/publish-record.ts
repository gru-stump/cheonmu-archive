import type { GenerationResult } from './contracts';

const contentIdPattern = /^[a-z0-9-]+$/;
const recordNumberPattern = /^\d{2,3}$/;
const datePattern = /^\d{4}-\d{2}-\d{2}$/;

export interface ApprovedNarrativeVersion {
  status: 'approved';
  content: Pick<GenerationResult, 'title' | 'body' | 'canonChangeCandidates' | 'unresolvedCallbacks'>;
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
  existingRecordIds?: readonly string[];
  existingRecordNumbers?: readonly string[];
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
  if (!recordNumberPattern.test(number)) invalid('recordNumber must be a two- or three-digit archive number.');
  return number;
}

function publicationDate(value: unknown): string {
  const date = plainText(value, 'date');
  const parsed = datePattern.test(date) ? new Date(`${date}T00:00:00.000Z`) : undefined;
  if (!parsed || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
    invalid('date must be an ISO calendar date.');
  }
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
  approvedVersion: ApprovedNarrativeVersion,
  publication: PublicationDetails,
): PublishedRecord {
  if (approvedVersion.status !== 'approved') invalid('version is not approved.');
  if (!Array.isArray(approvedVersion.content.canonChangeCandidates) || approvedVersion.content.canonChangeCandidates.length > 0) {
    invalid('version has unresolved canon-change candidates.');
  }
  if (!Array.isArray(approvedVersion.content.unresolvedCallbacks) || approvedVersion.content.unresolvedCallbacks.length > 0) {
    invalid('version has unresolved callbacks.');
  }

  const id = contentId(publication.id, 'id');
  const number = recordNumber(publication.recordNumber);
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

  const knownIds = publication.existingRecordIds ? new Set(publication.existingRecordIds) : undefined;
  if (knownIds?.has(id)) invalid(`record ID already exists: ${id}.`);
  if (related.length > 0 && !knownIds) invalid('related records cannot be validated without existingRecordIds.');
  if (knownIds && related.some((relatedId) => !knownIds.has(relatedId))) invalid('related contains a missing archive record.');
  if (publication.existingRecordNumbers?.includes(number)) invalid(`record number already exists: ${number}.`);

  const frontmatter = [
    `id: ${yamlString(id)}`,
    `recordNumber: ${yamlString(number)}`,
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
