import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

type CanonMetadata = Record<string, unknown>;
export type CanonClaimStatus = 'confirmed' | 'unresolved' | 'conflicting' | 'request-only';

export interface CanonSource {
  id: string;
  path: string;
  visibility: 'public' | 'private';
  metadata: CanonMetadata;
}

export interface CanonRecord extends CanonSource {
  stage: number;
  status: string;
}

export interface CanonClaim {
  id: string;
  sourceId: string;
  sourcePriority: number;
  status: CanonClaimStatus;
  revealStage: number;
  text: string;
}

export interface CanonSourcePriority {
  id: string;
  priority: number;
}

export interface NarrativeCanonSnapshot {
  schemaVersion: 2;
  sourcePriority: CanonSourcePriority[];
  currentRelationshipStage: number | null;
  profiles: CanonSource[];
  documents: CanonSource[];
  records: CanonRecord[];
  world: unknown[];
  claims: CanonClaim[];
}

const SOURCE_PRIORITY = { rootCharacterProfile: 1, profilesAndDocuments: 2, recordsAndWorld: 3, references: 4, requestOnly: 5 } as const;
const sourcePriority: CanonSourcePriority[] = [
  { id: 'root-character-profile', priority: SOURCE_PRIORITY.rootCharacterProfile },
  { id: 'profiles-and-documents', priority: SOURCE_PRIORITY.profilesAndDocuments },
  { id: 'records-and-world', priority: SOURCE_PRIORITY.recordsAndWorld },
  { id: 'story-references', priority: SOURCE_PRIORITY.references },
  { id: 'request-only', priority: SOURCE_PRIORITY.requestOnly },
];
const frontmatterPattern = /^---\r?\n([\s\S]*?)\r?\n---(?=\r?\n|$)/;

function asMetadata(value: unknown, path: string): CanonMetadata {
  if (value === null || Array.isArray(value) || typeof value !== 'object') throw new Error(`Expected YAML frontmatter object in ${path}`);
  return value as CanonMetadata;
}

function sourceId(metadata: CanonMetadata, path: string): string {
  if (typeof metadata.id !== 'string' || metadata.id.length === 0) throw new Error(`Markdown frontmatter must include an id: ${path}`);
  return metadata.id;
}

function normalise(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalise);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, normalise(nested)]));
  }
  return value;
}

function parseFrontmatter(source: string, path: string): CanonMetadata {
  const match = source.match(frontmatterPattern);
  if (!match) throw new Error(`Markdown source must start with YAML frontmatter: ${path}`);
  return normalise(asMetadata(parseYaml(match[1]), path)) as CanonMetadata;
}

