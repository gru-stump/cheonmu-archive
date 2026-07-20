import { readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Plugin, ResolvedConfig } from 'vite';
import { parse as parseYaml, stringify } from 'yaml';
import { gallerySchema, type GalleryItem } from '../src/content/schema';

const publicGalleryId = 'virtual:public-gallery';
const resolvedPublicGalleryId = `\0${publicGalleryId}`;

async function galleryItems(rootDir: string): Promise<GalleryItem[]> {
  const source = await readFile(join(rootDir, 'src', 'content', 'gallery.yaml'), 'utf8');
  return gallerySchema.parse(parseYaml(source));
}

export function publicGalleryPlugin(rootDir: string): Plugin {
  let config: ResolvedConfig | undefined;

  return {
    name: 'cheonmu-public-gallery',
    enforce: 'pre',
    configResolved(resolvedConfig) {
      config = resolvedConfig;
    },
    resolveId(id) {
      return id === publicGalleryId ? resolvedPublicGalleryId : null;
    },
    async load(id) {
      if (id !== resolvedPublicGalleryId) return null;
      const source = stringify((await galleryItems(rootDir)).filter((item) => item.public));
      return `export default ${JSON.stringify(source)};`;
    },
    async closeBundle() {
      if (config?.command !== 'build') return;
      const items = await galleryItems(rootDir);
      const publicPaths = new Set(items.filter((item) => item.public).map((item) => item.image.toLowerCase()));
      const privatePaths = items
        .filter((item) => !item.public && !publicPaths.has(item.image.toLowerCase()))
        .map((item) => item.image.replace(/^\//, ''));
      const outDir = resolve(config.root, config.build.outDir);
      await Promise.all(privatePaths.map((path) => rm(join(outDir, path), { force: true })));
    },
  };
}
