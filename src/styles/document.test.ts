import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const runtimeGlobal = globalThis as typeof globalThis & { process: { cwd: () => string } };
const documentStyles = readFileSync(
  resolve(runtimeGlobal.process.cwd(), 'src/styles/document.css'),
  'utf8',
);

describe('document responsive layout', () => {
  it('collapses the home grid before the tablet workspace can clip its minimum tracks', () => {
    expect(documentStyles).toMatch(
      /@media\s*\(max-width:\s*64rem\)[\s\S]*?\.home-page\s*\{[\s\S]*?display:\s*flex/,
    );
  });
});
