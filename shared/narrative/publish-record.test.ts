import { describe, expect, it } from 'vitest';
import { validateContentSources } from '../../scripts/validate-content';
import { toPublishedRecord } from './publish-record';

const approvedFixture = {
  status: 'approved' as const,
  content: {
    title: '비가 그친 뒤',
    body: '비가 멎은 처마 아래에서, 천령은 무영의 젖은 소매를 조용히 짜 주었다.\n\n무영은 이번에는 물러서지 않았다.',
    canonChangeCandidates: [],
    unresolvedCallbacks: [],
    prompt: 'private prompt',
    rawResponse: 'private response',
    privateMemory: 'private memory',
    costMicros: 42,
  },
};

const publicationFixture = {
  id: 'rainy-return',
  recordNumber: '08',
  relationshipStage: 7,
  date: '2026-08-15',
  summary: '비가 그친 뒤, 두 사람은 처마 아래에서 잠시 머문다.',
  characters: ['cheonryeong', 'muyeong'],
  tags: ['비', '귀환'],
  related: ['witnessing'],
  quote: '이번에는 물러서지 않았다.',
  existingRecordIds: ['witnessing'],
  existingRecordNumbers: ['07'],
};

describe('toPublishedRecord', () => {
  it('renders an approved Korean narrative using only the public archive allowlist', () => {
    // A renderer that copies its input, changes a public field, or emits private draft data must fail this test.
    const published = toPublishedRecord(approvedFixture, publicationFixture);

    expect(published.path).toBe('src/content/records/08-rainy-return.md');
    expect(published.source).toMatchSnapshot();
    expect(published.source).not.toMatch(/prompt|costMicros|rawResponse|privateMemory/i);
  });

  it('is accepted by the same Markdown parser and archive validator used by the CLI', () => {
    const published = toPublishedRecord(approvedFixture, publicationFixture);
    const result = validateContentSources({
      records: {
        '07-witnessing.md': `---\nid: witnessing\nrecordNumber: '07'\ntitle: Witnessing\nstage: 7\nstatus: confirmed\ncharacters: [cheonryeong, muyeong]\ntags: [witness]\nrelated: []\nquote: Witness\ncinematic: false\n---\nExisting archive record.`,
        '08-rainy-return.md': published.source,
      },
    });

    expect(result.errors).toEqual([]);
  });

  it.each([
    ['unresolved canon candidates', { canonChangeCandidates: ['new canon'] }, publicationFixture],
    ['unresolved callbacks', { unresolvedCallbacks: ['unknown callback'] }, publicationFixture],
    ['unsafe record ID', {}, { ...publicationFixture, id: 'rainy-return\nstatus: draft' }],
    ['unsafe record number', {}, { ...publicationFixture, recordNumber: '../08' }],
    ['an impossible calendar date', {}, { ...publicationFixture, date: '2026-02-30' }],
    ['unsafe title YAML injection', { title: 'Title\nstatus: draft' }, publicationFixture],
    ['a missing related record', {}, { ...publicationFixture, related: ['missing'] }],
    ['a duplicate related record', {}, { ...publicationFixture, related: ['witnessing', 'witnessing'] }],
    ['a colliding known record ID', {}, { ...publicationFixture, id: 'witnessing' }],
    ['a colliding known record number', {}, { ...publicationFixture, recordNumber: '07' }],
  ])('rejects %s before frontmatter rendering', (_reason, content, publication) => {
    // Removing any corresponding input guard would permit an unsafe or invalid archive record.
    expect(() => toPublishedRecord({ ...approvedFixture, content: { ...approvedFixture.content, ...content } }, publication))
      .toThrow();
  });
});
