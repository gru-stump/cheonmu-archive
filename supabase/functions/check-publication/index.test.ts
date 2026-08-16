import { describe, expect, it, vi } from 'vitest';
import {
  CheckPublicationError,
  GitHubPublicationObserver,
  checkNextPublication,
  createCheckPublicationHandler,
  createSupabaseTrackingDependencies,
  type PublicationCheckClaim,
  type PublicationTrackingDependencies,
} from './index';

const commitSha = '1'.repeat(40);
const otherSha = '2'.repeat(40);
const job: PublicationCheckClaim = {
  outcome: 'claimed',
  checkToken: 'a1000000-0000-4000-8000-000000000001',
  publishJobId: 'a2000000-0000-0000-0000-000000000001',
  commitSha,
  repository: { owner: 'cheonmu-owner', name: 'cheonmu-archive', branch: 'main', credential: 'fixture-github-token' },
};

const json = (value: unknown, status = 200) => Response.json(value, { status });

function observer(responses: Response[]) {
  const calls: Array<{ url: string; authorization: string | null }> = [];
  const fetch: typeof globalThis.fetch = vi.fn(async (input, init) => {
    calls.push({ url: String(input), authorization: new Headers(init?.headers).get('authorization') });
    const response = responses.shift();
    if (!response) throw new Error('unexpected GitHub request');
    return response;
  });
  return { calls, observer: new GitHubPublicationObserver({ fetch, timeoutMs: 25 }) };
}

describe('GitHub publication observation', () => {
  it.each([
    ['queued', 'workflow_running', 'queued'],
    ['in_progress', 'workflow_running', 'in_progress'],
  ] as const)('keeps a matching exact-commit workflow %s nonterminal', async (status, phase, workflowStatus) => {
    const h = observer([json({ workflow_runs: [{ id: 41, head_sha: commitSha, path: '.github/workflows/deploy.yml', status, conclusion: null }] })]);

    await expect(h.observer.observe(job)).resolves.toMatchObject({ phase, workflowStatus, pagesStatus: 'pending', terminal: false, workflowRunId: 41 });
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]?.url).toContain(`head_sha=${commitSha}`);
    expect(h.calls[0]?.authorization).toBe('Bearer fixture-github-token');
  });

  it('ignores the newest unrelated workflow and binds both workflow and Pages deployment to the exact commit SHA', async () => {
    const h = observer([
      json({ workflow_runs: [
        { id: 99, head_sha: otherSha, path: '.github/workflows/deploy.yml', status: 'completed', conclusion: 'success' },
        { id: 42, head_sha: commitSha, path: '.github/workflows/deploy.yml', status: 'completed', conclusion: 'success' },
      ] }),
      json([
        { id: 777, sha: otherSha, environment: 'github-pages' },
        { id: 314, sha: commitSha, environment: 'github-pages' },
      ]),
      json([{ id: 9, state: 'success', environment_url: 'https://cheonmu-owner.github.io/cheonmu-archive/' }]),
    ]);

    await expect(h.observer.observe(job)).resolves.toEqual({
      phase: 'deployed', workflowStatus: 'success', pagesStatus: 'success', terminal: true,
      workflowRunId: 42, deploymentId: 314, pagesUrl: 'https://cheonmu-owner.github.io/cheonmu-archive/', failureCode: null,
    });
    expect(h.calls[1]?.url).toContain(`sha=${commitSha}`);
    expect(h.calls[2]?.url).toContain('/deployments/314/statuses');
  });

  it('keeps workflow failure separate from the already-created commit and never queries deployments', async () => {
    const h = observer([json({ workflow_runs: [{ id: 43, head_sha: commitSha, path: '.github/workflows/deploy.yml', status: 'completed', conclusion: 'failure' }] })]);

    await expect(h.observer.observe(job)).resolves.toEqual({
      phase: 'workflow_failed', workflowStatus: 'failure', pagesStatus: 'pending', terminal: true,
      workflowRunId: 43, deploymentId: null, pagesUrl: null, failureCode: 'workflow_failed',
    });
    expect(h.calls).toHaveLength(1);
  });

  it('records Pages failure without rewriting successful workflow or commit state', async () => {
    const h = observer([
      json({ workflow_runs: [{ id: 44, head_sha: commitSha, path: '.github/workflows/deploy.yml', status: 'completed', conclusion: 'success' }] }),
      json([{ id: 315, sha: commitSha, environment: 'github-pages' }]),
      json([{ id: 10, state: 'failure', environment_url: 'https://cheonmu-owner.github.io/cheonmu-archive/' }]),
    ]);

    await expect(h.observer.observe(job)).resolves.toMatchObject({
      phase: 'pages_failed', workflowStatus: 'success', pagesStatus: 'failure', terminal: true,
      failureCode: 'pages_deployment_failed',
    });
  });

  it('drops attacker-controlled deployment URLs instead of persisting or returning them', async () => {
    const h = observer([
      json({ workflow_runs: [{ id: 45, head_sha: commitSha, path: '.github/workflows/deploy.yml', status: 'completed', conclusion: 'success' }] }),
      json([{ id: 316, sha: commitSha, environment: 'github-pages' }]),
      json([{ id: 11, state: 'success', environment_url: 'https://evil.example/phish' }]),
    ]);

    await expect(h.observer.observe(job)).resolves.toMatchObject({ phase: 'deployed', pagesUrl: null });
  });

  it('sanitizes bounded GitHub failures without leaking tokens or provider response bodies', async () => {
    const h = observer([json({ message: 'fixture-github-token raw private response' }, 403)]);
    const error = await h.observer.observe(job).catch((value) => value);

    expect(error).toBeInstanceOf(CheckPublicationError);
    expect(error).toMatchObject({ code: 'github_credentials_rejected' });
    expect(JSON.stringify(error)).not.toMatch(/fixture-github-token|raw private response/);
  });
});

