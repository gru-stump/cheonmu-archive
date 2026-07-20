// @vitest-environment node

import { mkdtemp, mkdir, readFile, readdir, rm, symlink, unlink as unlinkFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { parse as parseYaml, stringify } from 'yaml';
import { afterEach, describe, expect, it } from 'vitest';
import { createEditorServer } from './server';
import { createGalleryStorage, GalleryStorageError } from './gallery-storage';

const temporaryRoots: string[] = [];
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');

function jpeg(width: number, height: number): Buffer {
  return Buffer.from([
    0xff, 0xd8,
    0xff, 0xc0, 0x00, 0x11, 0x08,
    (height >> 8) & 0xff, height & 0xff,
    (width >> 8) & 0xff, width & 0xff,
    0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00,
    0xff, 0xd9,
  ]);
}

function webp(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(30);
  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(22, 4);
  buffer.write('WEBP', 8, 'ascii');
  buffer.write('VP8X', 12, 'ascii');
  buffer.writeUInt32LE(10, 16);
  buffer.writeUIntLE(width - 1, 24, 3);
  buffer.writeUIntLE(height - 1, 27, 3);
  return buffer;
}

async function makeRoot(source = '[]\n'): Promise<string> {
  const rootDir = await mkdtemp(join(tmpdir(), 'cheonmu-gallery-'));
  temporaryRoots.push(rootDir);
  await mkdir(join(rootDir, 'src', 'content'), { recursive: true });
  await mkdir(join(rootDir, 'public', 'images'), { recursive: true });
  await writeFile(join(rootDir, 'src', 'content', 'gallery.yaml'), source, 'utf8');
  return rootDir;
}

const item = {
  id: 'new-work',
  title: 'New work',
  image: '/images/new-work.png',
  alt: 'A complete alternative description',
  creator: 'Archive artist',
  source: 'https://example.com/work',
  characters: ['cheonryeong'],
  tags: ['portrait'],
  public: true,
};

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((rootDir) => rm(rootDir, { recursive: true, force: true })));
});

