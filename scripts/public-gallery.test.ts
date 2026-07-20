// @vitest-environment node

import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'vite';
import { stringify } from 'yaml';
import { afterEach, describe, expect, it } from 'vitest';
import { publicGalleryPlugin } from './public-gallery';
import { createGalleryStorage } from '../editor/gallery-storage';
import { createEditorServer } from '../editor/server';
import request from 'supertest';

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

  it('keeps a staged POST replacement and final private bytes out of build artifacts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cheonmu-public-gallery-staged-'));
    roots.push(root);
    await Promise.all([
      mkdir(join(root, 'src', 'content', 'private-images'), { recursive: true }),
      mkdir(join(root, 'public', 'images'), { recursive: true }),
      ...['records', 'profiles', 'documents'].map((kind) => mkdir(join(root, 'src', 'content', kind), { recursive: true })),
    ]);
    await writeFile(join(root, 'index.html'), '<script type="module" src="/src/main.ts"></script>', 'utf8');
    await writeFile(join(root, 'src', 'main.ts'), "import source from 'virtual:public-gallery'; console.log(source);", 'utf8');
    await writeFile(join(root, 'src', 'content', 'gallery.yaml'), `- id: private-work
  title: Private work
  image: /images/private-legacy.png
  alt: Private image
  creator: Artist
  characters: [muyeong]
  public: false
`, 'utf8');
    await writeFile(join(root, 'src', 'content', 'private-images', 'private-legacy.png'), png);
    const replacement = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x01, 0x00, 0x01, 0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00, 0xff, 0xd9]);
    const app = createEditorServer({ rootDir: root });
    await request(app)
      .post('/api/editor/gallery/image')
      .set('Content-Type', 'application/octet-stream')
      .set('X-Gallery-Id', 'private-work')
      .set('X-File-Name', 'replacement.jpg')
      .set('X-Confirm-Overwrite', 'true')
      .send(replacement)
      .expect(200, { path: '/images/private-work.jpg', width: 1, height: 1 });

    const runBuild = () => build({
      root,
      logLevel: 'silent',
      plugins: [publicGalleryPlugin(root)],
      build: { sourcemap: true, outDir: 'dist' },
    });
    await runBuild();
    await expect(readFile(join(root, 'dist', 'images', 'private-work.jpg')))
      .rejects.toMatchObject({ code: 'ENOENT' });

    const updatedItem = {
      id: 'private-work', title: 'Private work', image: '/images/private-work.jpg', alt: 'Private image',
      creator: 'Artist', characters: ['muyeong'], public: false,
    };
    await request(app).put('/api/editor/gallery/private-work').send(updatedItem).expect(200, updatedItem);
    await runBuild();
    await expect(readFile(join(root, 'dist', 'images', 'private-work.jpg')))
      .rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(join(root, 'public', 'images', 'private-work.jpg')))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('removes a confirmed orphan candidate before the next public build', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cheonmu-public-gallery-orphan-'));
    roots.push(root);
    await Promise.all([
      mkdir(join(root, 'public', 'images'), { recursive: true }),
      ...['records', 'profiles', 'documents'].map((kind) => mkdir(join(root, 'src', 'content', kind), { recursive: true })),
    ]);
    await writeFile(join(root, 'index.html'), '<script type="module" src="/src/main.ts"></script>', 'utf8');
    await writeFile(join(root, 'src', 'main.ts'), "import source from 'virtual:public-gallery'; console.log(source);", 'utf8');
    const legacyItem = {
      id: 'work', title: 'Work', image: '/images/legacy-work.png', alt: 'Work image',
      creator: 'Artist', characters: ['muyeong'], public: true,
    };
    await writeFile(join(root, 'src', 'content', 'gallery.yaml'), stringify([legacyItem]), 'utf8');
    await writeFile(join(root, 'public', 'images', 'legacy-work.png'), png);
    await writeFile(join(root, 'public', 'images', 'work.png'), png);
    const app = createEditorServer({ rootDir: root });
    const replacement = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x01, 0x00, 0x01, 0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00, 0xff, 0xd9]);

    await request(app)
      .post('/api/editor/gallery/image')
      .set('Content-Type', 'application/octet-stream')
      .set('X-Gallery-Id', 'work')
      .set('X-File-Name', 'replacement.jpg')
      .set('X-Confirm-Overwrite', 'true')
      .send(replacement)
      .expect(200, { path: '/images/work.jpg', width: 1, height: 1 });
    const updatedItem = { ...legacyItem, image: '/images/work.jpg' };
    await request(app).put('/api/editor/gallery/work').send(updatedItem).expect(200, updatedItem);
    await build({
      root,
      logLevel: 'silent',
      plugins: [publicGalleryPlugin(root)],
      build: { sourcemap: true, outDir: 'dist' },
    });

    await expect(readFile(join(root, 'dist', 'images', 'work.jpg'))).resolves.toEqual(replacement);
    await expect(readFile(join(root, 'dist', 'images', 'work.png')))
      .rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(join(root, 'dist', 'images', 'legacy-work.png')))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('keeps both public owners intact after a combined save and production build', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cheonmu-public-gallery-combined-owner-'));
    roots.push(root);
    await Promise.all([
      mkdir(join(root, 'public', 'images'), { recursive: true }),
      ...['records', 'profiles', 'documents'].map((kind) => mkdir(join(root, 'src', 'content', kind), { recursive: true })),
    ]);
    await writeFile(join(root, 'index.html'), '<script type="module" src="/src/main.ts"></script>', 'utf8');
    await writeFile(join(root, 'src', 'main.ts'), "import source from 'virtual:public-gallery'; console.log(source);", 'utf8');
    const owner = {
      id: 'other-work', title: 'COMBINED_OWNER_MARKER', image: '/images/work.png', alt: 'Owner image',
      creator: 'Artist', characters: ['muyeong'], public: true,
    };
    const newItem = {
      id: 'work', title: 'COMBINED_NEW_MARKER', image: '/images/ignored.png', alt: 'New image',
      creator: 'Artist', characters: ['muyeong'], public: true,
    };
    await writeFile(join(root, 'src', 'content', 'gallery.yaml'), stringify([owner]), 'utf8');
    await writeFile(join(root, 'public', 'images', 'work.png'), png);
    const replacement = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x01, 0x00, 0x01, 0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00, 0xff, 0xd9]);

    await createGalleryStorage({ rootDir: root }).writeItemWithImage(newItem, replacement, true);
    await build({
      root,
      logLevel: 'silent',
      plugins: [publicGalleryPlugin(root)],
      build: { sourcemap: true, outDir: 'dist' },
    });

    await expect(readFile(join(root, 'dist', 'images', 'work.png'))).resolves.toEqual(png);
    await expect(readFile(join(root, 'dist', 'images', 'work.jpg'))).resolves.toEqual(replacement);
    const emitted = (await Promise.all((await readdir(join(root, 'dist', 'assets')))
      .filter((name) => name.endsWith('.js'))
      .map((name) => readFile(join(root, 'dist', 'assets', name), 'utf8')))).join('\n');
    expect(emitted).toContain('COMBINED_OWNER_MARKER');
    expect(emitted).toContain('COMBINED_NEW_MARKER');
  });
});
