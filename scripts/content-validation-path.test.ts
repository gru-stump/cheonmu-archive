import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { resolveValidationRoot } from './content-validation-path';

describe('resolveValidationRoot', () => {
  it.skipIf(process.platform !== 'win32')('converts a Windows file URL into a usable filesystem root', () => {
    const root = resolveValidationRoot('file:///C:/archive/scripts/validate-content.ts');

    expect(root).toBe('C:\\archive\\');
    expect(root).not.toMatch(/^\/C:\//);
  });

  it('resolves a file URL from the current platform to its project root', () => {
    const projectRoot = join(tmpdir(), 'cheonmu-validation-path-test');
    const moduleUrl = pathToFileURL(join(projectRoot, 'scripts', 'validate-content.ts')).href;

    expect(resolveValidationRoot(moduleUrl)).toBe(`${projectRoot}${sep}`);
  });
});
