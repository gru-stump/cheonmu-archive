import { describe, expect, it } from 'vitest';
import type { GenerationResult } from '../../../shared/narrative/contracts';
import type { ContextSelection } from '../_shared/context';
import type { ContinuityContext } from '../_shared/continuity';
import { FakeNarrativeProvider } from '../_shared/fake-provider';
import { createGenerateDraftHandler, createSupabaseGenerationDependencies, runGeneration, GenerationError, type GenerationDependencies } from './index';

const result: GenerationResult = {
  title: '비 오는 처마',
  kind: 'short_dialogue',
  setting: { time: '저녁', place: '처마 아래' },
  body: '천령과 무영은 빗소리를 들었다.',
  emotionalStart: '조용함',
  emotionalEnd: '안도',
  continuityUsed: ['promise-1'],
  continuityCandidates: ['rain-promise'],
  canonChangeCandidates: [],
  unresolvedCallbacks: [],
  riskFlags: [],
};

const selection: ContextSelection = {
  versionIds: ['canon-v1', 'continuity-v2'],
  fixedCanon: [],
  continuity: [],
  recent: [],
  feedback: [],
  claims: [],
  tokenCount: 42,
};

const continuityContext: ContinuityContext = {
  selectedSourceIds: selection.versionIds,
  currentRelationshipStage: 7,
  relationshipSourceId: 'canon-v1',
};

function generationHarness(overrides: Partial<GenerationDependencies> = {}) {
  const events: string[] = [];
  let calls = 0;
  const stored: unknown[] = [];
  const deps: GenerationDependencies = {
    authenticate: async () => { events.push('authenticate'); return { ownerId: 'owner-1' }; },
    authorize: async () => { events.push('authorize'); return { draftStatus: 'queued', workflowPhase: null }; },
    findIdempotent: async () => { events.push('idempotency'); return null; },
    selectContext: async () => { events.push('select'); return { selection, continuityContext }; },
    freezeContext: async (input) => { events.push(`freeze:${input.contextVersionIds.join(',')}`); },
    reserveBudget: async () => { events.push('reserve'); return { status: 'reserved', remainingMicros: 900 }; },
    transitionDraft: async (_draftId, expected, next) => { events.push(`transition:${expected}->${next}`); },
    provider: {
      generate: async () => {
        calls += 1;
        events.push('provider');
        return { result, usage: { inputTokens: 42, outputTokens: 80, costMicros: 37 }, rawId: 'fake-raw-1' };
      },
    },
    parseProviderResponse: (value) => { events.push('parse'); return value as never; },
    checkContinuity: () => {
      events.push('continuity');
      return { level: 'review', findings: [{ code: 'manual_semantic_review', level: 'review', message: 'review', sourceIds: selection.versionIds }] };
    },
    reconcileBudget: async () => { events.push('reconcile'); },
    failBudget: async () => { events.push('fail-budget'); },
    storeVersion: async (input) => { events.push('store'); stored.push(input); return { draftId: input.draftId, versionId: 'version-1', status: 'generated' }; },
    ...overrides,
  };
  return { deps, events, stored, providerCalls: () => calls };
}

const baseCommand = {
  authToken: 'valid-token',
  jobId: 'job-1',
  draftId: 'draft-1',
  idempotencyKey: 'request-1',
  mode: 'new' as const,
  kind: 'short_dialogue' as const,
  maxInputTokens: 500,
  maxOutputTokens: 200,
  worstCaseCostMicros: 100,
};

