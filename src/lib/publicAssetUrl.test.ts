import { describe, expect, it } from 'vitest';
import { resolvePublicAssetUrl } from './publicAssetUrl';

describe('resolvePublicAssetUrl', () => {
  it('prefixes root-relative content assets with the configured Pages base', () => {
    expect(resolvePublicAssetUrl('/images/Cheonryeong_LD.png', '/cheonmu-archive/'))
      .toBe('/cheonmu-archive/images/Cheonryeong_LD.png');
  });

  it('joins paths without introducing duplicate slashes', () => {
    expect(resolvePublicAssetUrl('images/Muyeong_head.png', '/cheonmu-archive/'))
      .toBe('/cheonmu-archive/images/Muyeong_head.png');
    expect(resolvePublicAssetUrl('/images/Muyeong_head.png', '/'))
      .toBe('/images/Muyeong_head.png');
  });

  it('leaves absolute remote asset URLs unchanged', () => {
    expect(resolvePublicAssetUrl('https://example.com/art.png', '/cheonmu-archive/'))
      .toBe('https://example.com/art.png');
  });
});
