# Cheonmu Editor Three-Pane Style Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the local editor a readable archive-themed three-pane layout with responsive tablet and mobile arrangements while preserving all existing content, validation, storage, and publication behavior.

**Architecture:** Import the existing public design tokens and document styles into the separate editor entry, then add one editor-only stylesheet whose selectors are scoped below `.editor-shell`. Add semantic layout wrappers to `EditorApp` without changing data flow. Verify the editor separately from the public Pages build with RTL contract tests and a dedicated Playwright configuration that starts the loopback API and editor Vite entry.

**Tech Stack:** React 19, TypeScript, CSS Grid, Vitest, Testing Library, Playwright, Vite

## Global Constraints

- Preserve all local API, validation, trash, rollback, public/private image, changed-file planning, and unsaved-change behavior.
- Do not add an external UI or CSS dependency.
- Use `editor-` as the prefix for editor-only class names.
- Import `tokens.css`, `global.css`, and `document.css` explicitly from the editor entry.
- Keep editor code and editor CSS absent from the public `vite build` output.
- Use three panes at 1024px and wider; a top navigation/list plus two panes from 700px through 1023px; a vertical layout at 699px and narrower.
- Keep ordinary inputs and body text at 14px or larger and small labels at 12px or larger.
- Preserve existing labels, `aria-invalid`, `aria-describedby`, status announcements, and keyboard focus behavior.

---

### Task 1: Connect the editor to the archive style foundation

**Files:**
- Create: `src/editor/editor.css`
- Create: `src/editor/editor-style.test.ts`
- Modify: `src/editor/main.tsx`

**Interfaces:**
- Consumes: CSS custom properties from `src/styles/tokens.css` and public document selectors from `src/styles/document.css`.
- Produces: an editor-only CSS entry imported after all public style files.

- [ ] **Step 1: Write the failing style-entry test**

Create `src/editor/editor-style.test.ts`:

```ts
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
});
```

- [ ] **Step 2: Run the test and confirm RED**

Run: `npm run test:run -- src/editor/editor-style.test.ts`

Expected: FAIL because `editor.css` does not exist and `main.tsx` imports no styles.

- [ ] **Step 3: Add the ordered imports and minimal shell stylesheet**

Add these lines below the React imports in `src/editor/main.tsx`:

```ts
import '../styles/tokens.css';
import '../styles/global.css';
import '../styles/document.css';
import './editor.css';
```

Create `src/editor/editor.css` with the minimal foundation:

```css
.editor-shell {
  min-height: 100vh;
  color: var(--paper-raised);
  background:
    radial-gradient(circle at top left, rgb(104 73 86 / 24%), transparent 28rem),
    linear-gradient(145deg, #171412, #24201d 58%, #171412);
  font-family: var(--font-label);
}

.editor-shell *,
.editor-shell *::before,
.editor-shell *::after {
  box-sizing: border-box;
}
```

- [ ] **Step 4: Run the focused test and public build**

Run: `npm run test:run -- src/editor/editor-style.test.ts && npm run build`

Expected: the two editor-style tests pass; the public build succeeds and contains no editor CSS chunk.

- [ ] **Step 5: Commit Task 1**

```powershell
git add src/editor/main.tsx src/editor/editor.css src/editor/editor-style.test.ts
git commit -m "style: connect editor archive foundations"
```

---

### Task 2: Add semantic three-pane editor structure and desktop styling

**Files:**
- Modify: `src/editor/EditorApp.tsx`
- Modify: `src/editor/PreviewPane.tsx`
- Modify: `src/editor/editor.css`
- Modify: `src/editor/EditorApp.test.tsx`

**Interfaces:**
- Consumes: all current `EditorApp` state and callbacks unchanged.
- Produces: `.editor-header`, `.editor-kind-nav`, `.editor-entry-list`, `.editor-workspace`, `.editor-form-pane`, `.editor-preview-pane`, `.editor-actions`, and `.editor-change-bar` layout hooks.

- [ ] **Step 1: Write the failing semantic-layout test**

Append to `src/editor/EditorApp.test.tsx`:

```tsx
it('renders the editor as navigation, form, preview, and change regions', async () => {
  const user = userEvent.setup();
  const { container } = render(<EditorApp api={createApi()} />);
  await openRecord(user);

  expect(container.querySelector('.editor-shell')).toBeVisible();
  expect(container.querySelector('.editor-header')).toBeVisible();
  expect(container.querySelector('.editor-kind-nav')).toBeVisible();
  expect(container.querySelector('.editor-entry-list')).toBeVisible();
  expect(container.querySelector('.editor-workspace')).toBeVisible();
  expect(container.querySelector('.editor-form-pane')).toContainElement(screen.getByRole('group', { name: '기록 정보' }));
  expect(container.querySelector('.editor-preview-pane')).toContainElement(screen.getByRole('complementary', { name: '미리보기' }));
  expect(container.querySelector('.editor-change-bar')).toHaveTextContent('src/content/records/first-contact.md');
});
```

