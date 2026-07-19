# Local Editor Task 2 Report

## Scope delivered

- Added the separate local editor entry at `/editor/`, editor API adapter, record/profile/document forms, searchable tabs, validation, live Markdown preview, changed-file reporting, and save/delete-planning controls.
- Added the `npm run editor` runner and a loopback editor API proxy while leaving the public Vite build rooted at `index.html`.
- Reused the public `StatusStamp` and Markdown renderer in the preview.

## TDD evidence

### RED

1. Added `src/editor/EditorApp.test.tsx` before editor production code.
2. Ran `npm run test:run -- src/editor/EditorApp.test.tsx`.
3. Result: exit 1; Vitest failed to resolve `./EditorApp` because the editor UI did not exist. This is the expected missing-feature RED state.

The first sandboxed invocation could not resolve the Windows workspace path (`EPERM` on `C:\Users\thdus`); the same read-only test was rerun with the approved external test permission and produced the intended RED result above.

### GREEN

1. Implemented the minimum editor UI and configuration described above.
2. The initial implementation exposed a real test-detected defect: clearing a required title made schema parsing unmount the form, so it could not be corrected. The preview now uses unvalidated YAML only for rendering while shared Zod schemas continue to determine `EditorDraft.validation` and Save enablement.
3. Ran `npm run test:run -- src/editor/EditorApp.test.tsx`.
4. Result: exit 0; 1 file passed, 2 tests passed.

## Verification commands and results

| Command | Result |
| --- | --- |
| `npm run test:run -- src/editor` | Exit 0; 1 file passed, 2 tests passed. |
| `npm run build` | Exit 0; `tsc --noEmit` and Vite public production build completed. |
| `rg -n '/api/editor|src/editor|private' dist` | No matches; public distribution has no editor API/source/private marker. |
| UTF-8 `ReadAllText` check across `src/editor/*.tsx` | Passed for `천무 로컬 편집기`, `제목`, `저장`, `생성`, `수정`, and `삭제 예정`, with no replacement character. |
| `git diff --check` | Exit 0; no whitespace errors. |

## Self-review

- Record, profile, and document forms expose every corresponding shared schema property, including optional credit fields; records include confirmed/draft selection, related-record multiselect, and Markdown body editing.
- Invalid fields show inline errors and disable Save. Dirty drafts show an unsaved-change warning.
- Preview reports `src/content/<kind>/<id>.md` and the modification state. The create state is represented for new unsaved drafts; delete is deliberately a two-step planned/confirm action and uses the existing recoverable API when available.
- The public build does not include the editor because no editor entry was added to Vite's production Rollup input.

## Concerns

- No blocking concerns. The editor is intentionally a separate local development entry, not a public production route.

---

## Review-fix follow-up

### Root causes

- Vite used the GitHub Pages production base during development, so the required `/editor/` URL returned 404 even though the runner launched.
- The first UI stored only a serialized source string and did not model whether a draft was existing/new, its saved baseline, or its cache relationship. That made creation unreachable, allowed existing IDs to drift, always reported existing files as modified, and left save/delete/reselection/navigation behavior inconsistent.
- API problems were reduced to a message, discarding server-provided field errors, and form errors had no accessible control linkage.
- Preview rendered only a small subset of the shared schema fields.

### RED evidence

1. Started the pre-fix `npm run editor` runner with browser opening suppressed only for automation, then requested `http://127.0.0.1:5173/editor/`.
   - Result: HTTP 404.
2. Added focused regressions for record editing, existing-ID locking, new record/profile/document creation, accurate file states, save/reselection, deletion/cache removal, dirty item/tab/create/unload navigation, API field errors, ARIA linkage, and profile/document previews.
   - Command: `npm run test:run -- src/editor/EditorApp.test.tsx`
   - Result: exit 1; 14 tests failed out of 14 for the missing review behaviors.
3. During self-review, added a cross-kind duplicate-ID regression.
   - Command: `npm run test:run -- src/editor/EditorApp.test.tsx -t "rejects a new ID"`
   - Result: exit 1; the new profile incorrectly accepted an ID already used by a record.

### Fixes and GREEN evidence

- Development now uses base `/`, while build and preview retain `/cheonmu-archive/`. The runner fixes the host and port with `--port 5173 --strictPort` and opens `/editor/`.
- Existing IDs are read-only with a clear explanation; only new drafts can edit IDs. New IDs are checked against every record/profile/document ID.
- Added reachable new-entry flows and schema-shaped defaults for all three kinds. File state is now exactly `생성`, `수정`, `변경 없음`, or `삭제 예정`, with the exact relative path derived from kind and ID.
- Successful saves replace/add the cached entry; successful deletes remove it. `remove` is required by `EditorApi`, and delete confirmation never falls through to `save`.
- Dirty or delete-planned drafts protect item selection, tab switching, starting another entry, and browser unload. Cancel preserves the draft; accept performs the requested navigation.
- JSON problem `fields` are preserved by `EditorApiError` and rendered inline. Controls with errors use `aria-invalid` and `aria-describedby` pointing to the corresponding alert.
- Preview continues to reuse public `StatusStamp`, `ReactMarkdown`, and public detail CSS structures, and now renders record number/stage/status/quote/characters/tags/related/cinematic/credit, profile height/credit, and document credit.
- Focused implementation GREEN: 14/14 tests passed after the primary fixes.
- Cross-kind ID GREEN: 1 passed, 14 skipped with the focused `-t` command.

### Final verification

| Command/check | Exact result |
| --- | --- |
| `npm run test:run -- src/editor` | Exit 0; 1 file passed, 15 tests passed. |
| `npm run test:run` | Exit 0; 14 files passed; 77 passed, 1 skipped (78 total). |
| `npm run build` | Exit 0; `tsc --noEmit` and Vite production build passed. |
| `rg -n '/api/editor|src/editor|private' dist` | No matches. |
| Clean `npm run editor` + HTTP request to `http://127.0.0.1:5173/editor/` | HTTP 200; response contains `/src/editor/main.tsx`. |
| HTTP request to `http://127.0.0.1:5173/api/editor/records` | HTTP 200; JSON array returned through the Vite proxy. |
| Listener cleanup | Verification processes on 127.0.0.1 ports 4174 and 5173 stopped; no listeners remained. |
| `git diff --check` | Exit 0. |

### Follow-up self-review and concerns

- All Critical, Important, and Minor findings supplied for the review fix are covered by focused regressions or direct HTTP/build boundary checks.
- Public record/profile/document page components are route-bound and unsuitable for direct composition in a form preview; the preview reuses their stable public primitives and class structures instead.
- No blocking concerns remain.
