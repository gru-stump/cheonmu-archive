import { z } from 'zod';
import { draftKinds, generationModes, type DraftKind, type DraftStatus, type GenerationMode, type GenerationRequest, type GenerationResult, type Usage } from '../../../shared/narrative/contracts.ts';
import { selectNarrativeContext, type ContextSelection, type NarrativeMemory } from '../_shared/context.ts';
import { checkContinuity, type ContinuityCheck, type ContinuityContext } from '../_shared/continuity.ts';
import { createServerNarrativeProvider, parseNarrativeProviderResponse, type NarrativeProvider, type NarrativeProviderResponse } from '../_shared/provider.ts';
import { corsGate, corsPolicyFromEnvironment, createCorsPolicy, withCorsHeaders, type CorsPolicy } from '../_shared/cors.ts';
import { bearerToken } from '../_shared/auth.ts';

export const CONTINUITY_POLICY_VERSION = 'cheonmu-continuity-v1';
export type { GenerationMode };

export interface GenerationCommand {
  authToken: string;
  jobId: string;
  draftId: string;
  idempotencyKey: string;
  mode: GenerationMode;
  kind: DraftKind;
  seed?: string;
  tags?: string[];
  revision?: { selectedText: string; instruction: string };
  requestedMaxOutputTokens?: number;
}

export interface GenerationPolicyValues {
  providerSettingId: string;
  modelKey: string;
  maxInputTokens: number;
  maxOutputTokens: number;
  maxRevisionOutputTokens: number;
  inputCostMicrosPerMillion: number;
  outputCostMicrosPerMillion: number;
  fixedCostMicros: number;
}

export interface TrustedGenerationPolicy extends GenerationPolicyValues {
  providerKey: 'openai' | 'anthropic' | 'fake-local-provider';
  secretRef: string | null;
  secretSource: 'env' | 'vault' | null;
}

export interface FrozenGenerationPolicy extends GenerationPolicyValues {
  attemptToken: string;
  worstCaseCostMicros: number;
  contextVersionIds: string[];
  contextSnapshot: GenerationRequest['contextMemories'];
}

export interface GenerationResponse {
  draftId: string;
  versionId: string;
  status: 'generated';
  continuityLevel: ContinuityCheck['level'];
}

export type AbortGenerationResult =
  | { outcome: 'aborted'; jobStatus: 'queued' | 'failed' | 'cancelled' }
  | { outcome: 'stale' }
  | { outcome: 'completed'; result: GenerationResponse };

export type GenerationFailureCode =
  | 'freeze_failed' | 'frozen_validation_failed' | 'reservation_failed' | 'budget_blocked'
  | 'provider_generation_failed' | 'provider_response_invalid' | 'provider_result_kind_mismatch'
  | 'provider_usage_exceeds_reservation' | 'continuity_check_failed' | 'finalization_failed';

export interface GenerationDependencies {
  createAttemptToken(): string;
  authenticate(token: string): Promise<{ ownerId: string }>;
  authorize(ownerId: string, command: GenerationCommand): Promise<{ draftStatus: DraftStatus; draftKind: DraftKind; workflowPhase: string | null }>;
  findIdempotent(ownerId: string, command: GenerationCommand): Promise<GenerationResponse | null>;
  loadPolicy(ownerId: string, command: GenerationCommand): Promise<TrustedGenerationPolicy>;
  selectContext(ownerId: string, command: GenerationCommand, inputTokenBudget: number): Promise<ContextSelection>;
  freezeContext(input: {
    ownerId: string; jobId: string; draftId: string; idempotencyKey: string; mode: GenerationMode;
    contextVersionIds: string[]; contextSnapshot: GenerationRequest['contextMemories']; providerSettingId: string; attemptToken: string;
  }): Promise<FrozenGenerationPolicy>;
  reserveAndStart(input: { jobId: string; draftId: string; attemptToken: string; worstCaseCostMicros: number }): Promise<
    | { status: 'reserved'; budgetStatus: string; remainingMicros: number | null }
    | { status: 'blocked'; budgetStatus: string; remainingMicros: number | null }
  >;
  resolveProvider(ownerId: string, loadedPolicy: TrustedGenerationPolicy, frozenPolicy: FrozenGenerationPolicy): NarrativeProvider | Promise<NarrativeProvider>;
  parseProviderResponse(value: unknown): NarrativeProviderResponse;
  checkContinuity(result: GenerationResult, context: ContinuityContext): ContinuityCheck;
  finalizeSuccess(input: {
    ownerId: string; jobId: string; draftId: string; attemptToken: string; result: GenerationResult; usage: Usage; actualCostMicros: number;
    contextVersionIds: string[]; continuityLevel: ContinuityCheck['level']; findings: ContinuityCheck['findings'];
    providerResponseId: string; providerResponseModel: string; visibility: 'private'; continuityPolicyVersion: typeof CONTINUITY_POLICY_VERSION;
  }): Promise<{ draftId: string; versionId: string; status: 'generated' }>;
  abortGenerationAttempt(input: { jobId: string; attemptToken: string; idempotencyKey: string; failureCode: GenerationFailureCode }): Promise<AbortGenerationResult>;
  auditFailure?(stage: string): void;
}