- [ ] **Step 2: Run the test and confirm RED**

Run: `npm run test:run -- src/editor/EditorApp.test.tsx -t "renders the editor as navigation"`

Expected: FAIL because the semantic editor class hooks do not exist.

- [ ] **Step 3: Add layout wrappers without changing handlers**

Immediately before the return statement, derive the bottom audit lines from the content path or authoritative gallery plan already held by `EditorApp`:

```tsx
const contentPath = draft ? `src/content/${draft.kind}/${draft.id}.md` : null;
const changeLines = galleryPlan
  ? galleryPlan.changes.map(galleryChangeText)
  : contentPath
    ? [`${action}: ${contentPath}`]
    : [];
```

Apply these structural changes without changing props, conditions, button copy, or callbacks:

- Change `<main>` to `<main className="editor-shell">`.
- Replace the header with the complete header below.
- Open `<div className="editor-layout">` after the header.
- Wrap the current navigation and content-list section in `<aside className="editor-navigation">` and add `editor-kind-nav` and `editor-entry-list` to those two current elements.
- Change the current draft section opening tag to `<section className="editor-workspace" aria-label="편집 초안">`.
- Open `<div className={galleryDraft ? 'editor-form-pane editor-form-pane--gallery' : 'editor-form-pane'}>` before the unsaved-status paragraph. Close it after the Markdown action buttons or gallery controls, before `PreviewPane`.
- Close `.editor-layout` after the draft section and render the complete audit footer below.

```tsx
<header className="editor-header">
  <div>
    <p className="editor-eyebrow">CHEONMU ARCHIVE</p>
    <h1>천무 로컬 편집기</h1>
    <p>저장 전 미리보기와 스키마 검증을 확인하세요.</p>
  </div>
</header>
```

Replace the Markdown preview invocation with this complete call:

```tsx
<PreviewPane
  className="editor-preview-pane"
  kind={draft.kind}
  data={preview.data}
  body={preview.body}
  path={`src/content/${draft.kind}/${draft.id}.md`}
  action={action}
/>
```

Render the authoritative audit footer once, rather than retaining the gallery plan list inside the form:

```tsx
<footer className="editor-change-bar" aria-label="변경 상태">
  <strong>{hasUnsavedChanges ? '저장되지 않은 변경' : '변경 없음'}</strong>
  {changeLines.length > 0 && <ul aria-label="변경 파일">
    {changeLines.map((line) => <li key={line}>{line}</li>)}
  </ul>}
</footer>
{message && <p className="editor-toast" role="status">{message}</p>}
```

Extend `PreviewPaneProps` with `className?: string` and merge it on the current `<aside>`. The resulting component is:

```tsx
import type { JSX } from 'react';
import { ArchiveContentDisplay, RecordContentDisplay } from '../components/ContentDisplay';
import type { ArchiveDocument, ArchiveProfile, ArchiveRecord, DocumentMeta, ProfileMeta, RecordMeta } from '../content/schema';
import type { EditorKind } from './api';

export type EditorAction = '생성' | '수정' | '변경 없음' | '삭제 예정';
type PreviewPaneProps = {
  className?: string;
  kind: EditorKind;
  data: RecordMeta | ProfileMeta | DocumentMeta;
  body: string;
  path: string;
  action: EditorAction;
};

export function PreviewPane({ className, kind, data, body, path, action }: PreviewPaneProps): JSX.Element {
  return <aside className={className} aria-label="미리보기">
    <p>변경 파일: <code>{path}</code></p>
    <p>작업: {action}</p>
    <article className={kind === 'records' ? 'record-detail' : 'archive-detail'}>
      {kind === 'records' && <RecordContentDisplay record={{ ...data as RecordMeta, body } as ArchiveRecord} headingLevel={2} editorDetails />}
      {kind === 'profiles' && <ArchiveContentDisplay kind="profile" content={{ ...data as ProfileMeta, body } as ArchiveProfile} headingLevel={2} editorDetails />}
      {kind === 'documents' && <ArchiveContentDisplay kind="document" content={{ ...data as DocumentMeta, body } as ArchiveDocument} headingLevel={2} editorDetails />}
    </article>
  </aside>;
}
```

- [ ] **Step 4: Add the desktop CSS**

Extend `src/editor/editor.css` with scoped rules implementing:

