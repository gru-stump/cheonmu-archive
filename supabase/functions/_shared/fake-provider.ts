import type { GenerationRequest, GenerationResult, Usage } from '../../../shared/narrative/contracts.ts';
import { parseNarrativeProviderResponse, type NarrativeProvider, type NarrativeProviderResponse } from './provider.ts';

export interface FakeProviderFixture {
  result: GenerationResult;
  usage?: Usage;
  rawId?: string;
  responseModel?: string;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function isFixture(value: GenerationResult | FakeProviderFixture): value is FakeProviderFixture {
  return 'result' in value;
}

/** A fixture-only provider for deterministic local and test execution. */
export class FakeNarrativeProvider implements NarrativeProvider {
  private readonly fixture: FakeProviderFixture;

  constructor(fixture: GenerationResult | FakeProviderFixture) {
    const copiedFixture = clone(fixture);
    const supplied = isFixture(copiedFixture) ? copiedFixture : { result: copiedFixture };
    const parsed = parseNarrativeProviderResponse({
      result: supplied.result,
      usage: supplied.usage ?? { inputTokens: 14, outputTokens: 9 },
      rawId: supplied.rawId ?? 'fake-fixture',
      responseModel: supplied.responseModel ?? 'fake-fixture-model',
    });
    this.fixture = {
      result: clone(parsed.result),
      usage: clone(parsed.usage),
      ...(supplied.rawId === undefined ? {} : { rawId: parsed.rawId }),
      ...(supplied.responseModel === undefined ? {} : { responseModel: parsed.responseModel }),
    };
  }

  async generate(request: GenerationRequest): Promise<NarrativeProviderResponse> {
    return parseNarrativeProviderResponse({
      result: clone(this.fixture.result),
      usage: clone(this.fixture.usage ?? { inputTokens: 14, outputTokens: 9 }),
      rawId: this.fixture.rawId ?? `fake-${request.kind}-${request.contextVersionIds.join(',') || 'no-context'}`,
      responseModel: this.fixture.responseModel ?? request.modelKey,
    });
  }
}
