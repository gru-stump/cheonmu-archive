import { expect, it } from 'vitest';
import { parseGenerationResult } from './contracts';

it('rejects a result without dialogue and continuity metadata', () => {
  expect(() => parseGenerationResult({ title: 'A draft' })).toThrow();
});
