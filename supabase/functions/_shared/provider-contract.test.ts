import { describe, expect, it } from 'vitest';
import { AnthropicNarrativeProvider } from './anthropic-provider.ts';
import { OpenAiNarrativeProvider } from './openai-provider.ts';
import { createServerNarrativeProvider } from './provider.ts';
import type { GenerationRequest, GenerationResult } from '../../../shared/narrative/contracts.ts';

const result: GenerationResult = {
  title: 'A quiet promise', kind: 'short_dialogue', setting: { time: 'night', place: 'garden' }, body: 'A promise is kept.',
  emotionalStart: 'guarded', emotionalEnd: 'warm', continuityUsed: ['canon-1'], continuityCandidates: [], canonChangeCandidates: [], unresolvedCallbacks: [], riskFlags: [],
};
const request: GenerationRequest = { kind: 'short_dialogue', mode: 'new', modelKey: 'server-model', maxInputTokens: 500, maxOutputTokens: 150, contextVersionIds: ['canon-1'], contextMemories: [{ versionId: 'canon-1', memoryType: 'canon', content: 'Canon', tokenCount: 1 }] };
const schemaResult = JSON.stringify(result);

function fetchOnce(response: Response): { fetch: typeof globalThis.fetch; calls: Array<{ input: string; init?: RequestInit }> } {
  const calls: Array<{ input: string; init?: RequestInit }> = [];
  return { calls, fetch: async (input, init) => { calls.push({ input: String(input), init }); return response; } };
}

describe.each([
  ['openai', (fetch: typeof globalThis.fetch) => new OpenAiNarrativeProvider({ apiKey: 'openai-secret', fetch, timeoutMs: 1_000 })],
  ['anthropic', (fetch: typeof globalThis.fetch) => new AnthropicNarrativeProvider({ apiKey: 'anthropic-secret', fetch, timeoutMs: 1_000 })],
] as const)('%s narrative provider', (_name, create) => {
  it('sends one strict structured request and parses usage when present', async () => {
    const upstream = _name === 'openai'
      ? Response.json({ id: 'resp-1', output: [{ type: 'message', content: [{ type: 'output_text', text: schemaResult }] }], usage: { input_tokens: 12, output_tokens: 34 } })
      : Response.json({ id: 'msg-1', content: [{ type: 'tool_use', id: 'tool-1', name: 'narrative_result', input: result }], usage: { input_tokens: 12, output_tokens: 34 } });
    const h = fetchOnce(upstream);
    await expect(create(h.fetch).generate(request)).resolves.toEqual({ result, usage: { inputTokens: 12, outputTokens: 34 }, rawId: _name === 'openai' ? 'resp-1' : 'msg-1' });
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
    await expect(create(h.fetch).generate(request)).rejects.toMatchObject({ code: expected });
    await expect(create(h.fetch).generate(request)).rejects.not.toThrow(/secret|openai-secret|anthropic-secret/i);
    expect(h.calls).toHaveLength(2);
  });

  it('maps abort timeout without leaking the abort reason', async () => {
    const fetch: typeof globalThis.fetch = async (_input, init) => await new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('provider key leaked'))));
    await expect(create(fetch).generate(request)).rejects.toMatchObject({ code: 'timeout' });
  });

  it('accepts absent usage as zero usage', async () => {
    const upstream = _name === 'openai'
      ? Response.json({ id: 'resp-2', output: [{ type: 'message', content: [{ type: 'output_text', text: schemaResult }] }] })
      : Response.json({ id: 'msg-2', content: [{ type: 'tool_use', id: 'tool-1', name: 'narrative_result', input: result }] });
    const h = fetchOnce(upstream);
    await expect(create(h.fetch).generate(request)).resolves.toMatchObject({ usage: { inputTokens: 0, outputTokens: 0 } });
  });
});

describe('server provider factory', () => {
  it('accepts exactly one active server-owned setting and never browser-selected provider details', () => {
    const fetch: typeof globalThis.fetch = async () => Response.json({ id: 'resp', output: [] });
    expect(createServerNarrativeProvider([{ provider_key: 'openai', enabled: true, model_key: 'server-model', configuration: { apiKeyEnv: 'OPENAI_KEY' } }], (name) => name === 'OPENAI_KEY' ? 'server-secret' : undefined, { fetch, timeoutMs: 50 })).toBeInstanceOf(OpenAiNarrativeProvider);
    expect(() => createServerNarrativeProvider([], () => undefined, { fetch, timeoutMs: 50 })).toThrow('active_provider_setting_required');
    expect(() => createServerNarrativeProvider([{ provider_key: 'openai', enabled: true, model_key: 'a', configuration: { apiKeyEnv: 'OPENAI_KEY' } }, { provider_key: 'anthropic', enabled: true, model_key: 'b', configuration: { apiKeyEnv: 'ANTHROPIC_KEY' } }], () => 'secret', { fetch, timeoutMs: 50 })).toThrow('active_provider_setting_required');
  });
});