describe('runGeneration', () => {
  it('freezes selected versions and reserves budget before exactly one provider call', async () => {
    const harness = generationHarness();

    const response = await runGeneration(harness.deps, baseCommand);

    expect(response).toEqual({ draftId: 'draft-1', versionId: 'version-1', status: 'generated', continuityLevel: 'review' });
    expect(harness.providerCalls()).toBe(1);
    expect(harness.events).toEqual([
      'authenticate', 'authorize', 'idempotency', 'select', 'freeze:canon-v1,continuity-v2',
      'reserve', 'transition:queued->generating', 'provider', 'parse', 'continuity', 'reconcile', 'store',
    ]);
    expect(harness.stored).toMatchObject([{
      contextVersionIds: ['canon-v1', 'continuity-v2'],
      providerResponseId: 'fake-raw-1',
      continuityLevel: 'review',
    }]);
  });

  it('returns an existing result without selecting context, reserving, or calling a provider', async () => {
    const existing = { draftId: 'draft-1', versionId: 'version-existing', status: 'generated' as const, continuityLevel: 'review' as const };
    const harness = generationHarness({
      authorize: async () => { harness.events.push('authorize'); return { draftStatus: 'generated', workflowPhase: null }; },
      findIdempotent: async () => { harness.events.push('idempotency'); return existing; },
    });

    await expect(runGeneration(harness.deps, baseCommand)).resolves.toEqual(existing);
    expect(harness.events).toEqual(['authenticate', 'authorize', 'idempotency']);
    expect(harness.providerCalls()).toBe(0);
  });

  it('returns 402 with budget state and never calls the provider when reservation is blocked', async () => {
    const harness = generationHarness({
      reserveBudget: async () => { harness.events.push('reserve'); return { status: 'blocked', budgetStatus: 'limit_reached', remainingMicros: 12 }; },
    });

    await expect(runGeneration(harness.deps, baseCommand)).rejects.toMatchObject<GenerationError>({
      status: 402,
      code: 'budget_blocked',
      details: { budgetStatus: 'limit_reached', remainingMicros: 12 },
    });
    expect(harness.providerCalls()).toBe(0);
    expect(harness.events.at(-1)).toBe('reserve');
  });

  it.each([
    ['new', null],
    ['revise_selection', null],
    ['major_event_scene_plan', 'proposal_approved'],
    ['major_event_draft', 'scene_plan_approved'],
  ] as const)('supports %s when its workflow prerequisite is satisfied', async (mode, workflowPhase) => {
    const harness = generationHarness({
      authorize: async () => { harness.events.push('authorize'); return { draftStatus: 'queued', workflowPhase }; },
    });

    await expect(runGeneration(harness.deps, { ...baseCommand, mode })).resolves.toMatchObject({ status: 'generated' });
    expect(harness.providerCalls()).toBe(1);
  });

  it.each([
    ['major_event_scene_plan', 'proposal'],
    ['major_event_draft', 'scene_plan'],
  ] as const)('rejects %s after idempotency lookup when the previous phase is not approved', async (mode, workflowPhase) => {
    const harness = generationHarness({
      authorize: async () => { harness.events.push('authorize'); return { draftStatus: 'queued', workflowPhase }; },
    });

    await expect(runGeneration(harness.deps, { ...baseCommand, mode })).rejects.toMatchObject({ status: 409, code: 'workflow_phase_not_approved' });
    expect(harness.events).toEqual(['authenticate', 'authorize', 'idempotency']);
    expect(harness.providerCalls()).toBe(0);
  });

  it('stores blocked prose and findings privately without promoting memory', async () => {
    const harness = generationHarness({
      checkContinuity: () => {
        harness.events.push('continuity');
        return { level: 'block', findings: [{ code: 'forbidden_reveal_term', level: 'block', message: 'blocked', sourceIds: ['canon-v1'] }] };
      },
    });

    const response = await runGeneration(harness.deps, baseCommand);

    expect(response.continuityLevel).toBe('block');
    expect(harness.stored).toMatchObject([{ continuityLevel: 'block', visibility: 'private', findings: [{ code: 'forbidden_reveal_term' }] }]);
  });

  it('turns stale draft claims into 409 and does not call the provider', async () => {
    const harness = generationHarness({
      transitionDraft: async () => { harness.events.push('transition:queued->generating'); throw new Error('stale_transition'); },
    });

    await expect(runGeneration(harness.deps, baseCommand)).rejects.toMatchObject({ status: 409, code: 'stale_transition' });
    expect(harness.providerCalls()).toBe(0);
  });
});

