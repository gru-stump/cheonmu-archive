import { describe, expect, it, vi } from 'vitest';
import {
  createGenerationWorkerHandler,
  createSupabaseGenerationWorkerDependencies,
  dispatchGenerationWorker,
  type ClaimedGenerationJob,
  type GenerationWorkerDependencies,
} from './index.ts';

const claim: ClaimedGenerationJob = {
  outcome: 'claimed',
  jobId: 'a1000000-0000-4000-8000-000000000001',
  ownerId: 'a1000000-0000-4000-8000-000000000002',
  draftId: 'a1000000-0000-4000-8000-000000000003',
  providerSettingId: 'a1000000-0000-4000-8000-000000000004',
  idempotencyKey: 'generation-worker:a1000000-0000-4000-8000-000000000001',
  mode: 'new',
  kind: 'daily_event',
  source: 'schedule',
  policyClass: 'schedule',
  seed: 'database seed',
  tags: ['database-tag'],
};

function harness(overrides: Partial<GenerationWorkerDependencies> = {}) {
  const events: string[] = [];
  const commands: unknown[] = [];
  const deps: GenerationWorkerDependencies = {
    createWorkerAttemptToken: () => 'a1000000-0000-4000-8000-000000000005',
    claim: async () => { events.push('claim'); return claim; },
    generate: async (value, workerAttemptToken) => {
      events.push('generate'); commands.push({ value, workerAttemptToken });
      return { draftId: claim.draftId, versionId: 'a1000000-0000-4000-8000-000000000006', status: 'generated', continuityLevel: 'pass' };
    },
    complete: async () => { events.push('complete'); return { outcome: 'completed' }; },
    fail: async (_jobId, _token, code) => { events.push(`fail:${code}`); return { outcome: 'retry_wait' }; },
    ...overrides,
  };
  return { deps, events, commands };
}

describe('generation worker dispatch', () => {
  it('claims at most one job, uses only the canonical database command, and completes it', async () => {
    const h = harness();
    await expect(dispatchGenerationWorker(h.deps)).resolves.toEqual({ outcome: 'completed', jobId: claim.jobId });
    expect(h.events).toEqual(['claim', 'generate', 'complete']);
    expect(h.commands).toEqual([{
      value: {
        authToken: '', jobId: claim.jobId, draftId: claim.draftId, idempotencyKey: claim.idempotencyKey,
        mode: 'new', kind: 'daily_event', seed: 'database seed', tags: ['database-tag'],
      },
      workerAttemptToken: 'a1000000-0000-4000-8000-000000000005',
    }]);
  });

  it.each(['idle', 'retry_wait', 'dead_lettered'] as const)('returns the database %s outcome without generation', async (outcome) => {
    const h = harness({ claim: async () => ({ outcome }) });
    await expect(dispatchGenerationWorker(h.deps)).resolves.toEqual({ outcome });
    expect(h.events).toEqual([]);
    expect(h.commands).toEqual([]);
  });

  it('maps generation failures through the database retry/dead-letter decision', async () => {
    const h = harness({ generate: async () => { throw Object.assign(new Error('budget'), { code: 'budget_blocked' }); } });
    await expect(dispatchGenerationWorker(h.deps)).resolves.toEqual({ outcome: 'retry_wait', jobId: claim.jobId });
    expect(h.events).toEqual(['claim', 'fail:budget_blocked']);
  });

  it.each(['provider_timeout', 'provider_output_limit', 'provider_connection_failed'])('preserves the safe post-dispatch %s diagnostic for the database', async (code) => {
    const h = harness({ generate: async () => { throw Object.assign(new Error('private provider detail'), { code }); } });

    await dispatchGenerationWorker(h.deps);

    expect(h.events).toEqual(['claim', `fail:${code}`]);
  });

  it('retries an idempotent completion response once without regenerating', async () => {
    let calls = 0;
    const h = harness({ complete: async () => { h.events.push('complete'); if (calls++ === 0) throw new Error('response lost'); return { outcome: 'completed' }; } });
    await expect(dispatchGenerationWorker(h.deps)).resolves.toEqual({ outcome: 'completed', jobId: claim.jobId });
    expect(h.events).toEqual(['claim', 'generate', 'complete', 'complete']);
    expect(h.commands).toHaveLength(1);
  });
});

