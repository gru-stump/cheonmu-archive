import { describe, expect, it } from 'vitest';
import { loadAllContent, validateContent } from './load';

const DRAFT_NOTICE = '> ??湲곕줉? ?쒖궗 ?쒖븞 珥덉븞?낅땲??';

describe('initial Cheonmu archive content', () => {
  it('contains eight ordered relationship stages and four cinematics', () => {
    const content = loadAllContent();

    expect(content.records.map((record) => record.stage)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(content.records.filter((record) => record.cinematic)).toHaveLength(4);
  });

  it('keeps every connective narrative visibly marked as a draft', () => {
    const drafts = loadAllContent().records.filter((record) => record.status === 'draft');

    expect(drafts.length).toBeGreaterThan(0);
    expect(drafts.every((record) => record.body.trimStart().startsWith(DRAFT_NOTICE))).toBe(true);
  });

  it('uses the chosen canonical Muyeong height without a validation conflict', () => {
    const content = loadAllContent();
    const muyeong = content.profiles.find((profile) => profile.id === 'muyeong');

    expect(muyeong?.height).toBe('185cm');
    expect(validateContent(content).errors).not.toContain('무영 신장이 185cm와 189cm로 충돌합니다.');
  });

  it('publishes three credited gallery entries', () => {
    const gallery = loadAllContent().gallery;

    expect(gallery).toHaveLength(3);
    expect(gallery.map((item) => item.image)).toEqual([
      '/images/cheonmu-full.png',
      '/images/cheonmu-pair-template.png',
      '/images/creator-profile.png',
    ]);
    expect(gallery.every((item) => item.creator === '그루 (@gru_stump)')).toBe(true);
    expect(gallery.every((item) => !('source' in item))).toBe(true);
  });
});