export interface SupabaseRestConfig { url: string; anonKey: string; serviceRoleKey: string; fetch?: typeof globalThis.fetch }

export class GenerationError extends Error {
  constructor(public readonly status: number, public readonly code: string, public readonly details?: Record<string, unknown>) {
    super(code); this.name = 'GenerationError';
  }
}

/** Only database adapters construct this after matching an explicit stable database code. */
export class PersistenceError extends Error {
  constructor(public readonly code: string) { super(code); this.name = 'PersistenceError'; }
}

const bodySchema = z.object({
  jobId: z.string().trim().min(1), draftId: z.string().trim().min(1), idempotencyKey: z.string().trim().min(1),
  mode: z.enum(generationModes), kind: z.enum(draftKinds),
  seed: z.string().max(4_000).optional(), tags: z.array(z.string().max(100)).max(20).optional(),
  revision: z.object({ selectedText: z.string().trim().min(1).max(4_000), instruction: z.string().trim().min(1).max(1_000) }).strict().optional(),
  requestedMaxOutputTokens: z.number().int().positive().optional(),
}).strict();

const narrativeClaimSchema = z.object({
  id: z.string().min(1), sourceId: z.string().min(1), sourcePriority: z.number().int(),
  status: z.enum(['confirmed', 'unresolved', 'conflicting', 'request-only']), revealStage: z.number().int().nonnegative(), text: z.string().min(1),
});
const continuityFactsSchema = z.object({
  relationshipStage: z.number().int().nonnegative().optional(),
  forbiddenReveals: z.array(z.object({ term: z.string().min(1), allowedAtRelationshipStage: z.number().int().nonnegative() })).optional(),
  permanentEntities: z.array(z.string().min(1)).optional(), permanentSettings: z.array(z.string().min(1)).optional(),
  continuityId: z.string().min(1).optional(), rejectedMotifs: z.array(z.string().min(1)).optional(), voiceAndTitleRules: z.boolean().optional(),
});
const memoryMetadataSchema = z.object({
  tokenCount: z.number().int().nonnegative().optional(),
  tags: z.array(z.string()).optional(),
  claims: z.array(narrativeClaimSchema).optional(),
  continuityFacts: continuityFactsSchema.optional(),
}).passthrough();
const frozenMemorySchema = z.object({
  versionId: z.string().min(1), memoryType: z.enum(['canon', 'feedback', 'continuity', 'summary']),
  content: z.string(), tokenCount: z.number().int().nonnegative(), claims: z.array(narrativeClaimSchema).optional(),
  continuityFacts: continuityFactsSchema.optional(),
}).strict();
const reservationResultSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('reserved'), budgetStatus: z.string().min(1), remainingMicros: z.number().int().nonnegative().nullable() }),
  z.object({ status: z.literal('blocked'), budgetStatus: z.string().min(1), remainingMicros: z.number().int().nonnegative().nullable() }),
]);
const generationResponseSchema = z.object({
  draftId: z.string().min(1), versionId: z.string().min(1), status: z.literal('generated'), continuityLevel: z.enum(['pass', 'review', 'block']),
});
const abortResultSchema = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('aborted'), jobStatus: z.enum(['queued', 'failed', 'cancelled']) }),
  z.object({ outcome: z.literal('stale') }),
  z.object({ outcome: z.literal('completed'), result: generationResponseSchema }),
]);

export function estimateWorstCaseCostMicros(policy: GenerationPolicyValues, mode: GenerationMode): number {
  const outputTokens = mode === 'revise_selection' ? Math.min(policy.maxOutputTokens, policy.maxRevisionOutputTokens) : policy.maxOutputTokens;
  const cost = policy.fixedCostMicros
    + Math.ceil(policy.maxInputTokens * policy.inputCostMicrosPerMillion / 1_000_000)
    + Math.ceil(outputTokens * policy.outputCostMicrosPerMillion / 1_000_000);
  if (!Number.isSafeInteger(cost) || cost < 0) throw new GenerationError(500, 'invalid_provider_setting');
  return cost;
}

/** Provider-reported money is audit data; accounting always uses frozen trusted rates. */
export function estimateActualCostMicros(policy: GenerationPolicyValues, usage: Usage): number {
  const cost = policy.fixedCostMicros
    + Math.ceil(usage.inputTokens * policy.inputCostMicrosPerMillion / 1_000_000)
    + Math.ceil(usage.outputTokens * policy.outputCostMicrosPerMillion / 1_000_000);
  if (!Number.isSafeInteger(cost) || cost < 0) throw new GenerationError(500, 'invalid_provider_setting');
  return cost;
}

function orderedMemories(selection: ContextSelection): NarrativeMemory[] {
  const byId = new Map([...selection.fixedCanon, ...selection.continuity, ...selection.recent, ...selection.feedback].map((memory) => [memory.versionId, memory]));
  return selection.versionIds.map((id) => byId.get(id)).filter((memory): memory is NarrativeMemory => memory !== undefined);
}

