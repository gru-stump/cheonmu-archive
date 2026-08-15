import { describe, expect, it, vi } from 'vitest';
import { GitHubPublisher, GitHubPublisherError } from './github-publisher';

const createdSha = '1111111111111111111111111111111111111111';
const reconciledSha = '2222222222222222222222222222222222222222';
const content = '비가 그친 뒤\n천령과 무영';

function encoded(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function response(status: number, value: unknown): Response {
  return Response.json(value, { status });
}

function publisher(fetch: typeof globalThis.fetch, timeoutMs = 25): GitHubPublisher {
  return new GitHubPublisher({
    owner: 'cheonmu-owner', repository: 'cheonmu-archive', token: 'fixture-github-token', fetch, timeoutMs,
  });
}

const request = {
  path: 'src/content/records/08-rainy-return.md', content,
  message: 'content: publish narrative rainy-return', branch: 'main',
};

describe('GitHubPublisher.createFile', () => {
  it('creates a missing file with the exact branch, deterministic message, and UTF-8 base64 body', async () => {
    // Removing the preflight, encoding bytes as code points, or changing the create-only payload breaks this boundary.
    const calls: Array<{ url: string; method: string; authorization: string | null; body: unknown }> = [];
    const fetch: typeof globalThis.fetch = vi.fn(async (input, init) => {
      calls.push({
        url: String(input), method: init?.method ?? 'GET',
        authorization: new Headers(init?.headers).get('authorization'),
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      return calls.length === 1 ? response(404, { message: 'Not Found' }) : response(201, { commit: { sha: createdSha } });
    });

    await expect(publisher(fetch).createFile(request)).resolves.toEqual({ outcome: 'created', commitSha: createdSha });
    expect(calls).toEqual([
      {
        url: 'https://api.github.com/repos/cheonmu-owner/cheonmu-archive/contents/src/content/records/08-rainy-return.md?ref=main',
        method: 'GET', authorization: 'Bearer fixture-github-token', body: null,
      },
      {
        url: 'https://api.github.com/repos/cheonmu-owner/cheonmu-archive/contents/src/content/records/08-rainy-return.md',
        method: 'PUT', authorization: 'Bearer fixture-github-token',
        body: { message: request.message, content: encoded(content), branch: 'main' },
      },
    ]);
  });

  it('reconciles exact existing content to its latest path commit without issuing any PUT', async () => {
    // Treating every existing path as a conflict would make response-loss recovery unsafe and non-idempotent.
    const methods: string[] = [];
    const fetch: typeof globalThis.fetch = vi.fn(async (_input, init) => {
      methods.push(init?.method ?? 'GET');
      return methods.length === 1
        ? response(200, { type: 'file', encoding: 'base64', content: encoded(content), sha: 'blob-sha' })
        : response(200, [{ sha: reconciledSha }]);
    });

    await expect(publisher(fetch).createFile(request)).resolves.toEqual({ outcome: 'reconciled', commitSha: reconciledSha });
    expect(methods).toEqual(['GET', 'GET']);
  });

  it('rejects different content at the expected path and never sends an update request', async () => {
    // Adding a sha-bearing update PUT or overwriting a collision must fail this test.
    const fetch = vi.fn<typeof globalThis.fetch>(async () => response(200, {
      type: 'file', encoding: 'base64', content: encoded('different archive content'), sha: 'existing-blob',
    }));

    await expect(publisher(fetch).createFile(request)).rejects.toMatchObject({ code: 'github_path_conflict' });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(false);
  });

  it.each([
    [409, 'github_conflict'],
    [422, 'github_validation_failed'],
  ] as const)('maps create status %s to sanitized %s without attempting an update', async (status, code) => {
    // Passing through provider response text or retrying as an update would expose details or overwrite content.
    const calls: RequestInit[] = [];
    const fetch: typeof globalThis.fetch = vi.fn(async (_input, init) => {
      calls.push(init ?? {});
      return calls.length === 1 ? response(404, { message: 'Not Found' }) : response(status, { message: `raw provider ${status}` });
    });

    const error = await publisher(fetch).createFile(request).catch((value) => value);
    expect(error).toBeInstanceOf(GitHubPublisherError);
    expect(error).toMatchObject({ code });
    expect(JSON.stringify(error)).not.toMatch(/raw provider|fixture-github-token|비가 그친/);
    expect(calls.filter((call) => call.method === 'PUT')).toHaveLength(1);
    expect(JSON.parse(String(calls[1]?.body))).not.toHaveProperty('sha');
  });

  it.each([401, 403] as const)('maps GitHub credential status %s without leaking the credential or response', async (status) => {
    // Returning the authorization header or raw GitHub message would leak server-only material.
    const fetch: typeof globalThis.fetch = vi.fn(async () => response(status, { message: 'fixture-github-token rejected in raw response' }));
    const error = await publisher(fetch).createFile(request).catch((value) => value);

    expect(error).toMatchObject({ code: 'github_credentials_rejected' });
    expect(JSON.stringify(error)).not.toMatch(/fixture-github-token|raw response/);
  });

  it('bounds a timed-out create, performs one read-only reconciliation, and returns a sanitized timeout', async () => {
    // Removing the abort deadline or blindly repeating the uncertain PUT must fail this test.
    let call = 0;
    const methods: string[] = [];
    const fetch: typeof globalThis.fetch = vi.fn(async (_input, init) => {
      call += 1;
      methods.push(init?.method ?? 'GET');
      if (call === 1 || call === 3) return response(404, { message: 'Not Found' });
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('fixture-github-token timeout detail', 'AbortError')), { once: true });
      });
    });

    const error = await publisher(fetch, 5).createFile(request).catch((value) => value);
    expect(error).toMatchObject({ code: 'github_timeout' });
    expect(JSON.stringify(error)).not.toContain('fixture-github-token');
    expect(methods).toEqual(['GET', 'PUT', 'GET']);
  });

  it('sanitizes a network failure after one read-only reconciliation and never logs source or provider details', async () => {
    // Propagating the thrown network message or logging raw Markdown would violate the server-only boundary.
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let call = 0;
    const fetch: typeof globalThis.fetch = vi.fn(async () => {
      call += 1;
      if (call === 1 || call === 3) return response(404, { message: 'Not Found' });
      throw new Error('fixture-github-token provider socket included raw Markdown 비가 그친 뒤');
    });

    const error = await publisher(fetch).createFile(request).catch((value) => value);
    expect(error).toMatchObject({ code: 'github_network_failure' });
    expect(JSON.stringify(error)).not.toMatch(/fixture-github-token|provider socket|비가 그친/);
    expect(log).not.toHaveBeenCalled();
  });

  it.each([
    ['existing content', [response(200, { type: 'file', encoding: 'utf-8', content: 'not-base64' })]],
    ['created commit', [response(404, { message: 'Not Found' }), response(201, { commit: {} })]],
    ['reconciliation commit', [response(200, { type: 'file', encoding: 'base64', content: encoded(content) }), response(200, [{}])]],
  ] as const)('rejects a malformed %s response without exposing it', async (_label, scripted) => {
    // Accepting a response without the complete documented shape could record a blob SHA or undefined commit.
    let index = 0;
    const fetch: typeof globalThis.fetch = vi.fn(async () => scripted[index++] as Response);
    await expect(publisher(fetch).createFile(request)).rejects.toMatchObject({ code: 'github_response_invalid' });
  });

  it('reconciles an uncertain response-loss create when the exact content and path commit become visible', async () => {
    // Retrying the PUT after response loss could duplicate commits; reconciliation must remain read-only.
    let call = 0;
    const methods: string[] = [];
    const fetch: typeof globalThis.fetch = vi.fn(async (_input, init) => {
      call += 1;
      methods.push(init?.method ?? 'GET');
      if (call === 1) return response(404, { message: 'Not Found' });
      if (call === 2) throw new TypeError('connection closed after upstream accepted request');
      if (call === 3) return response(200, { type: 'file', encoding: 'base64', content: encoded(content), sha: 'blob-sha' });
      return response(200, [{ sha: reconciledSha }]);
    });

    await expect(publisher(fetch).createFile(request)).resolves.toEqual({ outcome: 'reconciled', commitSha: reconciledSha });
    expect(methods).toEqual(['GET', 'PUT', 'GET', 'GET']);
  });
});
