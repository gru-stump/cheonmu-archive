# Cheonmu Local Editor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an owner-only local editor that validates, previews, writes, and recoverably deletes the same Markdown and gallery content consumed by the public archive.

**Architecture:** A loopback-only Express service exposes narrowly scoped content CRUD endpoints backed by the shared Zod schemas. A separate Vite editor entry uses React forms and preview components; the standard production build continues to use only the public `index.html`, so editor code never ships to GitHub Pages.

**Tech Stack:** React, TypeScript, Express, Vite, Zod, Vitest, Supertest, Testing Library, tsx

## Global Constraints

- `npm run editor` must bind its write service only to `127.0.0.1`.
- Public production builds must not contain editor routes, API code, or private gallery items.
- All writes must pass the same schemas and cross-reference validation as public builds.
- Deletes move files to `.trash/` with a timestamped name; they never permanently delete source content.
- The editor must show a changed-file list and preview before save.
- Image writes are limited to supported raster extensions `.png`, `.jpg`, `.jpeg`, and `.webp`.

---

### Task 1: Add a loopback-only content service

**Files:**
- Create: `editor/server.ts`
- Create: `editor/storage.ts`
- Create: `editor/storage.test.ts`
- Modify: `package.json`
- Modify: `.gitignore`

**Interfaces:**
- Produces: `createEditorServer({ rootDir }): Express`.
- Produces: `listEntries(kind)`, `readEntry(kind, id)`, `writeEntry(kind, id, source)`, `trashEntry(kind, id)`.
- API: `GET /api/editor/:kind`, `GET|PUT|DELETE /api/editor/:kind/:id`.

- [ ] **Step 1: Write failing storage safety tests**

```ts
it('rejects traversal outside the content root', async () => {
  await expect(storage.readEntry('records', '../profiles/muyeong')).rejects.toThrow('허용되지 않은 경로입니다.');
});

it('moves deleted content into trash', async () => {
  await storage.trashEntry('records', 'draft-event');
  expect(await exists('src/content/records/draft-event.md')).toBe(false);
  expect(await glob('.trash/records/*-draft-event.md')).toHaveLength(1);
});
```

- [ ] **Step 2: Install server dependencies and confirm failure**

Run:

```powershell
npm install express
npm install -D @types/express supertest @types/supertest
npm run test:run -- editor/storage.test.ts
```

Expected: FAIL because editor storage does not exist.

- [ ] **Step 3: Implement constrained storage**

Map allowed kinds explicitly to `records`, `profiles`, and `documents`; accept IDs matching `/^[a-z0-9-]+$/`; resolve paths and verify they remain under the mapped root. Validate Markdown with shared schemas before atomic replacement. Implement trash by moving to `.trash/<kind>/<ISO-safe-timestamp>-<id>.md`.

- [ ] **Step 4: Implement the API and loopback startup**

Start with `app.listen(4174, '127.0.0.1')`. Return JSON problem objects `{ error: string; fields?: Record<string,string> }` for validation errors. Reject request bodies over 2 MB.

- [ ] **Step 5: Verify and commit**

Run: `npm run test:run -- editor && npm run build`

Expected: storage/API tests pass and the public build contains no editor server code.

```powershell
git add editor package.json package-lock.json .gitignore
git commit -m "feat: add safe local content service"
```

### Task 2: Build the editor UI and validated preview

**Files:**
- Create: `editor/index.html`
- Create: `src/editor/main.tsx`
- Create: `src/editor/EditorApp.tsx`
- Create: `src/editor/RecordForm.tsx`
- Create: `src/editor/ProfileForm.tsx`
- Create: `src/editor/DocumentForm.tsx`
- Create: `src/editor/PreviewPane.tsx`
- Create: `src/editor/api.ts`
- Create: `src/editor/EditorApp.test.tsx`
- Create: `scripts/start-editor.mjs`
- Modify: `vite.config.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes the API from Task 1 and schemas from the public archive.
- Produces an editor at `http://127.0.0.1:5173/editor/`.
- Produces `EditorDraft` with `{ kind, id, source, dirty, validation }`.

- [ ] **Step 1: Write the failing edit-preview-save test**

```tsx
it('validates and saves an edited record', async () => {
  render(<EditorApp api={fakeEditorApi} />);
  await userEvent.click(screen.getByRole('button', { name: '첫 조우 편집' }));
  await userEvent.clear(screen.getByLabelText('제목'));
  await userEvent.type(screen.getByLabelText('제목'), '최초 접촉');
  expect(screen.getByRole('heading', { name: '최초 접촉' })).toBeVisible();
  await userEvent.click(screen.getByRole('button', { name: '저장' }));
  expect(fakeEditorApi.save).toHaveBeenCalledWith(expect.objectContaining({ id: 'first-contact' }));
});
```