function contextSnapshot(selection: ContextSelection): GenerationRequest['contextMemories'] {
  return orderedMemories(selection).map((memory) => ({
    versionId: memory.versionId, memoryType: memory.memoryType, content: memory.content, tokenCount: memory.tokenCount,
    ...(memory.claims ? { claims: memory.claims.map((claim) => ({ ...claim })) } : {}),
    ...(memory.continuityFacts ? { continuityFacts: structuredClone(memory.continuityFacts) } : {}),
  }));
}

function selectionFromSnapshot(versionIds: string[], snapshot: GenerationRequest['contextMemories']): ContextSelection {
  const memories: NarrativeMemory[] = snapshot.map((memory) => ({ ...memory, status: 'frozen' }));
  const byId = new Map(memories.map((memory) => [memory.versionId, memory]));
  const ordered = versionIds.map((id) => byId.get(id)).filter((memory): memory is NarrativeMemory => memory !== undefined);
  if (ordered.length !== versionIds.length || snapshot.length !== versionIds.length) throw new GenerationError(500, 'invalid_frozen_context');
  return {
    versionIds, fixedCanon: ordered.filter((memory) => memory.memoryType === 'canon'),
    continuity: ordered.filter((memory) => memory.memoryType === 'continuity'), recent: ordered.filter((memory) => memory.memoryType === 'summary'),
    feedback: ordered.filter((memory) => memory.memoryType === 'feedback'), claims: ordered.flatMap((memory) => memory.claims ?? []),
    tokenCount: ordered.reduce((total, memory) => total + memory.tokenCount, 0),
  };
}

export function buildFrozenContinuityContext(selection: ContextSelection): ContinuityContext {
  const memories = orderedMemories(selection);
  const relationship = memories
    .filter((memory) => Number.isSafeInteger(memory.continuityFacts?.relationshipStage))
    .sort((left, right) => left.continuityFacts!.relationshipStage! - right.continuityFacts!.relationshipStage!)[0];
  if (!relationship || relationship.continuityFacts?.relationshipStage === undefined) throw new GenerationError(409, 'continuity_context_incomplete');
  return {
    selectedSourceIds: selection.versionIds,
    currentRelationshipStage: relationship.continuityFacts.relationshipStage,
    relationshipSourceId: relationship.versionId,
    forbiddenRevealTerms: memories.flatMap((memory) => (memory.continuityFacts?.forbiddenReveals ?? []).map((fact) => ({ ...fact, sourceId: memory.versionId }))),
    knownPermanentEntities: memories.flatMap((memory) => (memory.continuityFacts?.permanentEntities ?? []).map((name) => ({ name, sourceId: memory.versionId }))),
    knownPermanentSettings: memories.flatMap((memory) => (memory.continuityFacts?.permanentSettings ?? []).map((name) => ({ name, sourceId: memory.versionId }))),
    approvedContinuity: selection.continuity.map((memory) => ({ id: memory.continuityFacts?.continuityId ?? memory.versionId, sourceId: memory.versionId })),
    rejectedMotifs: memories.flatMap((memory) => (memory.continuityFacts?.rejectedMotifs ?? []).map((term) => ({ term, sourceId: memory.versionId }))),
    voiceAndTitleSourceIds: memories.filter((memory) => memory.continuityFacts?.voiceAndTitleRules === true).map((memory) => memory.versionId),
  };
}

function validateCommand(command: GenerationCommand, draftKind: DraftKind): void {
  if (command.kind !== draftKind) throw new GenerationError(400, 'draft_kind_mismatch');
  if ((command.mode === 'major_event_scene_plan' || command.mode === 'major_event_draft') && command.kind !== 'major_event_proposal') throw new GenerationError(400, 'mode_kind_mismatch');
  if (command.mode === 'revise_selection' && !command.revision) throw new GenerationError(400, 'revision_payload_required');
  if (command.mode !== 'revise_selection' && command.revision) throw new GenerationError(400, 'revision_payload_forbidden');
  if (command.mode !== 'revise_selection' && command.requestedMaxOutputTokens !== undefined) throw new GenerationError(400, 'revision_token_limit_forbidden');
}

function prerequisiteApproved(mode: GenerationMode, phase: string | null): boolean {
  if (mode === 'major_event_scene_plan') return phase === 'proposal_approved';
  if (mode === 'major_event_draft') return phase === 'scene_plan_approved';
  return true;
}

function sameFrozenPolicy(loaded: TrustedGenerationPolicy, frozen: FrozenGenerationPolicy, command: GenerationCommand): boolean {
  const revisionLimitMatches = command.mode === 'revise_selection' && command.requestedMaxOutputTokens !== undefined
    ? command.requestedMaxOutputTokens <= loaded.maxRevisionOutputTokens
      && frozen.maxRevisionOutputTokens === Math.min(loaded.maxOutputTokens, command.requestedMaxOutputTokens)
    : loaded.maxRevisionOutputTokens === frozen.maxRevisionOutputTokens;
  return loaded.providerSettingId === frozen.providerSettingId && loaded.modelKey === frozen.modelKey
    && loaded.maxInputTokens === frozen.maxInputTokens && loaded.maxOutputTokens === frozen.maxOutputTokens
    && revisionLimitMatches
    && loaded.inputCostMicrosPerMillion === frozen.inputCostMicrosPerMillion
    && loaded.outputCostMicrosPerMillion === frozen.outputCostMicrosPerMillion
    && loaded.fixedCostMicros === frozen.fixedCostMicros;
}

