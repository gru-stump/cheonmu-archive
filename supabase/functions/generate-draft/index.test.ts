import { describe, expect, it, vi } from 'vitest';
import type { GenerationResult } from '../../../shared/narrative/contracts';
import type { ContextSelection, NarrativeMemory } from '../_shared/context';
import { FakeNarrativeProvider } from '../_shared/fake-provider';
import { createCorsPolicy } from '../_shared/cors.ts';
import type { NarrativeProvider } from '../_shared/provider';
import {
  CONTINUITY_POLICY_VERSION,
  PersistenceError,
  buildFrozenContinuityContext,
  createLocalFixtureProvider,
  createGenerateDraftHandler,
  createSupabaseGenerationDependencies,
  createSupabaseProviderSecretReader,
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
const policy: TrustedGenerationPolicy = { providerSettingId: 'setting-1', modelKey: 'fake-model', maxInputTokens: 500, maxOutputTokens: 200, maxRevisionOutputTokens: 80, inputCostMicrosPerMillion: 1_000_000, outputCostMicrosPerMillion: 2_000_000, fixedCostMicros: 5, providerKey: 'fake-local-provider', secretRef: null, secretSource: null };
const baseCommand = { authToken: 'valid-token', jobId: 'job-1', draftId: 'draft-1', idempotencyKey: 'request-1', mode: 'new' as const, kind: 'short_dialogue' as const };
const attemptToken = 'd3000000-0000-4000-8000-000000000001';

function harness(overrides: Partial<GenerationDependencies> & {
  provider?: NarrativeProvider;
  fenceProviderDispatch?: (input: { jobId: string; attemptToken: string }) => Promise<{ outcome: 'fenced' }>;
} = {}) {
  const events: string[] = [];
  const providerRequests: unknown[] = [];
  const finalized: unknown[] = [];
  const aborts: unknown[] = [];
  const provider = overrides.provider ?? { generate: async (request) => { events.push('provider'); providerRequests.push(request); return { result: { ...result, kind: request.kind }, usage: { inputTokens: 38, outputTokens: 80, costMicros: 37 }, rawId: 'raw-1', responseModel: 'canonical-fake-model' }; } };
  const { provider: _providerOverride, ...dependencyOverrides } = overrides;
  const deps = {
    createAttemptToken: () => attemptToken,
    authenticate: async () => { events.push('authenticate'); return { ownerId: 'owner-1' }; },
    authorize: async () => { events.push('authorize'); return { draftStatus: 'queued', draftKind: 'short_dialogue', workflowPhase: null, jobPayload: { source: 'schedule', budgetPolicy: 'block_at_risk', kind: 'short_dialogue' } }; },
    findIdempotent: async () => { events.push('idempotency'); return null; },
    loadPolicy: async () => { events.push('policy'); return policy; },
    selectContext: async () => { events.push('select'); return selection; },
    freezeContext: async (input) => { events.push('freeze'); return { ...policy, attemptToken: input.attemptToken, worstCaseCostMicros: estimateWorstCaseCostMicros(policy, input.mode), contextVersionIds: input.contextVersionIds, contextSnapshot: input.contextSnapshot }; },
    reserveAndStart: async () => { events.push('reserve-start'); return { status: 'reserved', budgetStatus: 'normal', remainingMicros: 999 }; },
    fenceProviderDispatch: async () => { events.push('fence'); return { outcome: 'fenced' as const }; },
    provider,
    resolveProvider: async () => { events.push('resolve-provider'); return provider; },
    parseProviderResponse: (value) => { events.push('parse'); return value as never; },
    checkContinuity: (_value, context) => { events.push('continuity'); expect(context.relationshipSourceId).toBe('canon-v1'); return { level: 'review', findings: [{ code: 'manual_semantic_review', level: 'review', message: 'review', sourceIds: context.selectedSourceIds }] }; },
    finalizeSuccess: async (input) => { events.push('finalize'); finalized.push(input); return { draftId: input.draftId, versionId: 'version-1', status: 'generated' }; },
    abortGenerationAttempt: async (input: unknown) => { events.push('abort'); aborts.push(input); return { outcome: 'aborted', jobStatus: 'failed' }; },
    ...dependencyOverrides,
  };
  return { deps: deps as GenerationDependencies, provider, events, providerRequests, finalized, aborts };
}

describe('trusted generation policy', () => {
  it('holds the loopback-only fake provider long enough to expose the reserved budget state', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const provider = createLocalFixtureProvider(sleep);

    const response = await provider.generate({ kind: 'short_dialogue', modelKey: 'fake-local-model' } as never);

    expect(sleep).toHaveBeenCalledWith(5_000);
    expect(response.usage).toEqual({ inputTokens: 14, outputTokens: 9 });
  });

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
    expect(h.events).toEqual(['authenticate', 'authorize', 'idempotency', 'policy', 'select', 'freeze', 'reserve-start', 'resolve-provider', 'fence', 'provider', 'parse', 'continuity', 'finalize']);
    expect(h.providerRequests).toMatchObject([{ modelKey: 'fake-model', maxInputTokens: 500, maxOutputTokens: 200, contextVersionIds: selection.versionIds,
      contextMemories: [{ versionId: 'canon-v1', content: canon.content, claims: canon.claims }, { versionId: 'feedback-v3', content: feedback.content }, { versionId: 'continuity-v2', content: continuity.content }],
    }]);
    expect(h.finalized).toMatchObject([{ continuityPolicyVersion: CONTINUITY_POLICY_VERSION, actualCostMicros: 203, contextVersionIds: selection.versionIds, providerResponseModel: 'canonical-fake-model' }]);
    expect(h.aborts).toEqual([]);
  });

  it.each([
    ['lost', async () => { throw new Error('lost fence response'); }],
    ['rejected', async () => ({ outcome: 'rejected' as const })],
    ['already dispatched', async () => ({ outcome: 'already_dispatched' as const })],
  ])('never calls the provider when the exact provider fence is %s', async (_case, fenceProviderDispatch) => {
    const h = harness({ fenceProviderDispatch: fenceProviderDispatch as never });

    await expect(runGeneration(h.deps, baseCommand)).rejects.toMatchObject({ code: 'generation_provider_fence_uncertain' });
    expect(h.events).toEqual(expect.arrayContaining(['reserve-start', 'resolve-provider', 'abort']));
    expect(h.providerRequests).toEqual([]);
    expect(h.events).not.toContain('provider');
  });

  it('stores blocked prose privately under policy', async () => {
    const h = harness({ checkContinuity: () => ({ level: 'block', findings: [{ code: 'forbidden', level: 'block', message: 'blocked', sourceIds: ['canon-v1'] }] }) });
    await expect(runGeneration(h.deps, baseCommand)).resolves.toMatchObject({ continuityLevel: 'block' });
    expect(h.finalized).toMatchObject([{ continuityLevel: 'block', visibility: 'private', continuityPolicyVersion: CONTINUITY_POLICY_VERSION }]);
  });

  it('returns a completed result before state and workflow checks', async () => {
    const existing = { draftId: 'draft-1', versionId: 'old', status: 'generated' as const, continuityLevel: 'review' as const };
    const h = harness({ authorize: async () => ({ draftStatus: 'generated', draftKind: 'short_dialogue', workflowPhase: 'final_approved', jobPayload: { source: 'schedule', budgetPolicy: 'block_at_risk', kind: 'short_dialogue' } }), findIdempotent: async () => existing });
    await expect(runGeneration(h.deps, baseCommand)).resolves.toEqual(existing);
    expect(h.providerRequests).toEqual([]);
  });

  it('validates kind and revision shape before any completed fast return', async () => {
    const existing = { draftId: 'draft-1', versionId: 'old', status: 'generated' as const, continuityLevel: 'review' as const };
    const wrongKind = harness({ findIdempotent: async () => existing });
    await expect(runGeneration(wrongKind.deps, { ...baseCommand, kind: 'daily_event' })).rejects.toMatchObject({ status: 400, code: 'draft_kind_mismatch' });
    expect(wrongKind.events).not.toContain('idempotency');

    const missingRevision = harness({ findIdempotent: async () => existing });
    await expect(runGeneration(missingRevision.deps, { ...baseCommand, mode: 'revise_selection' })).rejects.toMatchObject({ status: 400, code: 'revision_payload_required' });
    expect(missingRevision.events).not.toContain('idempotency');
  });

  it.each([
    ['changed', { revision: { selectedText: 'browser selection', instruction: 'browser instruction' }, requestedMaxOutputTokens: 1, seed: 'browser seed', tags: ['browser-tag'] }],
    ['omitted', {}],
  ] as const)('uses the persisted manual revision when caller content is %s', async (_case, callerContent) => {
    const contextCommands: unknown[] = [];
    const persistedRevision = { selectedText: 'database selection', instruction: 'database instruction' };
    const h = harness({
      authorize: async () => ({
        draftStatus: 'queued', draftKind: 'short_dialogue', workflowPhase: null,
        jobPayload: {
          source: 'manual', mode: 'revise_selection', kind: 'short_dialogue', manualRequestKey: 'request-1',
          revision: persistedRevision, requestedMaxOutputTokens: 80,
        },
      }),
      selectContext: async (_ownerId, effectiveCommand) => { contextCommands.push(effectiveCommand); return selection; },
    });

    await expect(runGeneration(h.deps, { ...baseCommand, mode: 'revise_selection', ...callerContent })).resolves.toMatchObject({ status: 'generated' });
    expect(contextCommands).toMatchObject([{ revision: persistedRevision, requestedMaxOutputTokens: 80 }]);
    expect(contextCommands[0]).not.toHaveProperty('seed');
    expect(contextCommands[0]).not.toHaveProperty('tags');
    expect(h.providerRequests).toMatchObject([{ revision: persistedRevision, maxOutputTokens: 80 }]);
    expect(h.providerRequests[0]).not.toHaveProperty('seed');
  });

  it('uses only persisted manual seed and tags for context selection and provider input', async () => {
    const contextCommands: unknown[] = [];
    const h = harness({
      authorize: async () => ({
        draftStatus: 'queued', draftKind: 'short_dialogue', workflowPhase: null,
        jobPayload: {
          source: 'manual', mode: 'new', kind: 'short_dialogue', manualRequestKey: 'request-1',
          seed: 'database seed', tags: ['database-tag'],
        },
      }),
      selectContext: async (_ownerId, effectiveCommand) => { contextCommands.push(effectiveCommand); return selection; },
    });

    await expect(runGeneration(h.deps, { ...baseCommand, seed: 'browser seed', tags: ['browser-tag'] })).resolves.toMatchObject({ status: 'generated' });
    expect(contextCommands).toMatchObject([{ seed: 'database seed', tags: ['database-tag'] }]);
    expect(h.providerRequests).toMatchObject([{ seed: 'database seed' }]);
  });

  it.each([
    ['revision without a ceiling', { source: 'manual', mode: 'revise_selection', kind: 'short_dialogue', manualRequestKey: 'request-1', revision: { selectedText: 'database selection', instruction: 'database instruction' } }],
    ['blank revision text', { source: 'manual', mode: 'revise_selection', kind: 'short_dialogue', manualRequestKey: 'request-1', revision: { selectedText: '   ', instruction: 'database instruction' }, requestedMaxOutputTokens: 80 }],
    ['oversized new tags', { source: 'manual', mode: 'new', kind: 'short_dialogue', manualRequestKey: 'request-1', tags: Array.from({ length: 11 }, (_, index) => `tag-${index}`) }],
  ])('fails closed on malformed persisted manual content: %s', async (_case, jobPayload) => {
    const h = harness({ authorize: async () => ({ draftStatus: 'queued', draftKind: 'short_dialogue', workflowPhase: null, jobPayload }) });
    await expect(runGeneration(h.deps, {
      ...baseCommand, mode: jobPayload.mode as 'new' | 'revise_selection',
      ...(jobPayload.mode === 'revise_selection' ? { revision: { selectedText: 'browser selection', instruction: 'browser instruction' }, requestedMaxOutputTokens: 80 } : {}),
    })).rejects.toMatchObject({ status: 409, code: 'manual_generation_binding_changed' });
    expect(h.events).not.toContain('idempotency');
    expect(h.events).not.toContain('select');
    expect(h.providerRequests).toEqual([]);
  });

  it('returns honest 402 state after safe idempotent cleanup without calling provider', async () => {
    const h = harness({ reserveAndStart: async () => ({ status: 'blocked', budgetStatus: 'period_limit_reached', remainingMicros: 12 }) });
    await expect(runGeneration(h.deps, baseCommand)).rejects.toMatchObject({ status: 402, code: 'budget_blocked', details: { budgetStatus: 'period_limit_reached', remainingMicros: 12 } });
    expect(h.providerRequests).toEqual([]);
    expect(h.aborts).toMatchObject([{ failureCode: 'budget_blocked' }]);
  });

  it.each([['major_event_scene_plan', 'proposal_approved'], ['major_event_draft', 'scene_plan_approved']] as const)('allows %s only for a major-event draft after its prerequisite', async (mode, workflowPhase) => {
    const h = harness({ authorize: async () => ({ draftStatus: 'queued', draftKind: 'major_event_proposal', workflowPhase, jobPayload: { source: 'schedule', budgetPolicy: 'block_at_risk', kind: 'major_event_proposal' } }) });
    await expect(runGeneration(h.deps, { ...baseCommand, mode, kind: 'major_event_proposal' })).resolves.toMatchObject({ status: 'generated' });
    expect(h.providerRequests).toMatchObject([{ mode, kind: 'major_event_proposal' }]);
  });

  it('aborts a freeze that committed before its response was lost', async () => {
    const h = harness({ freezeContext: async () => { throw new Error('response lost after commit'); } });
    await expect(runGeneration(h.deps, baseCommand)).rejects.toMatchObject({ status: 500, code: 'internal_error' });
    expect(h.aborts).toMatchObject([{ jobId: 'job-1', attemptToken, idempotencyKey: 'request-1', failureCode: 'freeze_failed' }]);
  });

  it('a concurrent duplicate freeze loser cannot abort the live winner', async () => {
    let winnerActive = true;
    const loserToken = 'd3000000-0000-4000-8000-000000000002';
    const h = harness({
      createAttemptToken: () => loserToken,
      freezeContext: async () => { throw new PersistenceError('duplicate_generation'); },
      abortGenerationAttempt: async (input) => {
        h.aborts.push(input);
        if (input.attemptToken === attemptToken) winnerActive = false;
        return { outcome: 'stale' };
      },
    });
    await expect(runGeneration(h.deps, baseCommand)).rejects.toMatchObject({ status: 409, code: 'duplicate_generation' });
    expect(h.aborts).toMatchObject([{ attemptToken: loserToken }]);
    expect(winnerActive).toBe(true);
  });

  it('a delayed abort from an old attempt cannot cancel its replacement', async () => {
    let replacementActive = true;
    const oldToken = 'd3000000-0000-4000-8000-000000000003';
    const replacementToken = 'd3000000-0000-4000-8000-000000000004';
    const h = harness({
      createAttemptToken: () => oldToken,
      reserveAndStart: async () => { throw new Error('delayed response loss'); },
      abortGenerationAttempt: async (input) => {
        h.aborts.push(input);
        if (input.attemptToken === replacementToken) replacementActive = false;
        return { outcome: 'stale' };
      },
    });
    await expect(runGeneration(h.deps, baseCommand)).rejects.toMatchObject({ status: 500, code: 'internal_error' });
    expect(h.aborts).toMatchObject([{ attemptToken: oldToken }]);
    expect(replacementActive).toBe(true);
  });

  it('aborts a reservation that committed before its response was lost', async () => {
    const h = harness({ reserveAndStart: async () => { throw new Error('response lost after reserve commit'); } });
    await expect(runGeneration(h.deps, baseCommand)).rejects.toMatchObject({ status: 500, code: 'internal_error' });
    expect(h.aborts).toMatchObject([{ failureCode: 'reservation_failed' }]);
    expect(h.providerRequests).toEqual([]);
  });

  it('aborts when the committed frozen snapshot response fails validation', async () => {
    const h = harness({ freezeContext: async (input) => ({ ...policy, worstCaseCostMicros: 1, contextVersionIds: input.contextVersionIds, contextSnapshot: input.contextSnapshot }) });
    await expect(runGeneration(h.deps, baseCommand)).rejects.toMatchObject({ status: 500, code: 'invalid_provider_setting' });
    expect(h.aborts).toMatchObject([{ failureCode: 'frozen_validation_failed' }]);
  });

  it.each([
    ['setting id', { ...policy, providerSettingId: 'other-owner-setting' }],
    ['model', { ...policy, modelKey: 'other-owner-model' }],
    ['token ceiling', { ...policy, maxOutputTokens: 201, worstCaseCostMicros: 907 }],
    ['pricing', { ...policy, fixedCostMicros: 6, worstCaseCostMicros: 906 }],
  ])('aborts before provider resolution when the frozen %s differs from the once-loaded owner setting', async (_field, mismatch) => {
    const h = harness({ freezeContext: async (input) => ({ ...mismatch, attemptToken: input.attemptToken, worstCaseCostMicros: 'worstCaseCostMicros' in mismatch ? mismatch.worstCaseCostMicros : estimateWorstCaseCostMicros(mismatch, input.mode), contextVersionIds: input.contextVersionIds, contextSnapshot: input.contextSnapshot }) });
    await expect(runGeneration(h.deps, baseCommand)).rejects.toMatchObject({ status: 500, code: 'invalid_provider_setting' });
    expect(h.events).not.toContain('resolve-provider');
    expect(h.providerRequests).toEqual([]);
    expect(h.aborts).toMatchObject([{ failureCode: 'frozen_validation_failed' }]);
  });

  it('resolves the provider only after reserve using the loaded owner setting and exact frozen policy', async () => {
    const seen: unknown[] = [];
    const h = harness({ resolveProvider: async (ownerId, loaded, frozen) => { seen.push({ ownerId, loaded, frozen }); return h.provider; } });
    await runGeneration(h.deps, baseCommand);
    expect(seen).toMatchObject([{ ownerId: 'owner-1', loaded: { providerSettingId: 'setting-1', providerKey: 'fake-local-provider', modelKey: 'fake-model' }, frozen: { providerSettingId: 'setting-1', modelKey: 'fake-model', attemptToken } }]);
    expect(h.events.indexOf('reserve-start')).toBeLessThan(h.events.indexOf('provider'));
  });

  it('recovers a completed result when finalization committed before response loss', async () => {
    const h = harness({ finalizeSuccess: async () => { throw new Error('response lost after finalization commit'); } });
    h.deps.abortGenerationAttempt = async (input) => {
      h.aborts.push(input);
      return { outcome: 'completed', result: { draftId: 'draft-1', versionId: 'committed-version', status: 'generated', continuityLevel: 'review' } };
    };
    await expect(runGeneration(h.deps, baseCommand)).resolves.toMatchObject({ versionId: 'committed-version', status: 'generated' });
    expect(h.aborts).toMatchObject([{ failureCode: 'finalization_failed' }]);
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

  it('maps the stable pre-freeze context budget conflict to 409 without aborting', async () => {
    const h = harness({ selectContext: async () => { throw new Error('context_budget_too_small'); } });
    await expect(runGeneration(h.deps, baseCommand)).rejects.toMatchObject({ status: 409, code: 'context_budget_too_small' });
    expect(h.aborts).toEqual([]);
  });

  it('maps a future-pricing reservation rejection to a stable conflict before provider work', async () => {
    const h = harness({ reserveAndStart: async () => { throw new PersistenceError('invalid_provider_pricing'); } });

    await expect(runGeneration(h.deps, baseCommand)).rejects.toMatchObject({ status: 409, code: 'invalid_provider_pricing' });
    expect(h.events).not.toContain('provider');
    expect(h.aborts).toMatchObject([{ failureCode: 'reservation_failed' }]);
  });

  it('bounds revision output and passes explicit selection/instruction', async () => {
    const h = harness();
    await runGeneration(h.deps, { ...baseCommand, mode: 'revise_selection', revision: { selectedText: '선택 문장', instruction: '말투만 다듬기' } });
    expect(h.providerRequests).toMatchObject([{ maxOutputTokens: 80, revision: { selectedText: '선택 문장', instruction: '말투만 다듬기' } }]);
  });

  it('honors the owner-confirmed revision token ceiling frozen by the database', async () => {
    const requestedPolicy = { ...policy, maxRevisionOutputTokens: 37 };
    const reservations: unknown[] = [];
    const requests: unknown[] = [];
    const h = harness({
      freezeContext: async (input) => ({ ...requestedPolicy, attemptToken: input.attemptToken, worstCaseCostMicros: estimateWorstCaseCostMicros(requestedPolicy, 'revise_selection'), contextVersionIds: input.contextVersionIds, contextSnapshot: input.contextSnapshot }),
      reserveAndStart: async (input) => { reservations.push(input); return { status: 'reserved', budgetStatus: 'normal', remainingMicros: 999 }; },
      provider: { generate: async (request) => { requests.push(request); return { result, usage: { inputTokens: 38, outputTokens: 37 }, rawId: 'requested-cap', responseModel: 'canonical-fake-model' }; } },
    });
    await runGeneration(h.deps, { ...baseCommand, mode: 'revise_selection', requestedMaxOutputTokens: 37, revision: { selectedText: '선택 문장', instruction: '말투만 다듬기' } });
    expect(requests).toMatchObject([{ maxOutputTokens: 37 }]);
    expect(reservations).toMatchObject([{ worstCaseCostMicros: 579 }]);
  });

  it('atomically aborts provider failure using the full reservation', async () => {
    const h = harness({ provider: { generate: async () => { throw new Error('raw secret response'); } } });
    await expect(runGeneration(h.deps, baseCommand)).rejects.toMatchObject({ status: 502, code: 'provider_generation_failed', details: undefined });
    expect(h.aborts).toMatchObject([{ failureCode: 'provider_generation_failed' }]);
    expect(h.events.filter((event) => event === 'abort')).toHaveLength(1);
  });

  it('logs only a stable failure code when a provider error contains secret material', async () => {
    const sentinel = 'provider-secret-sentinel-must-never-be-logged';
    const logged: unknown[][] = [];
    const error = vi.spyOn(console, 'error').mockImplementation((...values) => { logged.push(values); });
    try {
      const adapter = createSupabaseGenerationDependencies(
        { url: 'http://supabase', anonKey: 'anon', serviceRoleKey: 'service-secret', fetch: async () => Response.json({}) },
        'token',
        async () => ({ generate: async () => { throw new Error(sentinel); } }),
      );
      const h = harness({
        provider: { generate: async () => { throw new Error(sentinel); } },
        auditFailure: adapter.auditFailure,
      });
      await expect(runGeneration(h.deps, baseCommand)).rejects.toMatchObject({ code: 'provider_generation_failed' });
      const rendered = logged.flat().map((value) => value instanceof Error
        ? `${value.name}:${value.message}`
        : value && typeof value === 'object' ? JSON.stringify(value) : String(value)).join(' ');
      expect(rendered).toContain('provider_generation_failed');
      expect(rendered).not.toContain(sentinel);
    } finally {
      error.mockRestore();
    }
  });

  it('rejects provider kind mismatch and fails with known usage', async () => {
    const h = harness({ provider: { generate: async () => ({ result: { ...result, kind: 'daily_event' }, usage: { inputTokens: 30, outputTokens: 20, costMicros: 22 }, rawId: 'wrong' }) } });
    await expect(runGeneration(h.deps, baseCommand)).rejects.toMatchObject({ status: 502, code: 'provider_result_kind_mismatch' });
    expect(h.aborts).toMatchObject([{ failureCode: 'provider_result_kind_mismatch' }]);
  });

  it('rejects usage beyond trusted token caps even when provider-reported cost is low', async () => {
    const h = harness({ provider: { generate: async () => ({ result, usage: { inputTokens: 38, outputTokens: 201, costMicros: 1 }, rawId: 'over-cap' }) } });
    await expect(runGeneration(h.deps, baseCommand)).rejects.toMatchObject({ status: 502, code: 'provider_usage_exceeds_reservation' });
    expect(h.aborts).toMatchObject([{ failureCode: 'provider_usage_exceeds_reservation' }]);
  });

  it('calls atomic failure after finalization failure and maps confirmed stale to 409', async () => {
    const h = harness({ finalizeSuccess: async () => { throw new PersistenceError('stale_transition'); } });
    await expect(runGeneration(h.deps, baseCommand)).rejects.toMatchObject({ status: 409, code: 'stale_transition' });
    expect(h.aborts).toHaveLength(1);
  });

  it('sanitizes unknown infrastructure failures as 500, not 409', async () => {
    const h = harness({ freezeContext: async () => { throw new Error('socket contents'); } });
    await expect(runGeneration(h.deps, baseCommand)).rejects.toMatchObject({ status: 500, code: 'internal_error' });
  });

  it.each(['duplicate_generation', 'stale_transition', 'stale_version', 'stale_attempt', 'workflow_phase_not_approved', 'mode_kind_mismatch', 'active_provider_setting_required', 'context_budget_too_small', 'manual_generation_disabled', 'schedule_automation_disabled', 'manual_call_limit_reached', 'invalid_generation_source', 'manual_generation_binding_changed', 'generation_replay_mismatch'])('maps the explicit database conflict %s to 409', async (code) => {
    const h = harness({ freezeContext: async () => { throw new PersistenceError(code); } });
    await expect(runGeneration(h.deps, baseCommand)).rejects.toMatchObject({ status: 409, code });
  });
});