- [ ] **Step 2: Run the test and confirm failure**

Run: `npm run test:run -- src/editor/EditorApp.test.tsx`

Expected: FAIL because the editor UI does not exist.

- [ ] **Step 3: Implement editor navigation and forms**

Provide record/profile/document tabs, searchable entry lists, labeled fields for every schema property, Markdown body editing, confirmed/draft selection, related-record multiselect, and unsaved-change warnings. Disable Save when validation fails and render field errors next to their controls.

- [ ] **Step 4: Implement live preview and changed-file reporting**

Reuse public `StatusStamp`, Markdown rendering, and record/profile display components. Show the exact relative file path and `생성`, `수정`, or `삭제 예정` state before confirmation.

- [ ] **Step 5: Configure separate editor development entry**

Proxy `/api/editor` to `http://127.0.0.1:4174`. Keep `vite build` rooted at public `index.html` only. Add `"editor": "node scripts/start-editor.mjs"` to `package.json`. The runner must start `npx tsx editor/server.ts` and `npx vite --host 127.0.0.1 --open /editor/` with `child_process.spawn`, inherit stdio, and forward `SIGINT`/`SIGTERM` to both children:

```js
import { spawn } from 'node:child_process';

const command = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const children = [
  spawn(command, ['tsx', 'editor/server.ts'], { stdio: 'inherit' }),
  spawn(command, ['vite', '--host', '127.0.0.1', '--open', '/editor/'], { stdio: 'inherit' }),
];

const stop = (signal) => children.forEach((child) => child.kill(signal));
process.on('SIGINT', () => stop('SIGINT'));
process.on('SIGTERM', () => stop('SIGTERM'));
```

- [ ] **Step 6: Verify and commit**

Run: `npm run test:run -- src/editor && npm run build`

Expected: editor tests pass and searching `dist/` for `/api/editor` returns no matches.

```powershell
git add editor/index.html src/editor scripts/start-editor.mjs vite.config.ts package.json package-lock.json
git commit -m "feat: add local archive editor interface"
```

### Task 3: Add recoverable gallery management

**Files:**
- Create: `editor/gallery-storage.ts`
- Create: `editor/gallery-storage.test.ts`
- Create: `src/editor/GalleryForm.tsx`
- Create: `src/editor/GalleryForm.test.tsx`
- Modify: `editor/server.ts`
- Modify: `src/editor/EditorApp.tsx`

**Interfaces:**
- API: `POST /api/editor/gallery/image`, `PUT /api/editor/gallery/:id`, `DELETE /api/editor/gallery/:id`.
- Upload result: `{ path: string; width: number; height: number }`.

- [ ] **Step 1: Write failing file-type and credit tests**

```ts
it('rejects executable uploads renamed as images', async () => {
  const result = await uploadFixture('not-an-image.png');
  expect(result.status).toBe(422);
  expect(result.body.error).toBe('지원하지 않는 이미지 파일입니다.');
});

it('requires creator and alt text for public work', async () => {
  const result = galleryItemSchema.safeParse({ id: 'work', public: true, creator: '', alt: '' });
  expect(result.success).toBe(false);
});
```

- [ ] **Step 2: Run tests and confirm failure**

Run: `npm run test:run -- editor/gallery-storage.test.ts src/editor/GalleryForm.test.tsx`

Expected: FAIL because gallery editing does not exist.

- [ ] **Step 3: Implement safe image registration**

Detect actual PNG, JPEG, and WebP signatures; do not trust filename extensions. Normalize generated filenames to `<gallery-id>.<ext>`, prevent overwrite without explicit confirmation, and move replaced/deleted images to `.trash/images/`.

- [ ] **Step 4: Implement gallery metadata editing**

Require title, creator, alt text, character tags, and public state. Allow an optional HTTPS source URL. Show the selected image preview and resulting public path before saving.

- [ ] **Step 5: Verify public exclusion and commit**

Run:

```powershell
npm run test:run
npm run validate
npm run build
rg "/api/editor|src/editor|private" dist
```

Expected: all tests and validation pass; final `rg` returns no editor code or private fixture marker.

```powershell
git add editor src/editor src/content/gallery.yaml
git commit -m "feat: add recoverable gallery editing"
```

## Phase Completion Gate

Run `npm run editor`, edit a draft record, add a credited test image, preview both, save them, and recoverably delete them. Then run the complete public gate (`validate`, unit tests, build, end-to-end tests) and confirm the editor and private items remain absent from `dist/`.