describe('publication polling orchestration', () => {
  function deps(claim: PublicationCheckClaim | { outcome: 'idle' | 'timed_out'; publishJobId?: string }, overrides: Partial<PublicationTrackingDependencies> = {}) {
    const recorded: unknown[] = [];
    const value: PublicationTrackingDependencies = {
      claimNext: vi.fn(async () => claim),
      observe: vi.fn(async () => ({
        phase: 'workflow_running', workflowStatus: 'in_progress', pagesStatus: 'pending', terminal: false,
        workflowRunId: 41, deploymentId: null, pagesUrl: null, failureCode: null,
      })),
      record: vi.fn(async (input) => { recorded.push(input); return { status: 'recorded' as const }; }),
      recordObservationRetry: vi.fn(async () => ({ status: 'retry_scheduled' as const })),
      retryTimedOut: vi.fn(async () => ({ status: 'retry_scheduled' as const })),
      ...overrides,
    };
    return { value, recorded };
  }

  it('polls only a claimed nonterminal row and records the exact check token', async () => {
    const h = deps(job);
    await expect(checkNextPublication(h.value)).resolves.toMatchObject({ status: 'workflow_running', publishJobId: job.publishJobId });
    expect(h.recorded).toEqual([expect.objectContaining({ publishJobId: job.publishJobId, checkToken: job.checkToken, commitSha })]);
  });

  it.each([{ outcome: 'idle' as const }, { outcome: 'timed_out' as const, publishJobId: job.publishJobId }])(
    'does not call GitHub for $outcome rows', async (claim) => {
      const h = deps(claim);
      await checkNextPublication(h.value);
      expect(h.value.observe).not.toHaveBeenCalled();
      expect(h.value.record).not.toHaveBeenCalled();
    },
  );

  it('durably schedules bounded backoff when GitHub observation times out', async () => {
    const h = deps(job, {
      observe: vi.fn(async () => { throw new CheckPublicationError(504, 'github_timeout'); }),
    });

    await expect(checkNextPublication(h.value)).resolves.toEqual({
      status: 'retry_scheduled', publishJobId: job.publishJobId,
    });
    expect(h.value.recordObservationRetry).toHaveBeenCalledWith({
      publishJobId: job.publishJobId, checkToken: job.checkToken, commitSha,
      errorCode: 'github_timeout',
    });
    expect(h.value.record).not.toHaveBeenCalled();
  });

  it('retries an observation timeout only through the dispatch boundary', async () => {
    const h = deps({ outcome: 'idle' });
    const handler = createCheckPublicationHandler(h.value, 'server-dispatch-token');
    const response = await handler(new Request('https://functions.example/check-publication', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-schedule-dispatch-token': 'server-dispatch-token' },
      body: JSON.stringify({ action: 'retry', publishJobId: job.publishJobId }),
    }));

    expect(response.status).toBe(200);
    expect(h.value.retryTimedOut).toHaveBeenCalledWith(job.publishJobId);
    expect(h.value.claimNext).not.toHaveBeenCalled();
  });

  it('rejects browser bearer credentials and wrong dispatch tokens before database or GitHub access', async () => {
    const h = deps(job);
    const handler = createCheckPublicationHandler(h.value, 'server-dispatch-token');
    const response = await handler(new Request('https://functions.example/check-publication', {
      method: 'POST', headers: { authorization: 'Bearer owner-token', 'x-schedule-dispatch-token': 'wrong' },
      body: JSON.stringify({ action: 'poll' }),
    }));

    expect(response.status).toBe(401);
    expect(h.value.claimNext).not.toHaveBeenCalled();
  });
});

