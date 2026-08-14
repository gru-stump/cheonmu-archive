import type { GenerationRequest, GenerationResult, Usage } from '../../../shared/narrative/contracts';

export interface NarrativeProviderResponse {
  result: GenerationResult;
  usage: Usage;
  rawId: string;
}

export interface NarrativeProvider {
  generate(request: GenerationRequest): Promise<NarrativeProviderResponse>;
}
