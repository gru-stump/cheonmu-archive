# Local Editor Task 3 Report

## Status

Implemented recoverable gallery management on top of Task 1 storage safety and Task 2 editor pending/unsaved protections.

## Delivered

- Added a serialized gallery store for `src/content/gallery.yaml` and `public/images/`.
- Image registration identifies PNG, JPEG, and WebP from binary signatures, reads dimensions, normalizes names to `<gallery-id>.<ext>`, rejects unsafe IDs/paths/reparse directories, and never replaces an image without explicit confirmation.
- Replaced and deleted images move to unique recoverable files under `.trash/images/`.
- Every metadata replacement first creates a unique hard-link backup under `.trash/gallery/`, writes a same-directory exclusive temporary file, rechecks canonical roots, and atomically renames the validated YAML.
- Concurrent gallery reads/writes/uploads/deletes are serialized so read-modify-write updates cannot lose entries.
- Added loopback editor routes for gallery listing, binary upload, metadata PUT, and recoverable DELETE with JSON problem responses.
- Shared gallery validation now requires a safe public image path, title, alt text, creator, at least one character tag, boolean public state, and HTTPS for the optional source URL.
- Added a gallery editor section with create/edit/delete flows, selected-file preview, resulting public path, duplicate-ID validation, explicit image-replacement confirmation, and the existing synchronous mutation lock plus dirty-navigation/before-unload protections.
- Public Vite production input remains unchanged; editor modules and private markers are absent from `dist/`.

## TDD evidence

### RED 1: storage and form contracts

Command:

`npm run test:run -- editor/gallery-storage.test.ts src/editor/GalleryForm.test.tsx`

The first sandboxed run hit the known Windows worktree `EPERM` at `C:\Users\thdus`; the approved external rerun exited 1. Both suites failed for the intended missing-feature reason: `./gallery-storage` and `./GalleryForm` could not be resolved.

### GREEN 1

After implementing the shared schema, hardened gallery store, and form, the focused run initially found a real overwrite defect: an orphaned normalized PNG was not detected when a JPEG replacement targeted a different extension. The store now checks all normalized PNG/JPG/JPEG/WebP candidates.

Rerun result: exit 0; 2 files passed, 12 tests passed.

### RED 2: API and EditorApp integration

Added API and live EditorApp integration regressions before their implementation.

Command:

`npm run test:run -- editor/gallery-storage.test.ts src/editor/GalleryForm.test.tsx`

Result: exit 1; 2 expected failures and 12 passes. Upload returned HTTP 404 because gallery routes did not exist, and the UI could not find the `화랑` tab.

### GREEN 2

Command:

`npm run test:run -- editor/gallery-storage.test.ts src/editor/GalleryForm.test.tsx src/editor/EditorApp.test.tsx`

Final focused result: exit 0; 3 files passed, 33 tests passed. This includes the 17 existing EditorApp regressions, a live Supertest upload/PUT/GET/DELETE flow, an executing Windows junction defense, dirty navigation protection, and delayed gallery-save locking.

## Exact final verification

| Command/check | Result |
| --- | --- |
| `npm run test:run -- editor/gallery-storage.test.ts src/editor/GalleryForm.test.tsx src/editor/EditorApp.test.tsx` | Exit 0; 3 files, 33 tests passed. |
| `npx tsc --ignoreConfig --noEmit --target ES2022 --module ESNext --moduleResolution Bundler --esModuleInterop --skipLibCheck --strict editor/gallery-storage.ts editor/server.ts editor/storage.ts` | Exit 0. |
| `npm run test:run` | Exit 0; 16 files passed; 95 passed, 1 skipped (96 total). The skip is the existing Windows permission-gated file-symlink fixture. |
| `npm run validate` | Exit 0; `Content validation passed.` |
| `npm run build` | Exit 0; TypeScript and Vite production build passed; 388 modules transformed. |
| `rg -n '/api/editor|src/editor|private' dist` | No matches; `DIST_EDITOR_PRIVATE_SCAN_CLEAN`. |
| `npm run e2e` | Exit 0; 6 Playwright tests passed. |
| Live `npm run editor` | `http://127.0.0.1:5173/editor/` returned 200 with `/src/editor/main.tsx`; proxied `/api/editor/gallery` returned 200 with 4 items. The started process tree was stopped afterward. |
| `git diff --check` | Exit 0. |