describe('Supabase publication tracking boundary', () => {
  it('uses the service role only for tracking mutation RPCs and never sends GitHub material back to the database', async () => {
    const calls: Array<{ path: string; authorization: string | null; body: Record<string, unknown> }> = [];
    const fetch: typeof globalThis.fetch = vi.fn(async (input, init) => {
      const path = new URL(String(input)).pathname;
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      calls.push({ path, authorization: new Headers(init?.headers).get('authorization'), body });
      if (path.endsWith('/claim_narrative_publication_check')) return json({
        outcome: 'claimed', check_token: job.checkToken, publish_job_id: job.publishJobId, commit_sha: commitSha,
        repository_owner: job.repository.owner, repository_name: job.repository.name, repository_branch: job.repository.branch,
        credential: 'fixture-github-token',
      });
      return json({
        status: path.endsWith('/retry_narrative_publication_check') || path.endsWith('/record_narrative_publication_check_retry')
          ? 'retry_scheduled'
          : 'recorded',
      });
    });
    const deps = createSupabaseTrackingDependencies({ url: 'https://db.example.test', serviceRoleKey: 'service-role-value', fetch });
    const claimed = await deps.claimNext();
    expect(claimed).toMatchObject(job);
    await deps.record({
      publishJobId: job.publishJobId, checkToken: job.checkToken, commitSha,
      phase: 'workflow_running', workflowStatus: 'in_progress', pagesStatus: 'pending', terminal: false,
      workflowRunId: 41, deploymentId: null, pagesUrl: null, failureCode: null,
    });
    await deps.recordObservationRetry({
      publishJobId: job.publishJobId, checkToken: job.checkToken, commitSha,
      errorCode: 'github_observation_failed',
    });
    await deps.retryTimedOut(job.publishJobId);

    expect(calls.map((call) => call.authorization)).toEqual(['Bearer service-role-value', 'Bearer service-role-value', 'Bearer service-role-value', 'Bearer service-role-value']);
    expect(calls.map((call) => call.path)).toEqual([
      '/rest/v1/rpc/claim_narrative_publication_check',
      '/rest/v1/rpc/record_narrative_publication_check',
      '/rest/v1/rpc/record_narrative_publication_check_retry',
      '/rest/v1/rpc/retry_narrative_publication_check',
    ]);
    expect(calls[1]?.body).toMatchObject({ p_publish_job_id: job.publishJobId, p_check_token: job.checkToken, p_commit_sha: commitSha });
    expect(calls[2]?.body).toMatchObject({
      p_publish_job_id: job.publishJobId, p_check_token: job.checkToken,
      p_commit_sha: commitSha, p_error_code: 'github_observation_failed',
    });
    expect(JSON.stringify(calls.slice(1).map((call) => call.body))).not.toMatch(/fixture-github-token|service-role-value|credential/);
  });

  it('uses the injected HTTP client and timeout for the GitHub observation leg', async () => {
    const injectedFetch: typeof globalThis.fetch = vi.fn(async (input) => {
      const url = new URL(String(input));
      if (url.hostname === 'api.github.com') return json({ workflow_runs: [] });
      throw new Error(`unexpected database call: ${url.pathname}`);
    });
    const forbiddenGlobalFetch = vi.fn(async () => { throw new Error('global fetch must not be used'); });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = forbiddenGlobalFetch;
    try {
      const deps = createSupabaseTrackingDependencies({
        url: 'https://db.example.test', serviceRoleKey: 'service-role-value', fetch: injectedFetch, timeoutMs: 25,
      });
      await expect(deps.observe(job)).resolves.toMatchObject({ phase: 'commit_created', terminal: false });
      expect(injectedFetch).toHaveBeenCalledOnce();
      expect(forbiddenGlobalFetch).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