describe('generation worker HTTP boundary', () => {
  it.each([
    ['missing secret', {}, { action: 'dispatch' }, 401],
    ['wrong secret', { 'x-schedule-dispatch-token': 'wrong' }, { action: 'dispatch' }, 401],
    ['extra body key', { 'x-schedule-dispatch-token': 'dispatch-secret' }, { action: 'dispatch', ownerId: 'attacker' }, 400],
    ['non-object body', { 'x-schedule-dispatch-token': 'dispatch-secret' }, ['dispatch'], 400],
  ])('rejects %s before database access', async (_case, headers, body, status) => {
    const h = harness({ claim: async () => { throw new Error('database must not be reached'); } });
    const response = await createGenerationWorkerHandler(h.deps, 'dispatch-secret')(new Request('http://local/run-generation-worker', {
      method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
    }));
    expect(response.status).toBe(status);
    expect(h.events).toEqual([]);
    expect(response.headers.has('access-control-allow-origin')).toBe(false);
  });

  it('rejects an oversized body before database access', async () => {
    const h = harness({ claim: async () => { throw new Error('database must not be reached'); } });
    const response = await createGenerationWorkerHandler(h.deps, 'dispatch-secret')(new Request('http://local/run-generation-worker', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-schedule-dispatch-token': 'dispatch-secret' },
      body: JSON.stringify({ action: 'dispatch', padding: 'x'.repeat(20_000) }),
    }));
    expect(response.status).toBe(413);
    expect(h.events).toEqual([]);
  });

  it('allows only POST and returns the single dispatch result', async () => {
    const h = harness();
    const get = await createGenerationWorkerHandler(h.deps, 'dispatch-secret')(new Request('http://local/run-generation-worker'));
    expect(get.status).toBe(405);
    const post = await createGenerationWorkerHandler(h.deps, 'dispatch-secret')(new Request('http://local/run-generation-worker', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-schedule-dispatch-token': 'dispatch-secret' }, body: '{"action":"dispatch"}',
    }));
    expect(post.status).toBe(202);
    await expect(post.json()).resolves.toEqual({ outcome: 'completed', jobId: claim.jobId });
  });

  it('caps the whole dispatch below the five-minute lease horizon and clears its timer', async () => {
    vi.useFakeTimers();
    const clear = vi.spyOn(globalThis, 'clearTimeout');
    try {
      const h = harness({ claim: async () => new Promise(() => undefined) });
      const pending = createGenerationWorkerHandler(h.deps, 'dispatch-secret', { dispatchTimeoutMs: 240_000 })(new Request('http://local/run-generation-worker', {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-schedule-dispatch-token': 'dispatch-secret' }, body: '{"action":"dispatch"}',
      }));
      await vi.advanceTimersByTimeAsync(240_000);
      expect((await pending).status).toBe(504);
      expect(clear).toHaveBeenCalled();
    } finally { clear.mockRestore(); vi.useRealTimers(); }
  });

  it('starts the whole deadline before reading a stalled request body and cancels the reader', async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    try {
      const body = new ReadableStream<Uint8Array>({ pull: () => new Promise(() => undefined), cancel });
      const h = harness();
      const pending = createGenerationWorkerHandler(h.deps, 'dispatch-secret', { dispatchTimeoutMs: 100 })(new Request('http://local/run-generation-worker', {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-schedule-dispatch-token': 'dispatch-secret' },
        body, duplex: 'half',
      } as RequestInit));
      let response: Response | undefined;
      void pending.then((value) => { response = value; });
      await vi.advanceTimersByTimeAsync(100);
      expect(response?.status).toBe(504);
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(h.events).toEqual([]);
    } finally { vi.useRealTimers(); }
  });

  it('aborts in-flight generation at the whole deadline so it cannot fail or complete after the 504', async () => {
    vi.useFakeTimers();
    let receivedSignal: AbortSignal | undefined;
    try {
      const h = harness({
        generate: async (_command, _token, _claim, signal?: AbortSignal) => {
          h.events.push('generate');
          receivedSignal = signal;
          return await new Promise((resolve, reject) => {
            const timer = setTimeout(() => resolve({ draftId: claim.draftId, versionId: 'late-version', status: 'generated', continuityLevel: 'pass' }), 200);
            signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new DOMException('aborted', 'AbortError')); }, { once: true });
          });
        },
      });
      const pending = createGenerationWorkerHandler(h.deps, 'dispatch-secret', { dispatchTimeoutMs: 100 })(new Request('http://local/run-generation-worker', {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-schedule-dispatch-token': 'dispatch-secret' }, body: '{"action":"dispatch"}',
      }));
      await vi.advanceTimersByTimeAsync(100);
      expect((await pending).status).toBe(504);
      await vi.advanceTimersByTimeAsync(200);
      expect(receivedSignal?.aborted).toBe(true);
      expect(h.events).toEqual(['claim', 'generate']);
    } finally { vi.useRealTimers(); }
  });
});

