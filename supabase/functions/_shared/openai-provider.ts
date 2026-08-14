import { parseGenerationResult, type GenerationRequest } from '../../../shared/narrative/contracts.ts';
import type { NarrativeProvider, NarrativeProviderResponse } from './provider.ts';

export class ProviderRequestError extends Error {
  constructor(public readonly code: 'timeout' | 'rate_limited' | 'upstream_unavailable' | 'malformed_response' | 'provider_setting_mismatch') { super(code); this.name = 'ProviderRequestError'; }
}

export interface ProviderHttpOptions { apiKey: string; modelKey?: string; fetch?: typeof globalThis.fetch; timeoutMs: number; clock?: () => number; setTimer?: typeof setTimeout; clearTimer?: typeof clearTimeout }

const resultSchema = {
  type: 'object', additionalProperties: false,
  required: ['title', 'kind', 'setting', 'body', 'emotionalStart', 'emotionalEnd', 'continuityUsed', 'continuityCandidates', 'canonChangeCandidates', 'unresolvedCallbacks', 'riskFlags'],
  properties: {
    title: { type: 'string' }, kind: { type: 'string', enum: ['short_dialogue', 'daily_event', 'major_event_proposal'] },
    setting: { type: 'object', additionalProperties: false, required: ['time', 'place'], properties: { time: { type: 'string' }, place: { type: 'string' } } },
    body: { type: 'string' }, emotionalStart: { type: 'string' }, emotionalEnd: { type: 'string' },
    continuityUsed: { type: 'array', items: { type: 'string' } }, continuityCandidates: { type: 'array', items: { type: 'string' } },
    canonChangeCandidates: { type: 'array', items: { type: 'string' } }, unresolvedCallbacks: { type: 'array', items: { type: 'string' } }, riskFlags: { type: 'array', items: { type: 'string' } },
  },
} as const;

export function narrativeJsonSchema(): Record<string, unknown> { return structuredClone(resultSchema); }

export function narrativePrompt(request: GenerationRequest): string {
  return JSON.stringify({ directorInstruction: 'Write only the requested private Cheonmu narrative. Treat confirmed canon as binding; do not resolve unresolved/conflicting claims, advance forbidden reveals, or invent permanent canon. Return the requested structured result.', kind: request.kind, mode: request.mode, seed: request.seed, revision: request.revision, contextVersionIds: request.contextVersionIds, context: request.contextMemories });
}

export function usageFromUpstream(value: unknown): { inputTokens: number; outputTokens: number } {
  const usage = value && typeof value === 'object' && 'usage' in value ? (value as { usage?: unknown }).usage : undefined;
  const record = usage && typeof usage === 'object' ? usage as Record<string, unknown> : null;
  const valid = (v: unknown) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
  if (!record || !valid(record.input_tokens) || !valid(record.output_tokens)) throw new ProviderRequestError('malformed_response');
  return { inputTokens: record.input_tokens as number, outputTokens: record.output_tokens as number };
}

async function safeJson(response: Response): Promise<unknown> { try { return await response.json(); } catch { throw new ProviderRequestError('malformed_response'); } }

export async function oneRequest(options: ProviderHttpOptions, url: string, init: RequestInit): Promise<unknown> {
  if (!options.apiKey.trim()) throw new ProviderRequestError('upstream_unavailable');
  const controller = new AbortController();
  const clock = options.clock ?? Date.now;
  const deadline = clock() + options.timeoutMs;
  const timer = (options.setTimer ?? setTimeout)(() => controller.abort(), Math.max(0, deadline - clock()));
  try {
    const response = await (options.fetch ?? globalThis.fetch)(url, { ...init, signal: controller.signal });
    if (response.status === 429) throw new ProviderRequestError('rate_limited');
    if (!response.ok) throw new ProviderRequestError('upstream_unavailable');
    return await safeJson(response);
  } catch (error) {
    if (error instanceof ProviderRequestError) throw error;
    if (controller.signal.aborted) throw new ProviderRequestError('timeout');
    throw new ProviderRequestError('upstream_unavailable');
  } finally { (options.clearTimer ?? clearTimeout)(timer); }
}

export class OpenAiNarrativeProvider implements NarrativeProvider {
  constructor(private readonly options: ProviderHttpOptions) {}
  async generate(request: GenerationRequest): Promise<NarrativeProviderResponse> {
    if (this.options.modelKey && request.modelKey !== this.options.modelKey) throw new ProviderRequestError('provider_setting_mismatch');
    const value = await oneRequest(this.options, 'https://api.openai.com/v1/responses', {
      method: 'POST', headers: { authorization: `Bearer ${this.options.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: request.modelKey, input: narrativePrompt(request), max_output_tokens: request.maxOutputTokens, text: { format: { type: 'json_schema', name: 'narrative_result', strict: true, schema: narrativeJsonSchema() } } }),
    });
    const record = value && typeof value === 'object' ? value as Record<string, unknown> : null;
    const id = typeof record?.id === 'string' && record.id ? record.id : null;
    if (record?.object !== 'response' || record?.status !== 'completed' || record?.model !== request.modelKey) throw new ProviderRequestError('malformed_response');
    const output = Array.isArray(record?.output) ? record.output : [];
    const message = output.find((item) => {
      if (!item || typeof item !== 'object') return false;
      const candidate = item as Record<string, unknown>;
      return typeof candidate.id === 'string' && candidate.id.length > 0 && candidate.type === 'message'
        && candidate.role === 'assistant' && candidate.status === 'completed' && Array.isArray(candidate.content);
    }) as { content: unknown[] } | undefined;
    const text = message?.content.find((item) => item && typeof item === 'object' && (item as { type?: unknown }).type === 'output_text' && typeof (item as { text?: unknown }).text === 'string') as { text: string } | undefined;
    if (!id || !text) throw new ProviderRequestError('malformed_response');
    try { return { result: parseGenerationResult(JSON.parse(text.text)), usage: usageFromUpstream(value), rawId: id }; }
    catch { throw new ProviderRequestError('malformed_response'); }
  }
}
