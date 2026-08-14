// @vitest-environment node

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { exportNarrativeCanon } from './export-narrative-canon';

const fixtureRoots: string[] = [];

async function writeFixture(root: string, relativePath: string, source: string): Promise<void> {
  const path = join(root, relativePath);
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, source, 'utf8');
}

async function createFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'cheonmu-canon-'));
  fixtureRoots.push(root);

  await Promise.all([
    writeFixture(root, 'src/content/profiles/cheonryeong.md', '---\nid: cheonryeong\ntitle: 천령\n---\npublicBody'),
    writeFixture(root, 'src/content/profiles/_hidden/cheonryeong-full.md', '---\nid: cheonryeong\ntitle: 천령\n---\nprivateBody'),
    writeFixture(root, 'src/content/documents/relationship.md', '---\nid: relationship\ntitle: 관계\n---\npublicBody'),
    writeFixture(root, 'src/content/documents/_hidden/settings.md', '---\nid: settings\ntitle: 설정\n---\nprivateBody'),
    writeFixture(root, 'src/content/records/07-witnessing.md', [
      '---', 'id: witnessing', 'recordNumber: CM-07', 'title: 목격', 'stage: 7', 'status: confirmed',
      'characters: [cheonryeong, muyeong]', 'tags: [목격]', 'related: []', 'quote: 확인됨', 'cinematic: false', '---', 'publicBody',
    ].join('\n')),
    writeFixture(root, 'src/content/records/08-unapproved.md', [
      '---', 'id: unapproved', 'recordNumber: CM-08', 'title: 미승인', 'stage: 8', 'status: draft',
      'characters: [cheonryeong]', 'tags: []', 'related: []', 'quote: 미승인', 'cinematic: false', '---', 'privateBody',
    ].join('\n')),
    writeFixture(root, 'src/content/world.yaml', '- id: field-log\n  documentNumber: WF-01\n  title: 현장 기록\n  categories: [observation]\n  status: public\n  clearance: public\n  basisStage: 1\n  summary: 관측 사실\n  explanation: 구조화된 세계관\n  sections:\n    - revealStage: 1\n      paragraphs: [공개 사실]\n  relatedRecords: [witnessing]\n'),
    writeFixture(root, '.agents/skills/cheonmu-story-writer/references/reveal-plan.md', '# Reveal\n\n- gate: witness\n'),
    writeFixture(root, '.agents/skills/cheonmu-story-writer/references/unresolved-canon.md', '# Unresolved\n\n- origin\n'),
    writeFixture(root, '.agents/skills/cheonmu-story-writer/references/continuity-ledger.md', '# Continuity\n\n- CM-07\n'),
  ]);

  return root;
}

afterEach(async () => {
  await Promise.all(fixtureRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('exportNarrativeCanon', () => {
  it('derives relationship stage 7 from the latest confirmed public record in this canon', async () => {
    const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

    const snapshot = await exportNarrativeCanon(projectRoot);

    expect(snapshot.currentRelationshipStage).toBe(7);
  });

  it('derives the latest confirmed relationship stage and excludes hidden prose bodies', async () => {
    const fixtureRoot = await createFixture();

    const snapshot = await exportNarrativeCanon(fixtureRoot);

    expect(snapshot.currentRelationshipStage).toBe(7);
    expect(JSON.stringify(snapshot)).not.toContain('privateBody');
    expect(snapshot.records.map((record) => record.id)).toEqual(['witnessing', 'unapproved']);
    expect(snapshot.references.map((reference) => reference.id)).toEqual([
      'reveal-plan',
      'unresolved-canon',
      'continuity-ledger',
    ]);
  });

  it('returns byte-identical data when the same canon is exported twice', async () => {
    const fixtureRoot = await createFixture();

    const first = JSON.stringify(await exportNarrativeCanon(fixtureRoot));
    const second = JSON.stringify(await exportNarrativeCanon(fixtureRoot));

    expect(second).toBe(first);
  });
});
