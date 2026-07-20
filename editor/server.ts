import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { pathToFileURL } from 'node:url';
import { createGalleryStorage, GalleryStorageError } from './gallery-storage';
import { createEditorStorage, EditorStorageError } from './storage';
import { ArchivePersistenceError } from './archive-persistence';

export const EDITOR_HOST = '127.0.0.1';
export const EDITOR_PORT = 4174;

export interface EditorServerOptions {
  rootDir: string;
}

export function createEditorServer({ rootDir }: EditorServerOptions): Express {
  const app = express();
  const storage = createEditorStorage({ rootDir });
  const gallery = createGalleryStorage({ rootDir });

  app.use((request, response, next) => {
    const host = request.get('Host') ?? '';
    const trustedHost = host === '127.0.0.1:4174' || host === 'localhost:4174';
    const supertestHost = process.env.NODE_ENV === 'test' && /^127\.0\.0\.1:\d+$/.test(host);
    const origin = request.get('Origin');
    const trustedOrigin = origin === undefined
      ? request.get('Sec-Fetch-Site') !== 'cross-site'
      : origin === 'http://127.0.0.1:5173' || origin === 'http://localhost:5173';
    if ((!trustedHost && !supertestHost) || !trustedOrigin) {
      response.status(403).json({ error: 'Editor request origin is not trusted.' });
      return;
    }
    next();
  });

  app.use(express.json({ limit: '2mb' }));

  app.get('/api/editor/gallery', async (_request, response, next) => {
    try {
      response.json(await gallery.listItems());
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/editor/gallery/:id/image', async (request, response, next) => {
    try {
      const image = await gallery.readPrivateImage(request.params.id);
      response.set({
        'Cache-Control': 'no-store',
        'Content-Type': image.contentType,
        'X-Content-Type-Options': 'nosniff',
      });
      response.send(image.bytes);
    } catch (error) {
      next(error);
    }
  });

  app.post(
    '/api/editor/gallery/image',
    express.raw({ type: 'application/octet-stream', limit: '20mb' }),
    async (request, response, next) => {
      try {
        const id = request.get('X-Gallery-Id') ?? '';
        const originalName = request.get('X-File-Name') ?? '';
        if (!Buffer.isBuffer(request.body) || !originalName) {
          throw new GalleryStorageError('Gallery validation failed.', 'VALIDATION_ERROR', { image: 'An image file is required.' });
        }
        response.json(await gallery.registerImage({
          id,
          originalName,
          bytes: request.body,
          overwrite: request.get('X-Confirm-Overwrite') === 'true',
        }));
      } catch (error) {
        next(error);
      }
    },
  );

  app.put(
    '/api/editor/gallery/:id/plan',
    express.raw({ type: 'application/octet-stream', limit: '20mb' }),
    async (request, response, next) => {
      try {
        const metadataHeader = request.get('X-Gallery-Metadata');
        if (!Buffer.isBuffer(request.body) || !metadataHeader) {
          throw new GalleryStorageError('Gallery validation failed.', 'VALIDATION_ERROR', { image: 'Image bytes and gallery metadata are required.' });
        }
        let metadata: { id?: string };
        try {
          metadata = JSON.parse(decodeURIComponent(metadataHeader)) as { id?: string };
        } catch {
          throw new GalleryStorageError('Gallery validation failed.', 'VALIDATION_ERROR', { gallery: 'Gallery metadata must be valid encoded JSON.' });
        }
        if (metadata.id !== request.params.id) {
          throw new GalleryStorageError('Gallery validation failed.', 'VALIDATION_ERROR', { id: 'Gallery ID must match the requested item ID.' });
        }
        response.json(await gallery.planItemWithImage(metadata as Parameters<typeof gallery.planItemWithImage>[0], request.body));
      } catch (error) {
        next(error);
      }
    },
  );

  app.put(
    '/api/editor/gallery/:id/image',
    express.raw({ type: 'application/octet-stream', limit: '20mb' }),
    async (request, response, next) => {
      try {
        const metadataHeader = request.get('X-Gallery-Metadata');
        if (!Buffer.isBuffer(request.body) || !metadataHeader) {
          throw new GalleryStorageError('Gallery validation failed.', 'VALIDATION_ERROR', { image: 'Image bytes and gallery metadata are required.' });
        }
        let metadata: { id?: string };
        try {
          metadata = JSON.parse(decodeURIComponent(metadataHeader)) as { id?: string };
        } catch {
          throw new GalleryStorageError('Gallery validation failed.', 'VALIDATION_ERROR', { gallery: 'Gallery metadata must be valid encoded JSON.' });
        }
        if (metadata.id !== request.params.id) {
          throw new GalleryStorageError('Gallery validation failed.', 'VALIDATION_ERROR', { id: 'Gallery ID must match the requested item ID.' });
        }
        response.json(await gallery.writeItemWithImage(
          metadata as Parameters<typeof gallery.writeItemWithImage>[0],
          request.body,
          request.get('X-Confirm-Overwrite') === 'true',
        ));
      } catch (error) {
        next(error);
      }
    },
  );

  app.put('/api/editor/gallery/:id', async (request, response, next) => {
    try {
      const { id } = request.params;
      if (request.body?.id !== id) {
        throw new GalleryStorageError('Gallery validation failed.', 'VALIDATION_ERROR', { id: 'Gallery ID must match the requested item ID.' });
      }
      response.json(await gallery.writeItem(request.body));
    } catch (error) {
      next(error);
    }
  });

  app.delete('/api/editor/gallery/:id', async (request, response, next) => {
    try {
      const { id } = request.params;
      await gallery.trashItem(id);
      response.json({ id, trashed: true });
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/editor/:kind', async (request, response, next) => {
    try {
      response.json(await storage.listEntries(request.params.kind));
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/editor/:kind/:id', async (request, response, next) => {
    try {
      const { kind, id } = request.params;
      response.json({ id, source: await storage.readEntry(kind, id) });
    } catch (error) {
      next(error);
    }
  });

  app.put('/api/editor/:kind/:id', async (request, response, next) => {
    try {
      const { kind, id } = request.params;
      if (typeof request.body?.source !== 'string') {
        throw new EditorStorageError(
          'Content validation failed.',
          'VALIDATION_ERROR',
          { source: 'Source must be a string.' },
        );
      }
      const source = await storage.writeEntry(kind, id, request.body.source);
      response.json({ id, source });
    } catch (error) {
      next(error);
    }
  });

  app.delete('/api/editor/:kind/:id', async (request, response, next) => {
    try {
      const { kind, id } = request.params;
      await storage.trashEntry(kind, id);
      response.json({ id, trashed: true });
    } catch (error) {
      next(error);
    }
  });

  app.use((error: unknown, request: Request, response: Response, _next: NextFunction) => {
    if (typeof error === 'object' && error !== null && 'status' in error && error.status === 413) {
      const limit = request.path.startsWith('/api/editor/gallery/') && request.path.endsWith('/image') ? 20 : 2;
      response.status(413).json({ error: `Request body exceeds ${limit} MB.` });
      return;
    }

    if (error instanceof EditorStorageError) {
      const status = error.code === 'VALIDATION_ERROR' ? 422 : 400;
      response.status(status).json({ error: error.message, fields: error.fields });
      return;
    }

    if (error instanceof ArchivePersistenceError) {
      response.status(422).json({ error: error.message, fields: error.fields });
      return;
    }

    if (error instanceof GalleryStorageError) {
      const status = error.code === 'VALIDATION_ERROR'
        ? 422
        : error.code === 'CONFLICT'
          ? 409
          : error.code === 'NOT_FOUND'
            ? 404
            : 400;
      response.status(status).json({ error: error.message, fields: error.fields });
      return;
    }

    if (typeof error === 'object' && error !== null && 'status' in error && error.status === 400) {
      response.status(400).json({ error: 'Malformed request body.' });
      return;
    }

    response.status(500).json({ error: 'Internal editor service error.' });
  });

  return app;
}

export function startEditorServer({ rootDir }: EditorServerOptions = { rootDir: process.cwd() }) {
  return createEditorServer({ rootDir }).listen(EDITOR_PORT, EDITOR_HOST, () => {
    console.info(`Editor service listening on http://${EDITOR_HOST}:${EDITOR_PORT}`);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startEditorServer();
}
