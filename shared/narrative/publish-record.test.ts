import { describe, expect, it } from 'vitest';
import { validateContentSources } from '../../scripts/validate-content';
import { toPublishedRecord } from './publish-record';

const approvedFixture = {
  version: { id: 'version-rainy-return-08', draftId: 'draft-rainy-return', versionNumber: 8, immutable: true },
  approval: { id: 'review-action-rainy-return', draftId: 'draft-rainy-return', versionId: 'version-rainy-return-08', status: 'approved_for_publication' },
  publicationBinding: {
    id: 'publication-rainy-return', draftId: 'draft-rainy-return', approvalId: 'review-action-rainy-return',
    versionId: 'version-rainy-return-08', latestVersionId: 'version-rainy-return-08',
  },
  content: {
    title: '비가 그친 뒤',
    body: '비가 멎은 처마 아래에서, 천령은 무영의 젖은 소매를 조용히 짜 주었다.\n\n무영은 이번에는 물러서지 않았다.',
    canonChangeCandidates: [], unresolvedCallbacks: [], prompt: 'private prompt', rawResponse: 'private response', privateMemory: 'private memory', costMicros: 42,
  },
};

const publicationFixture = {
  id: 'rainy-return', recordNumber: '08', relationshipStage: 7, date: '2026-08-15',
  summary: '비가 그친 뒤, 두 사람은 처마 아래에서 잠시 머문다.',
  characters: ['cheonryeong', 'muyeong'], tags: ['비', '귀환'], related: ['witnessing'], quote: '이번에는 물러서지 않았다.',
  archiveSnapshot: { recordIds: ['witnessing'], recordNumbers: ['CM-07'] },
};

const existingWitnessing = `---
id: witnessing
recordNumber: CM-07
title: Witnessing
stage: 7
status: confirmed
characters: [cheonryeong, muyeong]
tags: [witness]
related: []
quote: Witness
cinematic: false
---
Existing archive record.`;

describe('toPublishedRecord', () => {
  it('renders the bound immutable approved version deterministically with canonical archive numbering', () => {
    // Removing the contract or CM prefix, copying private input, or adding nondeterministic output must fail this test.
    const first = toPublishedRecord(approvedFixture as never, publicationFixture as never);
    const second = toPublishedRecord(approvedFixture as never, publicationFixture as never);

    expect(first.path).toBe('src/content/records/08-rainy-return.md');
    expect(first.source).toBe(second.source);
    expect(first.source).toMatchSnapshot();
    expect(first.source).toContain('recordNumber: "CM-08"');
    expect(first.source).not.toMatch(/prompt|costMicros|rawResponse|privateMemory/i);
  });

  it('allows an empty related list when the mandatory complete archive snapshot is empty', () => {
    const published = toPublishedRecord(approvedFixture as never, {
      ...publicationFixture, id: 'quiet-return', recordNumber: '09', related: [],
      archiveSnapshot: { recordIds: [], recordNumbers: [] },
    } as never);

    expect(published.source).toContain('related: []');
  });

  it('is accepted by the same Markdown parser and archive validator used by the CLI', () => {
    const published = toPublishedRecord(approvedFixture as never, publicationFixture as never);
    const result = validateContentSources({ records: { '07-witnessing.md': existingWitnessing, '08-rainy-return.md': published.source } });

    expect(result.errors).toEqual([]);
  });

  it('rejects impossible calendar dates through the real Markdown schema path', () => {
    expect(() => validateContentSources({ records: {
      'bad-date.md': existingWitnessing.replace('recordNumber: CM-07', 'recordNumber: CM-08').replace('stage: 7', 'date: 2026-02-30\nstage: 7'),
    } })).toThrow();
  });

  it('reports duplicate normalized record numbers through the real archive validator', () => {
    const result = validateContentSources({ records: {
      'first.md': existingWitnessing,
      'second.md': existingWitnessing.replace('id: witnessing', 'id: duplicate-witnessing').replace('recordNumber: CM-07', "recordNumber: '07'"),
    } });

    expect(result.errors).toContain('Duplicate record number: 07');
  });

  it.each([
    ['a missing immutable version ID', { version: { ...approvedFixture.version, id: '' } }, publicationFixture],
    ['a mutable version', { version: { ...approvedFixture.version, immutable: false } }, publicationFixture],
    ['a missing public approval ID', { approval: { ...approvedFixture.approval, id: '' } }, publicationFixture],
    ['a missing publication binding ID', { publicationBinding: { ...approvedFixture.publicationBinding, id: '' } }, publicationFixture],
    ['a non-public approval', { approval: { ...approvedFixture.approval, status: 'approved_private' } }, publicationFixture],
    ['an approval bound to another version', { approval: { ...approvedFixture.approval, versionId: 'version-other' } }, publicationFixture],
    ['a publication job bound to another version', { publicationBinding: { ...approvedFixture.publicationBinding, versionId: 'version-other' } }, publicationFixture],
    ['a stale version that is no longer latest', { publicationBinding: { ...approvedFixture.publicationBinding, latestVersionId: 'version-newer' } }, publicationFixture],
    ['an approval and publication with different actions', { publicationBinding: { ...approvedFixture.publicationBinding, approvalId: 'review-action-other' } }, publicationFixture],
    ['an unresolved canon candidate', { content: { ...approvedFixture.content, canonChangeCandidates: [{ id: 'candidate-1', resolution: 'unresolved' }] } }, publicationFixture],
    ['a missing archive collision snapshot', {}, { ...publicationFixture, archiveSnapshot: undefined }],
    ['a malformed archive snapshot ID', {}, { ...publicationFixture, archiveSnapshot: { recordIds: ['bad\nid'], recordNumbers: ['CM-07'] } }],
    ['duplicate archive snapshot IDs', {}, { ...publicationFixture, archiveSnapshot: { recordIds: ['witnessing', 'witnessing'], recordNumbers: ['CM-07'] } }],
    ['duplicate normalized archive snapshot numbers', {}, { ...publicationFixture, archiveSnapshot: { recordIds: ['witnessing'], recordNumbers: ['CM-07', '07'] } }],
    ['a colliding known record ID', {}, { ...publicationFixture, id: 'witnessing' }],
    ['a colliding normalized record number', {}, { ...publicationFixture, recordNumber: '07' }],
    ['an unsafe record ID', {}, { ...publicationFixture, id: 'rainy-return\nstatus: draft' }],
    ['an unsafe record number', {}, { ...publicationFixture, recordNumber: '../08' }],
    ['unsafe title YAML injection', { content: { ...approvedFixture.content, title: 'Title\nstatus: draft' } }, publicationFixture],
    ['a missing related record', {}, { ...publicationFixture, related: ['missing'] }],
    ['a duplicate related record', {}, { ...publicationFixture, related: ['witnessing', 'witnessing'] }],
    ['unresolved callbacks', { content: { ...approvedFixture.content, unresolvedCallbacks: ['unresolved'] } }, publicationFixture],
  ])('rejects %s before frontmatter rendering', (_reason, versionChange, publication) => {
    expect(() => toPublishedRecord({ ...approvedFixture, ...versionChange } as never, publication as never)).toThrow();
  });

  it('permits resolved canon candidates from the immutable approved version', () => {
    const published = toPublishedRecord({
      ...approvedFixture,
      content: { ...approvedFixture.content, canonChangeCandidates: [{ id: 'candidate-1', resolution: 'resolved' }] },
    } as never, publicationFixture as never);

    expect(published.source).toContain('title: "비가 그친 뒤"');
  });
});
