import { describe, expect, it } from 'vitest';
import { parseMarkdown } from './frontmatter';
import { loadContentFromSources, validateContent } from './load';
import { recordMetaSchema, type ArchiveContent } from './schema';

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
});

describe('validateContent', () => {
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