const stableConflictCodes = new Set([
  'duplicate_generation', 'stale_transition', 'stale_version', 'workflow_phase_not_approved',
  'mode_kind_mismatch', 'active_provider_setting_required', 'context_budget_too_small', 'stale_attempt',
  'stale_provider_pricing', 'invalid_provider_pricing', 'manual_generation_disabled',
  'schedule_automation_disabled', 'manual_call_limit_reached', 'invalid_generation_source',
  'manual_generation_binding_changed', 'generation_replay_mismatch',
]);

function mapPersistence(error: unknown, fallbackCode = 'internal_error'): GenerationError {
  if (error instanceof GenerationError) return error;
  if (error instanceof PersistenceError && stableConflictCodes.has(error.code)) return new GenerationError(409, error.code);
  return new GenerationError(500, fallbackCode);
}

async function abortAfterFreeze(
  deps: GenerationDependencies,
  command: GenerationCommand,
  attemptToken: string,
  failureCode: GenerationFailureCode,
  response: GenerationError,
): Promise<GenerationResponse> {
  try { deps.auditFailure?.(failureCode); } catch { /* audit logging cannot suppress cleanup */ }
  let outcome: AbortGenerationResult;
  try { outcome = await deps.abortGenerationAttempt({ jobId: command.jobId, attemptToken, idempotencyKey: command.idempotencyKey, failureCode }); }
  catch (cleanupError) {
    try { deps.auditFailure?.('abort_generation_failed'); } catch { /* preserve the cleanup error */ }
    throw mapPersistence(cleanupError);
  }
  if (outcome.outcome === 'completed') return outcome.result;
  throw response;
}

export async function runGeneration(deps: GenerationDependencies, command: GenerationCommand): Promise<GenerationResponse> {
  const { ownerId } = await deps.authenticate(command.authToken);
  const authorized = await deps.authorize(ownerId, command);
  validateCommand(command, authorized.draftKind);
  const existing = await deps.findIdempotent(ownerId, command);
  if (existing) return existing;
  if (!prerequisiteApproved(command.mode, authorized.workflowPhase)) throw new GenerationError(409, 'workflow_phase_not_approved');
  if (authorized.draftStatus !== 'queued') throw new GenerationError(409, 'stale_transition');

  const loadedPolicy = await deps.loadPolicy(ownerId, command);
  let selection: ContextSelection;
  try { selection = await deps.selectContext(ownerId, command, loadedPolicy.maxInputTokens); }
  catch (error) {
    if (error instanceof Error && error.message === 'context_budget_too_small') throw new GenerationError(409, 'context_budget_too_small');
    throw error;
  }
  const snapshot = contextSnapshot(selection);
  buildFrozenContinuityContext(selection);
  const attemptToken = deps.createAttemptToken();
  let frozenPolicy: FrozenGenerationPolicy;
  try {
    frozenPolicy = await deps.freezeContext({ ownerId, jobId: command.jobId, draftId: command.draftId, idempotencyKey: command.idempotencyKey, mode: command.mode, contextVersionIds: selection.versionIds, contextSnapshot: snapshot, providerSettingId: loadedPolicy.providerSettingId, attemptToken });
  } catch (error) { return abortAfterFreeze(deps, command, attemptToken, 'freeze_failed', mapPersistence(error)); }
  let continuityContext: ContinuityContext;
  try {
    if (frozenPolicy.attemptToken !== attemptToken || !sameFrozenPolicy(loadedPolicy, frozenPolicy, command)
      || estimateWorstCaseCostMicros(frozenPolicy, command.mode) !== frozenPolicy.worstCaseCostMicros) throw new GenerationError(500, 'invalid_provider_setting');
    const frozenSelection = selectionFromSnapshot(frozenPolicy.contextVersionIds, frozenPolicy.contextSnapshot);
    continuityContext = buildFrozenContinuityContext(frozenSelection);
  } catch (error) { return abortAfterFreeze(deps, command, attemptToken, 'frozen_validation_failed', mapPersistence(error)); }

  let reservation: Awaited<ReturnType<GenerationDependencies['reserveAndStart']>>;
  try { reservation = await deps.reserveAndStart({ jobId: command.jobId, draftId: command.draftId, attemptToken, worstCaseCostMicros: frozenPolicy.worstCaseCostMicros }); }
  catch (error) { return abortAfterFreeze(deps, command, attemptToken, 'reservation_failed', mapPersistence(error)); }
  if (reservation.status === 'blocked') return abortAfterFreeze(deps, command, attemptToken, 'budget_blocked', new GenerationError(402, 'budget_blocked', { budgetStatus: reservation.budgetStatus, remainingMicros: reservation.remainingMicros }));

  const outputCap = command.mode === 'revise_selection' ? Math.min(frozenPolicy.maxOutputTokens, frozenPolicy.maxRevisionOutputTokens) : frozenPolicy.maxOutputTokens;
  const request: GenerationRequest = {
    kind: command.kind, mode: command.mode, modelKey: frozenPolicy.modelKey, ...(command.seed === undefined ? {} : { seed: command.seed }),
    maxInputTokens: frozenPolicy.maxInputTokens, maxOutputTokens: outputCap,
    contextVersionIds: frozenPolicy.contextVersionIds, contextMemories: frozenPolicy.contextSnapshot,
    ...(command.revision ? { revision: command.revision } : {}),
  };

  let raw: unknown;
  try {
    const provider = await deps.resolveProvider(ownerId, loadedPolicy, frozenPolicy);
    raw = await provider.generate(request);
  }
  catch { return abortAfterFreeze(deps, command, attemptToken, 'provider_generation_failed', new GenerationError(502, 'provider_generation_failed')); }
  let providerResponse: NarrativeProviderResponse;
  try { providerResponse = deps.parseProviderResponse(raw); }
  catch { return abortAfterFreeze(deps, command, attemptToken, 'provider_response_invalid', new GenerationError(502, 'provider_response_invalid')); }
  let trustedActualCost: number;
  try { trustedActualCost = estimateActualCostMicros(frozenPolicy, providerResponse.usage); }
  catch { return abortAfterFreeze(deps, command, attemptToken, 'provider_usage_exceeds_reservation', new GenerationError(502, 'provider_usage_exceeds_reservation')); }
  if (providerResponse.result.kind !== command.kind) return abortAfterFreeze(deps, command, attemptToken, 'provider_result_kind_mismatch', new GenerationError(502, 'provider_result_kind_mismatch'));
  if (providerResponse.usage.inputTokens > frozenPolicy.maxInputTokens
    || providerResponse.usage.outputTokens > outputCap
    || trustedActualCost > frozenPolicy.worstCaseCostMicros) {
    return abortAfterFreeze(deps, command, attemptToken, 'provider_usage_exceeds_reservation', new GenerationError(502, 'provider_usage_exceeds_reservation'));
  }

  let continuity: ContinuityCheck;
  try { continuity = deps.checkContinuity(providerResponse.result, continuityContext); }
  catch { return abortAfterFreeze(deps, command, attemptToken, 'continuity_check_failed', new GenerationError(500, 'continuity_check_failed')); }
  const actualCostMicros = trustedActualCost;
  try {
    const stored = await deps.finalizeSuccess({ ownerId, jobId: command.jobId, draftId: command.draftId, attemptToken, result: providerResponse.result, usage: providerResponse.usage, actualCostMicros, contextVersionIds: frozenPolicy.contextVersionIds, continuityLevel: continuity.level, findings: continuity.findings, providerResponseId: providerResponse.rawId, providerResponseModel: providerResponse.responseModel, visibility: 'private', continuityPolicyVersion: CONTINUITY_POLICY_VERSION });
    return { ...stored, continuityLevel: continuity.level };
  } catch (error) {
    const mapped = mapPersistence(error, 'finalization_failed');
    return abortAfterFreeze(deps, command, attemptToken, 'finalization_failed', mapped);
  }
}

