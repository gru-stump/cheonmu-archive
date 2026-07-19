import { describe, expect, it } from 'vitest';
import { resolveValidationRoot } from './content-validation-path';

describe('resolveValidationRoot', () => {
  it('converts a Windows file URL into a usable filesystem root', () => {
    const root = resolveValidationRoot('file:///C:/archive/scripts/validate-content.ts');

    expect(root).toBe('C:\\archive\\');
    expect(root).not.toMatch(/^\/C:\//);
  });
});
