import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

type CanonMetadata = Record<string, unknown>;

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

export interface CanonReference {
  id: 'reveal-plan' | 'unresolved-canon' | 'continuity-ledger';
  facts: string[];
}

export interface NarrativeCanonSnapshot {
  schemaVersion: 1;
  currentRelationshipStage: number | null;
  profiles: CanonSource[];
  documents: CanonSource[];
  records: CanonRecord[];
  world: unknown[];
  references: CanonReference[];
}

const frontmatterPattern = /^---\r?\n([\s\S]*?)\r?\n---(?=\r?\n|$)/;

function asMetadata(value: unknown, path: string): CanonMetadata {
  if (value === null || Array.isArray(value) || typeof value !== 'object') {
    throw new Error(`Expected YAML frontmatter object in ${path}`);
  }

  return value as CanonMetadata;
}

function sourceId(metadata: CanonMetadata, path: string): string {
  if (typeof metadata.id !== 'string' || metadata.id.length === 0) {
    throw new Error(`Markdown frontmatter must include an id: ${path}`);
  }
  return metadata.id;
}

function normalise(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalise);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, normalise(nested)]),
    );
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
    return {
      id: sourceId(metadata, path),
      path: relative(root, path).replace(/\\/g, '/'),
      visibility: visibilityFor(path),
      metadata,
    };
  }));
}

function asStage(metadata: CanonMetadata): number {
  const stage = metadata.stage;
  if (typeof stage !== 'number' || !Number.isFinite(stage)) {
    throw new Error('Record frontmatter must include a numeric stage');
  }
  return stage;
}

function asStatus(metadata: CanonMetadata): string {
  return typeof metadata.status === 'string' ? metadata.status : '';
}

async function referenceFacts(path: string): Promise<string[]> {
  const source = await readFile(path, 'utf8');
  return source
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
}

export async function exportNarrativeCanon(root: string): Promise<NarrativeCanonSnapshot> {
  const [profiles, documents, rawRecords, worldSource, revealPlan, unresolvedCanon, continuityLedger] = await Promise.all([
    exportSources(root, 'src/content/profiles'),
    exportSources(root, 'src/content/documents'),
    exportSources(root, 'src/content/records'),
    readFile(join(root, 'src/content/world.yaml'), 'utf8'),
    referenceFacts(join(root, '.agents/skills/cheonmu-story-writer/references/reveal-plan.md')),
    referenceFacts(join(root, '.agents/skills/cheonmu-story-writer/references/unresolved-canon.md')),
    referenceFacts(join(root, '.agents/skills/cheonmu-story-writer/references/continuity-ledger.md')),
  ]);
  const records = rawRecords.map((record) => ({
    ...record,
    stage: asStage(record.metadata),
    status: asStatus(record.metadata),
  }));
  const confirmedStages = records
    .filter((record) => record.visibility === 'public' && record.status === 'confirmed')
    .map((record) => record.stage);

  return {
    schemaVersion: 1,
    currentRelationshipStage: confirmedStages.length === 0 ? null : Math.max(...confirmedStages),
    profiles,
    documents,
    records,
    world: normalise(parseYaml(worldSource)) as unknown[],
    references: [
      { id: 'reveal-plan', facts: revealPlan },
      { id: 'unresolved-canon', facts: unresolvedCanon },
      { id: 'continuity-ledger', facts: continuityLedger },
    ],
  };
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