function jsonError(error: unknown): Response {
  const known = error instanceof GenerationError ? error : new GenerationError(500, 'internal_error');
  return Response.json({ error: known.code, ...(known.details ? { details: known.details } : {}) }, { status: known.status });
}

const noCorsPolicy = createCorsPolicy([]);

export function createGenerateDraftHandler(deps: GenerationDependencies, cors: CorsPolicy = noCorsPolicy): (request: Request) => Promise<Response> {
  return async (request) => {
    const gated = corsGate(request, cors);
    if (gated) return gated;
    const respond = (response: Response) => withCorsHeaders(request, response, cors);
    if (request.method !== 'POST') return respond(Response.json({ error: 'method_not_allowed' }, { status: 405 }));
    try {
      const token = bearerToken(request);
      if (!token) throw new GenerationError(401, 'authentication_required');
      let json: unknown;
      try { json = await request.json(); } catch { throw new GenerationError(400, 'invalid_command'); }
      const parsed = bodySchema.safeParse(json);
      if (!parsed.success) throw new GenerationError(400, 'invalid_command');
      return respond(Response.json(await runGeneration(deps, { ...parsed.data, authToken: token })));
    } catch (error) { return respond(jsonError(error)); }
  };
}

function row<T>(value: unknown): T | null { return Array.isArray(value) ? (value[0] as T | undefined) ?? null : value && typeof value === 'object' ? value as T : null }

function safeInteger(value: unknown, minimum: number): number {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < minimum) throw new Error('invalid_trusted_provider_setting');
  return parsed;
}

function policyFromRecord(value: Record<string, unknown>): GenerationPolicyValues {
  const parsed: GenerationPolicyValues = {
    providerSettingId: String(value.provider_setting_id ?? value.id ?? ''), modelKey: String(value.model_key ?? ''),
    maxInputTokens: safeInteger(value.max_input_tokens, 1), maxOutputTokens: safeInteger(value.max_output_tokens, 1),
    maxRevisionOutputTokens: safeInteger(value.max_revision_output_tokens, 1),
    inputCostMicrosPerMillion: safeInteger(value.input_cost_micros_per_million, 0),
    outputCostMicrosPerMillion: safeInteger(value.output_cost_micros_per_million, 0), fixedCostMicros: safeInteger(value.fixed_cost_micros, 0),
  };
  if (!parsed.providerSettingId || !parsed.modelKey || parsed.maxRevisionOutputTokens > parsed.maxOutputTokens) throw new Error('invalid_trusted_provider_setting');
  return parsed;
}

