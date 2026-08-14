import { describe, expect, it } from 'vitest';
import type { GenerationResult } from '../../../shared/narrative/contracts';
import type { ContextSelection, NarrativeMemory } from '../_shared/context';
import { FakeNarrativeProvider } from '../_shared/fake-provider';
import {
  CONTINUITY_POLICY_VERSION,
  PersistenceError,
  buildFrozenContinuityContext,
  createGenerateDraftHandler,
  createSupabaseGenerationDependencies,
  estimateActualCostMicros,
  estimateWorstCaseCostMicros,
  runGeneration,
  type GenerationDependencies,
  type TrustedGenerationPolicy,
} from './index';

const result: GenerationResult = {
  title: '비 오는 처마', kind: 'short_dialogue', setting: { time: '저녁', place: '처마 아래' },
  body: '천령과 무영은 빗소리를 들었다.', emotionalStart: '조용함', emotionalEnd: '안도',
  continuityUsed: ['promise-1'], continuityCandidates: ['rain-promise'], canonChangeCandidates: [], unresolvedCallbacks: [], riskFlags: [],
};
const canon: NarrativeMemory = {
  versionId: 'canon-v1', memoryType: 'canon', content: '관계 단계와 금지된 비밀', tokenCount: 20, status: 'approved',
  claims: [{ id: 'relationship-claim', sourceId: 'canon-source', sourcePriority: 1, status: 'confirmed', revealStage: 7, text: 'relationship stage seven' }],
  continuityFacts: { relationshipStage: 7, forbiddenReveals: [{ term: '진명', allowedAtRelationshipStage: 9 }], permanentEntities: ['천령'], permanentSettings: ['처마'], voiceAndTitleRules: true },
};
const continuity: NarrativeMemory = { versionId: 'continuity-v2', memoryType: 'continuity', content: '비 오는 날의 약속', tokenCount: 10, status: 'approved', continuityFacts: { continuityId: 'rain-promise' } };
const feedback: NarrativeMemory = { versionId: 'feedback-v3', memoryType: 'feedback', content: '현대식 농담 금지', tokenCount: 8, status: 'active', blocking: true, continuityFacts: { rejectedMotifs: ['스마트폰'], voiceAndTitleRules: true } };
const selection: ContextSelection = { versionIds: ['canon-v1', 'feedback-v3', 'continuity-v2'], fixedCanon: [canon], continuity: [continuity], recent: [], feedback: [feedback], claims: canon.claims ?? [], tokenCount: 38 };
const policy: TrustedGenerationPolicy = { providerSettingId: 'setting-1', modelKey: 'fake-model', maxInputTokens: 500, maxOutputTokens: 200, maxRevisionOutputTokens: 80, inputCostMicrosPerMillion: 1_000_000, outputCostMicrosPerMillion: 2_000_000, fixedCostMicros: 5 };
const baseCommand = { authToken: 'valid-token', jobId: 'job-1', draftId: 'draft-1', idempotencyKey: 'request-1', mode: 'new' as const, kind: 'short_dialogue' as const };

function harness(overrides: Partial<GenerationDependencies> = {}) {
  const events: string[] = [];
  const providerRequests: unknown[] = [];
  const finalized: unknown[] = [];
  const failures: unknown[] = [];
  const deps: GenerationDependencies = {
    authenticate: async () => { events.push('authenticate'); return { ownerId: 'owner-1' }; },
    authorize: async () => { events.push('authorize'); return { draftStatus: 'queued', draftKind: 'short_dialogue', workflowPhase: null }; },
    findIdempotent: async () => { events.push('idempotency'); return null; },
    loadPolicy: async () => { events.push('policy'); return policy; },
    selectContext: async () => { events.push('select'); return selection; },
    freezeContext: async (input) => { events.push('freeze'); return { ...policy, worstCaseCostMicros: estimateWorstCaseCostMicros(policy, input.mode), contextVersionIds: input.contextVersionIds, contextSnapshot: input.contextSnapshot }; },
    reserveAndStart: async () => { events.push('reserve-start'); return { status: 'reserved', budgetStatus: 'normal', remainingMicros: 999 }; },
    provider: { generate: async (request) => { events.push('provider'); providerRequests.push(request); return { result: { ...result, kind: request.kind }, usage: { inputTokens: 38, outputTokens: 80, costMicros: 37 }, rawId: 'raw-1' }; } },
    parseProviderResponse: (value) => { events.push('parse'); return value as never; },
    checkContinuity: (_value, context) => { events.push('continuity'); expect(context.relationshipSourceId).toBe('canon-v1'); return { level: 'review', findings: [{ code: 'manual_semantic_review', level: 'review', message: 'review', sourceIds: context.selectedSourceIds }] }; },
    finalizeSuccess: async (input) => { events.push('finalize'); finalized.push(input); return { draftId: input.draftId, versionId: 'version-1', status: 'generated' }; },
    finalizeFailure: async (input) => { events.push('failure'); failures.push(input); },
    ...overrides,
  };
  return { deps, events, providerRequests, finalized, failures };
}

