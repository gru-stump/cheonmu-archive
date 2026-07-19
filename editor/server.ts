import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { pathToFileURL } from 'node:url';
import { createEditorStorage, EditorStorageError } from './storage';

export const EDITOR_HOST = '127.0.0.1';
export const EDITOR_PORT = 4174;

export interface EditorServerOptions {
  rootDir: string;
}

export function createEditorServer({ rootDir }: EditorServerOptions): Express {
  const app = express();
  const storage = createEditorStorage({ rootDir });

  app.use(express.json({ limit: '2mb' }));

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

  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    if (typeof error === 'object' && error !== null && 'status' in error && error.status === 413) {
      response.status(413).json({ error: 'Request body exceeds 2 MB.' });
      return;
    }

    if (error instanceof EditorStorageError) {
      const status = error.code === 'VALIDATION_ERROR' ? 422 : 400;
      response.status(status).json({ error: error.message, fields: error.fields });
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
