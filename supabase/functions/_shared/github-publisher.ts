export type GitHubPublisherErrorCode =
  | 'github_path_conflict'
  | 'github_conflict'
  | 'github_validation_failed'
  | 'github_credentials_rejected'
  | 'github_timeout'
  | 'github_network_failure'
  | 'github_response_invalid';

export class GitHubPublisherError extends Error {
  constructor(public readonly code: GitHubPublisherErrorCode) {
    super(code);
    this.name = 'GitHubPublisherError';
  }
}

export interface GitHubPublisherConfig {
  owner: string;
  repository: string;
  token: string;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}

export interface CreateFileInput {
  path: string;
  content: string;
  message: string;
  branch: string;
}

export interface CreateFileResult {
  outcome: 'created' | 'reconciled';
  commitSha: string;
}

type ExistingFile = { outcome: 'missing' } | { outcome: 'same'; commitSha: string } | { outcome: 'different' };

const repositoryPart = /^[A-Za-z0-9_.-]+$/;
const commitSha = /^[0-9a-f]{40}$/i;

function invalidConfiguration(): never {
  throw new GitHubPublisherError('github_response_invalid');
}

function utf8Bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

function decodeBase64(value: string): Uint8Array {
  let binary: string;
  try { binary = atob(value.replaceAll(/\s/g, '')); }
  catch { throw new GitHubPublisherError('github_response_invalid'); }
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function json(response: Response): Promise<unknown> {
  try { return await response.json(); }
  catch { throw new GitHubPublisherError('github_response_invalid'); }
}

function mapStatus(status: number): GitHubPublisherError {
  if (status === 401 || status === 403) return new GitHubPublisherError('github_credentials_rejected');
  if (status === 409) return new GitHubPublisherError('github_conflict');
  if (status === 422) return new GitHubPublisherError('github_validation_failed');
  if (status >= 500) return new GitHubPublisherError('github_network_failure');
  return new GitHubPublisherError('github_response_invalid');
}

export class GitHubPublisher {
  private readonly request: typeof globalThis.fetch;
  private readonly timeoutMs: number;
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;

  constructor(config: GitHubPublisherConfig) {
    if (!repositoryPart.test(config.owner) || !repositoryPart.test(config.repository) || !config.token.trim()) invalidConfiguration();
    this.request = config.fetch ?? globalThis.fetch;
    this.timeoutMs = config.timeoutMs ?? 15_000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1) invalidConfiguration();
    this.baseUrl = `https://api.github.com/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repository)}`;
    this.headers = {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${config.token}`,
      'content-type': 'application/json',
      'x-github-api-version': '2022-11-28',
    };
  }

  async createFile(input: CreateFileInput): Promise<CreateFileResult> {
    this.validateInput(input);
    const bytes = utf8Bytes(input.content);
    const existing = await this.inspectPath(input.path, input.branch, bytes);
    if (existing.outcome === 'different') throw new GitHubPublisherError('github_path_conflict');
    if (existing.outcome === 'same') {
      return { outcome: 'reconciled', commitSha: existing.commitSha };
    }

    let response: Response;
    try {
      response = await this.fetchWithTimeout(this.contentUrl(input.path), {
        method: 'PUT', headers: this.headers,
        body: JSON.stringify({ message: input.message, content: encodeBase64(bytes), branch: input.branch }),
      });
      if (response.status !== 201) throw mapStatus(response.status);
    } catch (error) {
      const known = error instanceof GitHubPublisherError ? error : new GitHubPublisherError('github_network_failure');
      if (known.code !== 'github_timeout' && known.code !== 'github_network_failure') throw known;
      return await this.reconcileUncertain(input.path, input.branch, bytes, known);
    }

    const value = await json(response);
    const sha = isRecord(value) && isRecord(value.commit) ? value.commit.sha : undefined;
    if (typeof sha !== 'string' || !commitSha.test(sha)) throw new GitHubPublisherError('github_response_invalid');
    return { outcome: 'created', commitSha: sha };
  }

  private validateInput(input: CreateFileInput): void {
    const parts = input.path.split('/');
    if (!input.path || input.path.startsWith('/') || input.path.includes('\\') || parts.some((part) => !part || part === '.' || part === '..')) invalidConfiguration();
    if (!input.content || !input.message.trim() || /[\r\n\0]/.test(input.message) || !input.branch.trim() || /[\r\n\0]/.test(input.branch)) invalidConfiguration();
  }

  private contentUrl(path: string): string {
    return `${this.baseUrl}/contents/${path.split('/').map(encodeURIComponent).join('/')}`;
  }

  private async inspectPath(path: string, branch: string, expected: Uint8Array): Promise<ExistingFile> {
    const response = await this.fetchWithTimeout(`${this.contentUrl(path)}?ref=${encodeURIComponent(branch)}`, { method: 'GET', headers: this.headers });
    if (response.status === 404) return { outcome: 'missing' };
    if (response.status !== 200) throw mapStatus(response.status);
    const value = await json(response);
    if (!isRecord(value) || value.type !== 'file') {
      throw new GitHubPublisherError('github_response_invalid');
    }
    const candidate = await this.latestPathCommit(path, branch);
    const committed = await this.fetchWithTimeout(`${this.contentUrl(path)}?ref=${encodeURIComponent(candidate)}`, { method: 'GET', headers: this.headers });
    if (committed.status === 404) return { outcome: 'different' };
    if (committed.status !== 200) throw mapStatus(committed.status);
    const immutableValue = await json(committed);
    if (!isRecord(immutableValue) || immutableValue.type !== 'file' || immutableValue.encoding !== 'base64' || typeof immutableValue.content !== 'string') {
      throw new GitHubPublisherError('github_response_invalid');
    }
    return sameBytes(decodeBase64(immutableValue.content), expected)
      ? { outcome: 'same', commitSha: candidate }
      : { outcome: 'different' };
  }

  private async latestPathCommit(path: string, branch: string): Promise<string> {
    const query = new URLSearchParams({ path, sha: branch, per_page: '1' });
    const response = await this.fetchWithTimeout(`${this.baseUrl}/commits?${query}`, { method: 'GET', headers: this.headers });
    if (response.status !== 200) throw mapStatus(response.status);
    const value = await json(response);
    const sha = Array.isArray(value) && isRecord(value[0]) ? value[0].sha : undefined;
    if (typeof sha !== 'string' || !commitSha.test(sha)) throw new GitHubPublisherError('github_response_invalid');
    return sha;
  }

  private async reconcileUncertain(path: string, branch: string, expected: Uint8Array, original: GitHubPublisherError): Promise<CreateFileResult> {
    try {
      const existing = await this.inspectPath(path, branch, expected);
      if (existing.outcome === 'same') return { outcome: 'reconciled', commitSha: existing.commitSha };
      if (existing.outcome === 'different') throw new GitHubPublisherError('github_path_conflict');
    } catch (error) {
      if (error instanceof GitHubPublisherError && error.code === 'github_path_conflict') throw error;
    }
    throw original;
  }

  private async fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await this.request(url, { ...init, signal: controller.signal });
    } catch {
      throw new GitHubPublisherError(controller.signal.aborted ? 'github_timeout' : 'github_network_failure');
    } finally {
      clearTimeout(timeout);
    }
  }
}