async function markdownFiles(directory: string): Promise<string[]> {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    const paths = await Promise.all(entries.map(async (entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return markdownFiles(path);
      return entry.isFile() && entry.name.endsWith('.md') ? [path] : [];
    }));
    return paths.flat().sort((left, right) => left.localeCompare(right));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

function visibilityFor(path: string): 'public' | 'private' {
  return path.split(/[\\/]/).includes('_hidden') ? 'private' : 'public';
}

async function exportSources(root: string, directory: string): Promise<CanonSource[]> {
  const files = await markdownFiles(join(root, directory));
  return Promise.all(files.map(async (path) => {
    const metadata = parseFrontmatter(await readFile(path, 'utf8'), path);
    return { id: sourceId(metadata, path), path: relative(root, path).replace(/\\/g, '/'), visibility: visibilityFor(path), metadata };
  }));
}

function asStage(metadata: CanonMetadata): number {
  if (typeof metadata.stage !== 'number' || !Number.isFinite(metadata.stage)) throw new Error('Record frontmatter must include a numeric stage');
  return metadata.stage;
}

function asStatus(metadata: CanonMetadata): string {
  return typeof metadata.status === 'string' ? metadata.status : '';
}

function boundedStage(value: number): number { return Math.max(0, Math.min(8, value)); }

function explicitStage(text: string): number | undefined {
  const match = /\bstage\s*(\d+)\b|(\d+)\s*단계/i.exec(text);
  const value = match?.[1] ?? match?.[2];
  return value === undefined ? undefined : boundedStage(Number(value));
}

function stageFromText(text: string, fallback: number): number {
  return explicitStage(text) ?? fallback;
}

function explicitStatus(text: string): CanonClaimStatus | undefined {
  if (/충돌|conflict/i.test(text)) return 'conflicting';
  if (/추가 결정|미해결|미확정|미정|미회수|잠김|unresolved/i.test(text)) return 'unresolved';
  if (/request-only|요청 전용|요청|질문|후보|candidate/i.test(text)) return 'request-only';
  if (/(?:^|\s)확정|\bconfirmed\b/i.test(text)) return 'confirmed';
  return undefined;
}

function markdownClaims(source: string, sourceIdValue: string, sourcePriorityValue: number, fallbackStatus: CanonClaimStatus, fallbackStage: number): CanonClaim[] {
  const scopes: Array<{ depth: number; status: CanonClaimStatus; revealStage: number }> = [{
    depth: 0,
    status: fallbackStatus,
    revealStage: fallbackStage,
  }];
  const claims: CanonClaim[] = [];
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    const heading = /^(#+)\s+(.+)$/.exec(line);
    if (heading) {
      const depth = heading[1].length;
      while (scopes[scopes.length - 1].depth >= depth) scopes.pop();
      const parent = scopes[scopes.length - 1];
      scopes.push({
        depth,
        status: explicitStatus(heading[2]) ?? parent.status,
        revealStage: explicitStage(heading[2]) ?? parent.revealStage,
      });
      continue;
    }
    const bullet = /^(?:[-*]|\d+[.)])\s+(.+)$/.exec(line);
    const table = line.startsWith('|') && !/^\|?\s*:?-{3,}/.test(line) ? line.split('|').map((cell) => cell.trim()).filter(Boolean).join(': ') : undefined;
    const text = bullet?.[1] ?? table;
    if (!text) continue;
    const scope = scopes[scopes.length - 1];
    claims.push({
      id: `${sourceIdValue}:${claims.length + 1}`,
      sourceId: sourceIdValue,
      sourcePriority: sourcePriorityValue,
      status: explicitStatus(text) ?? scope.status,
      revealStage: stageFromText(text, scope.revealStage),
      text,
    });
  }
  return claims;
}

function metadataClaim(source: CanonSource, sourceIdValue: string, sourcePriorityValue: number, status: CanonClaimStatus, revealStage: number): CanonClaim {
  return { id: `${sourceIdValue}:1`, sourceId: sourceIdValue, sourcePriority: sourcePriorityValue, status, revealStage, text: JSON.stringify(source.metadata) };
}

function filteredWorld(worldSource: string, currentStage: number): unknown[] {
  const parsed = parseYaml(worldSource);
  if (!Array.isArray(parsed)) throw new Error('world.yaml must contain a YAML list');
  return parsed
    .filter((document) => {
      if (typeof document !== 'object' || document === null) return false;
      const basisStage = (document as CanonMetadata).basisStage;
      return typeof basisStage !== 'number' || basisStage <= currentStage;
    })
    .map((document) => {
      const value = document as CanonMetadata;
      const sections = Array.isArray(value.sections)
        ? value.sections.filter((section) => {
          if (typeof section !== 'object' || section === null) return false;
          const revealStage = (section as CanonMetadata).revealStage;
          return typeof revealStage !== 'number' || revealStage <= currentStage;
        })
        : [];
      return normalise({ ...value, sections });
    });
}

