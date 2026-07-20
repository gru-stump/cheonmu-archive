# Cheonmu Editor Balanced Spacing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Normalize navigation, form, control, action, and gallery spacing in the styled local editor without changing editor behavior or public output.

**Architecture:** Keep the current JSX and three-pane layout, adding only editor-scoped CSS selectors and browser geometry assertions. Use a CSS contract test for exact spacing rules and the existing dedicated editor Playwright suite for real desktop, tablet, and mobile verification.

**Tech Stack:** CSS Grid/Flexbox, Vitest, Playwright, React 19, Vite

## Global Constraints

- Preserve the approved three-pane desktop layout, tablet two-pane layout, and mobile vertical layout.
- Preserve all handlers, storage, API, validation, trash, rollback, gallery planning, security, ARIA, and focus-ring behavior.
- Use the balanced values exactly: 16px panel padding, 14px field spacing, 6px label-control spacing, 4px description/error spacing, 8px action spacing, and 40px minimum control height.
- Use a 2-column non-scrolling content-kind grid at 699px and narrower.
- Keep editor-only selectors scoped below `.editor-` classes and keep editor CSS absent from public `dist/`.
- Do not add an external CSS or component dependency.

---

### Task 1: Normalize navigation, search, and mobile content tabs

**Files:**
- Modify: `src/editor/editor.css`
- Modify: `src/editor/editor-style.test.ts`
- Modify: `e2e/editor-layout.spec.ts`

**Interfaces:**
- Consumes: `.editor-kind-nav`, `.editor-entry-list`, and existing content-kind/list buttons.
- Produces: vertically separated search controls, equal-width list buttons, tablet scroll affordance, and a complete mobile 2×2 kind grid.

- [ ] **Step 1: Write the failing CSS contract**

Append to `src/editor/editor-style.test.ts`:

```ts
it('defines balanced navigation and mobile tab spacing', () => {
  const css = read('./editor.css');
  expect(css).toContain(`.editor-entry-list > label {
  display: grid;
  gap: 0.375rem;
}`);
  expect(css).toContain(`.editor-entry-list > button {
  width: 100%;
  margin-top: 0.625rem;
}`);
  expect(css).toContain(`.editor-entry-list li > button {
  width: 100%;
  text-align: left;
}`);
  expect(css).toContain(`grid-template-columns: repeat(2, minmax(0, 1fr));`);
  expect(css).toContain(`.editor-kind-nav {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    overflow: visible;
  }`);
});
```

- [ ] **Step 2: Run the focused test and confirm RED**

Run: `npm run test:run -- src/editor/editor-style.test.ts -t "balanced navigation"`

Expected: FAIL because search controls are inline, list buttons use content width, and mobile tabs remain a horizontal flex scroller.

- [ ] **Step 3: Implement balanced navigation rules**

Add before the media queries in `src/editor/editor.css`:

```css
.editor-entry-list > label {
  display: grid;
  gap: 0.375rem;
}

.editor-entry-list > label input {
  width: 100%;
  min-height: 2.5rem;
  border: 1px solid #65594e;
  border-radius: 0.35rem;
  padding: 0.55rem 0.7rem;
  color: #f1e8dc;
  background: #211e1c;
}

.editor-entry-list > button {
  width: 100%;
  margin-top: 0.625rem;
}

.editor-entry-list li > button {
  width: 100%;
  text-align: left;
}
```

Change the tablet list gap from `0.5rem` to `0.5rem` explicitly and add a scroll affordance to `.editor-entry-list` inside the 1023px media query:

```css
.editor-entry-list {
  position: relative;
}

.editor-entry-list::after {
  position: absolute;
  right: 0;
  bottom: 1rem;
  width: 2rem;
  height: 3rem;
  pointer-events: none;
  content: '';
  background: linear-gradient(90deg, transparent, rgb(23 20 18 / 92%));
}
```

Inside the 699px media query, override the tablet rules exactly:

```css
.editor-kind-nav {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  overflow: visible;
}
.editor-kind-nav button { width: 100%; }
.editor-entry-list::after { display: none; }
```

- [ ] **Step 4: Add a real mobile navigation regression**

Append this test to `e2e/editor-layout.spec.ts` outside the viewport loop:

