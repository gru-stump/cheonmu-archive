import { describe, expect, it } from 'vitest';
import {
  catalogModels,
  estimateMaximumGenerationMicros,
  providerCatalog,
} from './provider-catalog';

describe('provider catalog', () => {
  it('offers only supported story-generation models returned by the provider', () => {
    expect(catalogModels('openai', ['gpt-5-mini', 'whisper-1']).map((item) => item.id))
      .toEqual(['gpt-5-mini']);
  });

  it('keeps a safe fallback when a live model list is temporarily unavailable', () => {
    expect(catalogModels('openai', null)[0]).toMatchObject({
      id: 'gpt-5-mini',
      recommended: true,
      availability: 'unverified',
    });
  });

  it('uses the hand-checked official GPT-5 mini prices and verification date', () => {
    expect(providerCatalog.find((item) => item.id === 'gpt-5-mini')).toMatchObject({
      maxOutputTokens: 8_000,
      inputPriceMicrosPerMillion: 250_000,
      outputPriceMicrosPerMillion: 2_000_000,
      verifiedAt: '2026-08-16',
    });
  });

  it('calculates the maximum charge from catalog token caps and prices', () => {
    const model = providerCatalog.find((item) => item.id === 'gpt-5-mini');
    expect(model).toBeDefined();
    expect(estimateMaximumGenerationMicros(model!)).toBe(17_000);
  });
});
