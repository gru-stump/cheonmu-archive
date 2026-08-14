import { parseGenerationResult, type GenerationRequest, type GenerationResult, type Usage } from '../../../shared/narrative/contracts';
import type { NarrativeProvider, NarrativeProviderResponse } from './provider';

export interface FakeProviderFixture {
  result: GenerationResult;
  usage?: Usage;
  rawId?: string;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function isFixture(value: GenerationResult | FakeProviderFixture): value is FakeProviderFixture {
  return 'result' in value;
}

/** A fixture-only provider for deterministic local and test execution. */
export class FakeNarrativeProvider implements NarrativeProvider {
  constructor(private readonly fixture: GenerationResult | FakeProviderFixture) {}

  async generate(request: GenerationRequest): Promise<NarrativeProviderResponse> {
    const fixture = isFixture(this.fixture) ? this.fixture : { result: this.fixture };
    const result = parseGenerationResult(clone(fixture.result));
    return {
      result,
      usage: clone(fixture.usage ?? { inputTokens: 14, outputTokens: 9 }),
      rawId: fixture.rawId ?? `fake-${request.kind}-${request.contextVersionIds.join(',') || 'no-context'}`,
    };
  }
}