describe('gallery image storage', () => {
  it('rejects executable uploads renamed as images', async () => {
    const storage = createGalleryStorage({ rootDir: await makeRoot() });

    await expect(storage.registerImage({
      id: 'not-an-image',
      originalName: 'not-an-image.png',
      bytes: Buffer.from('MZ executable content'),
      overwrite: false,
    })).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      message: '지원하지 않는 이미지 파일입니다.',
    });
  });

  it.each([
    ['misleading.exe', png, '/images/work.png', 1, 1],
    ['misleading.png', jpeg(9, 7), '/images/work.jpg', 9, 7],
    ['misleading.jpg', webp(11, 13), '/images/work.webp', 11, 13],
  ])('uses the actual %s signature and dimensions', async (originalName, bytes, path, width, height) => {
    const rootDir = await makeRoot();
    const storage = createGalleryStorage({ rootDir });

    await expect(storage.registerImage({ id: 'work', originalName, bytes, overwrite: false }))
      .resolves.toEqual({ path, width, height });
    await expect(readFile(join(rootDir, 'src', 'content', 'staged-images', path.slice('/images/'.length))))
      .resolves.toEqual(bytes);
    await expect(readFile(join(rootDir, 'public', path.slice(1))))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('requires confirmation before replacement and recovers the old image in trash', async () => {
    const rootDir = await makeRoot();
    const storage = createGalleryStorage({ rootDir });
    await storage.registerImage({ id: 'work', originalName: 'first.png', bytes: png, overwrite: false });
    const replacement = jpeg(4, 5);

    await expect(storage.registerImage({ id: 'work', originalName: 'replacement.jpg', bytes: replacement, overwrite: false }))
      .rejects.toMatchObject({ code: 'CONFLICT' });
    await storage.registerImage({ id: 'work', originalName: 'replacement.jpg', bytes: replacement, overwrite: true });

    await expect(readFile(join(rootDir, 'src', 'content', 'staged-images', 'work.jpg'))).resolves.toEqual(replacement);
    await expect(readFile(join(rootDir, 'src', 'content', 'staged-images', 'work.png')))
      .rejects.toMatchObject({ code: 'ENOENT' });
    const trashed = await readdir(join(rootDir, '.trash', 'images'));
    expect(trashed.some((name) => name.endsWith('-work.png'))).toBe(true);
  });

  it('stages a private legacy metadata replacement without exposing or removing active bytes', async () => {
    const legacyItem = { ...item, image: '/images/legacy-portrait.png', public: false };
    const rootDir = await makeRoot(stringify([legacyItem]));
    await mkdir(join(rootDir, 'src', 'content', 'private-images'), { recursive: true });
    await writeFile(join(rootDir, 'src', 'content', 'private-images', 'legacy-portrait.png'), png);
    const storage = createGalleryStorage({ rootDir });

    await storage.registerImage({
      id: item.id,
      originalName: 'replacement.jpg',
      bytes: jpeg(4, 5),
      overwrite: true,
    });

    await expect(readFile(join(rootDir, 'src', 'content', 'private-images', 'legacy-portrait.png')))
      .resolves.toEqual(png);
    await expect(readFile(join(rootDir, 'public', 'images', 'new-work.jpg')))
      .rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(join(rootDir, 'src', 'content', 'staged-images', 'new-work.jpg')))
      .resolves.toEqual(jpeg(4, 5));
  });

  it('rejects unsafe IDs before resolving an image path', async () => {
    const storage = createGalleryStorage({ rootDir: await makeRoot() });
    await expect(storage.registerImage({ id: '../escape', originalName: 'work.png', bytes: png, overwrite: false }))
      .rejects.toBeInstanceOf(GalleryStorageError);
  });

  it('rejects a junction-backed public image directory', async (context) => {
    const rootDir = await makeRoot();
    const outside = await mkdtemp(join(tmpdir(), 'cheonmu-gallery-outside-'));
    temporaryRoots.push(outside);
    const images = join(rootDir, 'public', 'images');
    await rm(images, { recursive: true });
    try {
      await symlink(outside, images, 'junction');
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'EPERM') {
        context.skip();
        return;
      }
      throw error;
    }

    const storage = createGalleryStorage({ rootDir });
    await expect(storage.registerImage({ id: 'work', originalName: 'work.png', bytes: png, overwrite: false }))
      .rejects.toMatchObject({ code: 'INVALID_PATH' });
  });
});

