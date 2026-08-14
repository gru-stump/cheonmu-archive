import { describe, expect, it } from 'vitest';
import type { GenerationRequest, GenerationResult } from '../../../shared/narrative/contracts';
import { FakeNarrativeProvider } from './fake-provider';

const request: GenerationRequest = {
  kind: 'short_dialogue',
  seed: 'A quiet return to the medical center.',
  maxInputTokens: 400,
  maxOutputTokens: 200,
  contextVersionIds: ['canon-v1'],
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
    });
  });
});
