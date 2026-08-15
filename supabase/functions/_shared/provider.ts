import { z } from 'zod';
import { parseGenerationResult, type GenerationRequest, type GenerationResult, type Usage } from '../../../shared/narrative/contracts.ts';
import { AnthropicNarrativeProvider } from './anthropic-provider.ts';
import { OpenAiNarrativeProvider, ProviderRequestError, type ProviderHttpOptions } from './openai-provider.ts';

export interface NarrativeProviderResponse {
  result: GenerationResult;
  usage: Usage;
  rawId: string;
  responseModel: string;
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
  responseModel: z.string().trim().min(1),
}).transform(({ result, usage, rawId, responseModel }): NarrativeProviderResponse => ({
  result: parseGenerationResult(result),
  usage,
  rawId,
  responseModel,
}));

/** Validates every provider response at the adapter boundary. */
export function parseNarrativeProviderResponse(value: unknown): NarrativeProviderResponse {
  return providerResponseSchema.parse(value);
}

const realActiveSettingSchema = z.object({
  provider_key: z.enum(['openai', 'anthropic']), enabled: z.literal(true), model_key: z.string().trim().min(1),
  configuration: z.object({ apiKeyEnv: z.string().regex(/^[A-Z][A-Z0-9_]*$/) }).strict(),
}).strict();
const fakeActiveSettingSchema = z.object({
  provider_key: z.literal('fake-local-provider'), enabled: z.literal(true), model_key: z.string().trim().min(1),
  configuration: z.object({ mode: z.literal('fixture') }).strict(),
}).strict();
const activeSettingSchema = z.union([realActiveSettingSchema, fakeActiveSettingSchema]);

export interface ServerProviderOptions extends Omit<ProviderHttpOptions, 'apiKey' | 'modelKey'> { fakeLocalProvider?: NarrativeProvider }

/**
 * Creates one adapter from the sole active database setting. The database
 * setting holds an environment-variable reference, never an API key itself.
 */
export function createServerNarrativeProvider(
  settings: unknown[],
  getSecret: (name: string) => string | undefined,
  options: ServerProviderOptions,
): NarrativeProvider {
  if (settings.length !== 1) throw new Error('active_provider_setting_required');
  const setting = activeSettingSchema.parse(settings[0]);
  if (setting.provider_key === 'fake-local-provider') {
    if (!options.fakeLocalProvider) throw new Error('unsupported_provider_setting');
    return {
      generate: (request) => {
        if (request.modelKey !== setting.model_key) throw new ProviderRequestError('provider_setting_mismatch');
        return options.fakeLocalProvider!.generate(request);
      },
    };
  }
  const apiKey = getSecret(setting.configuration.apiKeyEnv);
  if (!apiKey?.trim()) throw new Error('provider_secret_unavailable');
  const { fakeLocalProvider: _fakeLocalProvider, ...httpOptions } = options;
  const http = { ...httpOptions, apiKey, modelKey: setting.model_key };
  return setting.provider_key === 'openai' ? new OpenAiNarrativeProvider(http) : new AnthropicNarrativeProvider(http);
}