function trustedSettingFromRecord(value: Record<string, unknown>, ownerId: string): TrustedGenerationPolicy {
  if (value.owner_id !== ownerId || value.enabled !== true) throw new Error('invalid_trusted_provider_setting');
  const providerKey = value.provider_key;
  if (providerKey !== 'openai' && providerKey !== 'anthropic' && providerKey !== 'fake-local-provider') throw new Error('invalid_trusted_provider_setting');
  const configuration = value.configuration && typeof value.configuration === 'object' ? value.configuration as Record<string, unknown> : {};
  let secretRef: string | null = null;
  let secretSource: TrustedGenerationPolicy['secretSource'] = null;
  if (providerKey === 'fake-local-provider') {
    if (configuration.mode !== 'fixture') throw new Error('invalid_trusted_provider_setting');
  } else {
    if (typeof configuration.apiKeyEnv === 'string' && /^[A-Z][A-Z0-9_]*$/.test(configuration.apiKeyEnv)) {
      secretRef = configuration.apiKeyEnv;
      secretSource = 'env';
    } else {
      const expectedVaultName = `narrative_${ownerId}_${providerKey}`;
      if (configuration.vaultSecretName !== expectedVaultName) throw new Error('invalid_trusted_provider_setting');
      secretRef = expectedVaultName;
      secretSource = 'vault';
    }
  }
  return { ...policyFromRecord(value), providerKey, secretRef, secretSource };
}