describe('generate-draft HTTP boundary', () => {
  it('returns 402 with budget status and does not invoke the provider', async () => {
    const harness = generationHarness({
      reserveBudget: async () => ({ status: 'blocked', budgetStatus: 'limit_reached', remainingMicros: 7 }),
    });
    const response = await createGenerateDraftHandler(harness.deps)(new Request('http://local/generate-draft', {
      method: 'POST',
      headers: { authorization: 'Bearer valid-token', 'content-type': 'application/json' },
      body: JSON.stringify(baseCommand),
    }));

    expect(response.status).toBe(402);
    await expect(response.json()).resolves.toEqual({ error: 'budget_blocked', details: { budgetStatus: 'limit_reached', remainingMicros: 7 } });
    expect(harness.providerCalls()).toBe(0);
  });

  it('rejects malformed commands before authentication', async () => {
    const harness = generationHarness();
    const response = await createGenerateDraftHandler(harness.deps)(new Request('http://local/generate-draft', {
      method: 'POST',
      headers: { authorization: 'Bearer valid-token', 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'new' }),
    }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: 'invalid_command' });
    expect(harness.events).toEqual([]);
  });
});

describe('Supabase generation adapter', () => {
  it('uses authenticated REST/RPC state and returns the stored immutable version', async () => {
    const calls: string[] = [];
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const url = String(input);
      const path = new URL(url).pathname + new URL(url).search;
      calls.push(`${init?.method ?? 'GET'} ${path}`);
      if (path === '/auth/v1/user') return Response.json({ id: 'owner-1' });
      if (path.startsWith('/rest/v1/drafts?')) return Response.json([{ status: 'queued', kind: 'short_dialogue' }]);
      if (path.startsWith('/rest/v1/major_event_workflows?')) return Response.json([]);
      if (path.startsWith('/rest/v1/generation_jobs?')) return Response.json([]);
      if (path.startsWith('/rest/v1/memory_items?')) return Response.json([{
        id: 'canon-v1', memory_type: 'canon', content: '관계 단계 7', status: 'approved', blocking: false,
        metadata: { tokenCount: 3, currentRelationshipStage: 7 }, updated_at: '2026-08-14T00:00:00Z',
      }]);
      if (path.endsWith('/rpc/store_generation_result')) return Response.json({ id: 'version-1', draft_id: 'draft-1' });
      return Response.json({ id: 'rpc-result' });
    };
    const deps = createSupabaseGenerationDependencies(
      { url: 'http://supabase.local', anonKey: 'anon', fetch },
      'valid-token',
      new FakeNarrativeProvider({ result, usage: { inputTokens: 3, outputTokens: 8, costMicros: 9 }, rawId: 'fake-1' }),
    );

    await expect(runGeneration(deps, baseCommand)).resolves.toMatchObject({ versionId: 'version-1', status: 'generated' });
    expect(calls).toEqual(expect.arrayContaining([
      'GET /auth/v1/user',
      'POST /rest/v1/rpc/freeze_generation_context',
      'POST /rest/v1/rpc/reserve_generation_budget',
      'POST /rest/v1/rpc/reconcile_generation_budget',
      'POST /rest/v1/rpc/store_generation_result',
    ]));
  });

  it('returns 409 for an in-flight duplicate before another reservation or provider call', async () => {
    const fetch: typeof globalThis.fetch = async (input) => {
      const path = new URL(String(input)).pathname + new URL(String(input)).search;
      if (path.startsWith('/rest/v1/generation_jobs?')) return Response.json([{ id: 'job-1', draft_id: 'draft-1', status: 'queued' }]);
      throw new Error(`unexpected request ${path}`);
    };
    const deps = createSupabaseGenerationDependencies(
      { url: 'http://supabase.local', anonKey: 'anon', fetch },
      'valid-token',
      new FakeNarrativeProvider(result),
    );

    await expect(deps.findIdempotent('owner-1', 'request-1')).rejects.toMatchObject({ status: 409, code: 'duplicate_generation' });
  });
});