describe('gallery metadata storage', () => {
  it('commits private image and metadata together outside public build inputs', async () => {
    const rootDir = await makeRoot();
    const storage = createGalleryStorage({ rootDir });
    const privateItem = { ...item, public: false };

    const result = await storage.writeItemWithImage(privateItem, png, false);

    expect(result.item).toEqual(privateItem);
    expect(result.image).toEqual({ path: item.image, width: 1, height: 1 });
    await expect(readFile(join(rootDir, 'src', 'content', 'private-images', 'new-work.png')))
      .resolves.toEqual(png);
    await expect(readFile(join(rootDir, 'public', 'images', 'new-work.png')))
      .rejects.toMatchObject({ code: 'ENOENT' });
    await expect(storage.listItems()).resolves.toEqual([privateItem]);
  });

  it('rolls back the image when the combined metadata commit fails', async () => {
    const originalItem = { ...item, id: 'other-work', image: '/images/new-work.png' };
    const originalSource = `${stringify([originalItem])}`;
    const rootDir = await makeRoot(originalSource);
    const imagePath = join(rootDir, 'public', 'images', 'new-work.png');
    await writeFile(imagePath, png);
    const replacement = Buffer.from(png);
    replacement[replacement.length - 1] ^= 0x01;
    const storage = createGalleryStorage({ rootDir });

    await expect(storage.writeItemWithImage(item, replacement, true))
      .rejects.toMatchObject({ code: 'VALIDATION_ERROR' });

    await expect(readFile(imagePath)).resolves.toEqual(png);
    await expect(readFile(join(rootDir, 'src', 'content', 'gallery.yaml'), 'utf8'))
      .resolves.toBe(originalSource);
    await expect(storage.listItems()).resolves.toEqual([originalItem]);
  });

  it('trashes the exact legacy metadata image during combined replacement', async () => {
    const legacyItem = { ...item, image: '/images/legacy-portrait.png' };
    const rootDir = await makeRoot(stringify([legacyItem]));
    await writeFile(join(rootDir, 'public', 'images', 'legacy-portrait.png'), png);
    const storage = createGalleryStorage({ rootDir });

    await storage.writeItemWithImage({ ...legacyItem, public: false }, jpeg(4, 5), true);

    await expect(readFile(join(rootDir, 'public', 'images', 'legacy-portrait.png')))
      .rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(join(rootDir, 'src', 'content', 'private-images', 'new-work.jpg')))
      .resolves.toEqual(jpeg(4, 5));
    await expect(storage.listItems()).resolves.toEqual([{
      ...legacyItem,
      image: '/images/new-work.jpg',
      public: false,
    }]);
  });

  it('moves an image between private and public roots when visibility changes', async () => {
    const rootDir = await makeRoot();
    const storage = createGalleryStorage({ rootDir });
    const privateItem = { ...item, public: false };
    await storage.writeItemWithImage(privateItem, png, false);

    await storage.writeItem({ ...privateItem, public: true });

    await expect(readFile(join(rootDir, 'public', 'images', 'new-work.png'))).resolves.toEqual(png);
    await expect(readFile(join(rootDir, 'src', 'content', 'private-images', 'new-work.png')))
      .rejects.toMatchObject({ code: 'ENOENT' });
    await expect(storage.listItems()).resolves.toEqual([{ ...privateItem, public: true }]);
  });

  it('removes legacy public bytes when a metadata-only update unpublishes the item', async () => {
    const legacyItem = { ...item, image: '/images/legacy-portrait.png' };
    const rootDir = await makeRoot(stringify([legacyItem]));
    await writeFile(join(rootDir, 'public', 'images', 'legacy-portrait.png'), png);
    const storage = createGalleryStorage({ rootDir });

    await storage.writeItem({ ...legacyItem, public: false });

    await expect(readFile(join(rootDir, 'public', 'images', 'legacy-portrait.png')))
      .rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(join(rootDir, 'src', 'content', 'private-images', 'legacy-portrait.png')))
      .resolves.toEqual(png);
    await expect(storage.listItems()).resolves.toEqual([{ ...legacyItem, public: false }]);
  });

  it('rolls back every side effect when source unlink fails during private-to-public migration', async () => {
    const rootDir = await makeRoot();
    const privateItem = { ...item, public: false };
    await createGalleryStorage({ rootDir }).writeItemWithImage(privateItem, png, false);
    const privateSource = join(rootDir, 'src', 'content', 'private-images', 'new-work.png');
    const metadataBefore = await readFile(join(rootDir, 'src', 'content', 'gallery.yaml'), 'utf8');
    let injected = false;
    const storage = createGalleryStorage({
      rootDir,
      filesystem: {
        unlink: async (path) => {
          if (!injected && path === privateSource) {
            injected = true;
            throw Object.assign(new Error('injected unlink failure'), { code: 'EACCES' });
          }
          await unlinkFile(path);
        },
      },
    });

    await expect(storage.writeItem({ ...privateItem, public: true }))
      .rejects.toThrow('injected unlink failure');

    await expect(readFile(join(rootDir, 'public', 'images', 'new-work.png')))
      .rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(privateSource)).resolves.toEqual(png);
    await expect(readFile(join(rootDir, 'src', 'content', 'gallery.yaml'), 'utf8'))
      .resolves.toBe(metadataBefore);
    await expect(storage.listItems()).resolves.toEqual([privateItem]);
  });

  it('restores active and staged bytes when a staged PUT fails, then permits retry', async () => {
    const legacyItem = { ...item, image: '/images/private-legacy.png', public: false };
    const updatedItem = { ...legacyItem, image: '/images/new-work.jpg' };
    const rootDir = await makeRoot(stringify([legacyItem]));
    const privateRoot = join(rootDir, 'src', 'content', 'private-images');
    await mkdir(privateRoot, { recursive: true });
    const oldPath = join(privateRoot, 'private-legacy.png');
    const stagedPath = join(rootDir, 'src', 'content', 'staged-images', 'new-work.jpg');
    const destination = join(privateRoot, 'new-work.jpg');
    const replacement = jpeg(7, 9);
    await writeFile(oldPath, png);
    let injected = false;
    const storage = createGalleryStorage({
      rootDir,
      filesystem: {
        unlink: async (path) => {
          if (!injected && path === stagedPath) {
            injected = true;
            throw Object.assign(new Error('injected staged unlink failure'), { code: 'EACCES' });
          }
          await unlinkFile(path);
        },
      },
    });
    await storage.registerImage({ id: item.id, originalName: 'replacement.jpg', bytes: replacement, overwrite: true });

    await expect(storage.writeItem(updatedItem)).rejects.toThrow('injected staged unlink failure');
    await expect(readFile(oldPath)).resolves.toEqual(png);
    await expect(readFile(stagedPath)).resolves.toEqual(replacement);
    await expect(readFile(destination)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(storage.listItems()).resolves.toEqual([legacyItem]);

    const retryStorage = createGalleryStorage({ rootDir });
    await expect(retryStorage.writeItem(updatedItem)).resolves.toEqual(updatedItem);
    await expect(readFile(destination)).resolves.toEqual(replacement);
    await expect(readFile(stagedPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('recovers a pre-staging interrupted upload from the exact submitted installed path', async () => {
    const legacyItem = { ...item, image: '/images/legacy-portrait.png' };
    const updatedItem = { ...legacyItem, image: '/images/new-work.jpg', public: false };
    const rootDir = await makeRoot(stringify([legacyItem]));
    const installed = join(rootDir, 'public', 'images', 'new-work.jpg');
    await writeFile(installed, jpeg(4, 5));
    const storage = createGalleryStorage({ rootDir });

    await expect(storage.writeItem(updatedItem)).resolves.toEqual(updatedItem);

    await expect(readFile(installed)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(join(rootDir, 'src', 'content', 'private-images', 'new-work.jpg')))
      .resolves.toEqual(jpeg(4, 5));
    await expect(storage.listItems()).resolves.toEqual([updatedItem]);
  });

  it('serializes concurrent updates without losing either item and backs up gallery.yaml', async () => {
    const rootDir = await makeRoot();
    const storage = createGalleryStorage({ rootDir });
    await storage.registerImage({ id: 'new-work', originalName: 'first.png', bytes: png, overwrite: false });
    await storage.registerImage({ id: 'second-work', originalName: 'second.webp', bytes: webp(2, 2), overwrite: false });

    await Promise.all([
      storage.writeItem(item),
      storage.writeItem({ ...item, id: 'second-work', image: '/images/second-work.webp', source: undefined }),
    ]);

    expect((await storage.listItems()).map(({ id }) => id).sort()).toEqual(['new-work', 'second-work']);
    const yaml = parseYaml(await readFile(join(rootDir, 'src', 'content', 'gallery.yaml'), 'utf8')) as unknown[];
    expect(yaml).toHaveLength(2);
    expect(await readdir(join(rootDir, '.trash', 'gallery'))).toHaveLength(2);
  });

  it('requires complete metadata and an HTTPS source URL', async () => {
    const storage = createGalleryStorage({ rootDir: await makeRoot() });

    await expect(storage.writeItem({ ...item, creator: '', alt: '', characters: [], source: 'http://example.com/work' }))
      .rejects.toMatchObject({ code: 'VALIDATION_ERROR', fields: expect.objectContaining({
        creator: expect.any(String),
        alt: expect.any(String),
        characters: expect.any(String),
        source: expect.any(String),
      }) });
  });

  it('recoverably deletes metadata and its registered image', async () => {
    const rootDir = await makeRoot();
    const storage = createGalleryStorage({ rootDir });
    await storage.registerImage({ id: item.id, originalName: 'work.png', bytes: png, overwrite: false });
    await storage.writeItem(item);

    await storage.trashItem(item.id);

    await expect(storage.listItems()).resolves.toEqual([]);
    await expect(readFile(join(rootDir, 'public', 'images', 'new-work.png'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await readdir(join(rootDir, '.trash', 'images'))).some((name) => name.endsWith('-new-work.png'))).toBe(true);
  });

  it('recoverably deletes an image stored in the private root', async () => {
    const rootDir = await makeRoot();
    const storage = createGalleryStorage({ rootDir });
    await storage.writeItemWithImage({ ...item, public: false }, png, false);

    await storage.trashItem(item.id);

    await expect(readFile(join(rootDir, 'src', 'content', 'private-images', 'new-work.png')))
      .rejects.toMatchObject({ code: 'ENOENT' });
    expect((await readdir(join(rootDir, '.trash', 'images')))
      .some((name) => name.endsWith('-new-work.png'))).toBe(true);
  });
});

describe('gallery editor API', () => {
  it('completes POST then PUT for a legacy public item across an extension change', async () => {
    const legacyItem = { ...item, image: '/images/legacy-portrait.png' };
    const rootDir = await makeRoot(stringify([legacyItem]));
    await Promise.all(['records', 'profiles', 'documents'].map((kind) => (
      mkdir(join(rootDir, 'src', 'content', kind), { recursive: true })
    )));
    await writeFile(join(rootDir, 'public', 'images', 'legacy-portrait.png'), png);
    const app = createEditorServer({ rootDir });
    const replacement = jpeg(4, 5);

    const upload = await request(app)
      .post('/api/editor/gallery/image')
      .set('Content-Type', 'application/octet-stream')
      .set('X-Gallery-Id', item.id)
      .set('X-File-Name', 'replacement.jpg')
      .set('X-Confirm-Overwrite', 'true')
      .send(replacement)
      .expect(200, { path: '/images/new-work.jpg', width: 4, height: 5 });

    await expect(readFile(join(rootDir, 'public', 'images', 'legacy-portrait.png'))).resolves.toEqual(png);
    await expect(readFile(join(rootDir, 'public', 'images', 'new-work.jpg')))
      .rejects.toMatchObject({ code: 'ENOENT' });
    const updatedItem = { ...legacyItem, image: upload.body.path };
    await request(app).put(`/api/editor/gallery/${item.id}`).send(updatedItem).expect(200, updatedItem);

    await expect(readFile(join(rootDir, 'public', 'images', 'new-work.jpg'))).resolves.toEqual(replacement);
    await expect(readFile(join(rootDir, 'public', 'images', 'legacy-portrait.png')))
      .rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(join(rootDir, 'src', 'content', 'staged-images', 'new-work.jpg')))
      .rejects.toMatchObject({ code: 'ENOENT' });
    await request(app).get('/api/editor/gallery').expect(200, [updatedItem]);
    expect((await readdir(join(rootDir, '.trash', 'images')))
      .some((name) => name.endsWith('-legacy-portrait.png'))).toBe(true);
  });

  it('keeps a private replacement staged across POST interruption and failed PUT, then retries', async () => {
    const privateItem = { ...item, image: '/images/private-legacy.png', public: false };
    const rootDir = await makeRoot(stringify([privateItem]));
    await Promise.all(['records', 'profiles', 'documents'].map((kind) => (
      mkdir(join(rootDir, 'src', 'content', kind), { recursive: true })
    )));
    await mkdir(join(rootDir, 'src', 'content', 'private-images'), { recursive: true });
    await writeFile(join(rootDir, 'src', 'content', 'private-images', 'private-legacy.png'), png);
    const app = createEditorServer({ rootDir });
    const replacement = jpeg(7, 9);

    const upload = await request(app)
      .post('/api/editor/gallery/image')
      .set('Content-Type', 'application/octet-stream')
      .set('X-Gallery-Id', item.id)
      .set('X-File-Name', 'replacement.jpg')
      .set('X-Confirm-Overwrite', 'true')
      .send(replacement)
      .expect(200, { path: '/images/new-work.jpg', width: 7, height: 9 });

    await expect(readFile(join(rootDir, 'src', 'content', 'private-images', 'private-legacy.png')))
      .resolves.toEqual(png);
    await expect(readFile(join(rootDir, 'public', 'images', 'new-work.jpg')))
      .rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(join(rootDir, 'src', 'content', 'staged-images', 'new-work.jpg')))
      .resolves.toEqual(replacement);
    await request(app).get('/api/editor/gallery').expect(200, [privateItem]);

    const updatedItem = { ...privateItem, image: upload.body.path };
    await request(app).put(`/api/editor/gallery/${item.id}`).send({ ...updatedItem, creator: '' }).expect(422);
    await expect(readFile(join(rootDir, 'src', 'content', 'staged-images', 'new-work.jpg')))
      .resolves.toEqual(replacement);
    await expect(readFile(join(rootDir, 'src', 'content', 'private-images', 'private-legacy.png')))
      .resolves.toEqual(png);

    await request(app).put(`/api/editor/gallery/${item.id}`).send(updatedItem).expect(200, updatedItem);
    await expect(readFile(join(rootDir, 'src', 'content', 'private-images', 'new-work.jpg')))
      .resolves.toEqual(replacement);
    await expect(readFile(join(rootDir, 'public', 'images', 'new-work.jpg')))
      .rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(join(rootDir, 'src', 'content', 'private-images', 'private-legacy.png')))
      .rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(join(rootDir, 'src', 'content', 'staged-images', 'new-work.jpg')))
      .rejects.toMatchObject({ code: 'ENOENT' });
    await request(app).get('/api/editor/gallery').expect(200, [updatedItem]);
    expect((await readdir(join(rootDir, '.trash', 'images')))
      .some((name) => name.endsWith('-private-legacy.png'))).toBe(true);
  });

  it('serves saved private preview bytes with safe loopback editor headers', async () => {
    const rootDir = await makeRoot();
    await Promise.all(['records', 'profiles', 'documents'].map((kind) => (
      mkdir(join(rootDir, 'src', 'content', kind), { recursive: true })
    )));
    const privateItem = { ...item, public: false };
    await createGalleryStorage({ rootDir }).writeItemWithImage(privateItem, png, false);

    const response = await request(createEditorServer({ rootDir }))
      .get(`/api/editor/gallery/${item.id}/image`)
      .expect(200)
      .expect('Content-Type', /image\/png/)
      .expect('Cache-Control', 'no-store')
      .expect('X-Content-Type-Options', 'nosniff');

    expect(response.body).toEqual(png);
  });

  it('does not expose a public item through the private preview route', async () => {
    const rootDir = await makeRoot();
    await Promise.all(['records', 'profiles', 'documents'].map((kind) => (
      mkdir(join(rootDir, 'src', 'content', kind), { recursive: true })
    )));
    await createGalleryStorage({ rootDir }).writeItemWithImage(item, png, false);

    await request(createEditorServer({ rootDir }))
      .get(`/api/editor/gallery/${item.id}/image`)
      .expect(404);
  });

  it('rejects a reparse-backed private preview image', async (context) => {
    const privateItem = { ...item, public: false };
    const rootDir = await makeRoot(stringify([privateItem]));
    await Promise.all(['records', 'profiles', 'documents'].map((kind) => (
      mkdir(join(rootDir, 'src', 'content', kind), { recursive: true })
    )));
    const privateImages = join(rootDir, 'src', 'content', 'private-images');
    await mkdir(privateImages, { recursive: true });
    const outside = join(rootDir, 'outside.png');
    await writeFile(outside, png);
    try {
      await symlink(outside, join(privateImages, 'new-work.png'), 'file');
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'EPERM') {
        context.skip();
        return;
      }
      throw error;
    }

    await request(createEditorServer({ rootDir }))
      .get(`/api/editor/gallery/${item.id}/image`)
      .expect(400, { error: '허용되지 않는 경로입니다.' });
  });

  it('atomically saves uploaded image bytes with gallery metadata', async () => {
    const rootDir = await makeRoot();
    await Promise.all(['records', 'profiles', 'documents'].map((kind) => (
      mkdir(join(rootDir, 'src', 'content', kind), { recursive: true })
    )));
    const privateItem = { ...item, public: false };

    await request(createEditorServer({ rootDir }))
      .put(`/api/editor/gallery/${item.id}/image`)
      .set('Content-Type', 'application/octet-stream')
      .set('X-Gallery-Metadata', encodeURIComponent(JSON.stringify(privateItem)))
      .set('X-Confirm-Overwrite', 'false')
      .send(png)
      .expect(200, {
        item: privateItem,
        image: { path: item.image, width: 1, height: 1 },
      });

    await expect(readFile(join(rootDir, 'src', 'content', 'private-images', 'new-work.png')))
      .resolves.toEqual(png);
  });

  it('reports the 20 MB upload limit accurately', async () => {
    const rootDir = await makeRoot();
    await Promise.all(['records', 'profiles', 'documents'].map((kind) => (
      mkdir(join(rootDir, 'src', 'content', kind), { recursive: true })
    )));

    await request(createEditorServer({ rootDir }))
      .post('/api/editor/gallery/image')
      .set('Content-Type', 'application/octet-stream')
      .set('X-Gallery-Id', 'large-work')
      .set('X-File-Name', 'large-work.png')
      .send(Buffer.alloc((20 * 1024 * 1024) + 1))
      .expect(413, { error: 'Request body exceeds 20 MB.' });
  });

  it('uploads by signature, edits metadata, lists it, and recoverably deletes it', async () => {
    const rootDir = await makeRoot();
    await Promise.all(['records', 'profiles', 'documents'].map((kind) => (
      mkdir(join(rootDir, 'src', 'content', kind), { recursive: true })
    )));
    const app = createEditorServer({ rootDir });

    const rejected = await request(app)
      .post('/api/editor/gallery/image')
      .set('Content-Type', 'application/octet-stream')
      .set('X-Gallery-Id', 'bad-work')
      .set('X-File-Name', 'bad-work.png')
      .send(Buffer.from('MZ executable content'))
      .expect(422);
    expect(rejected.body.error).toBe('지원하지 않는 이미지 파일입니다.');

    await request(app)
      .post('/api/editor/gallery/image')
      .set('Content-Type', 'application/octet-stream')
      .set('X-Gallery-Id', item.id)
      .set('X-File-Name', 'renamed.exe')
      .send(png)
      .expect(200, { path: item.image, width: 1, height: 1 });
    await request(app).put(`/api/editor/gallery/${item.id}`).send(item).expect(200, item);
    await request(app).get('/api/editor/gallery').expect(200, [item]);
    await request(app).delete(`/api/editor/gallery/${item.id}`).expect(200, { id: item.id, trashed: true });
  });
});