```ts
test('mobile navigation shows all content kinds and separates search actions', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('./');

  const kinds = page.getByRole('navigation', { name: '콘텐츠 종류' }).getByRole('button');
  await expect(kinds).toHaveCount(4);
  const kindBoxes = await kinds.evaluateAll((buttons) => buttons.map((button) => button.getBoundingClientRect().toJSON()));
  expect(kindBoxes.every((box) => box.left >= 0 && box.right <= 390)).toBe(true);
  expect(new Set(kindBoxes.map((box) => Math.round(box.top))).size).toBe(2);

  const search = page.getByRole('textbox', { name: '검색' });
  const create = page.getByRole('button', { name: '새 기록' });
  const searchBox = await search.boundingBox();
  const createBox = await create.boundingBox();
  expect(searchBox).not.toBeNull();
  expect(createBox).not.toBeNull();
  expect(createBox!.y).toBeGreaterThanOrEqual(searchBox!.y + searchBox!.height + 9);
});
```

- [ ] **Step 5: Verify Task 1**

Run: `npm run test:run -- src/editor/editor-style.test.ts && npm run e2e:editor`

Expected: CSS contract passes; all editor E2E tests pass; mobile shows four complete kind buttons in two rows and the create button begins at least 9px below the search input.

- [ ] **Step 6: Commit Task 1**

```powershell
git add src/editor/editor.css src/editor/editor-style.test.ts e2e/editor-layout.spec.ts
git commit -m "style: align editor navigation spacing"
```

---

### Task 2: Normalize form controls, field rhythm, actions, and gallery spacing

**Files:**
- Modify: `src/editor/editor.css`
- Modify: `src/editor/editor-style.test.ts`
- Modify: `e2e/editor-layout.spec.ts`

**Interfaces:**
- Consumes: the current fieldset/label/paragraph structure, `.editor-actions`, and gallery image preview.
- Produces: balanced field rhythm, aligned checkbox/file controls, consistent action spacing, and bounded gallery height.

- [ ] **Step 1: Write the failing form-spacing contract**

Append to `src/editor/editor-style.test.ts`:

```ts
it('defines balanced form, checkbox, file, action, and gallery spacing', () => {
  const css = read('./editor.css');
  expect(css).toContain('gap: 0.875rem;');
  expect(css).toContain('gap: 0.375rem;');
  expect(css).toContain('min-height: 2.5rem;');
  expect(css).toContain(`.editor-form-pane label:has(input[type='checkbox'])`);
  expect(css).toContain(`.editor-form-pane input[type='file']::file-selector-button`);
  expect(css).toContain('max-height: min(62vh, 47.5rem);');
  expect(css).toContain('.editor-actions { display: flex; flex-wrap: wrap; gap: 0.5rem;');
});
```

- [ ] **Step 2: Run the contract and confirm RED**

Run: `npm run test:run -- src/editor/editor-style.test.ts -t "balanced form"`

Expected: FAIL because default paragraph margins, checkbox/file styles, 14px field rhythm, and gallery max-height do not exist.

- [ ] **Step 3: Implement the exact form rhythm**

Replace the current fieldset, label, control, error, action, and image rules with:

```css
.editor-form-pane fieldset {
  display: grid;
  gap: 0.875rem;
  margin: 0;
  border: 0;
  padding: 0;
}

.editor-form-pane legend { margin-bottom: 0.875rem; font-weight: 700; }
.editor-form-pane label {
  display: grid;
  gap: 0.375rem;
  color: #e5d9ca;
  font-size: 0.875rem;
  font-weight: 700;
}

.editor-form-pane label + p,
.editor-form-pane [role='alert'] {
  margin: -0.625rem 0 0;
  font-size: 0.75rem;
  line-height: 1.45;
}

.editor-form-pane input:not([type='checkbox']):not([type='file']),
.editor-form-pane select,
.editor-form-pane textarea {
  width: 100%;
  min-height: 2.5rem;
  border: 1px solid #65594e;
  border-radius: 0.35rem;
  padding: 0.65rem 0.75rem;
  color: #f1e8dc;
  background: #211e1c;
  font-size: 0.875rem;
}

.editor-form-pane label:has(input[type='checkbox']) {
  display: inline-flex;
  align-items: center;
  justify-self: start;
  gap: 0.5rem;
  min-height: 2.5rem;
}

.editor-form-pane input[type='checkbox'] {
  width: 1rem;
  height: 1rem;
  margin: 0;
}

.editor-form-pane input[type='file'] {
  width: 100%;
  min-height: 2.5rem;
  border: 1px solid #65594e;
  border-radius: 0.35rem;
  padding: 0.25rem;
  color: #d9cdbf;
  background: #211e1c;
}

.editor-form-pane input[type='file']::file-selector-button {
  min-height: 2rem;
  margin-right: 0.625rem;
  border: 1px solid #706156;
  border-radius: 0.25rem;
  padding: 0.35rem 0.65rem;
  color: #f4eadc;
  background: #3b332e;
}

.editor-actions { display: flex; flex-wrap: wrap; gap: 0.5rem; margin-top: 1rem; }
.editor-form-pane img {
  display: block;
  max-width: 100%;
  max-height: min(62vh, 47.5rem);
  width: auto;
  height: auto;
  margin: 0.5rem auto 0.75rem;
  padding: 0.75rem;
  object-fit: contain;
  background: rgb(23 20 18 / 70%);
}
```

