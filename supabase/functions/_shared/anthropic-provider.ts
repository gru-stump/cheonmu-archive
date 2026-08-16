import { parseGenerationResult, type GenerationRequest } from '../../../shared/narrative/contracts.ts';
import type { NarrativeProvider, NarrativeProviderResponse } from './provider.ts';
import { narrativeJsonSchema, narrativePrompt, oneRequest, type ProviderHttpOptions, ProviderRequestError, usageFromUpstream } from './openai-provider.ts';

export class AnthropicNarrativeProvider implements NarrativeProvider {
  constructor(private readonly options: ProviderHttpOptions) {}
  async generate(request: GenerationRequest, signal?: AbortSignal): Promise<NarrativeProviderResponse> {
    if (this.options.modelKey && request.modelKey !== this.options.modelKey) throw new ProviderRequestError('provider_setting_mismatch');
    const value = await oneRequest(this.options, 'https://api.anthropic.com/v1/messages', {
      method: 'POST', headers: { 'x-api-key': this.options.apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: request.modelKey, max_tokens: request.maxOutputTokens, messages: [{ role: 'user', content: narrativePrompt(request) }], tools: [{ name: 'narrative_result', description: 'Return the completed narrative result.', input_schema: narrativeJsonSchema(), strict: true }], tool_choice: { type: 'tool', name: 'narrative_result' } }),
    }, signal);
    const record = value && typeof value === 'object' ? value as Record<string, unknown> : null;
    const id = typeof record?.id === 'string' && record.id ? record.id : null;
    const responseModel = typeof record?.model === 'string' && record.model.trim() ? record.model : null;
    if (record?.type !== 'message' || record?.role !== 'assistant' || !responseModel || record?.stop_reason !== 'tool_use') throw new ProviderRequestError('malformed_response');
    const tool = (Array.isArray(record?.content) ? record.content : []).find((item) => item && typeof item === 'object'
      && (item as { type?: unknown }).type === 'tool_use' && typeof (item as { id?: unknown }).id === 'string'
      && Boolean((item as { id: string }).id) && (item as { name?: unknown }).name === 'narrative_result') as { input?: unknown } | undefined;
    if (!id || !tool || !('input' in tool)) throw new ProviderRequestError('malformed_response');
    try { return { result: parseGenerationResult(tool.input), usage: usageFromUpstream(value), rawId: id, responseModel }; }
    catch { throw new ProviderRequestError('malformed_response'); }
  }
}