## Self-review

- Actual content, not the filename or MIME declaration, selects the server-side output type and extension.
- Normalized targets and existing metadata image paths are resolved only below a canonical, non-reparse `public/images` root. The gallery file, content root, public root, trash roots, temporary files, replacement targets, and restored paths are all constrained to canonical workspace locations.
- Image replacement requires a 409/explicit-confirmation round trip. Metadata mutations and deletes are recoverable, and partial image-delete failures restore the original image from the newly created trash link.
- The shared Zod schema is consumed by public loading, the editor form, and server storage. The server also verifies the stored image exists, its signature matches its extension, and gallery IDs/image paths remain unique.
- Gallery state is deliberately separate from Markdown draft serialization but shares the global pending lock, navigation guard, search/list disabling, and unload warning. Existing editor tests remained green.
- No smoke content or test image was written to tracked archive content during verification; `src/content/gallery.yaml` remains semantically and textually unchanged in the task diff.

## Concerns

- The in-app browser connection failed at its environment bootstrap metadata boundary, so the live verification was limited to loopback HTTP/editor-entry/proxy checks. The same authoring mutations are covered through Supertest and React Testing Library, and the public app passed the full Playwright suite.

## Review-fix addendum (2026-07-20)

### Delivered

- Production gallery data now enters Vite through `virtual:public-gallery`, which serializes only `public: true` items before bundling. A build integration test scans emitted JavaScript and source maps and proves the private title/path markers are absent while the public marker remains.
- Private images are stored under `src/content/private-images/`, outside Vite's `public/` input. The production plugin also removes legacy private gallery resources copied from `public/` so old repositories do not leak them into `dist/`.
- Public/private metadata-only toggles move the existing image between the private and public roots. Failed metadata commits move it back; private deletion remains recoverable through `.trash/images/`.
- Image bytes and metadata now save through one serialized `PUT /api/editor/gallery/:id/image` transaction. Any metadata failure removes the replacement and restores every displaced prior image from trash, including failures after a partial candidate move.
- Selecting a replacement file always marks the gallery draft dirty, even when its normalized path equals the saved path.
- Preview/result paths use a signature-derived PNG/JPEG/WebP extension and recompute when a new item's ID changes. The server independently derives and returns the canonical path from the same uploaded bytes.
- Gallery uploads retain the 20 MB body limit and 413 responses now report `Request body exceeds 20 MB.` instead of the unrelated 2 MB metadata limit.
- Pure content validation moved to `src/content/validation.ts`, keeping the Node validation gate independent of Vite's virtual module while the browser-facing loader preserves its existing validation API.

### Additional TDD evidence

- RED: the build-filter integration test failed because `public-gallery` did not exist; GREEN: emitted JS/maps excluded private metadata and `/images/private-work.png`, and `dist` excluded the private resource.
- RED: combined private save, metadata rollback, visibility movement, private deletion, combined API, and 20 MB error regressions each failed at their missing/incorrect behavior; GREEN: the focused storage/API suite passed after implementation.
- RED: a same-path selected replacement did not trigger the navigation guard, and a PNG disguised as JPEG retained the filename extension and did not follow ID edits; GREEN: all 7 gallery form/integration tests passed.
- During final gating, `npm run validate` exposed the Node/Vite virtual-module boundary (`ERR_UNSUPPORTED_ESM_URL_SCHEME`); separating pure validation removed that dependency and the gate passed on rerun.

### Final verification after review fixes