Keep the current `[aria-invalid='true']` border color and surface-specific focus rules unchanged.

- [ ] **Step 4: Add browser spacing assertions for records and gallery**

In the record viewport test, add this evaluation after the existing form/preview geometry assertions. It measures only directly consecutive label groups, excluding labels separated by descriptions or errors:

```ts
const fieldGaps = await page.locator('.editor-form-pane fieldset').evaluate((fieldset) => {
  const labels = Array.from(fieldset.children).filter((element): element is HTMLLabelElement => element instanceof HTMLLabelElement);
  return labels.flatMap((label, index) => {
    const next = labels[index + 1];
    if (!next || label.nextElementSibling !== next) return [];
    const currentRect = label.getBoundingClientRect();
    const nextRect = next.getBoundingClientRect();
    return [nextRect.top - currentRect.bottom];
  });
});
expect(fieldGaps.length).toBeGreaterThan(0);
for (const gap of fieldGaps) {
  expect(gap).toBeGreaterThanOrEqual(8);
  expect(gap).toBeLessThanOrEqual(24);
}
```

Add checkbox geometry assertions on mobile:

```ts
const checkboxLine = await page.getByLabel('장면 재구성').evaluate((checkbox: HTMLInputElement) => {
  const label = checkbox.closest('label')!;
  const labelRect = label.getBoundingClientRect();
  const boxRect = checkbox.getBoundingClientRect();
  return { display: getComputedStyle(label).display, delta: Math.abs((labelRect.top + labelRect.height / 2) - (boxRect.top + boxRect.height / 2)) };
});
expect(checkboxLine.display).toBe('flex');
expect(checkboxLine.delta).toBeLessThan(2);
```

In the gallery viewport test, extend the current `page.evaluate` return object with these values:

```ts
const fileInput = formPane.querySelector<HTMLInputElement>('input[type="file"]')!;
const publicCheckbox = formPane.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
const checkboxLabel = publicCheckbox.closest('label')!;
const checkboxRect = publicCheckbox.getBoundingClientRect();
const checkboxLabelRect = checkboxLabel.getBoundingClientRect();

return {
  // Retain every current gallery geometry property.
  documentScrollWidth: document.documentElement.scrollWidth,
  documentClientWidth: document.documentElement.clientWidth,
  paneScrollWidth: formPane.scrollWidth,
  paneClientWidth: formPane.clientWidth,
  contentWidth,
  imageWidth: imageRect.width,
  imageHeight: imageRect.height,
  imageNaturalWidth: imageElement.naturalWidth,
  fileInputHeight: fileInput.getBoundingClientRect().height,
  checkboxDisplay: getComputedStyle(checkboxLabel).display,
  checkboxCenterDelta: Math.abs(
    (checkboxLabelRect.top + checkboxLabelRect.height / 2)
      - (checkboxRect.top + checkboxRect.height / 2),
  ),
};
```

Assert:

```ts
expect(geometry.imageHeight).toBeLessThanOrEqual(Math.min(viewport.height * 0.62, 760) + 1);
expect(geometry.fileInputHeight).toBeGreaterThanOrEqual(40);
expect(geometry.checkboxDisplay).toBe('flex');
expect(geometry.checkboxCenterDelta).toBeLessThan(2);
```

Capture fresh record and gallery screenshots at all three existing viewports.

- [ ] **Step 5: Run focused verification and visually inspect screenshots**

Run: `npm run test:run -- src/editor && npm run e2e:editor`

Expected: all editor unit/style tests and editor browser tests pass; mobile kinds are 2×2; controls have no clipping; checkbox/file geometry and gallery height assertions pass. Inspect all six full-page screenshots and confirm consistent 14px field rhythm, 6px label gaps, 8px action gaps, and no half-visible kind tab.

- [ ] **Step 6: Run the complete gate**

Run:

```powershell
npm run test:run
npm run validate
npm run build
npm run e2e
npm run e2e:editor
rg -n '/api/editor|src/editor|editor-shell|private-images|staged-images' dist
git diff --check
```

Expected: all tests pass with only permission-gated symlink skips; validation and build pass; both Playwright suites pass; the `rg` command exits 1 with no matches; diff check is clean.

- [ ] **Step 7: Commit Task 2**

```powershell
git add src/editor/editor.css src/editor/editor-style.test.ts e2e/editor-layout.spec.ts
git commit -m "style: balance editor form spacing"
```
