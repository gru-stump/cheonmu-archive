import { z } from 'zod';
import { parseGenerationResult, type GenerationRequest, type GenerationResult, type Usage } from '../../../shared/narrative/contracts.ts';

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