describe('trusted generation policy', () => {
  it('estimates reservation from trusted model prices and caps revision output', () => {
    expect(estimateWorstCaseCostMicros(policy, 'new')).toBe(905);
    expect(estimateWorstCaseCostMicros(policy, 'revise_selection')).toBe(665);
  });

  it('derives actual cost from trusted prices rather than provider-reported cost', () => {
    expect(estimateActualCostMicros(policy, { inputTokens: 38, outputTokens: 80, costMicros: 1 })).toBe(203);
  });
});

describe('frozen continuity context', () => {
  it('builds every source-backed gate from selected immutable memories', () => {
    expect(buildFrozenContinuityContext(selection)).toEqual({
      selectedSourceIds: selection.versionIds, currentRelationshipStage: 7, relationshipSourceId: 'canon-v1',
      forbiddenRevealTerms: [{ term: '진명', allowedAtRelationshipStage: 9, sourceId: 'canon-v1' }],
      knownPermanentEntities: [{ name: '천령', sourceId: 'canon-v1' }], knownPermanentSettings: [{ name: '처마', sourceId: 'canon-v1' }],
      approvedContinuity: [{ id: 'rain-promise', sourceId: 'continuity-v2' }], rejectedMotifs: [{ term: '스마트폰', sourceId: 'feedback-v3' }],
      voiceAndTitleSourceIds: ['canon-v1', 'feedback-v3'],
    });
  });
});

