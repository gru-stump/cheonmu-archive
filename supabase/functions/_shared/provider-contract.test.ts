import { describe, expect, it } from 'vitest';
import { AnthropicNarrativeProvider } from './anthropic-provider.ts';
import { OpenAiNarrativeProvider, type ProviderHttpOptions } from './openai-provider.ts';
import { createServerNarrativeProvider } from './provider.ts';
import type { GenerationRequest, GenerationResult } from '../../../shared/narrative/contracts.ts';

const result: GenerationResult = {
  title: 'A quiet promise', kind: 'short_dialogue', setting: { time: 'night', place: 'garden' }, body: 'A promise is kept.',
  emotionalStart: 'guarded', emotionalEnd: 'warm', continuityUsed: ['canon-1'], continuityCandidates: [], canonChangeCandidates: [], unresolvedCallbacks: [], riskFlags: [],
};
const request: GenerationRequest = { kind: 'short_dialogue', mode: 'new', modelKey: 'server-model', maxInputTokens: 500, maxOutputTokens: 150, contextVersionIds: ['canon-1'], contextMemories: [{ versionId: 'canon-1', memoryType: 'canon', content: 'Canon', tokenCount: 1 }] };
const schemaResult = JSON.stringify(result);

function completedEnvelope(provider: 'openai' | 'anthropic', overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return provider === 'openai'
    ? { id: 'resp-1', object: 'response', status: 'completed', model: 'server-model', output: [{ id: 'message-1', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: schemaResult, annotations: [] }] }], usage: { input_tokens: 12, output_tokens: 34, total_tokens: 46 }, ...overrides }
    : { id: 'msg-1', type: 'message', role: 'assistant', model: 'server-model', stop_reason: 'tool_use', stop_sequence: null, content: [{ type: 'tool_use', id: 'tool-1', name: 'narrative_result', input: result }], usage: { input_tokens: 12, output_tokens: 34 }, ...overrides };
}

function fetchOnce(response: Response): { fetch: typeof globalThis.fetch; calls: Array<{ input: string; init?: RequestInit }> } {
  const calls: Array<{ input: string; init?: RequestInit }> = [];
  return { calls, fetch: async (input, init) => { calls.push({ input: String(input), init }); return response; } };
}

