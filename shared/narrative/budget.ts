export interface ModelPricingMicros {
  inputPerMillionMicros: number;
  outputPerMillionMicros: number;
}

function toNonNegativeSafeInteger(value: number, name: string): bigint {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer`);
  }

  return BigInt(value);
}

export function estimateMaxCostMicros(
  pricing: ModelPricingMicros,
  inputLimit: number,
  outputLimit: number,
): number {
  const inputPrice = toNonNegativeSafeInteger(pricing.inputPerMillionMicros, 'inputPerMillionMicros');
  const outputPrice = toNonNegativeSafeInteger(pricing.outputPerMillionMicros, 'outputPerMillionMicros');
  const inputTokens = toNonNegativeSafeInteger(inputLimit, 'inputLimit');
  const outputTokens = toNonNegativeSafeInteger(outputLimit, 'outputLimit');
  const microdollarsPerMillion = 1_000_000n;
  const numerator = inputPrice * inputTokens + outputPrice * outputTokens;
  const estimate = (numerator + microdollarsPerMillion - 1n) / microdollarsPerMillion;

  if (estimate > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError('estimated cost exceeds safe integer microdollars');
  }

  return Number(estimate);
}
