export type WorkflowTrackingStatus = 'pending' | 'queued' | 'in_progress' | 'success' | 'failure' | 'timed_out';
export type PagesTrackingStatus = 'pending' | 'queued' | 'in_progress' | 'success' | 'failure' | 'timed_out';
export type PublicationPhase = 'commit_created' | 'workflow_running' | 'workflow_succeeded' | 'workflow_failed' | 'pages_running' | 'pages_failed' | 'deployed' | 'tracking_timed_out';

export interface PublicationCheckClaim {
  outcome: 'claimed';
  checkToken: string;
  publishJobId: string;
  commitSha: string;
  repository: { owner: string; name: string; branch: string; credential: string };
}

export type PublicationClaimResult = PublicationCheckClaim | { outcome: 'idle' } | { outcome: 'timed_out'; publishJobId: string };

export interface PublicationObservation {
  phase: PublicationPhase;
  workflowStatus: WorkflowTrackingStatus;
  pagesStatus: PagesTrackingStatus;
  terminal: boolean;
  workflowRunId: number | null;
  deploymentId: number | null;
  pagesUrl: string | null;
  failureCode: 'workflow_failed' | 'pages_deployment_failed' | null;
}

export interface PublicationTrackingDependencies {
  claimNext(): Promise<PublicationClaimResult>;
  observe(claim: PublicationCheckClaim): Promise<PublicationObservation>;
  record(input: PublicationObservation & { publishJobId: string; checkToken: string; commitSha: string }): Promise<{ status: 'recorded' }>;
  retryTimedOut(publishJobId: string): Promise<{ status: 'retry_scheduled' }>;
}

export class CheckPublicationError extends Error {
  constructor(public readonly status: number, public readonly code: string) {
    super(code);
    this.name = 'CheckPublicationError';
  }
}

interface GitHubObserverConfig { fetch?: typeof globalThis.fetch; timeoutMs?: number; baseUrl?: string }

