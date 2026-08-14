import { z } from 'zod';
import { parseGenerationResult, type GenerationRequest, type GenerationResult, type Usage } from '../../../shared/narrative/contracts.ts';
import { AnthropicNarrativeProvider } from './anthropic-provider.ts';
import { OpenAiNarrativeProvider, type ProviderHttpOptions } from './openai-provider.ts';

export interface NarrativeProviderResponse {
  result: GenerationResult;
  usage: Usage;
  rawId: string;
}

export interface NarrativeProvider {
  generate(request: GenerationRequest): Promise<NarrativeProviderResponse>;
}

const safeUsageValue = z.number().finite().int().safe().nonnegative();

const providerResponseSchema = z.object({
  result: z.unknown(),
  usage: z.object({
    inputTokens: safeUsageValue,
    outputTokens: safeUsageValue,
    costMicros: safeUsageValue.optional(),
  }),
  rawId: z.string().trim().min(1),
}).transform(({ result, usage, rawId }): NarrativeProviderResponse => ({
  result: parseGenerationResult(result),
  usage,
  rawId,
}));

/** Validates every provider response at the adapter boundary. */
export function parseNarrativeProviderResponse(value: unknown): NarrativeProviderResponse {
  return providerResponseSchema.parse(value);
}

const activeSettingSchema = z.object({
  provider_key: z.enum(['openai', 'anthropic']), enabled: z.literal(true), model_key: z.string().trim().min(1),
  configuration: z.object({ apiKeyEnv: z.string().regex(/^[A-Z][A-Z0-9_]*$/) }).strict(),
}).strict();

/**
 * Creates one adapter from the sole active database setting. The database
 * setting holds an environment-variable reference, never an API key itself.
 */
export function createServerNarrativeProvider(
  settings: unknown[],
  getSecret: (name: string) => string | undefined,
  options: Omit<ProviderHttpOptions, 'apiKey'>,
): NarrativeProvider {
  if (settings.length !== 1) throw new Error('active_provider_setting_required');
  const setting = activeSettingSchema.parse(settings[0]);
  const apiKey = getSecret(setting.configuration.apiKeyEnv);
  if (!apiKey?.trim()) throw new Error('provider_secret_unavailable');
  const http = { ...options, apiKey };
  return setting.provider_key === 'openai' ? new OpenAiNarrativeProvider(http) : new AnthropicNarrativeProvider(http);
}