function worldClaims(world: unknown[], currentStage: number): CanonClaim[] {
  const claims: CanonClaim[] = [];
  for (const document of world) {
    if (document === null || typeof document !== 'object') continue;
    const value = document as CanonMetadata;
    const id = typeof value.id === 'string' ? value.id : `world-${claims.length + 1}`;
    const status: CanonClaimStatus = value.status === 'locked' ? 'unresolved' : 'confirmed';
    for (const section of Array.isArray(value.sections) ? value.sections : []) {
      if (section === null || typeof section !== 'object') continue;
      const sectionValue = section as CanonMetadata;
      const revealStage = typeof sectionValue.revealStage === 'number' ? sectionValue.revealStage : currentStage;
      for (const paragraph of Array.isArray(sectionValue.paragraphs) ? sectionValue.paragraphs : []) {
        if (typeof paragraph !== 'string') continue;
        claims.push({ id: `world:${id}:${claims.length + 1}`, sourceId: `world:${id}`, sourcePriority: SOURCE_PRIORITY.recordsAndWorld, status, revealStage, text: paragraph });
      }
    }
  }
  return claims;
}

export async function exportNarrativeCanon(root: string): Promise<NarrativeCanonSnapshot> {
  const [rootProfileSource, profiles, documents, rawRecords, worldSource, revealPlanSource, unresolvedSource, continuitySource] = await Promise.all([
    readFile(join(root, '천무_캐릭터_프로필.md'), 'utf8'), exportSources(root, 'src/content/profiles'), exportSources(root, 'src/content/documents'), exportSources(root, 'src/content/records'),
    readFile(join(root, 'src/content/world.yaml'), 'utf8'), readFile(join(root, '.agents/skills/cheonmu-story-writer/references/reveal-plan.md'), 'utf8'), readFile(join(root, '.agents/skills/cheonmu-story-writer/references/unresolved-canon.md'), 'utf8'), readFile(join(root, '.agents/skills/cheonmu-story-writer/references/continuity-ledger.md'), 'utf8'),
  ]);
  const records = rawRecords.map((record) => ({ ...record, stage: asStage(record.metadata), status: asStatus(record.metadata) }));
  const confirmedStages = records.filter((record) => record.visibility === 'public' && record.status === 'confirmed').map((record) => record.stage);
  const currentRelationshipStage = confirmedStages.length === 0 ? null : Math.max(...confirmedStages);
  const stage = currentRelationshipStage ?? 0;
  const world = filteredWorld(worldSource, stage);
  const claims = [
    ...markdownClaims(rootProfileSource, 'root-character-profile', SOURCE_PRIORITY.rootCharacterProfile, 'confirmed', stage),
    ...profiles.map((profile) => metadataClaim(profile, `profile:${profile.id}`, SOURCE_PRIORITY.profilesAndDocuments, 'confirmed', stage)),
    ...documents.map((document) => metadataClaim(document, `document:${document.id}`, SOURCE_PRIORITY.profilesAndDocuments, 'confirmed', stage)),
    ...records.map((record) => metadataClaim(record, `record:${record.id}`, SOURCE_PRIORITY.recordsAndWorld, record.status === 'confirmed' ? 'confirmed' : 'unresolved', record.stage)),
    ...worldClaims(world, stage),
    ...markdownClaims(revealPlanSource, 'reveal-plan', SOURCE_PRIORITY.references, 'unresolved', stage),
    ...markdownClaims(unresolvedSource, 'unresolved-canon', SOURCE_PRIORITY.references, 'unresolved', stage),
    ...markdownClaims(continuitySource, 'continuity-ledger', SOURCE_PRIORITY.references, 'confirmed', stage),
  ];
  return { schemaVersion: 2, sourcePriority, currentRelationshipStage, profiles, documents, records, world, claims };
}

export async function writeNarrativeCanonSnapshot(root: string, outputPath: string): Promise<NarrativeCanonSnapshot> {
  const snapshot = await exportNarrativeCanon(root);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
  return snapshot;
}

const thisFile = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === resolve(thisFile)) {
  const projectRoot = resolve(dirname(thisFile), '..');
  await writeNarrativeCanonSnapshot(projectRoot, join(projectRoot, 'supabase/seed/canon-snapshot.json'));
}
