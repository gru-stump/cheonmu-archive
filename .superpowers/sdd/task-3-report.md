# Task 3 report: editor scene integration

## Root cause

`ArchiveContent.scenes` became required and `validateArchiveContent` now iterates it. The browser loader in `src/content/load.ts` and the CLI validator in `scripts/validate-content.ts` both assemble scenes from `src/content/scenes/*.md`, using the file stem as the scene ID and trimmed file contents as the body.

The editor persistence path was the only production `ArchiveContent` assembler left behind. `validateProspectiveArchive` in `editor/archive-persistence.ts` loaded records, profiles, documents, gallery data, and public image paths, then constructed `{ records, profiles, documents, gallery }`. Passing that incomplete object into the shared validator caused `content.scenes is not iterable`. The persistence error wrapper converted this into an archive field error, cascading through all editor and gallery mutation tests.

The fix is at the source assembler: the editor now loads the existing scene sidecars with the same ID/body convention and includes them in prospective archive validation. Validation remains strict, and `ArchiveContent.scenes` remains required. Because scenes participate in every prospective validation, an editor mutation cannot silently invalidate an existing scene-to-record relationship.

## RED / GREEN

Added `loads existing scene sidecars when validating a prospective record change` to `editor/storage.test.ts`. The fixture creates a cinematic record with an existing sidecar, then attempts to change the record to non-cinematic. It expects the shared relationship error and verifies that the original record remains unchanged.

- RED: `npm run test:run -- editor/storage.test.ts -t "loads existing scene sidecars"`
  - 1 failed, 19 skipped.
  - Expected `attached to a non-cinematic record`; received `content.scenes is not iterable`.
- GREEN: the same command after the source fix.
  - 1 passed, 19 skipped.
- Former cascade set: `npm run test:run -- editor/storage.test.ts editor/server.test.ts editor/gallery-storage.test.ts scripts/public-gallery.test.ts`
  - 4 files passed; 76 tests passed, 2 skipped.

## Full verification

- `npm run validate`: passed (`Content validation passed.`).
- `npm run test:run`: 18 files passed; 172 tests passed, 2 skipped (174 total).
- `npm run build`: passed; TypeScript no-emit check and Vite production build succeeded (390 modules transformed).
- `npm run e2e`: 9 tests passed.
- `git diff --check`: passed.
- `git status --short`: only task-owned source/test/report files selected for commit; pre-existing untracked user PDFs, PNGs, and profile Markdown remain untouched and unstaged.

## Self-review

- Scope is limited to the editor prospective-content assembler, one regression test, and this report.
- Missing `scenes` directories correctly produce an empty required collection; other read errors still propagate.
- Scene IDs use Markdown file stems and bodies are trimmed, matching the existing loader/CLI behavior.
- No defensive fallback was added to validation and the schema type was not weakened.

## Review follow-up: scene path safety and extension parity

Review found that the first scene loader used `readdir` and `readFile` directly. Unlike the established editor storage pattern, it did not reject reparse points, verify regular filesystem types, canonicalize paths, or prove containment before reading. It also lowercased extensions, which admitted `.MD` even though the browser loader and CLI accept lowercase `.md` only.

The revised loader now follows the existing editor path-safety sequence for both the scenes directory and every accepted file: `lstat`, reject symbolic links/non-regular types, `realpath`, verify canonical containment, then read the canonical file. Its extension filter is exactly `.md`.

### Security RED / GREEN

- RED: `npm run test:run -- editor/storage.test.ts -t "scenes directory junction|scene file symbolic link|extension is not lowercase"`
  - 2 failed: the directory junction was followed and produced `Scene escaped has no matching record`; `.MD` was loaded and produced `Scene ignored has no matching record`.
  - The file-symlink case was permission-skipped on this Windows host. Its skip guard is limited to `EPERM`, `EACCES`, and `UNKNOWN`; every other creation error is rethrown.
- GREEN: `npm run test:run -- editor/storage.test.ts -t "loads existing scene sidecars|scenes directory junction|scene file symbolic link|extension is not lowercase"`
  - 3 passed, 20 skipped (19 unselected tests plus the permission-skipped file-symlink case).
- Full focused storage: `npm run test:run -- editor/storage.test.ts`
  - 1 file passed; 21 tests passed, 2 skipped.
- Former cascade set: `npm run test:run -- editor/storage.test.ts editor/server.test.ts editor/gallery-storage.test.ts scripts/public-gallery.test.ts`
  - 4 files passed; 78 tests passed, 3 skipped.

### Fresh full verification after production changes

- `npm run validate`: passed (`Content validation passed.`).
- `npm run test:run`: 18 files passed; 174 tests passed, 3 skipped (177 total).
- `npm run build`: passed; TypeScript no-emit check and Vite production build succeeded (390 modules transformed).
- `npm run e2e`: 9 tests passed.