```css
.editor-header,
.editor-change-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-md);
  padding: var(--space-md) clamp(1rem, 3vw, 2.5rem);
  border-color: rgb(184 170 144 / 32%);
  background: rgb(29 27 26 / 92%);
}

.editor-header { border-bottom: 1px solid rgb(184 170 144 / 32%); }
.editor-change-bar { border-top: 1px solid rgb(184 170 144 / 32%); }
.editor-eyebrow { margin: 0; color: #c6a879; font-size: 0.75rem; letter-spacing: 0.18em; }
.editor-header h1 { margin: 0.2rem 0; font: 700 clamp(1.35rem, 2vw, 2rem)/1.2 var(--font-document); }
.editor-header p { margin-block: 0; color: #c7bbae; }

.editor-layout {
  display: grid;
  grid-template-columns: 15rem minmax(0, 1fr);
  min-height: calc(100vh - 10rem);
}

.editor-navigation {
  min-width: 0;
  border-right: 1px solid rgb(184 170 144 / 28%);
  background: rgb(23 20 18 / 88%);
}

.editor-kind-nav { display: grid; grid-template-columns: repeat(2, 1fr); gap: 0.4rem; padding: 1rem; }
.editor-entry-list { padding: 0 1rem 1rem; }
.editor-entry-list ul { display: grid; gap: 0.35rem; padding: 0; list-style: none; }

.editor-workspace {
  display: grid;
  grid-template-columns: minmax(22rem, 1fr) minmax(22rem, 1fr);
  gap: 1rem;
  min-width: 0;
  padding: 1rem;
}

.editor-form-pane,
.editor-preview-pane {
  min-width: 0;
  max-height: calc(100vh - 12rem);
  overflow: auto;
  border: 1px solid rgb(184 170 144 / 35%);
  border-radius: 0.5rem;
  background: rgb(42 37 34 / 96%);
  box-shadow: 0 1rem 2.5rem rgb(0 0 0 / 24%);
}

.editor-form-pane { padding: 1rem; }
.editor-preview-pane { padding: clamp(1rem, 2.5vw, 2rem); color: var(--ink); background: var(--paper-raised); }
.editor-form-pane fieldset { display: grid; gap: 0.8rem; margin: 0; border: 0; padding: 0; }
.editor-form-pane label { display: grid; gap: 0.3rem; color: #e5d9ca; font-size: 0.875rem; font-weight: 700; }
.editor-form-pane input:not([type='checkbox']):not([type='file']),
.editor-form-pane select,
.editor-form-pane textarea {
  width: 100%;
  border: 1px solid #65594e;
  border-radius: 0.35rem;
  padding: 0.65rem 0.75rem;
  color: #f1e8dc;
  background: #211e1c;
  font-size: 0.875rem;
}
.editor-form-pane textarea { min-height: 9rem; resize: vertical; }
.editor-form-pane [aria-invalid='true'] { border-color: #d47d70; }
.editor-form-pane [role='alert'] { margin: -0.5rem 0 0; color: #ffafa3; font-size: 0.75rem; }
.editor-shell button { min-height: 2.5rem; border: 1px solid #706156; border-radius: 0.35rem; padding: 0.55rem 0.8rem; color: #f4eadc; background: #3b332e; cursor: pointer; }
.editor-shell button[aria-pressed='true'] { border-color: #bd6e62; background: var(--muyeong-red); }
.editor-shell button:disabled { cursor: not-allowed; opacity: 0.48; }
.editor-shell button:not(:disabled):hover { background: #54463e; }
```

- [ ] **Step 5: Verify Task 2**

Run: `npm run test:run -- src/editor/EditorApp.test.tsx src/editor/editor-style.test.ts`

Expected: all focused tests pass with existing save, delete, validation, plan, and stale-response coverage unchanged.

- [ ] **Step 6: Commit Task 2**

```powershell
git add src/editor/EditorApp.tsx src/editor/PreviewPane.tsx src/editor/EditorApp.test.tsx src/editor/editor.css
git commit -m "style: add editor three-pane workspace"
```

---

### Task 3: Add responsive behavior and real browser layout verification