describe.each([
  ['openai', (options: Partial<ProviderHttpOptions>) => new OpenAiNarrativeProvider({ apiKey: 'openai-secret', timeoutMs: 1_000, ...options })],
  ['anthropic', (options: Partial<ProviderHttpOptions>) => new AnthropicNarrativeProvider({ apiKey: 'anthropic-secret', timeoutMs: 1_000, ...options })],
] as const)('%s narrative provider', (_name, create) => {
  it('sends one strict structured request and parses usage when present', async () => {
    const upstream = Response.json(completedEnvelope(_name));
    const h = fetchOnce(upstream);
    await expect(create({ fetch: h.fetch }).generate(request)).resolves.toEqual({ result, usage: { inputTokens: 12, outputTokens: 34 }, rawId: _name === 'openai' ? 'resp-1' : 'msg-1', responseModel: 'server-model' });
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0].input).toBe(_name === 'openai' ? 'https://api.openai.com/v1/responses' : 'https://api.anthropic.com/v1/messages');
    const body = JSON.parse(String(h.calls[0].init?.body));
    if (_name === 'openai') expect(body.text.format).toMatchObject({ type: 'json_schema', name: 'narrative_result', strict: true });
    else expect(body).toMatchObject({ tool_choice: { type: 'tool', name: 'narrative_result' }, tools: [{ name: 'narrative_result', strict: true }] });
  });

  it.each([
    ['malformed_response', Response.json({ id: 'upstream-id', output: [] })],
    ['rate_limited', Response.json({ error: { message: 'secret upstream body' } }, { status: 429 })],
  ])('returns a stable sanitized %s error and never retries', async (expected, upstream) => {
    const h = fetchOnce(upstream);
    await expect(create({ fetch: h.fetch }).generate(request)).rejects.toMatchObject({ code: expected });
    await expect(create({ fetch: h.fetch }).generate(request)).rejects.not.toThrow(/secret|openai-secret|anthropic-secret/i);
    expect(h.calls).toHaveLength(2);
  });

  it('uses the injected deadline timer, aborts one fetch, sanitizes the error, and clears the timer', async () => {
    const delays: number[] = []; const cleared: unknown[] = []; let fire: (() => void) | undefined; let calls = 0;
    const fetch: typeof globalThis.fetch = async (_input, init) => {
      calls += 1;
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('provider key leaked')));
        queueMicrotask(() => fire?.());
      });
    };
    const times = [1_000, 1_250, 2_000, 2_250];
    const provider = create({
      fetch,
      clock: () => times.shift() ?? 2_250,
      setTimer: ((callback: () => void, delay: number) => { fire = callback; delays.push(delay); return 77 as never; }) as typeof setTimeout,
      clearTimer: ((timer: unknown) => { cleared.push(timer); }) as typeof clearTimeout,
    });
    await expect(provider.generate(request)).rejects.toMatchObject({ code: 'timeout', message: 'timeout' });
    await expect(provider.generate(request)).rejects.not.toThrow(/provider key leaked|openai-secret|anthropic-secret/i);
    expect(calls).toBe(2);
    expect(delays).toEqual([750, 750]);
    expect(cleared).toEqual([77, 77]);
  });

  it('propagates an outer cancellation into the single provider request', async () => {
    let requestSignal: AbortSignal | null | undefined;
    const fetch: typeof globalThis.fetch = async (_input, init) => {
      requestSignal = init?.signal;
      return await new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('outer cancelled', 'AbortError')), { once: true }));
    };
    const provider = create({ fetch, setTimer: (() => 77 as never) as typeof setTimeout });
    const controller = new AbortController();
    const pending = (provider.generate as (request: GenerationRequest, signal?: AbortSignal) => ReturnType<typeof provider.generate>)(request, controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'timeout' });
    expect(requestSignal?.aborted).toBe(true);
  });

  it.each([
    ['absent', undefined],
    ['malformed', { input_tokens: -1, output_tokens: '34' }],
  ])('rejects %s usage so it can never be settled as zero', async (_case, usage) => {
    const upstream = Response.json(completedEnvelope(_name, { usage }));
    const h = fetchOnce(upstream);
    await expect(create({ fetch: h.fetch }).generate(request)).rejects.toMatchObject({ code: 'malformed_response' });
  });

  it.each([
    ['missing message/tool id', _name === 'openai'
      ? completedEnvelope('openai', { output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: schemaResult }] }] })
      : completedEnvelope('anthropic', { content: [{ type: 'tool_use', name: 'narrative_result', input: result }] })],
    ['missing response model', completedEnvelope(_name, { model: '' })],
    ['wrong output role/status', _name === 'openai'
      ? completedEnvelope('openai', { output: [{ id: 'message-1', type: 'message', role: 'user', status: 'in_progress', content: [{ type: 'output_text', text: schemaResult }] }] })
      : completedEnvelope('anthropic', { stop_reason: 'end_turn' })],
  ])('rejects a completed-looking envelope with %s', async (_case, envelope) => {
    const h = fetchOnce(Response.json(envelope));
    await expect(create({ fetch: h.fetch }).generate(request)).rejects.toMatchObject({ code: 'malformed_response' });
    expect(h.calls).toHaveLength(1);
  });

  it('accepts canonicalized response model metadata while sending the exact configured alias', async () => {
    const configuredAlias = _name === 'openai' ? 'gpt-production-alias' : 'claude-production-alias';
    const canonicalModel = _name === 'openai' ? 'gpt-canonical-2026-08-01' : 'claude-canonical-20260801';
    const h = fetchOnce(Response.json(completedEnvelope(_name, { model: canonicalModel })));
    await expect(create({ fetch: h.fetch, modelKey: configuredAlias }).generate({ ...request, modelKey: configuredAlias })).resolves.toMatchObject({ rawId: _name === 'openai' ? 'resp-1' : 'msg-1', responseModel: canonicalModel });
    const body = JSON.parse(String(h.calls[0].init?.body));
    expect(body.model).toBe(configuredAlias);
    expect(h.calls).toHaveLength(1);
  });
});

it('classifies an OpenAI max-output incomplete response without exposing upstream text', async () => {
  const h = fetchOnce(Response.json({
    id: 'resp-incomplete',
    object: 'response',
    status: 'incomplete',
    model: 'server-model',
    output: [],
    incomplete_details: { reason: 'max_output_tokens' },
    usage: { input_tokens: 120, output_tokens: 150, total_tokens: 270 },
  }));

  await expect(new OpenAiNarrativeProvider({ apiKey: 'openai-secret', fetch: h.fetch, timeoutMs: 1_000 }).generate(request))
    .rejects.toMatchObject({ code: 'output_limit', message: 'output_limit' });
  await expect(new OpenAiNarrativeProvider({ apiKey: 'openai-secret', fetch: h.fetch, timeoutMs: 1_000 }).generate(request))
    .rejects.not.toThrow(/max_output_tokens|resp-incomplete|openai-secret/i);
});

