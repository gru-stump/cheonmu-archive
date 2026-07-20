// @vitest-environment node

import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'vite';
import { afterEach, describe, expect, it } from 'vitest';
import { publicGalleryPlugin } from './public-gallery';
import { createGalleryStorage } from '../editor/gallery-storage';

const roots: string[] = [];
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('public gallery production filtering', () => {
  it('omits private metadata from JS/maps and private image resources from dist', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cheonmu-public-gallery-'));
    roots.push(root);
    await Promise.all([
      mkdir(join(root, 'src', 'content'), { recursive: true }),
      mkdir(join(root, 'public', 'images'), { recursive: true }),
    ]);
    await writeFile(join(root, 'index.html'), '<script type="module" src="/src/main.ts"></script>', 'utf8');
    await writeFile(join(root, 'src', 'main.ts'), "import source from 'virtual:public-gallery'; console.log(source);", 'utf8');
    await writeFile(join(root, 'src', 'content', 'gallery.yaml'), `- id: public-work
  title: PUBLIC_METADATA_MARKER
  image: /images/public-work.png
  alt: Public image
  creator: Artist
  characters: [cheonryeong]
  public: true
- id: private-work
  title: PRIVATE_METADATA_MARKER
  image: /images/private-work.png
  alt: Private image
  creator: Artist
  characters: [muyeong]
  public: false
`, 'utf8');
    await writeFile(join(root, 'public', 'images', 'public-work.png'), 'PUBLIC_IMAGE_BYTES');
    await writeFile(join(root, 'public', 'images', 'private-work.png'), 'PRIVATE_IMAGE_BYTES');

    await build({
      root,
      logLevel: 'silent',
      plugins: [publicGalleryPlugin(root)],
      build: { sourcemap: true, outDir: 'dist' },
    });

    const assets = await readdir(join(root, 'dist', 'assets'));
    const emittedText = (await Promise.all(
      assets.filter((name) => /\.(?:js|map)$/.test(name))
        .map((name) => readFile(join(root, 'dist', 'assets', name), 'utf8')),
    )).join('\n');
    expect(emittedText).toContain('PUBLIC_METADATA_MARKER');
    expect(emittedText).not.toContain('PRIVATE_METADATA_MARKER');
    expect(emittedText).not.toContain('/images/private-work.png');
    await expect(readFile(join(root, 'dist', 'images', 'public-work.png'), 'utf8'))
      .resolves.toBe('PUBLIC_IMAGE_BYTES');
    await expect(readFile(join(root, 'dist', 'images', 'private-work.png'), 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('omits an orphaned legacy public image after replacing a private item', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cheonmu-public-gallery-legacy-'));
    roots.push(root);
    await Promise.all([
      mkdir(join(root, 'src', 'content'), { recursive: true }),
      mkdir(join(root, 'public', 'images'), { recursive: true }),
    ]);
    await writeFile(join(root, 'index.html'), '<script type="module" src="/src/main.ts"></script>', 'utf8');
    await writeFile(join(root, 'src', 'main.ts'), "import source from 'virtual:public-gallery'; console.log(source);", 'utf8');
    const legacyItem = {
      id: 'private-work',
      title: 'Private work',
      image: '/images/legacy-private.png',
      alt: 'Private image',
      creator: 'Artist',
      characters: ['muyeong'],
      public: false,
    };
    await writeFile(join(root, 'src', 'content', 'gallery.yaml'), `- id: private-work
  title: Private work
  image: /images/legacy-private.png
  alt: Private image
  creator: Artist
  characters: [muyeong]
  public: false
`, 'utf8');
    await writeFile(join(root, 'public', 'images', 'legacy-private.png'), png);

    await createGalleryStorage({ rootDir: root }).writeItemWithImage(legacyItem, png, true);
    await build({
      root,
      logLevel: 'silent',
      plugins: [publicGalleryPlugin(root)],
      build: { sourcemap: true, outDir: 'dist' },
    });

    await expect(readFile(join(root, 'dist', 'images', 'legacy-private.png')))
      .rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(join(root, 'dist', 'images', 'private-work.png')))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });
});