describe('generate-draft HTTP boundary', () => {
  it.each([undefined, 'Basic token', 'Bearer ', 'Bearer token extra'])('rejects malformed bearer authorization %s before calling dependencies', async (authorization) => {
    const h = harness();
    const { authToken: _authToken, ...body } = baseCommand;
    const headers = new Headers({ origin: 'https://admin.example.test', 'content-type': 'application/json' });
    if (authorization !== undefined) headers.set('authorization', authorization);
    const response = await createGenerateDraftHandler(h.deps, createCorsPolicy(['https://admin.example.test']))(new Request('http://local/generate', {
      method: 'POST', headers, body: JSON.stringify(body),
    }));
    expect(response.status).toBe(401);
    expect(response.headers.get('access-control-allow-origin')).toBe('https://admin.example.test');
    expect(h.events).toEqual([]);
  });

  it('handles allowlisted browser preflight and adds exact-origin CORS headers to errors', async () => {
    const h = harness();
    const cors = createCorsPolicy(['https://admin.example.test']);
    const handler = createGenerateDraftHandler(h.deps, cors);
    const preflight = await handler(new Request('http://local/generate', {
      method: 'OPTIONS',
      headers: { origin: 'https://admin.example.test', 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization, apikey, x-client-info, content-type' },
    }));
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-origin')).toBe('https://admin.example.test');
    expect(preflight.headers.get('access-control-allow-headers')).toBe('authorization, apikey, x-client-info, content-type');
    expect(preflight.headers.get('access-control-allow-credentials')).toBeNull();
    const error = await handler(new Request('http://local/generate', { method: 'GET', headers: { origin: 'https://admin.example.test' } }));
    expect(error.status).toBe(405);
    expect(error.headers.get('access-control-allow-origin')).toBe('https://admin.example.test');
    const denied = await handler(new Request('http://local/generate', { method: 'OPTIONS', headers: { origin: 'https://evil.example.test' } }));
    expect(denied.status).toBe(403);
    expect(denied.headers.get('access-control-allow-origin')).toBeNull();
    expect(h.events).toEqual([]);
  });

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

  it.each([
    ['changed', { revision: { selectedText: 'browser selection', instruction: 'browser instruction' }, requestedMaxOutputTokens: 1, seed: 'browser seed', tags: ['browser-tag'] }],
    ['omitted', {}],
  ] as const)('uses the database manual revision for a direct Edge request with %s caller content', async (_case, callerContent) => {
    const persistedRevision = { selectedText: 'database selection', instruction: 'database instruction' };
    const h = harness({ authorize: async () => ({
      draftStatus: 'queued', draftKind: 'short_dialogue', workflowPhase: null,
      jobPayload: {
        source: 'manual', mode: 'revise_selection', kind: 'short_dialogue', manualRequestKey: 'request-1',
        revision: persistedRevision, requestedMaxOutputTokens: 80,
      },
    }) });
    const { authToken: _authToken, ...body } = { ...baseCommand, mode: 'revise_selection' as const, ...callerContent };
    const response = await createGenerateDraftHandler(h.deps)(new Request('http://local/generate', {
      method: 'POST', headers: { authorization: 'Bearer token', 'content-type': 'application/json' }, body: JSON.stringify(body),
    }));

    expect(response.status).toBe(200);
    expect(h.providerRequests).toMatchObject([{ revision: persistedRevision, maxOutputTokens: 80 }]);
    expect(h.providerRequests[0]).not.toHaveProperty('seed');
  });

  it.each([
    ['missing source', {}],
    ['unknown source', { source: 'browser' }],
    ['schedule missing policy', { source: 'schedule' }],
    ['schedule unknown policy', { source: 'schedule', budgetPolicy: 'allow' }],
    ['access missing policy', { source: 'access' }],
    ['access warning policy', { source: 'access', budgetPolicy: 'block_at_warning' }],
  ])('returns stable invalid_generation_source for %s before provider work', async (_case, jobPayload) => {
    const h = harness({
      authorize: async () => ({ draftStatus: 'queued', draftKind: 'short_dialogue', workflowPhase: null, jobPayload }),
      freezeContext: async () => { throw new PersistenceError('invalid_generation_source'); },
    });
    const { authToken: _authToken, ...body } = baseCommand;
    const response = await createGenerateDraftHandler(h.deps)(new Request('http://local/generate', {
      method: 'POST', headers: { authorization: 'Bearer token', 'content-type': 'application/json' }, body: JSON.stringify(body),
    }));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: 'invalid_generation_source' });
    expect(h.providerRequests).toEqual([]);
  });
});