it('uses one identical explicit director/canon prompt with ordered source and claim metadata for both adapters', async () => {
  const detailedRequest: GenerationRequest = {
    ...request,
    contextVersionIds: ['canon-1', 'feedback-2'],
    contextMemories: [
      { ...request.contextMemories[0], claims: [
        { id: 'claim-later', sourceId: 'canon-source', sourcePriority: 20, status: 'unresolved', revealStage: 9, text: 'hidden truth' },
        { id: 'claim-binding', sourceId: 'canon-source', sourcePriority: 1, status: 'confirmed', revealStage: 0, text: 'binding truth' },
      ], continuityFacts: { relationshipStage: 7, forbiddenReveals: [{ term: 'truth', allowedAtRelationshipStage: 9 }] } },
      { versionId: 'feedback-2', memoryType: 'feedback', content: 'Avoid a rejected motif.', tokenCount: 2 },
    ],
  };
  const openAi = fetchOnce(Response.json(completedEnvelope('openai')));
  const anthropic = fetchOnce(Response.json(completedEnvelope('anthropic')));
  await new OpenAiNarrativeProvider({ apiKey: 'openai-secret', fetch: openAi.fetch, timeoutMs: 1_000 }).generate(detailedRequest);
  await new AnthropicNarrativeProvider({ apiKey: 'anthropic-secret', fetch: anthropic.fetch, timeoutMs: 1_000 }).generate(detailedRequest);
  const openAiPrompt = JSON.parse(String(JSON.parse(String(openAi.calls[0].init?.body)).input));
  const anthropicPrompt = JSON.parse(String(JSON.parse(String(anthropic.calls[0].init?.body)).messages[0].content));
  expect(openAiPrompt).toEqual(anthropicPrompt);
  expect(openAiPrompt).toMatchObject({
    directorInstruction: expect.stringContaining('confirmed canon'),
    contextVersionIds: ['canon-1', 'feedback-2'],
    context: [{ versionId: 'canon-1', claims: [
      { id: 'claim-later', sourceId: 'canon-source', sourcePriority: 20, status: 'unresolved', revealStage: 9 },
      { id: 'claim-binding', sourceId: 'canon-source', sourcePriority: 1, status: 'confirmed', revealStage: 0 },
    ] }, { versionId: 'feedback-2' }],
  });
});

describe('server provider factory', () => {
  it('accepts exactly one active server-owned setting and never browser-selected provider details', () => {
    const fetch: typeof globalThis.fetch = async () => Response.json({ id: 'resp', output: [] });
    const requestedSecrets: string[] = [];
    expect(createServerNarrativeProvider([{ provider_key: 'openai', enabled: true, model_key: 'server-model', configuration: { apiKeyEnv: 'OPENAI_KEY' } }], (name) => { requestedSecrets.push(name); return name === 'OPENAI_KEY' ? 'server-secret' : undefined; }, { fetch, timeoutMs: 50 })).toBeInstanceOf(OpenAiNarrativeProvider);
    expect(requestedSecrets).toEqual(['OPENAI_KEY']);
    expect(() => createServerNarrativeProvider([], () => undefined, { fetch, timeoutMs: 50 })).toThrow('active_provider_setting_required');
    expect(() => createServerNarrativeProvider([{ provider_key: 'openai', enabled: true, model_key: 'a', configuration: { apiKeyEnv: 'OPENAI_KEY' } }, { provider_key: 'anthropic', enabled: true, model_key: 'b', configuration: { apiKeyEnv: 'ANTHROPIC_KEY' } }], () => 'secret', { fetch, timeoutMs: 50 })).toThrow('active_provider_setting_required');
  });

  it('binds the adapter to the selected model before any HTTP request', async () => {
    const h = fetchOnce(Response.json(completedEnvelope('openai')));
    const provider = createServerNarrativeProvider([{ provider_key: 'openai', enabled: true, model_key: 'server-model', configuration: { apiKeyEnv: 'OWNER_ONE_OPENAI_KEY' } }], () => 'owner-one-secret', { fetch: h.fetch, timeoutMs: 50 });
    await expect(provider.generate({ ...request, modelKey: 'other-owner-model' })).rejects.toMatchObject({ code: 'provider_setting_mismatch' });
    expect(h.calls).toHaveLength(0);
  });

  it('allows fake-local only when an explicit fixture provider is supplied', async () => {
    const fixture = { generate: async () => ({ result, usage: { inputTokens: 1, outputTokens: 1 }, rawId: 'fixture', responseModel: 'fake-local-model' }) };
    expect(() => createServerNarrativeProvider([{ provider_key: 'fake-local-provider', enabled: true, model_key: 'fake-local-model', configuration: { mode: 'fixture' } }], () => undefined, { timeoutMs: 50 })).toThrow('unsupported_provider_setting');
    await expect(createServerNarrativeProvider([{ provider_key: 'fake-local-provider', enabled: true, model_key: 'fake-local-model', configuration: { mode: 'fixture' } }], () => undefined, { timeoutMs: 50, fakeLocalProvider: fixture } as never).generate({ ...request, modelKey: 'fake-local-model' })).resolves.toMatchObject({ rawId: 'fixture' });
  });
});