| Command/check | Result |
| --- | --- |
| `npm run test:run -- editor/gallery-storage.test.ts scripts/public-gallery.test.ts src/editor/GalleryForm.test.tsx src/editor/EditorApp.test.tsx` | Exit 0; 4 files, 42 tests passed. |
| `npm run test:run` | Exit 0; 17 files passed; 104 passed, 1 skipped (105 total). |
| `npm run validate` | Exit 0; `Content validation passed.` |
| `npm run build` | Exit 0; TypeScript and Vite production build passed; 389 modules transformed. |
| `npm run e2e` | Exit 0; 6 Playwright tests passed. |
| `rg -n '/api/editor|src/editor|PRIVATE_METADATA_MARKER|private-work' dist` | No matches; `DIST_PRIVATE_EDITOR_SCAN_CLEAN`. |
| `git diff --check` | Exit 0. |

## Second review hardening addendum (2026-07-20)

### Delivered

- Replacement candidates now include the existing item's exact metadata image path, even when its legacy basename is unrelated to the item ID, plus normalized ID candidates in both public and private roots. The combined PUT and original POST workflows share this resolution.
- Legacy public bytes are moved to recoverable trash during replacement or metadata-only unpublishing. A storage-plus-Vite integration fixture proves neither the legacy public basename nor the normalized private replacement appears in `dist/`.
- Metadata-only public/private migration now treats destination linking, source removal, and metadata replacement as one compensating transaction. If source unlink fails, the new destination link is removed; if metadata replacement fails after source removal, the source is restored before the destination is removed.
- The loopback editor API now provides `GET /api/editor/gallery/:id/image` for private items only. Storage resolves bytes inside the canonical non-reparse private root and the route returns signature-derived `Content-Type`, `Cache-Control: no-store`, and `X-Content-Type-Options: nosniff`. Public items return 404 and reparse-backed files are rejected.
- Saved private previews use the editor API while saved public previews retain their public asset URL. Unsaved visibility toggles continue using the saved location until the migration commits, avoiding a broken preview during editing.
- File selection immediately marks the gallery draft dirty and signature inspection pending, disables save, and installs a generation token plus selected-file identity guard. Resolution updates the latest draft functionally, so current ID edits win and older file/navigation results cannot overwrite current state.

### Strict TDD evidence

- Legacy RED: original POST tried the private legacy metadata path only under `public/images` and failed with `ENOENT`; combined replacement left the exact legacy public file; a real Vite build copied that orphan into `dist`. GREEN: all three focused regressions passed after the shared two-root candidate resolver.
- Migration RED: an injected private-source unlink failure was ignored because the injection boundary did not exist, demonstrating that the existing operation could leave its public hard link. GREEN: normal migration and injected failure rollback passed, with public destination absent, private source intact, and YAML byte-for-byte unchanged.
- Preview RED: the private preview request returned 404 and `GalleryForm` used `/images/...` for private saved content. GREEN: private bytes/security headers, public denial, reparse rejection, private/public URLs, and unsaved toggle stability passed.
- FileReader RED: all four delayed-read regressions failed—no immediate pending/dirty state, an edited ID reverted, an older file won, and navigation did not prompt or invalidate the old result. GREEN: all four passed with generation and identity guards.

### Final verification after second review

| Command/check | Result |
| --- | --- |
| `npm run test:run -- editor/gallery-storage.test.ts scripts/public-gallery.test.ts src/editor/GalleryForm.test.tsx src/editor/EditorApp.test.tsx` | Exit 0; 4 files passed; 55 passed, 1 skipped (56 total). |
| `npm run test:run` | Exit 0; 17 files passed; 117 passed, 2 skipped (119 total). The skips are Windows permission-gated symlink fixtures. |
| `npm run validate` | Exit 0; `Content validation passed.` |
| `npm run build` | Exit 0; TypeScript and Vite production build passed; 389 modules transformed. |
| `npm run e2e` | Exit 0; 6 Playwright tests passed. |
| `rg -n '/api/editor|src/editor|PRIVATE_METADATA_MARKER|PRIVATE_IMAGE_BYTES|legacy-private' dist` | No matches; `DIST_PRIVATE_EDITOR_LEGACY_SCAN_CLEAN`. |
| `git diff --check` | Exit 0. |
