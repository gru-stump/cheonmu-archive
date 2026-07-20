import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseMarkdown } from './frontmatter';
import { loadContentFromSources, validateContent } from './load';
import {
  recordMetaSchema,
  visibleWorldSections,
  type ArchiveContent,
  type WorldDocument,
} from './schema';

describe('content Markdown discovery', () => {
  it('limits the Vite glob boundary to direct children of public content collections', () => {
    const loadSource = readFileSync(resolve('src/content/load.ts'), 'utf8');
    const globCalls = Array.from(loadSource.matchAll(
      /import\.meta\.glob\(\s*(\[[\s\S]*?\]|['"][^'"]+['"])\s*,/g,
    ));

    expect(globCalls).toHaveLength(1);
    expect(Array.from(globCalls[0][1].matchAll(/['"]([^'"]+)['"]/g), (match) => match[1]))
      .toEqual([
        './records/*.md',
        './scenes/*.md',
        './profiles/*.md',
        './documents/*.md',
      ]);
  });
});

describe('parseMarkdown', () => {
  it('parses a confirmed event record', () => {
    const source = `---
id: first-contact
recordNumber: CM-01
title: First contact
stage: 1
status: confirmed
characters: [cheonryeong, muyeong]
tags: [first-contact]
related: []
quote: Is everyone safe?
cinematic: true
---
Body`;

    expect(parseMarkdown(source, recordMetaSchema).data.id).toBe('first-contact');
  });

  it('rejects a record without a status', () => {
    const source = ['---', 'id: broken', 'title: Broken', '---', 'Body'].join('\n');

    expect(() => parseMarkdown(source, recordMetaSchema)).toThrow();
  });

  it('requires the closing delimiter to occupy its own line', () => {
    const source = [
      '---',
      'id: first-contact',
      'recordNumber: CM-01',
      'title: First contact',
      'stage: 1',
      'status: confirmed',
      'characters: [cheonryeong, muyeong]',
      'tags: [first-contact]',
      'related: []',
      'quote: Is everyone safe?',
      'cinematic: true',
      '---not-a-delimiter',
      'Body',
    ].join('\n');

    expect(() => parseMarkdown(source, recordMetaSchema)).toThrow();
  });

  it('preserves the body after the closing delimiter', () => {
    const source = [
      '---',
      'id: first-contact',
      'recordNumber: CM-01',
      'title: First contact',
      'stage: 1',
      'status: confirmed',
      'characters: [cheonryeong, muyeong]',
      'tags: [first-contact]',
      'related: []',
      'quote: Is everyone safe?',
      'cinematic: true',
      '---',
      '',
      'Body',
      '',
    ].join('\n');

    expect(parseMarkdown(source, recordMetaSchema).body).toBe('\n\nBody\n');
  });
});

describe('loadContentFromSources', () => {
  it('loads staged world documents and exposes only released sections', () => {
    const content = loadContentFromSources({}, undefined, true, `
- id: agency
  documentNumber: WF-01
  title: Agency
  categories: [organization]
  status: public
  clearance: public
  basisStage: 1
  summary: Summary
  explanation: Explanation
  sections:
    - revealStage: 1
      paragraphs: [Visible]
    - revealStage: 7
      paragraphs: [Future]
  relatedRecords: []
`);

    expect(content.world[0].sections).toHaveLength(2);
    expect(visibleWorldSections(content.world[0])).toEqual([
      { revealStage: 1, paragraphs: ['Visible'] },
    ]);
  });

  it('keeps a record summary separate from its full cinematic scene', () => {
    const content = loadContentFromSources({
      './records/01-first-contact.md': `---
id: first-contact
recordNumber: CM-01
title: First contact
stage: 1
status: confirmed
characters: [cheonryeong, muyeong]
tags: [first-contact]
related: []
quote: Is everyone safe?
cinematic: true
---
Short summary`,
      './scenes/first-contact.md': '\nFull cinematic prose\n',
    });

    expect(content.records[0]).toMatchObject({
      cinematicBody: 'Full cinematic prose',
    });
    expect(content.records[0].body.trim()).toBe('Short summary');
    expect(content.scenes).toEqual([{ id: 'first-contact', body: 'Full cinematic prose' }]);
  });

  it('ignores scene Markdown nested below the flat scenes directory', () => {
    const content = loadContentFromSources({
      './records/01-nested-scene.md': `---
id: nested-scene
recordNumber: CM-01
title: Nested scene
stage: 1
status: confirmed
characters: [cheonryeong]
tags: [nested]
related: []
quote: Nested.
cinematic: true
---
Summary`,
      './scenes/archive/nested-scene.md': 'Nested cinematic prose',
    });

    expect(content.scenes).toEqual([]);
    expect(content.records[0]).not.toHaveProperty('cinematicBody');
  });
});

describe('validateContent', () => {
  it('rejects duplicate world identifiers and missing record links', () => {
    const worldFixture = (overrides: Partial<WorldDocument> = {}): WorldDocument => ({
      id: 'world-entry', documentNumber: 'WF-99', title: 'World entry',
      categories: ['organization'], status: 'public', clearance: 'Public',
      basisStage: 1, summary: 'Summary', explanation: 'Explanation',
      sections: [], relatedRecords: [], ...overrides,
    });
    const result = validateContent({
      records: [], scenes: [], profiles: [], documents: [], gallery: [],
      world: [
        worldFixture({ id: 'same', documentNumber: 'WF-01', relatedRecords: ['missing'] }),
        worldFixture({ id: 'same', documentNumber: 'WF-01' }),
      ],
    });

    expect(result.errors).toEqual(expect.arrayContaining([
      'Duplicate world document ID: same',
      'Duplicate world document number: WF-01',
      'World document same references missing record ID: missing',
    ]));
  });

  it('reports a scene attached to a non-cinematic record', () => {
    const content = loadContentFromSources({
      './records/01-plain-record.md': `---
id: plain-record
recordNumber: CM-01
title: Plain record
stage: 1
status: confirmed
characters: [cheonryeong]
tags: [plain]
related: []
quote: Plain.
cinematic: false
---
Summary`,
      './scenes/plain-record.md': 'Full cinematic prose',
    });

    expect(validateContent(content).errors).toContain(
      'Scene plain-record is attached to a non-cinematic record.',
    );
  });

  it('reports an orphan scene', () => {
    const content = loadContentFromSources({
      './scenes/missing-record.md': 'Full cinematic prose',
    });

    expect(validateContent(content).errors).toContain('Scene missing-record has no matching record.');
  });

  it('reports an empty scene', () => {
    const content = loadContentFromSources({
      './scenes/empty-scene.md': '  \n\t',
    });

    expect(validateContent(content).errors).toContain('Scene empty-scene is empty.');
  });

  it('reports duplicate IDs when one gallery item is private', () => {
    const content = loadContentFromSources(
      {},
      `- id: shared-work
  title: Public work
  image: /images/public.png
  alt: Public work image
  creator: Creator
  characters: [cheonryeong]
  public: true
- id: shared-work
  title: Private work
  image: /images/private.png
  alt: Private work image
  creator: Creator
  characters: [muyeong]
  public: false`,
    );

    expect(validateContent(content, { publicImagePaths: ['/images/public.png'] }).errors)
      .toContain('Duplicate content ID: shared-work');
  });

  it('reports duplicate IDs, missing relationships, missing public images, invalid stages, and the Muyeong height conflict', () => {
    const content = {
      records: [
        {
          id: 'first-contact',
          recordNumber: 'CM-01',
          title: 'First contact',
          stage: 0,
          status: 'confirmed',
          characters: ['cheonryeong', 'muyeong'],
          tags: ['first-contact'],
          related: ['missing-record'],
          quote: 'Is everyone safe?',
          cinematic: true,
          body: 'Body',
        },
        {
          id: 'first-contact',
          recordNumber: 'CM-02',
          title: 'Reunion',
          stage: 2,
          status: 'draft',
          characters: ['cheonryeong'],
          tags: ['reunion'],
          related: [],
          quote: 'We meet again.',
          cinematic: false,
          body: 'Body',
        },
      ],
      scenes: [],
      profiles: [
        { id: 'muyeong', title: 'Muyeong', height: '185cm', body: '185cm' },
        { id: 'muyeong-profile', title: 'Muyeong supplement', height: '189cm', body: '189cm' },
      ],
      documents: [],
      gallery: [
        {
          id: 'missing-image',
          title: 'Missing image',
          image: '/images/missing.png',
          alt: 'A missing image',
          creator: 'Creator',
          characters: ['cheonryeong'],
          public: true,
        },
      ],
      world: [],
    } as unknown as ArchiveContent;

    const result = validateContent(content, { publicImagePaths: [] });

    expect(result.errors).toEqual(expect.arrayContaining([
      'Duplicate content ID: first-contact',
      'Record first-contact references missing related ID: missing-record',
      'Public gallery image is missing: /images/missing.png',
      'Record first-contact has invalid stage: 0',
      '\uBB34\uC601 \uC2E0\uC7A5\uC774 185cm\uC640 189cm\uB85C \uCDA9\uB3CC\uD569\uB2C8\uB2E4.',
    ]));
  });
});