describe('runGeneration', () => {
  it('reserves before one provider call and atomically finalizes the result', async () => {
    const h = harness();
    await expect(runGeneration(h.deps, baseCommand)).resolves.toEqual({ draftId: 'draft-1', versionId: 'version-1', status: 'generated', continuityLevel: 'review' });
    expect(h.events).toEqual(['authenticate', 'authorize', 'idempotency', 'policy', 'select', 'freeze', 'reserve-start', 'provider', 'parse', 'continuity', 'finalize']);
    expect(h.providerRequests).toMatchObject([{ modelKey: 'fake-model', maxInputTokens: 500, maxOutputTokens: 200, contextVersionIds: selection.versionIds,
      contextMemories: [{ versionId: 'canon-v1', content: canon.content, claims: canon.claims }, { versionId: 'feedback-v3', content: feedback.content }, { versionId: 'continuity-v2', content: continuity.content }],
    }]);
    expect(h.finalized).toMatchObject([{ continuityPolicyVersion: CONTINUITY_POLICY_VERSION, actualCostMicros: 203, contextVersionIds: selection.versionIds }]);
    expect(h.failures).toEqual([]);
  });

  it('stores blocked prose privately under policy', async () => {
    const h = harness({ checkContinuity: () => ({ level: 'block', findings: [{ code: 'forbidden', level: 'block', message: 'blocked', sourceIds: ['canon-v1'] }] }) });
    await expect(runGeneration(h.deps, baseCommand)).resolves.toMatchObject({ continuityLevel: 'block' });
    expect(h.finalized).toMatchObject([{ continuityLevel: 'block', visibility: 'private', continuityPolicyVersion: CONTINUITY_POLICY_VERSION }]);
  });

  it('returns a completed result before state and workflow checks', async () => {
    const existing = { draftId: 'draft-1', versionId: 'old', status: 'generated' as const, continuityLevel: 'review' as const };
    const h = harness({ authorize: async () => ({ draftStatus: 'generated', draftKind: 'short_dialogue', workflowPhase: 'final_approved' }), findIdempotent: async () => existing });
    await expect(runGeneration(h.deps, baseCommand)).resolves.toEqual(existing);
    expect(h.providerRequests).toEqual([]);
  });

  it('returns honest 402 state without calling provider or failure cleanup', async () => {
    const h = harness({ reserveAndStart: async () => ({ status: 'blocked', budgetStatus: 'period_limit_reached', remainingMicros: 12 }) });
    await expect(runGeneration(h.deps, baseCommand)).rejects.toMatchObject({ status: 402, code: 'budget_blocked', details: { budgetStatus: 'period_limit_reached', remainingMicros: 12 } });
    expect(h.providerRequests).toEqual([]);
    expect(h.failures).toEqual([]);
  });

  it.each([['major_event_scene_plan', 'proposal_approved'], ['major_event_draft', 'scene_plan_approved']] as const)('allows %s only for a major-event draft after its prerequisite', async (mode, workflowPhase) => {
    const h = harness({ authorize: async () => ({ draftStatus: 'queued', draftKind: 'major_event_proposal', workflowPhase }) });
    await expect(runGeneration(h.deps, { ...baseCommand, mode, kind: 'major_event_proposal' })).resolves.toMatchObject({ status: 'generated' });
  });

  it.each([
    [{ ...baseCommand, mode: 'major_event_scene_plan' as const }, 'mode_kind_mismatch'],
    [{ ...baseCommand, mode: 'revise_selection' as const }, 'revision_payload_required'],
    [{ ...baseCommand, revision: { selectedText: '문장', instruction: '고쳐 줘' } }, 'revision_payload_forbidden'],
  ])('rejects incoherent mode payloads before selection', async (command, code) => {
    const h = harness();
    await expect(runGeneration(h.deps, command)).rejects.toMatchObject({ status: 400, code });
    expect(h.events).not.toContain('select');
  });

  it('bounds revision output and passes explicit selection/instruction', async () => {
    const h = harness();
    await runGeneration(h.deps, { ...baseCommand, mode: 'revise_selection', revision: { selectedText: '선택 문장', instruction: '말투만 다듬기' } });
    expect(h.providerRequests).toMatchObject([{ maxOutputTokens: 80, revision: { selectedText: '선택 문장', instruction: '말투만 다듬기' } }]);
  });

  it('atomically records provider failure using the full reservation when usage is unavailable', async () => {
    const h = harness({ provider: { generate: async () => { throw new Error('raw secret response'); } } });
    await expect(runGeneration(h.deps, baseCommand)).rejects.toMatchObject({ status: 502, code: 'provider_generation_failed', details: undefined });
    expect(h.failures).toMatchObject([{ failureCode: 'provider_generation_failed', usage: null }]);
    expect(h.events.filter((event) => event === 'failure')).toHaveLength(1);
  });

  it('rejects provider kind mismatch and fails with known usage', async () => {
    const h = harness({ provider: { generate: async () => ({ result: { ...result, kind: 'daily_event' }, usage: { inputTokens: 30, outputTokens: 20, costMicros: 22 }, rawId: 'wrong' }) } });
    await expect(runGeneration(h.deps, baseCommand)).rejects.toMatchObject({ status: 502, code: 'provider_result_kind_mismatch' });
    expect(h.failures).toMatchObject([{ failureCode: 'provider_result_kind_mismatch', usage: { inputTokens: 30, outputTokens: 20, costMicros: 22 } }]);
  });

  it('rejects usage beyond trusted token caps even when provider-reported cost is low', async () => {
    const h = harness({ provider: { generate: async () => ({ result, usage: { inputTokens: 38, outputTokens: 201, costMicros: 1 }, rawId: 'over-cap' }) } });
    await expect(runGeneration(h.deps, baseCommand)).rejects.toMatchObject({ status: 502, code: 'provider_usage_exceeds_reservation' });
    expect(h.failures).toMatchObject([{ failureCode: 'provider_usage_exceeds_reservation', usage: null }]);
  });

  it('calls atomic failure after finalization failure and maps confirmed stale to 409', async () => {
    const h = harness({ finalizeSuccess: async () => { throw new PersistenceError('stale_transition'); } });
    await expect(runGeneration(h.deps, baseCommand)).rejects.toMatchObject({ status: 409, code: 'stale_transition' });
    expect(h.failures).toHaveLength(1);
  });

  it('sanitizes unknown infrastructure failures as 500, not 409', async () => {
    const h = harness({ freezeContext: async () => { throw new Error('socket contents'); } });
    await expect(runGeneration(h.deps, baseCommand)).rejects.toMatchObject({ status: 500, code: 'internal_error' });
  });
});