export function createSupabaseProviderSecretReader(config: SupabaseRestConfig) {
  const request = config.fetch ?? globalThis.fetch;
  return async (ownerId: string, providerKey: 'openai' | 'anthropic'): Promise<string> => {
    const response = await request(`${config.url}/rest/v1/rpc/read_narrative_secret`, {
      method: 'POST',
      headers: { apikey: config.serviceRoleKey, authorization: `Bearer ${config.serviceRoleKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ p_owner_id: ownerId, p_secret_kind: providerKey }),
    });
    const value = await response.json().catch(() => null);
    if (!response.ok || typeof value !== 'string' || !value.trim()) throw new GenerationError(500, 'provider_secret_unavailable');
    return value;
  };
}

export function createSupabaseGenerationDependencies(
  config: SupabaseRestConfig,
  authToken: string,
  resolveProvider: GenerationDependencies['resolveProvider'],
): GenerationDependencies {
  const request = config.fetch ?? globalThis.fetch;
  const userHeaders = { apikey: config.anonKey, authorization: `Bearer ${authToken}`, 'content-type': 'application/json' };
  const serviceHeaders = { apikey: config.serviceRoleKey, authorization: `Bearer ${config.serviceRoleKey}`, 'content-type': 'application/json' };
  const callWith = async (headers: Record<string, string>, path: string, init: RequestInit = {}): Promise<unknown> => {
    const response = await request(`${config.url}${path}`, { ...init, headers: { ...headers, ...init.headers } });
    const value = response.status === 204 ? null : await response.json();
    if (!response.ok) {
      if (path === '/auth/v1/user' && (response.status === 401 || response.status === 403)) throw new GenerationError(401, 'authentication_required');
      const databaseCode = value && typeof value === 'object' && 'code' in value ? String(value.code) : '';
      const message = value && typeof value === 'object' ? String(('message' in value && value.message) || ('msg' in value && value.msg) || `supabase_${response.status}`) : `supabase_${response.status}`;
      if (databaseCode === 'P0001' && stableConflictCodes.has(message)) throw new PersistenceError(message);
      throw new Error(`supabase_request_failed_${response.status}`);
    }
    return value;
  };
  const call = (path: string, init: RequestInit = {}) => callWith(userHeaders, path, init);
  const rpc = (name: string, body: Record<string, unknown>) => callWith(serviceHeaders, `/rest/v1/rpc/${name}`, { method: 'POST', body: JSON.stringify(body) });
  return {
    createAttemptToken: () => crypto.randomUUID(),
    authenticate: async () => {
      const user = row<{ id: string }>(await call('/auth/v1/user'));
      if (!user?.id) throw new GenerationError(401, 'authentication_required');
      return { ownerId: user.id };
    },
    authorize: async (_ownerId, command) => {
      const draft = row<{ status: DraftStatus; kind: DraftKind }>(await call(`/rest/v1/drafts?select=status,kind&id=eq.${encodeURIComponent(command.draftId)}`));
      if (!draft) throw new GenerationError(404, 'draft_not_found');
      const job = row<{ id: string; draft_id: string | null }>(await call(`/rest/v1/generation_jobs?select=id,draft_id&id=eq.${encodeURIComponent(command.jobId)}`));
      if (!job || (job.draft_id !== null && job.draft_id !== command.draftId)) throw new GenerationError(404, 'generation_target_not_found');
      const workflowPhase = command.mode.startsWith('major_event_') ? row<{ phase: string }>(await call(`/rest/v1/major_event_workflows?select=phase&draft_id=eq.${encodeURIComponent(command.draftId)}`))?.phase ?? null : null;
      return { draftStatus: draft.status, draftKind: draft.kind, workflowPhase };
    },
    findIdempotent: async (_ownerId, command) => {
      const job = row<{
        id: string; draft_id: string | null; status: string; idempotency_key: string | null;
        generation_mode: GenerationMode | null; payload: Record<string, unknown>;
      }>(await call(`/rest/v1/generation_jobs?select=id,draft_id,status,idempotency_key,generation_mode,payload&id=eq.${encodeURIComponent(command.jobId)}`));
      if (!job) return null;
      const payload = job.payload && typeof job.payload === 'object' ? job.payload : {};
      const preboundKey = typeof payload.manualRequestKey === 'string' ? payload.manualRequestKey : null;
      const preboundMode = typeof payload.mode === 'string' ? payload.mode : null;
      const storedKind = typeof payload.kind === 'string' ? payload.kind : null;
      const completedBindingMatches = job.id === command.jobId
        && job.draft_id === command.draftId
        && job.idempotency_key === command.idempotencyKey
        && job.generation_mode === command.mode
        && storedKind === command.kind;
      if (job.status === 'completed' && !completedBindingMatches) throw new GenerationError(409, 'generation_replay_mismatch');
      if (job.status !== 'completed') {
        const frozenBindingMismatch = job.idempotency_key !== null
          && (job.draft_id !== command.draftId || job.idempotency_key !== command.idempotencyKey
            || job.generation_mode !== command.mode || storedKind !== command.kind);
        const queuedBindingMismatch = preboundKey !== null
          && (job.draft_id !== command.draftId || preboundKey !== command.idempotencyKey
            || preboundMode !== command.mode || storedKind !== command.kind);
        if (job.id !== command.jobId || frozenBindingMismatch || queuedBindingMismatch) throw new GenerationError(409, 'generation_replay_mismatch');
        if (job.idempotency_key !== null) throw new GenerationError(409, 'duplicate_generation');
        return null;
      }
      const version = row<{ id: string; continuity_level: ContinuityCheck['level'] }>(await call(`/rest/v1/draft_versions?select=id,continuity_level&generation_job_id=eq.${job.id}`));
      return version ? { draftId: command.draftId, versionId: version.id, status: 'generated', continuityLevel: version.continuity_level } : null;
    },
    loadPolicy: async (ownerId) => {
      const values = await callWith(serviceHeaders, `/rest/v1/provider_settings?select=id,owner_id,provider_key,enabled,configuration,model_key,max_input_tokens,max_output_tokens,max_revision_output_tokens,input_cost_micros_per_million,output_cost_micros_per_million,fixed_cost_micros&enabled=eq.true&owner_id=eq.${encodeURIComponent(ownerId)}`);
      const ownerSettings = (Array.isArray(values) ? values : []).filter((candidate) => candidate && typeof candidate === 'object'
        && (candidate as Record<string, unknown>).owner_id === ownerId && (candidate as Record<string, unknown>).enabled === true);
      if (ownerSettings.length !== 1) throw new GenerationError(409, 'active_provider_setting_required');
      try { return trustedSettingFromRecord(ownerSettings[0] as Record<string, unknown>, ownerId); }
      catch { throw new GenerationError(500, 'invalid_provider_setting'); }
    },
    selectContext: async (_ownerId, command, inputTokenBudget) => {
      const values = await call('/rest/v1/memory_items?select=id,memory_type,content,status,blocking,metadata,updated_at&status=in.(active,approved)');
      const memories = (Array.isArray(values) ? values : []).map((raw) => {
        const value = raw as { id: string; memory_type: NarrativeMemory['memoryType']; content: string; status: string; blocking: boolean; metadata?: Record<string, unknown>; updated_at?: string };
        const metadata = memoryMetadataSchema.parse(value.metadata ?? {});
        return { versionId: value.id, memoryType: value.memory_type, content: value.content, status: value.status, blocking: value.blocking, tokenCount: metadata.tokenCount ?? Math.ceil(value.content.length / 4), tags: metadata.tags, updatedAt: value.updated_at, claims: metadata.claims, continuityFacts: metadata.continuityFacts };
      });
      const relationshipStages = memories.filter((memory) => memory.memoryType === 'canon' && memory.continuityFacts?.relationshipStage !== undefined).map((memory) => memory.continuityFacts!.relationshipStage!);
      const currentRelationshipStage = relationshipStages.length > 0 ? Math.min(...relationshipStages) : undefined;
      return selectNarrativeContext({ memories, tokenBudget: inputTokenBudget, tags: command.tags, currentRelationshipStage });
    },
    freezeContext: async (input) => {
      const value = row<Record<string, unknown>>(await rpc('freeze_generation_context', { p_job_id: input.jobId, p_draft_id: input.draftId, p_generation_mode: input.mode, p_idempotency_key: input.idempotencyKey, p_context_version_ids: input.contextVersionIds, p_context_snapshot: input.contextSnapshot, p_provider_setting_id: input.providerSettingId, p_attempt_token: input.attemptToken }));
      if (!value) throw new Error('freeze_failed');
      return {
        ...policyFromRecord(value), attemptToken: z.string().uuid().parse(value.attempt_token), worstCaseCostMicros: safeInteger(value.worst_case_cost_micros, 0),
        contextVersionIds: z.array(z.string().min(1)).parse(value.context_version_ids),
        contextSnapshot: z.array(frozenMemorySchema).parse(value.context_snapshot),
      };
    },
    reserveAndStart: async (input) => reservationResultSchema.parse(await rpc('reserve_and_start_generation', { p_job_id: input.jobId, p_attempt_token: input.attemptToken, p_amount_micros: input.worstCaseCostMicros })),
    resolveProvider, parseProviderResponse: parseNarrativeProviderResponse, checkContinuity,
    finalizeSuccess: async (input) => {
      const version = row<{ id: string; draft_id?: string }>(await rpc('finalize_generation_success', { p_job_id: input.jobId, p_attempt_token: input.attemptToken, p_actual_micros: input.actualCostMicros, p_usage_json: input.usage, p_content: input.result, p_continuity_level: input.continuityLevel, p_continuity_findings: input.findings, p_provider_response_id: input.providerResponseId, p_provider_response_model: input.providerResponseModel, p_policy_version: input.continuityPolicyVersion }));
      if (!version?.id) throw new Error('success_finalization_missing_version');
      return { draftId: version.draft_id ?? input.draftId, versionId: version.id, status: 'generated' };
    },
    abortGenerationAttempt: async (input) => abortResultSchema.parse(await rpc('abort_generation_attempt', { p_job_id: input.jobId, p_attempt_token: input.attemptToken, p_idempotency_key: input.idempotencyKey, p_failure_code: input.failureCode })),
    auditFailure: (stage) => console.error('generate-draft failure', { stage }),
  };
}

interface DenoRuntime { env: { get(name: string): string | undefined }; serve(handler: (request: Request) => Response | Promise<Response>): void }
declare const Deno: DenoRuntime;
const defaultFakeResult: GenerationResult = { title: '로컬 생성 초안', kind: 'short_dialogue', setting: { time: '저녁', place: '처마 아래' }, body: '천령과 무영은 빗소리 사이에서 잠시 말을 멈추었다.', emotionalStart: '고요함', emotionalEnd: '잔잔한 안도', continuityUsed: [], continuityCandidates: [], canonChangeCandidates: [], unresolvedCallbacks: [], riskFlags: [] };
export function createLocalFixtureProvider(sleep: (milliseconds: number) => Promise<unknown> = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))): NarrativeProvider {
  return {
    generate: async (providerRequest) => {
      await sleep(5_000);
      return { result: { ...defaultFakeResult, kind: providerRequest.kind }, usage: { inputTokens: 14, outputTokens: 9 }, rawId: `fake-${providerRequest.kind}`, responseModel: providerRequest.modelKey };
    },
  };
}
if (typeof Deno !== 'undefined' && (import.meta as ImportMeta & { main?: boolean }).main) {
  const url = Deno.env.get('SUPABASE_URL'); const anonKey = Deno.env.get('SUPABASE_ANON_KEY'); const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !anonKey || !serviceRoleKey) throw new Error('SUPABASE_URL, SUPABASE_ANON_KEY, and SUPABASE_SERVICE_ROLE_KEY are required');
  const fakeLocalProvider: NarrativeProvider | undefined = Deno.env.get('NARRATIVE_FAKE_LOCAL_FIXTURE') === 'true' ? createLocalFixtureProvider() : undefined;
  const readVaultSecret = createSupabaseProviderSecretReader({ url, anonKey, serviceRoleKey });
  const resolveProvider: GenerationDependencies['resolveProvider'] = async (ownerId, loadedPolicy) => {
    const resolvedSecret = loadedPolicy.providerKey === 'fake-local-provider'
      ? undefined
      : loadedPolicy.secretSource === 'vault'
        ? await readVaultSecret(ownerId, loadedPolicy.providerKey)
        : loadedPolicy.secretRef ? Deno.env.get(loadedPolicy.secretRef) : undefined;
    const configuration = loadedPolicy.providerKey === 'fake-local-provider'
      ? { mode: 'fixture' }
      : { apiKeyEnv: 'NARRATIVE_RESOLVED_PROVIDER_SECRET' };
    return createServerNarrativeProvider(
      [{ provider_key: loadedPolicy.providerKey, enabled: true, model_key: loadedPolicy.modelKey, configuration }],
      (name) => name === 'NARRATIVE_RESOLVED_PROVIDER_SECRET' ? resolvedSecret : undefined,
      { timeoutMs: 30_000, ...(fakeLocalProvider ? { fakeLocalProvider } : {}) },
    );
  };
  const cors = corsPolicyFromEnvironment(Deno.env.get('NARRATIVE_ADMIN_ORIGINS'));
  Deno.serve((request) => {
    const token = bearerToken(request) ?? '';
    return createGenerateDraftHandler(createSupabaseGenerationDependencies({ url, anonKey, serviceRoleKey }, token, resolveProvider), cors)(request);
  });
}
