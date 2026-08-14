export interface ModelPricingMicros {
  inputPerMillionMicros: number;
  outputPerMillionMicros: number;
}

export function estimateMaxCostMicros(
  pricing: ModelPricingMicros,
  inputLimit: number,
  outputLimit: number,
): number {
  return Math.ceil(
    (pricing.inputPerMillionMicros * inputLimit + pricing.outputPerMillionMicros * outputLimit) /
      1_000_000,
  );
}
