# Gallery Review Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make legacy gallery replacement, visibility migration, private previews, and asynchronous image selection safe and regression-tested.

**Architecture:** Gallery storage owns canonical path resolution and compensating filesystem transactions. The loopback editor server serves private bytes only through storage, while React keeps signature reads generation-scoped so stale asynchronous results cannot mutate current drafts.

**Tech Stack:** TypeScript, Node.js filesystem promises, Express, React 19, Vitest, React Testing Library, Supertest, Vite.

## Global Constraints

- Use strict RED→GREEN: every production behavior change follows an observed failing test.
- Private bytes remain outside `public/` and production `dist/`.
- Private preview is available only through the editor API bound to `127.0.0.1`.
- All filesystem targets remain canonical, workspace-contained, and non-reparse.
- Do not push.

---

### Task 1: Legacy replacement candidate resolution

**Files:**
- Modify: `editor/gallery-storage.test.ts`
- Modify: `editor/gallery-storage.ts`
- Modify: `scripts/public-gallery.test.ts`

**Interfaces:**
- Consumes: `GalleryItem.image`, `storedImagePath(locations, item)`.
- Produces: a shared candidate collector used by `registerImage` and `writeItemWithImage` that includes the exact existing metadata path plus normalized ID paths in both roots.

- [ ] **Step 1: Write failing legacy fixtures**

Add storage tests that create an existing item whose image is `/images/legacy-portrait.png`, replace ID `work`, and assert the legacy public/private file is trashed. Add a build integration flow that performs a private replacement before Vite build and asserts neither legacy nor normalized private bytes exist in `dist`. Add a legacy POST test whose existing private image is outside `public/`.

- [ ] **Step 2: Verify RED**

Run: `npm run test:run -- editor/gallery-storage.test.ts scripts/public-gallery.test.ts -t "legacy|original POST"`

Expected: failures show legacy files remain, POST cannot resolve the private metadata path, or `dist/images/legacy-portrait.png` still exists.

- [ ] **Step 3: Implement the candidate collector**

Collect the current item's canonical metadata path through `storedImagePath`, then scan `/images/<id>.{png,jpg,jpeg,webp}` in both roots. Deduplicate canonical paths. Use the helper from combined replacement and legacy POST replacement.

- [ ] **Step 4: Verify GREEN**

Run the focused command from Step 2 and expect all selected tests to pass.

### Task 2: Failure-atomic visibility migration

**Files:**
- Modify: `editor/gallery-storage.test.ts`
- Modify: `editor/gallery-storage.ts`

**Interfaces:**
- Consumes: optional `filesystem.unlink` operation in `GalleryStorageOptions`.
- Produces: `writeItem()` compensation that removes a linked destination and restores a removed source before propagating failure.

- [ ] **Step 1: Write the injected unlink failure regression**

Create a private item, configure storage with an unlink function that throws for its private source, attempt `public: true`, and assert the public destination is absent, the private source bytes remain, and gallery metadata is unchanged.

- [ ] **Step 2: Verify RED**

Run: `npm run test:run -- editor/gallery-storage.test.ts -t "unlink failure"`

Expected: the public destination exists after rejection.

- [ ] **Step 3: Implement compensation**

Track `destinationLinked` and `sourceRemoved`. Wrap link, unlink, and metadata write in one `try`. On error, restore the source from the destination if it was removed, then remove the destination; if unlink itself failed, remove only the newly linked destination.

- [ ] **Step 4: Verify GREEN**

Run the focused command from Step 2 and expect the atomicity assertions to pass.

### Task 3: Loopback private image preview

**Files:**
- Modify: `editor/gallery-storage.test.ts`
- Modify: `editor/gallery-storage.ts`
- Modify: `editor/server.ts`
- Modify: `src/editor/GalleryForm.test.tsx`
- Modify: `src/editor/GalleryForm.tsx`