describe('Supabase generation adapter', () => {
  it('maps an expired or invalid bearer response to 401', async () => {
    const deps = createSupabaseGenerationDependencies({
      url: 'http://supabase', anonKey: 'anon', serviceRoleKey: 'service-secret',
      fetch: async () => Response.json({ message: 'invalid JWT' }, { status: 401 }),
    }, 'expired-token', async () => new FakeNarrativeProvider(result));
    await expect(deps.authenticate('expired-token')).rejects.toMatchObject({ status: 401, code: 'authentication_required' });
  });

  it('selects approval-tagged continuity for the next generation without admitting unapproved continuity', async () => {
    const fetch: typeof globalThis.fetch = async (input) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith('/memory_items')) return Response.json([
        { id: 'canon-v1', memory_type: 'canon', content: '관계 단계', status: 'approved', blocking: false, metadata: { tokenCount: 5, continuityFacts: { relationshipStage: 7 } } },
        { id: 'approved-v2', memory_type: 'continuity', content: '치료실에서 맺은 약속', status: 'approved', blocking: false, metadata: { tokenCount: 6, tags: ['치료실', '밤'], continuityFacts: { continuityId: 'approved-v2' } } },
        { id: 'unapproved-v3', memory_type: 'continuity', content: '검토되지 않은 사건', status: 'active', blocking: false, metadata: { tokenCount: 6, tags: ['치료실'], continuityFacts: { continuityId: 'unapproved-v3' } } },
      ]);
      return Response.json([]);
    };
    const deps = createSupabaseGenerationDependencies({ url: 'http://supabase', anonKey: 'anon', serviceRoleKey: 'service-secret', fetch }, 'token', async () => new FakeNarrativeProvider(result));
    const selected = await deps.selectContext('owner-1', { ...baseCommand, tags: ['치료실'] }, 500);
    expect(selected.versionIds).toEqual(['canon-v1', 'approved-v2']);
    expect(selected.continuity.map((memory) => memory.versionId)).toEqual(['approved-v2']);
  });

  it('authorizes both draft and job with the user client before service mutations', async () => {
    const seen: string[] = [];
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const path = new URL(String(input)).pathname;
      seen.push(`${path}:${new Headers(init?.headers).get('authorization')}`);
      if (path.endsWith('/drafts')) return Response.json([{ status: 'queued', kind: 'short_dialogue' }]);
      if (path.endsWith('/generation_jobs')) return Response.json([{ id: 'job-1', draft_id: 'draft-1', payload: { source: 'manual', mode: 'new', kind: 'short_dialogue', manualRequestKey: 'request-1', seed: 'database seed', tags: ['database-tag'] } }]);
      return Response.json([]);
    };
    const deps = createSupabaseGenerationDependencies({ url: 'http://supabase', anonKey: 'anon', serviceRoleKey: 'service-secret', fetch }, 'token', async () => new FakeNarrativeProvider(result));
    await expect(deps.authorize('owner-1', baseCommand)).resolves.toMatchObject({
      draftStatus: 'queued', draftKind: 'short_dialogue',
      jobPayload: { source: 'manual', mode: 'new', kind: 'short_dialogue', manualRequestKey: 'request-1', seed: 'database seed', tags: ['database-tag'] },
    });
    expect(seen).toEqual(['/rest/v1/drafts:Bearer token', '/rest/v1/generation_jobs:Bearer token']);
  });

  it('cannot return completed job B when queued prebound job A is invoked with B key', async () => {
    const fetch: typeof globalThis.fetch = async (input) => {
      const url = new URL(String(input));
      if (url.pathname === '/auth/v1/user') return Response.json({ id: 'owner-1' });
      if (url.pathname === '/rest/v1/drafts') return Response.json([{ status: 'queued', kind: 'short_dialogue' }]);
      if (url.pathname === '/rest/v1/generation_jobs' && url.searchParams.get('select') === 'id,draft_id,payload') {
        return Response.json([{ id: 'job-1', draft_id: 'draft-1', payload: { kind: 'short_dialogue', mode: 'new', manualRequestKey: 'queued-a-key' } }]);
      }
      if (url.pathname === '/rest/v1/generation_jobs') {
        if (url.searchParams.has('idempotency_key')) {
          return Response.json([{ id: 'job-b', draft_id: 'draft-b', status: 'completed', idempotency_key: 'completed-b-key', generation_mode: 'new', payload: { kind: 'short_dialogue', mode: 'new', manualRequestKey: 'completed-b-key' } }]);
        }
        expect(url.searchParams.get('id')).toBe('eq.job-1');
        return Response.json([{ id: 'job-1', draft_id: 'draft-1', status: 'queued', idempotency_key: null, generation_mode: null, payload: { kind: 'short_dialogue', mode: 'new', manualRequestKey: 'queued-a-key' } }]);
      }
      if (url.pathname === '/rest/v1/draft_versions') return Response.json([{ id: 'version-b', continuity_level: 'review' }]);
      return Response.json([]);
    };
    const deps = createSupabaseGenerationDependencies({ url: 'http://supabase', anonKey: 'anon', serviceRoleKey: 'service-secret', fetch }, 'token', async () => new FakeNarrativeProvider(result));

    await expect(runGeneration(deps, { ...baseCommand, idempotencyKey: 'completed-b-key' }))
      .rejects.toMatchObject({ status: 409, code: 'generation_replay_mismatch' });
  });

  it.each([
    ['mode', { mode: 'new', kind: 'short_dialogue', idempotencyKey: 'revision-key' }, 'generation_replay_mismatch'],
    ['kind', { mode: 'revise_selection', kind: 'daily_event', idempotencyKey: 'revision-key', revision: { selectedText: '문장', instruction: '수정' } }, 'draft_kind_mismatch'],
    ['key', { mode: 'revise_selection', kind: 'short_dialogue', idempotencyKey: 'wrong-key', revision: { selectedText: '문장', instruction: '수정' } }, 'generation_replay_mismatch'],
  ] as const)('rejects a completed same-job replay with the wrong %s', async (_field, overrides, expectedCode) => {
    const fetch: typeof globalThis.fetch = async (input) => {
      const url = new URL(String(input));
      if (url.pathname === '/auth/v1/user') return Response.json({ id: 'owner-1' });
      if (url.pathname === '/rest/v1/drafts') return Response.json([{ status: 'approved_private', kind: 'short_dialogue' }]);
      if (url.pathname === '/rest/v1/generation_jobs' && url.searchParams.get('select') === 'id,draft_id,payload') return Response.json([{ id: 'job-1', draft_id: 'draft-1', payload: { kind: 'short_dialogue', mode: 'revise_selection', manualRequestKey: 'revision-key' } }]);
      if (url.pathname === '/rest/v1/generation_jobs') return Response.json([{
        id: 'job-1', draft_id: 'draft-1', status: 'completed', idempotency_key: 'revision-key', generation_mode: 'revise_selection',
        payload: { kind: 'short_dialogue', mode: 'revise_selection', manualRequestKey: 'revision-key' },
      }]);
      if (url.pathname === '/rest/v1/draft_versions') return Response.json([{ id: 'version-1', continuity_level: 'review' }]);
      return Response.json([]);
    };
    const deps = createSupabaseGenerationDependencies({ url: 'http://supabase', anonKey: 'anon', serviceRoleKey: 'service-secret', fetch }, 'token', async () => new FakeNarrativeProvider(result));

    await expect(runGeneration(deps, { ...baseCommand, ...overrides } as never)).rejects.toMatchObject({ code: expectedCode });
  });

  it('returns only the exact completed job/draft/key/mode/kind retry after draft state advanced', async () => {
    const fetch: typeof globalThis.fetch = async (input) => {
      const url = new URL(String(input));
      if (url.pathname === '/auth/v1/user') return Response.json({ id: 'owner-1' });
      if (url.pathname === '/rest/v1/drafts') return Response.json([{ status: 'approved_private', kind: 'short_dialogue' }]);
      if (url.pathname === '/rest/v1/generation_jobs' && url.searchParams.get('select') === 'id,draft_id,payload') return Response.json([{ id: 'job-1', draft_id: 'draft-1', payload: { kind: 'short_dialogue', mode: 'revise_selection', manualRequestKey: 'revision-key' } }]);
      if (url.pathname === '/rest/v1/generation_jobs') return Response.json([{
        id: 'job-1', draft_id: 'draft-1', status: 'completed', idempotency_key: 'revision-key', generation_mode: 'revise_selection',
        payload: { kind: 'short_dialogue', mode: 'revise_selection', manualRequestKey: 'revision-key' },
      }]);
      if (url.pathname === '/rest/v1/draft_versions') return Response.json([{ id: 'version-1', continuity_level: 'review' }]);
      return Response.json([]);
    };
    const deps = createSupabaseGenerationDependencies({ url: 'http://supabase', anonKey: 'anon', serviceRoleKey: 'service-secret', fetch }, 'token', async () => new FakeNarrativeProvider(result));

    await expect(runGeneration(deps, {
      ...baseCommand, mode: 'revise_selection', idempotencyKey: 'revision-key',
      revision: { selectedText: '문장', instruction: '수정' },
    })).resolves.toEqual({ draftId: 'draft-1', versionId: 'version-1', status: 'generated', continuityLevel: 'review' });
  });

  it('returns an exact completed manual revision replay when caller content is omitted', async () => {
    const persistedRevision = { selectedText: 'database selection', instruction: 'database instruction' };
    const payload = {
      source: 'manual', mode: 'revise_selection', kind: 'short_dialogue', manualRequestKey: 'revision-key',
      revision: persistedRevision, requestedMaxOutputTokens: 64,
    };
    const fetch: typeof globalThis.fetch = async (input) => {
      const url = new URL(String(input));
      if (url.pathname === '/auth/v1/user') return Response.json({ id: 'owner-1' });
      if (url.pathname === '/rest/v1/drafts') return Response.json([{ status: 'approved_private', kind: 'short_dialogue' }]);
      if (url.pathname === '/rest/v1/generation_jobs' && ['id,draft_id', 'id,draft_id,payload'].includes(url.searchParams.get('select') ?? '')) {
        return Response.json([{ id: 'job-1', draft_id: 'draft-1', payload }]);
      }
      if (url.pathname === '/rest/v1/generation_jobs') return Response.json([{
        id: 'job-1', draft_id: 'draft-1', status: 'completed', idempotency_key: 'revision-key', generation_mode: 'revise_selection', payload,
      }]);
      if (url.pathname === '/rest/v1/draft_versions') return Response.json([{ id: 'version-1', continuity_level: 'review' }]);
      return Response.json([]);
    };
    const deps = createSupabaseGenerationDependencies({ url: 'http://supabase', anonKey: 'anon', serviceRoleKey: 'service-secret', fetch }, 'token', async () => new FakeNarrativeProvider(result));

    await expect(runGeneration(deps, {
      ...baseCommand, mode: 'revise_selection', idempotencyKey: 'revision-key',
    })).resolves.toEqual({ draftId: 'draft-1', versionId: 'version-1', status: 'generated', continuityLevel: 'review' });
  });

  it('loads trusted settings and uses atomic start/success RPCs', async () => {
    const calls: string[] = [];
    const authorizations: Array<{ path: string; value: string | null }> = [];
    const requestBodies: Array<{ path: string; value: unknown }> = [];
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const path = new URL(String(input)).pathname + new URL(String(input)).search;
      calls.push(`${init?.method ?? 'GET'} ${path}`);
      authorizations.push({ path, value: new Headers(init?.headers).get('authorization') });
      requestBodies.push({ path, value: init?.body ? JSON.parse(String(init.body)) : null });
      if (path.startsWith('/rest/v1/provider_settings?')) return Response.json([{ id: 'setting-1', owner_id: 'owner-1', provider_key: 'fake-local-provider', enabled: true, configuration: { mode: 'fixture' }, model_key: 'fake-model', max_input_tokens: 500, max_output_tokens: 200, max_revision_output_tokens: 80, input_cost_micros_per_million: 1000000, output_cost_micros_per_million: 2000000, fixed_cost_micros: 5 }]);
      if (path.endsWith('/rpc/freeze_generation_context')) return Response.json({ id: 'job-1', attempt_token: attemptToken, provider_setting_id: 'setting-1', model_key: 'fake-model', max_input_tokens: 500, max_output_tokens: 200, max_revision_output_tokens: 80, input_cost_micros_per_million: 1000000, output_cost_micros_per_million: 2000000, fixed_cost_micros: 5, worst_case_cost_micros: 905, context_version_ids: selection.versionIds, context_snapshot: selection.versionIds.map((versionId, index) => ({ versionId, memoryType: index === 0 ? 'canon' : index === 1 ? 'feedback' : 'continuity', content: 'frozen', tokenCount: 1 })) });
      if (path.endsWith('/rpc/reserve_and_start_generation')) return Response.json({ status: 'reserved', budgetStatus: 'normal', remainingMicros: 50 });
      if (path.endsWith('/rpc/finalize_generation_success')) return Response.json({ id: 'version-1', draft_id: 'draft-1' });
      if (path.endsWith('/rpc/abort_generation_attempt')) return Response.json({ outcome: 'aborted', jobStatus: 'queued' });
      return Response.json({ id: 'ok' });
    };
    const deps = createSupabaseGenerationDependencies({ url: 'http://supabase', anonKey: 'anon', serviceRoleKey: 'service-secret', fetch }, 'token', async () => new FakeNarrativeProvider(result));
    await expect(deps.loadPolicy('owner-1', baseCommand)).resolves.toMatchObject({ modelKey: 'fake-model', maxInputTokens: 500 });
    await expect(deps.freezeContext({ ownerId: 'owner-1', jobId: 'job-1', draftId: 'draft-1', idempotencyKey: 'key', mode: 'new', contextVersionIds: selection.versionIds, contextSnapshot: selection.versionIds.map((versionId, index) => ({ versionId, memoryType: index === 0 ? 'canon' : index === 1 ? 'feedback' : 'continuity', content: 'frozen', tokenCount: 1 })), providerSettingId: 'setting-1', attemptToken })).resolves.toMatchObject({ providerSettingId: 'setting-1', worstCaseCostMicros: 905, attemptToken });
    await expect(deps.reserveAndStart({ jobId: 'job-1', draftId: 'draft-1', attemptToken, worstCaseCostMicros: 905 })).resolves.toMatchObject({ remainingMicros: 50 });
    await expect(deps.finalizeSuccess({ ownerId: 'owner-1', jobId: 'job-1', draftId: 'draft-1', attemptToken, result, usage: { inputTokens: 1, outputTokens: 1, costMicros: 2 }, actualCostMicros: 2, contextVersionIds: selection.versionIds, continuityLevel: 'review', findings: [], providerResponseId: 'raw', providerResponseModel: 'canonical-fake-model', visibility: 'private', continuityPolicyVersion: CONTINUITY_POLICY_VERSION })).resolves.toMatchObject({ versionId: 'version-1' });
    await expect(deps.abortGenerationAttempt({ jobId: 'job-1', attemptToken, idempotencyKey: 'key', failureCode: 'finalization_failed' })).resolves.toMatchObject({ outcome: 'aborted' });
    expect(calls).toEqual(expect.arrayContaining(['POST /rest/v1/rpc/reserve_and_start_generation', 'POST /rest/v1/rpc/finalize_generation_success']));
    expect(requestBodies.find(({ path }) => path.endsWith('/rpc/finalize_generation_success'))?.value).toMatchObject({ p_provider_response_model: 'canonical-fake-model' });
    expect(calls.some((call) => call.includes('reconcile_generation_budget') || call.includes('store_generation_result'))).toBe(false);
    expect(authorizations.find(({ path }) => path.startsWith('/rest/v1/provider_settings?'))?.value).toBe('Bearer service-secret');
    expect(authorizations.filter(({ path }) => path.startsWith('/rest/v1/rpc/')).map(({ value }) => value)).toEqual(['Bearer service-secret', 'Bearer service-secret', 'Bearer service-secret', 'Bearer service-secret']);
  });

  it('selects exactly one active row for the authenticated owner without being affected by another owner', async () => {
    const fetch: typeof globalThis.fetch = async (input) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith('/provider_settings')) return Response.json([
        { id: 'owner-2-setting', owner_id: 'owner-2', provider_key: 'anthropic', enabled: true, configuration: { apiKeyEnv: 'OWNER_TWO_KEY' }, model_key: 'owner-two-model', max_input_tokens: 900, max_output_tokens: 300, max_revision_output_tokens: 100, input_cost_micros_per_million: 9, output_cost_micros_per_million: 9, fixed_cost_micros: 9 },
        { id: 'setting-1', owner_id: 'owner-1', provider_key: 'openai', enabled: true, configuration: { apiKeyEnv: 'OWNER_ONE_KEY' }, model_key: 'fake-model', max_input_tokens: 500, max_output_tokens: 200, max_revision_output_tokens: 80, input_cost_micros_per_million: 1_000_000, output_cost_micros_per_million: 2_000_000, fixed_cost_micros: 5 },
      ]);
      return Response.json([]);
    };
    const deps = createSupabaseGenerationDependencies({ url: 'http://supabase', anonKey: 'anon', serviceRoleKey: 'service-secret', fetch }, 'token', async () => new FakeNarrativeProvider(result));
    await expect(deps.loadPolicy('owner-1', baseCommand)).resolves.toMatchObject({ providerSettingId: 'setting-1', providerKey: 'openai', modelKey: 'fake-model', secretRef: 'OWNER_ONE_KEY', secretSource: 'env' });
  });

  it('accepts only the owner/provider-bound Vault reference and reads it with the service credential', async () => {
    const seen: Array<{ authorization: string | null; body: unknown }> = [];
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith('/provider_settings')) return Response.json([{ id: 'setting-1', owner_id: 'owner-1', provider_key: 'openai', enabled: true, configuration: { vaultSecretName: 'narrative_owner-1_openai' }, model_key: 'server-model', max_input_tokens: 500, max_output_tokens: 200, max_revision_output_tokens: 80, input_cost_micros_per_million: 1, output_cost_micros_per_million: 2, fixed_cost_micros: 0 }]);
      seen.push({ authorization: new Headers(init?.headers).get('authorization'), body: init?.body ? JSON.parse(String(init.body)) : null });
      return Response.json('resolved-material');
    };
    const config = { url: 'http://supabase', anonKey: 'anon', serviceRoleKey: 'service-credential', fetch };
    const deps = createSupabaseGenerationDependencies(config, 'token', async () => new FakeNarrativeProvider(result));
    const loaded = await deps.loadPolicy('owner-1', baseCommand);
    expect(loaded).toMatchObject({ providerKey: 'openai', secretSource: 'vault', secretRef: 'narrative_owner-1_openai' });
    await expect(createSupabaseProviderSecretReader(config)('owner-1', 'openai')).resolves.toBe('resolved-material');
    expect(seen).toEqual([{ authorization: 'Bearer service-credential', body: { p_owner_id: 'owner-1', p_secret_kind: 'openai' } }]);
  });

  it.each([
    ['zero', []],
    ['multiple', [
      { id: 'setting-1', owner_id: 'owner-1', provider_key: 'openai', enabled: true, configuration: { apiKeyEnv: 'ONE' }, model_key: 'a', max_input_tokens: 1, max_output_tokens: 1, max_revision_output_tokens: 1, input_cost_micros_per_million: 0, output_cost_micros_per_million: 0, fixed_cost_micros: 0 },
      { id: 'setting-2', owner_id: 'owner-1', provider_key: 'anthropic', enabled: true, configuration: { apiKeyEnv: 'TWO' }, model_key: 'b', max_input_tokens: 1, max_output_tokens: 1, max_revision_output_tokens: 1, input_cost_micros_per_million: 0, output_cost_micros_per_million: 0, fixed_cost_micros: 0 },
    ]],
  ])('rejects %s active settings for the authenticated owner', async (_case, rows) => {
    const deps = createSupabaseGenerationDependencies({ url: 'http://supabase', anonKey: 'anon', serviceRoleKey: 'service-secret', fetch: async () => Response.json(rows) }, 'token', async () => new FakeNarrativeProvider(result));
    await expect(deps.loadPolicy('owner-1', baseCommand)).rejects.toMatchObject({ status: 409, code: 'active_provider_setting_required' });
  });

  it('recognizes only exact P0001 storage conflict codes', async () => {
    const exact = createSupabaseGenerationDependencies({ url: 'http://supabase', anonKey: 'anon', serviceRoleKey: 'service-secret', fetch: async () => Response.json({ code: 'P0001', message: 'stale_transition' }, { status: 400 }) }, 'token', async () => new FakeNarrativeProvider(result));
    await expect(exact.abortGenerationAttempt({ jobId: 'job-1', attemptToken, idempotencyKey: 'key', failureCode: 'finalization_failed' })).rejects.toMatchObject({ code: 'stale_transition' });

    const misleading = createSupabaseGenerationDependencies({ url: 'http://supabase', anonKey: 'anon', serviceRoleKey: 'service-secret', fetch: async () => Response.json({ code: 'XX000', message: 'proxy mentioned stale_transition' }, { status: 500 }) }, 'token', async () => new FakeNarrativeProvider(result));
    await expect(misleading.abortGenerationAttempt({ jobId: 'job-1', attemptToken, idempotencyKey: 'key', failureCode: 'finalization_failed' })).rejects.not.toBeInstanceOf(PersistenceError);
  });
});
