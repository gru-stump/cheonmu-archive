// @vitest-environment node

import { once } from 'node:events';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { createEditorServer, EDITOR_HOST, EDITOR_PORT, startEditorServer } from './server';

const temporaryRoots: string[] = [];

async function makeRoot(): Promise<string> {
  const rootDir = await mkdtemp(join(tmpdir(), 'cheonmu-editor-api-'));
  temporaryRoots.push(rootDir);
  await Promise.all(['records', 'profiles', 'documents'].map((kind) => (
    mkdir(join(rootDir, 'src', 'content', kind), { recursive: true })
  )));
  return rootDir;
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((rootDir) => rm(rootDir, { recursive: true })));
});

describe('editor content API', () => {
  it('rejects untrusted Host and cross-site Origin requests before routing', async () => {
    const app = createEditorServer({ rootDir: await makeRoot() });

    await request(app).get('/api/editor/documents').set('Host', 'evil.example').expect(403);
    await request(app)
      .get('/api/editor/documents')
      .set('Host', 'localhost:4174')
      .set('Origin', 'https://evil.example')
      .set('Sec-Fetch-Site', 'cross-site')
      .expect(403);
  });

  it('accepts the Vite proxy Host with a trusted development Origin', async () => {
    await request(createEditorServer({ rootDir: await makeRoot() }))
      .get('/api/editor/documents')
      .set('Host', '127.0.0.1:4174')
      .set('Origin', 'http://localhost:5173')
      .expect(200);
  });

  it('returns 400 for malformed JSON instead of an internal error', async () => {
    await request(createEditorServer({ rootDir: await makeRoot() }))
      .put('/api/editor/documents/notes')
      .set('Content-Type', 'application/json')
      .send('{broken')
      .expect(400);
  });
  it('binds startup to the configured loopback host and port', async () => {
    const rootDir = await makeRoot();
    const server = startEditorServer({ rootDir });

    try {
      await once(server, 'listening');
      const address = server.address() as AddressInfo;
      expect(address.address).toBe(EDITOR_HOST);
      expect(address.port).toBe(EDITOR_PORT);
      expect(address.address).toBe('127.0.0.1');
    } finally {
      await new Promise<void>((resolveClose, rejectClose) => {
        server.close((error) => error ? rejectClose(error) : resolveClose());
      });
    }
  });

  it('lists entries from an allowed content kind', async () => {
    const rootDir = await makeRoot();
    await writeFile(join(rootDir, 'src', 'content', 'documents', 'settings.md'), 'settings', 'utf8');

    const response = await request(createEditorServer({ rootDir }))
      .get('/api/editor/documents')
      .expect(200);

    expect(response.body).toEqual([{ id: 'settings', source: 'settings' }]);
  });

  it('reads, writes, and recoverably deletes an entry', async () => {
    const rootDir = await makeRoot();
    const source = ['---', 'id: notes', 'title: Notes', '---', '', 'Body'].join('\n');
    const app = createEditorServer({ rootDir });

    await request(app)
      .put('/api/editor/documents/notes')
      .send({ source })
      .expect(200, { id: 'notes', source });
    await request(app)
      .get('/api/editor/documents/notes')
      .expect(200, { id: 'notes', source });
    await request(app)
      .delete('/api/editor/documents/notes')
      .expect(200, { id: 'notes', trashed: true });
  });

  it('returns field-level problem details for invalid Markdown', async () => {
    const rootDir = await makeRoot();
    const source = ['---', 'id: notes', '---', '', 'Body'].join('\n');

    const response = await request(createEditorServer({ rootDir }))
      .put('/api/editor/documents/notes')
      .send({ source })
      .expect(422);

    expect(response.body).toEqual({
      error: 'Content validation failed.',
      fields: { title: expect.any(String) },
    });
  });

  it('rejects request bodies larger than 2 MB', async () => {
    const rootDir = await makeRoot();

    await request(createEditorServer({ rootDir }))
      .put('/api/editor/documents/notes')
      .send({ source: 'x'.repeat((2 * 1024 * 1024) + 1) })
      .expect(413, { error: 'Request body exceeds 2 MB.' });
  });
});
