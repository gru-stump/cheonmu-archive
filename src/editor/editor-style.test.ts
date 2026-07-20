import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const read = (relative: string) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');

describe('editor style entry', () => {
  it('loads public foundations before the editor-only stylesheet', () => {
    const main = read('./main.tsx');
    const imports = [
      "import '../styles/tokens.css';",
      "import '../styles/global.css';",
      "import '../styles/document.css';",
      "import './editor.css';",
    ];
    imports.forEach((statement) => expect(main).toContain(statement));
    expect(imports.map((statement) => main.indexOf(statement))).toEqual(
      [...imports.map((statement) => main.indexOf(statement))].sort((a, b) => a - b),
    );
  });

  it('scopes editor rules below the editor shell', () => {
    const css = read('./editor.css');
    expect(css).toContain('.editor-shell');
    expect(css).toContain('min-height: 100vh');
    expect(css).not.toMatch(/^\s*(input|button|fieldset|textarea|select)\s*\{/m);
  });

  it('uses a high-contrast focus ring inside the dark editor shell', () => {
    const css = read('./editor.css');
    expect(css).toMatch(/\.editor-shell :focus-visible\s*\{[^}]*outline: 0\.2rem solid #f1c27d;[^}]*outline-offset: 0\.2rem;[^}]*\}/s);
  });
});