describe('generate-draft HTTP boundary', () => {
  it('rejects caller pricing/token overrides before authentication', async () => {
    const h = harness();
    const response = await createGenerateDraftHandler(h.deps)(new Request('http://local/generate', { method: 'POST', headers: { authorization: 'Bearer token', 'content-type': 'application/json' }, body: JSON.stringify({ ...baseCommand, worstCaseCostMicros: 1, maxInputTokens: 9, maxOutputTokens: 9 }) }));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: 'invalid_command' });
    expect(h.events).toEqual([]);
  });

  it('never exposes provider text to the client', async () => {
    const h = harness({ provider: { generate: async () => { throw new Error('raw provider body with secret'); } } });
    const { authToken: _authToken, ...body } = baseCommand;
    const response = await createGenerateDraftHandler(h.deps)(new Request('http://local/generate', { method: 'POST', headers: { authorization: 'Bearer token', 'content-type': 'application/json' }, body: JSON.stringify(body) }));
    expect(response.status).toBe(502);
    expect(JSON.stringify(await response.json())).toBe('{"error":"provider_generation_failed"}');
  });
});

describe('Supabase generation adapter', () => {
  it('loads trusted settings and uses atomic start/success RPCs', async () => {
    const calls: string[] = [];
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const path = new URL(String(input)).pathname + new URL(String(input)).search;
      calls.push(`${init?.method ?? 'GET'} ${path}`);
      if (path.startsWith('/rest/v1/provider_settings?')) return Response.json([{ id: 'setting-1', model_key: 'fake-model', max_input_tokens: 500, max_output_tokens: 200, max_revision_output_tokens: 80, input_cost_micros_per_million: 1000000, output_cost_micros_per_million: 2000000, fixed_cost_micros: 5 }]);
      if (path.endsWith('/rpc/reserve_and_start_generation')) return Response.json({ status: 'reserved', budgetStatus: 'normal', remainingMicros: 50 });
      if (path.endsWith('/rpc/finalize_generation_success')) return Response.json({ id: 'version-1', draft_id: 'draft-1' });
      return Response.json({ id: 'ok' });
    };
    const deps = createSupabaseGenerationDependencies({ url: 'http://supabase', anonKey: 'anon', fetch }, 'token', new FakeNarrativeProvider(result));
    await expect(deps.loadPolicy('owner-1', baseCommand)).resolves.toMatchObject({ modelKey: 'fake-model', maxInputTokens: 500 });
    await expect(deps.reserveAndStart({ jobId: 'job-1', draftId: 'draft-1', worstCaseCostMicros: 905 })).resolves.toMatchObject({ remainingMicros: 50 });
    await expect(deps.finalizeSuccess({ ownerId: 'owner-1', jobId: 'job-1', draftId: 'draft-1', result, usage: { inputTokens: 1, outputTokens: 1, costMicros: 2 }, actualCostMicros: 2, contextVersionIds: selection.versionIds, continuityLevel: 'review', findings: [], providerResponseId: 'raw', visibility: 'private', continuityPolicyVersion: CONTINUITY_POLICY_VERSION })).resolves.toMatchObject({ versionId: 'version-1' });
    expect(calls).toEqual(expect.arrayContaining(['POST /rest/v1/rpc/reserve_and_start_generation', 'POST /rest/v1/rpc/finalize_generation_success']));
    expect(calls.some((call) => call.includes('reconcile_generation_budget') || call.includes('store_generation_result'))).toBe(false);
  });

  it('recognizes only exact P0001 storage conflict codes', async () => {
    const exact = createSupabaseGenerationDependencies({ url: 'http://supabase', anonKey: 'anon', fetch: async () => Response.json({ code: 'P0001', message: 'stale_transition' }, { status: 400 }) }, 'token', new FakeNarrativeProvider(result));
    await expect(exact.finalizeFailure({ jobId: 'job-1', failureCode: 'finalization_failed', usage: { inputTokens: 1, outputTokens: 1 } })).rejects.toMatchObject({ code: 'stale_transition' });

    const misleading = createSupabaseGenerationDependencies({ url: 'http://supabase', anonKey: 'anon', fetch: async () => Response.json({ code: 'XX000', message: 'proxy mentioned stale_transition' }, { status: 500 }) }, 'token', new FakeNarrativeProvider(result));
    await expect(misleading.finalizeFailure({ jobId: 'job-1', failureCode: 'finalization_failed', usage: { inputTokens: 1, outputTokens: 1 } })).rejects.not.toBeInstanceOf(PersistenceError);
  });
});
