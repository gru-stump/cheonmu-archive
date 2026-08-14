import { expect, it } from 'vitest';
import { estimateMaxCostMicros } from './budget';

it('calculates the maximum cost from input and output token limits', () => {
  expect(
    estimateMaxCostMicros(
      { inputPerMillionMicros: 2_000_000, outputPerMillionMicros: 8_000_000 },
      10_000,
      2_000,
    ),
  ).toBe(36_000);
});

it('rounds fractional microdollar estimates up to a whole microdollar', () => {
  expect(
    estimateMaxCostMicros(
      { inputPerMillionMicros: 1, outputPerMillionMicros: 0 },
      1,
      0,
    ),
  ).toBe(1);
});