**Files:**
- Create: `playwright.editor.config.ts`
- Create: `e2e/editor-layout.spec.ts`
- Modify: `src/editor/editor.css`
- Modify: `src/editor/editor-style.test.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: local editor API at `127.0.0.1:4174` and Vite editor entry at `127.0.0.1:5173/editor/`.
- Produces: `npm run e2e:editor` for 1440px, 768px, and 390px layout verification.

- [ ] **Step 1: Write failing responsive CSS assertions**

Append to `src/editor/editor-style.test.ts`:

```ts
it('defines the approved tablet and mobile breakpoints', () => {
  const css = read('./editor.css');
  expect(css).toContain('@media (max-width: 1023px)');
  expect(css).toContain('@media (max-width: 699px)');
  expect(css).toContain('grid-template-columns: minmax(0, 1fr) minmax(0, 1fr)');
  expect(css).toContain('grid-template-columns: 1fr');
});
```

- [ ] **Step 2: Run the test and confirm RED**

Run: `npm run test:run -- src/editor/editor-style.test.ts -t "approved tablet"`

Expected: FAIL because the media queries do not exist.

- [ ] **Step 3: Implement exact tablet/mobile layouts**

Append to `src/editor/editor.css`:

```css
@media (max-width: 1023px) {
  .editor-layout { grid-template-columns: 1fr; }
  .editor-navigation { border-right: 0; border-bottom: 1px solid rgb(184 170 144 / 28%); }
  .editor-kind-nav { display: flex; overflow-x: auto; padding-bottom: 0.5rem; }
  .editor-kind-nav button { flex: 0 0 auto; }
  .editor-entry-list ul { display: flex; gap: 0.5rem; overflow-x: auto; }
  .editor-entry-list li { flex: 0 0 auto; }
  .editor-workspace { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }
}

@media (max-width: 699px) {
  .editor-header,
  .editor-change-bar { align-items: flex-start; flex-direction: column; padding: 1rem; }
  .editor-workspace { grid-template-columns: 1fr; padding: 0.75rem; }
  .editor-form-pane,
  .editor-preview-pane { max-height: none; }
  .editor-shell button { width: 100%; }
  .editor-entry-list ul { display: grid; overflow: visible; }
}
```

- [ ] **Step 4: Add a dedicated editor Playwright configuration**

Create `playwright.editor.config.ts`:

```ts
import { defineConfig } from 'playwright/test';

export default defineConfig({
  testDir: './e2e',
  testMatch: 'editor-layout.spec.ts',
  workers: 1,
  use: { baseURL: 'http://127.0.0.1:5173/editor/', trace: 'on-first-retry' },
  webServer: [
    {
      command: 'npx tsx editor/server.ts',
      url: 'http://127.0.0.1:4174/api/editor/records',
      reuseExistingServer: !process.env.CI,
    },
    {
      command: 'npx vite --host 127.0.0.1 --port 5173 --strictPort',
      url: 'http://127.0.0.1:5173/editor/',
      reuseExistingServer: !process.env.CI,
    },
  ],
});
```

Add to `package.json` scripts:

```json
"e2e:editor": "playwright test --config playwright.editor.config.ts"
```

- [ ] **Step 5: Write browser geometry tests before final visual tuning**

Create `e2e/editor-layout.spec.ts`:

```ts
import { expect, test } from '@playwright/test';

for (const viewport of [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'tablet', width: 768, height: 900 },
  { name: 'mobile', width: 390, height: 844 },
]) {
  test(`${viewport.name} editor stays readable without horizontal overflow`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto('./');
    await page.getByRole('button', { name: '첫 조우 편집' }).click();

    const shell = page.locator('.editor-shell');
    const form = page.locator('.editor-form-pane');
    const preview = page.locator('.editor-preview-pane');
    await expect(shell).toBeVisible();
    await expect(form).toBeVisible();
    await expect(preview).toBeVisible();

    const geometry = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
      formTop: document.querySelector('.editor-form-pane')!.getBoundingClientRect().top,
      previewTop: document.querySelector('.editor-preview-pane')!.getBoundingClientRect().top,
    }));
    expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth + 1);
    if (viewport.width >= 700) expect(Math.abs(geometry.formTop - geometry.previewTop)).toBeLessThan(2);
    else expect(geometry.previewTop).toBeGreaterThan(geometry.formTop);
  });
}
```

- [ ] **Step 6: Run responsive and editor browser tests**

Run: `npm run test:run -- src/editor && npm run e2e:editor`

Expected: all editor unit tests pass; Playwright passes at 1440x900, 768x900, and 390x844 with no horizontal overflow.

- [ ] **Step 7: Run the full publication gate and inspect all three widths**

Run:

```powershell
npm run test:run
npm run validate
npm run build
npm run e2e
npm run e2e:editor
rg -n '/api/editor|src/editor|editor-shell|private-images|staged-images' dist
```

Expected: 0 test failures; validation and both builds succeed; public and editor E2E suites pass; final `rg` exits 1 with no matches. Capture or inspect screenshots at 1440x900, 768x900, and 390x844 and confirm labels, inputs, action buttons, and preview do not overlap or clip.

- [ ] **Step 8: Commit Task 3**

```powershell
git add src/editor/editor.css src/editor/editor-style.test.ts playwright.editor.config.ts e2e/editor-layout.spec.ts package.json
git commit -m "test: verify responsive editor layout"
```