**Interfaces:**
- Produces: `readPrivateImage(id): Promise<{ bytes: Buffer; contentType: 'image/png' | 'image/jpeg' | 'image/webp' }>`.
- Produces: `GET /api/editor/gallery/:id/image` for private items only.
- Consumes: `GalleryItem.public` and `GalleryItem.id` to choose saved preview URL.

- [ ] **Step 1: Write failing HTTP/storage/RTL tests**

Assert private GET returns exact bytes, correct `Content-Type`, `Cache-Control: no-store`, and `X-Content-Type-Options: nosniff`; public GET returns 404; a private-root symlink/reparse target is rejected; `GalleryForm` renders `/api/editor/gallery/<id>/image` for private saved items and the public asset URL for public items.

- [ ] **Step 2: Verify RED**

Run: `npm run test:run -- editor/gallery-storage.test.ts src/editor/GalleryForm.test.tsx -t "private preview|saved preview"`

Expected: HTTP route is 404 and the form points a private item at `/images/...`.

- [ ] **Step 3: Implement storage, route, and URL selection**

Validate ID and private metadata, resolve strictly within `privateImages`, inspect signature to choose MIME, set response headers, and send bytes. In the form, keep selected object URLs first, use editor API only for saved private items, and retain `resolvePublicAssetUrl` for public items.

- [ ] **Step 4: Verify GREEN**

Run the focused command from Step 2 and expect all selected tests to pass.

### Task 4: Generation-scoped asynchronous signature reads

**Files:**
- Modify: `src/editor/GalleryForm.test.tsx`
- Modify: `src/editor/EditorApp.tsx`

**Interfaces:**
- Produces: immediate `galleryImagePending` state and a monotonically increasing `galleryImageReadToken`.
- Consumes: functional `setGalleryDraft(current => ...)` so the latest ID is used after async resolution.

- [ ] **Step 1: Write delayed FileReader regressions**

Install a controllable FileReader test double and assert: selection immediately marks an unchanged item dirty; an ID edited before resolution determines the final path; a newer file remains selected when an older read resolves later; navigation invalidates the old read and preserves the newly opened draft.

- [ ] **Step 2: Verify RED**

Run: `npm run test:run -- src/editor/GalleryForm.test.tsx -t "pending signature|older signature|navigation during signature"`

Expected: dirty/save state is delayed, stale files overwrite current state, or old navigation context reappears.

- [ ] **Step 3: Implement immediate pending state and guards**

Increment the token before every read and on every gallery reset/navigation. Store selected file identity in a ref. Immediately set dirty/pending and an image validation message. On resolution, require matching token/file and update the current draft functionally, deriving the path from its current ID. Clear pending on valid, invalid, reset, save, and delete outcomes.

- [ ] **Step 4: Verify GREEN**

Run the focused command from Step 2 and then all `GalleryForm.test.tsx` tests.

### Task 5: Final verification and handoff

**Files:**
- Modify: `.superpowers/sdd/editor-task-3-report.md`

- [ ] **Step 1: Run focused and full verification**

Run `npm run test:run -- editor/gallery-storage.test.ts scripts/public-gallery.test.ts src/editor/GalleryForm.test.tsx src/editor/EditorApp.test.tsx`, `npm run test:run`, `npm run validate`, `npm run build`, and `npm run e2e`.

- [ ] **Step 2: Scan production output and diff**

Run `rg -n '/api/editor|src/editor|PRIVATE_METADATA_MARKER|PRIVATE_IMAGE_BYTES|legacy-private' dist` and require no matches. Run `git diff --check` and require exit 0.

- [ ] **Step 3: Append report**

Record RED/GREEN evidence, exact final counts, route security headers, transaction rollback coverage, and distribution absence in `.superpowers/sdd/editor-task-3-report.md`.

- [ ] **Step 4: Commit without pushing**

Stage only Task 3 review-hardening changes and commit with `fix: harden private gallery workflows`. Confirm a clean worktree and report the commit hash.
