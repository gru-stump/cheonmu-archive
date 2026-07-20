# Final Editor Review Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close all final whole-branch editor review findings while preserving previous transactional image, privacy, and publish protections.

**Architecture:** A per-canonical-root coordinator serializes every content mutation and validates an in-memory prospective archive through `validateArchiveContent` before disk changes. Gallery commit and read-only planning share ownership/path resolution. A pre-parser loopback guard enforces Host/Origin/fetch-site policy, while the UI renders server-provided logical change plans.

**Tech Stack:** TypeScript, Node.js filesystem promises, Express, React, Supertest, Testing Library, Vitest, Vite, Playwright.

## Global Constraints

- Strict RED/GREEN for every behavior change.
- Prospective validation failures produce zero disk changes.
- Same-process Markdown/gallery mutations serialize across storage instances.
- Plan responses expose only workspace-relative logical paths/actions, never bytes, fingerprints, backups, or absolute paths.
- Preserve public/private/staged roots, recoverable trash, candidate ownership, compensation, and the combined endpoint.
- Commit locally without pushing.

---

### Task 1: Prospective archive validation boundary

**Files:**
- Create: `editor/archive-persistence.ts`
- Create: `editor/archive-persistence.test.ts`
- Modify: `editor/storage.ts`
- Modify: `editor/storage.test.ts`
- Modify: `editor/gallery-storage.ts`
- Modify: `editor/gallery-storage.test.ts`
- Modify: `editor/server.test.ts`

**Interfaces:**
- `archiveCoordinator(rootDir).mutate<T>(operation: () => Promise<T>): Promise<T>` serializes by canonical root.
- `loadArchiveSnapshot(rootDir): Promise<{ content: ArchiveContent; publicImagePaths: string[] }>` loads all Markdown/gallery data.
- `validateProspectiveArchive(rootDir, change, options?): Promise<void>` applies a typed Markdown/gallery write/delete and throws `ArchivePersistenceError` with `fields`.

- [ ] Add RED storage/API tests for missing related IDs, cross-kind duplicate IDs, referenced-record deletion, gallery-vs-Markdown duplicate IDs, zero byte-for-byte disk changes, and two concurrent storage instances.
- [ ] Implement snapshot loading with the same schemas/frontmatter parser and call `validateArchiveContent` after applying the prospective change.
- [ ] Map duplicate messages to `id`, missing related messages to `related`, missing public images to `image`, and remaining errors to `archive`.
- [ ] Wrap every Markdown/gallery write/delete in the shared coordinator and validate before temporary files, links, unlinks, trash, or renames.
- [ ] Add prospective public gallery destination paths only for transactions that install those bytes, then run focused tests to GREEN.

### Task 2: Metadata-only extension/content enforcement

**Files:**
- Modify: `editor/gallery-storage.test.ts`
- Modify: `editor/gallery-storage.ts`

**Interfaces:**
- Reuses `validateImageExtension(submittedPath, inspectImage(bytes))` before metadata-only movement.

- [ ] Add RED storage/API PNG-to-`.jpg` metadata-only tests asserting 422 and byte-for-byte unchanged YAML/source paths.
- [ ] Validate the submitted destination extension, not only the current source filename, before link/unlink.
- [ ] Run metadata movement, interruption fallback, and rollback suites to GREEN.

### Task 3: Loopback boundary and request problem mapping

**Files:**
- Modify: `editor/server.ts`
- Modify: `editor/server.test.ts`
- Modify: `editor/gallery-storage.test.ts`
- Modify: `vite.config.ts`

**Interfaces:**
- Allowed hosts: `127.0.0.1:4174`, `localhost:4174`.
- Allowed origins: `http://127.0.0.1:5173`, `http://localhost:5173`.
- Reject `Sec-Fetch-Site: cross-site`; allow absent Origin only with absent/`none`/`same-origin`/`same-site` fetch-site.

- [ ] Add RED tests for hostile/missing Host, hostile Origin, cross-site fetch metadata, both allowed host/origin forms, and trusted no-Origin clients.
- [ ] Add pre-parser middleware returning JSON 403 before routes and set Vite proxy `changeOrigin: true`.
- [ ] Add RED malformed JSON body, malformed percent encoding, and malformed metadata JSON cases; map body parser syntax to 400 and metadata decoding/parsing to 422.
- [ ] Update API tests to send the canonical Host and run the server suites to GREEN.

### Task 4: Shared gallery change planning and UI list

**Files:**
- Modify: `editor/gallery-storage.ts`
- Modify: `editor/gallery-storage.test.ts`
- Modify: `editor/server.ts`
- Modify: `editor/server.test.ts`
- Modify: `src/editor/api.ts`
- Modify: `src/editor/EditorApp.tsx`
- Modify: `src/editor/EditorApp.test.tsx`
- Modify: `src/editor/GalleryForm.test.tsx`

**Interfaces:**
- `GalleryChangePlan = { files: Array<{ path: string; action: 'metadata' | 'destination' | 'trash' | 'stage' }> }`.
- `gallery.planItem({ item, imageExtension?, deleting? }): Promise<GalleryChangePlan>` shares candidate/path helpers with commit.
- `POST /api/editor/gallery/:id/plan` accepts the plan request and returns only logical paths/actions.
- `EditorApi.planGallery(request)` exposes the endpoint to React.

- [ ] Add RED storage/API plan tests for public, private, metadata-only move, replacement candidates, ownership exclusion, and delete.
- [ ] Extract physical-to-logical path mapping and reuse the exact destination/candidate resolvers used by write/delete operations.
- [ ] Add endpoint and API client without returning bytes, absolute paths, fingerprints, or backup names.
- [ ] Add RED UI tests proving metadata, correct private/public destination, and trash paths render before overwrite confirmation; ignore stale plan responses.
- [ ] Fetch plans for valid gallery drafts/file extensions/delete intent and render the action/path list; run editor suites to GREEN.

### Task 5: Localization and operator documentation

**Files:**
- Modify: `index.html`
- Modify: `README.md`
- Modify: `src/content/content.test.ts`

- [ ] Add RED assertions for `<html lang="ko">` and README sections covering `npm run editor`, ports 5173/4174, loopback Host/Origin policy, `public/images`, `src/content/private-images`, `src/content/staged-images`, `.trash`, and validate/test/build publishing gates.
- [ ] Change the HTML language and add concise Korean operator documentation with exact commands/paths.
- [ ] Run the focused content/document tests to GREEN.

### Task 6: Final verification and handoff

**Files:**
- Create: `.superpowers/sdd/final-editor-review-fixes-report.md`

- [ ] Run all focused storage/server/gallery/editor/content suites.
- [ ] Run full Vitest, `npm run validate`, `npm run build`, `npm run e2e`, dist private/editor/marker scans, and cached diff check.
- [ ] Record each RED/GREEN root cause, final architecture guarantees, exact commands/counts, and any environment skips in the new report.
- [ ] Commit the implementation and report; do not push; confirm a clean worktree.