const shaPattern = /^[0-9a-f]{40}$/i;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const repositoryPart = /^[A-Za-z0-9_.-]{1,100}$/;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function positiveId(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function safePagesUrl(value: unknown, owner: string, repository: string): string | null {
  if (typeof value !== 'string' || !repositoryPart.test(owner) || !repositoryPart.test(repository)) return null;
  try {
    const url = new URL(value);
    const expectedHost = `${owner.toLowerCase()}.github.io`;
    const userSite = repository.toLowerCase() === expectedHost;
    const expectedPath = userSite ? '/' : `/${repository}/`;
    if (
      url.protocol !== 'https:' || url.hostname !== expectedHost || url.port || url.username || url.password
      || url.search || url.hash || !url.pathname.toLowerCase().startsWith(expectedPath.toLowerCase())
    ) return null;
    return url.href;
  } catch {
    return null;
  }
}

function githubStatus(status: number): CheckPublicationError {
  if (status === 401 || status === 403) return new CheckPublicationError(502, 'github_credentials_rejected');
  if (status >= 500 || status === 429) return new CheckPublicationError(502, 'github_observation_failed');
  return new CheckPublicationError(502, 'github_response_invalid');
}

export class GitHubPublicationObserver {
  private readonly request: typeof globalThis.fetch;
  private readonly timeoutMs: number;
  private readonly baseUrl: string;

  constructor(config: GitHubObserverConfig = {}) {
    this.request = config.fetch ?? globalThis.fetch;
    this.timeoutMs = typeof config.timeoutMs === 'number' && Number.isFinite(config.timeoutMs) && config.timeoutMs > 0
      ? Math.min(config.timeoutMs, 10_000) : 10_000;
    this.baseUrl = (config.baseUrl ?? 'https://api.github.com').replace(/\/$/, '');
  }

  private async get(path: string, token: string): Promise<unknown> {
    const controller = new AbortController();
    let handle: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      handle = setTimeout(() => { controller.abort(); reject(new CheckPublicationError(504, 'github_timeout')); }, this.timeoutMs);
    });
    try {
      let response: Response;
      try {
        response = await Promise.race([this.request(`${this.baseUrl}${path}`, {
          method: 'GET', signal: controller.signal,
          headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${token}`, 'x-github-api-version': '2022-11-28' },
        }), timeout]);
      } catch (error) {
        if (error instanceof CheckPublicationError) throw error;
        throw new CheckPublicationError(502, 'github_observation_failed');
      }
      if (!response.ok) throw githubStatus(response.status);
      try { return await Promise.race([response.json(), timeout]); }
      catch (error) {
        if (error instanceof CheckPublicationError) throw error;
        throw new CheckPublicationError(502, 'github_response_invalid');
      }
    } finally {
      if (handle !== undefined) clearTimeout(handle);
    }
  }

  async observe(claim: PublicationCheckClaim): Promise<PublicationObservation> {
    const { owner, name, branch, credential } = claim.repository;
    if (!repositoryPart.test(owner) || !repositoryPart.test(name) || !branch || !shaPattern.test(claim.commitSha) || !credential) {
      throw new CheckPublicationError(500, 'publication_check_invalid');
    }
    const repositoryPath = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
    const query = new URLSearchParams({ head_sha: claim.commitSha, branch, event: 'push', per_page: '100' });
    const runsValue = record(await this.get(`${repositoryPath}/actions/runs?${query}`, credential));
    const runs = Array.isArray(runsValue?.workflow_runs) ? runsValue.workflow_runs : null;
    if (!runs) throw new CheckPublicationError(502, 'github_response_invalid');
    const run = runs.map(record).find((candidate) => candidate
      && typeof candidate.head_sha === 'string' && candidate.head_sha.toLowerCase() === claim.commitSha.toLowerCase()
      && typeof candidate.path === 'string' && candidate.path.split('@')[0] === '.github/workflows/deploy.yml'
      && positiveId(candidate.id) !== null);
    if (!run) return {
      phase: 'commit_created', workflowStatus: 'pending', pagesStatus: 'pending', terminal: false,
      workflowRunId: null, deploymentId: null, pagesUrl: null, failureCode: null,
    };

    const workflowRunId = positiveId(run.id)!;
    if (run.status !== 'completed') {
      const workflowStatus: WorkflowTrackingStatus = run.status === 'queued' ? 'queued' : 'in_progress';
      return { phase: 'workflow_running', workflowStatus, pagesStatus: 'pending', terminal: false, workflowRunId, deploymentId: null, pagesUrl: null, failureCode: null };
    }
    if (run.conclusion !== 'success') {
      return { phase: 'workflow_failed', workflowStatus: 'failure', pagesStatus: 'pending', terminal: true, workflowRunId, deploymentId: null, pagesUrl: null, failureCode: 'workflow_failed' };
    }

    const deploymentQuery = new URLSearchParams({ sha: claim.commitSha, environment: 'github-pages', per_page: '100' });
    const deploymentsValue = await this.get(`${repositoryPath}/deployments?${deploymentQuery}`, credential);
    if (!Array.isArray(deploymentsValue)) throw new CheckPublicationError(502, 'github_response_invalid');
    const deployment = deploymentsValue.map(record).find((candidate) => candidate
      && candidate.sha === claim.commitSha && candidate.environment === 'github-pages' && positiveId(candidate.id) !== null);
    if (!deployment) return {
      phase: 'workflow_succeeded', workflowStatus: 'success', pagesStatus: 'pending', terminal: false,
      workflowRunId, deploymentId: null, pagesUrl: null, failureCode: null,
    };
    const deploymentId = positiveId(deployment.id)!;
    const statusesValue = await this.get(`${repositoryPath}/deployments/${deploymentId}/statuses?per_page=100`, credential);
    if (!Array.isArray(statusesValue)) throw new CheckPublicationError(502, 'github_response_invalid');
    const status = statusesValue.map(record).find((candidate) => candidate && typeof candidate.state === 'string');
    if (!status) return {
      phase: 'pages_running', workflowStatus: 'success', pagesStatus: 'pending', terminal: false,
      workflowRunId, deploymentId, pagesUrl: null, failureCode: null,
    };
    const pagesUrl = safePagesUrl(status.environment_url, owner, name);
    if (status.state === 'success') return {
      phase: 'deployed', workflowStatus: 'success', pagesStatus: 'success', terminal: true,
      workflowRunId, deploymentId, pagesUrl, failureCode: null,
    };
    if (status.state === 'failure' || status.state === 'error' || status.state === 'inactive') return {
      phase: 'pages_failed', workflowStatus: 'success', pagesStatus: 'failure', terminal: true,
      workflowRunId, deploymentId, pagesUrl, failureCode: 'pages_deployment_failed',
    };
    const pagesStatus: PagesTrackingStatus = status.state === 'queued' || status.state === 'pending' ? 'queued' : 'in_progress';
    return { phase: 'pages_running', workflowStatus: 'success', pagesStatus, terminal: false, workflowRunId, deploymentId, pagesUrl, failureCode: null };
  }
}

export async function checkNextPublication(deps: PublicationTrackingDependencies): Promise<Record<string, unknown>> {
  const claim = await deps.claimNext();
  if (claim.outcome === 'idle') return { status: 'idle' };
  if (claim.outcome === 'timed_out') return { status: 'tracking_timed_out', publishJobId: claim.publishJobId };
  const observation = await deps.observe(claim);
  await deps.record({ ...observation, publishJobId: claim.publishJobId, checkToken: claim.checkToken, commitSha: claim.commitSha });
  return { status: observation.phase, publishJobId: claim.publishJobId };
}

function unauthorized(): Response { return Response.json({ error: 'authentication_required' }, { status: 401 }); }

export function createCheckPublicationHandler(deps: PublicationTrackingDependencies, dispatchToken: string) {
  return async (request: Request): Promise<Response> => {
    if (request.method !== 'POST') return Response.json({ error: 'method_not_allowed' }, { status: 405 });
    if (!dispatchToken || request.headers.get('x-schedule-dispatch-token') !== dispatchToken) return unauthorized();
    let value: unknown;
    try { value = await request.json(); } catch { return Response.json({ error: 'invalid_command' }, { status: 400 }); }
    const command = record(value);
    try {
      if (command?.action === 'poll' && Object.keys(command).length === 1) return Response.json(await checkNextPublication(deps));
      if (command?.action === 'retry' && typeof command.publishJobId === 'string' && uuidPattern.test(command.publishJobId) && Object.keys(command).length === 2) {
        return Response.json(await deps.retryTimedOut(command.publishJobId));
      }
      return Response.json({ error: 'invalid_command' }, { status: 400 });
    } catch (error) {
      const known = error instanceof CheckPublicationError ? error : new CheckPublicationError(500, 'internal_error');
      return Response.json({ error: known.code }, { status: known.status });
    }
  };
}

interface SupabaseTrackingConfig { url: string; serviceRoleKey: string; fetch?: typeof globalThis.fetch; timeoutMs?: number }

export function createSupabaseTrackingDependencies(config: SupabaseTrackingConfig): PublicationTrackingDependencies {
  const request = config.fetch ?? globalThis.fetch;
  const timeoutMs = typeof config.timeoutMs === 'number' && Number.isFinite(config.timeoutMs) && config.timeoutMs > 0 ? Math.min(config.timeoutMs, 10_000) : 10_000;
  const rpc = async (name: string, body: Record<string, unknown>): Promise<unknown> => {
    const controller = new AbortController();
    let handle: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => { handle = setTimeout(() => { controller.abort(); reject(new CheckPublicationError(500, 'internal_error')); }, timeoutMs); });
    try {
      const response = await Promise.race([request(`${config.url.replace(/\/$/, '')}/rest/v1/rpc/${name}`, {
        method: 'POST', signal: controller.signal,
        headers: { apikey: config.serviceRoleKey, authorization: `Bearer ${config.serviceRoleKey}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }), timeout]);
      const value = await Promise.race([response.json(), timeout]);
      if (!response.ok) throw new CheckPublicationError(500, 'internal_error');
      return value;
    } catch (error) {
      if (error instanceof CheckPublicationError) throw error;
      throw new CheckPublicationError(500, 'internal_error');
    } finally { if (handle !== undefined) clearTimeout(handle); }
  };
  const observer = new GitHubPublicationObserver();
  return {
    claimNext: async () => {
      const value = record(await rpc('claim_narrative_publication_check', { p_check_token: crypto.randomUUID() }));
      if (value?.outcome === 'idle') return { outcome: 'idle' };
      if (value?.outcome === 'timed_out' && typeof value.publish_job_id === 'string') return { outcome: 'timed_out', publishJobId: value.publish_job_id };
      if (!value || value.outcome !== 'claimed' || typeof value.check_token !== 'string' || typeof value.publish_job_id !== 'string'
        || typeof value.commit_sha !== 'string' || typeof value.repository_owner !== 'string' || typeof value.repository_name !== 'string'
        || typeof value.repository_branch !== 'string' || typeof value.credential !== 'string') throw new CheckPublicationError(500, 'internal_error');
      return {
        outcome: 'claimed', checkToken: value.check_token, publishJobId: value.publish_job_id, commitSha: value.commit_sha,
        repository: { owner: value.repository_owner, name: value.repository_name, branch: value.repository_branch, credential: value.credential },
      };
    },
    observe: (claim) => observer.observe(claim),
    record: async (input) => {
      const value = record(await rpc('record_narrative_publication_check', {
        p_publish_job_id: input.publishJobId, p_check_token: input.checkToken,
        p_commit_sha: input.commitSha,
        p_workflow_status: input.workflowStatus, p_pages_status: input.pagesStatus,
        p_workflow_run_id: input.workflowRunId, p_pages_deployment_id: input.deploymentId,
        p_pages_url: input.pagesUrl, p_failure_code: input.failureCode,
      }));
      if (value?.status !== 'recorded') throw new CheckPublicationError(500, 'internal_error');
      return { status: 'recorded' };
    },
    retryTimedOut: async (publishJobId) => {
      const value = record(await rpc('retry_narrative_publication_check', { p_publish_job_id: publishJobId }));
      if (value?.status !== 'retry_scheduled') throw new CheckPublicationError(500, 'internal_error');
      return { status: 'retry_scheduled' };
    },
  };
}

interface DenoRuntime { env: { get(name: string): string | undefined }; serve(handler: (request: Request) => Response | Promise<Response>): void }
declare const Deno: DenoRuntime;
if (typeof Deno !== 'undefined' && (import.meta as ImportMeta & { main?: boolean }).main) {
  const url = Deno.env.get('SUPABASE_URL');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const dispatchToken = Deno.env.get('NARRATIVE_SCHEDULE_DISPATCH_TOKEN');
  if (!url || !serviceRoleKey || !dispatchToken) throw new Error('check-publication runtime settings are required');
  Deno.serve(createCheckPublicationHandler(createSupabaseTrackingDependencies({ url, serviceRoleKey }), dispatchToken));
}
