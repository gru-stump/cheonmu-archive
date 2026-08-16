import { describe, expect, it } from 'vitest';
import type { GenerationRequest, GenerationResult } from '../../../shared/narrative/contracts';
import { FakeNarrativeProvider } from './fake-provider';
import { parseNarrativeProviderResponse } from './provider';

const request: GenerationRequest = {
  kind: 'short_dialogue',
  mode: 'new',
  modelKey: 'fake-model',
  seed: 'A quiet return to the medical center.',
  maxInputTokens: 400,
  maxOutputTokens: 200,
  contextVersionIds: ['canon-v1'],
  contextMemories: [{ versionId: 'canon-v1', memoryType: 'canon', content: 'approved canon', tokenCount: 10 }],
};

const fixture: GenerationResult = {
  title: 'After the return',
  kind: 'short_dialogue',
  setting: { time: 'night', place: 'medical center' },
  body: 'They return without naming what remains unsaid.',
  emotionalStart: 'guarded',
  emotionalEnd: 'steady',
  continuityUsed: ['canon-v1'],
  continuityCandidates: [],
  canonChangeCandidates: [],
  unresolvedCallbacks: [],
  riskFlags: [],
};

describe('FakeNarrativeProvider', () => {
  it('returns a deterministic, independently-owned fixture without network access', async () => {
    const provider = new FakeNarrativeProvider(fixture);

    const first = await provider.generate(request);
    first.result.title = 'changed only in this result';
    const second = await provider.generate(request);

    expect(second).toEqual({
      result: fixture,
      usage: { inputTokens: 14, outputTokens: 9 },
      rawId: 'fake-short_dialogue-canon-v1',
      responseModel: 'fake-model',
    });
  });

  it('isolates the fixture from caller mutation made after construction', async () => {
    const mutableFixture = structuredClone(fixture);
    const provider = new FakeNarrativeProvider(mutableFixture);
    mutableFixture.body = 'caller mutation';

    expect((await provider.generate(request)).result.body).toBe('They return without naming what remains unsaid.');
  });

  it('rejects malformed provider usage and empty response IDs at the shared boundary', () => {
    expect(parseNarrativeProviderResponse({
      result: fixture,
      usage: { inputTokens: 1, outputTokens: 1, costMicros: 0 },
      rawId: 'provider-1',
      responseModel: 'canonical-provider-model',
    })).toEqual({
      result: fixture,
      usage: { inputTokens: 1, outputTokens: 1, costMicros: 0 },
      rawId: 'provider-1',
      responseModel: 'canonical-provider-model',
    });
    expect(() => parseNarrativeProviderResponse({
      result: fixture,
      usage: { inputTokens: -1, outputTokens: 1 },
      rawId: 'provider-1',
      responseModel: 'canonical-provider-model',
    })).toThrow();
    expect(() => parseNarrativeProviderResponse({
      result: fixture,
      usage: { inputTokens: 1, outputTokens: 1, costMicros: Number.POSITIVE_INFINITY },
      rawId: ' ',
      responseModel: ' ',
    })).toThrow();
  });

  it('validates a fake fixture at construction through the shared response parser', () => {
    expect(() => new FakeNarrativeProvider({ result: fixture, usage: { inputTokens: 1.5, outputTokens: 1 } })).toThrow();
  });
});