describe('generation worker Supabase adapter', () => {
  it('uses service-only RPCs, rejects malformed canonical claims, and caps calls at ten seconds', async () => {
    vi.useFakeTimers();
    try {
      const seen: Array<{ path: string; authorization: string | null; signal?: AbortSignal | null }> = [];
      const fetch: typeof globalThis.fetch = async (input, init) => {
        seen.push({ path: new URL(String(input)).pathname, authorization: new Headers(init?.headers).get('authorization'), signal: init?.signal });
        return new Promise(() => undefined);
      };
      const deps = createSupabaseGenerationWorkerDependencies({ url: 'http://supabase', serviceRoleKey: 'service-secret', fetch, timeoutMs: 99_000 }, async () => ({ ...claim, ownerId: 'wrong' }) as never);
      const pending = deps.claim('a1000000-0000-4000-8000-000000000005');
      const rejected = expect(pending).rejects.toMatchObject({ code: 'generation_worker_rpc_uncertain' });
      await vi.advanceTimersByTimeAsync(10_000);
      await rejected;
      expect(seen).toMatchObject([{ path: '/rest/v1/rpc/claim_generation_worker_job', authorization: 'Bearer service-secret' }]);
      expect(seen[0]?.signal?.aborted).toBe(true);
    } finally { vi.useRealTimers(); }
  });

  it('fails closed on a claim response whose immutable binding is malformed', async () => {
    const fetch: typeof globalThis.fetch = async () => Response.json({ outcome: 'claimed', jobId: claim.jobId, ownerId: claim.ownerId });
    const deps = createSupabaseGenerationWorkerDependencies({ url: 'http://supabase', serviceRoleKey: 'service-secret', fetch }, async () => ({ ...claim }) as never);
    await expect(deps.claim('a1000000-0000-4000-8000-000000000005')).rejects.toMatchObject({ code: 'generation_worker_claim_invalid' });
  });

  it('propagates an outer abort into an in-flight Supabase RPC', async () => {
    let requestSignal: AbortSignal | null | undefined;
    const fetch: typeof globalThis.fetch = async (_input, init) => {
      requestSignal = init?.signal;
      return await new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true }));
    };
    const deps = createSupabaseGenerationWorkerDependencies({ url: 'http://supabase', serviceRoleKey: 'service-secret', fetch }, async () => ({ ...claim }) as never);
    const controller = new AbortController();
    const pending = (deps.claim as (token: string, signal?: AbortSignal) => ReturnType<typeof deps.claim>)('a1000000-0000-4000-8000-000000000005', controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'generation_worker_cancelled' });
    expect(requestSignal?.aborted).toBe(true);
  });
});
