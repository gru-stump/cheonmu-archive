# Final editor review fixes report

Date: 2026-07-20

## Outcome

All four Important and three Minor review findings were addressed.

- Added one canonical-workspace coordinator shared by Markdown and gallery persistence.
- Added prospective full-archive validation before Markdown/gallery saves and referenced-record deletes. Cross-kind duplicate IDs, missing `related` records, and missing public gallery images return field-level `422` problems without changing archive files.
- Validated metadata-only gallery destination extensions against stored image signatures before moving bytes.
- Added strict loopback `Host` and development `Origin`/Fetch Metadata checks ahead of parsers and routes; the Vite proxy now rewrites the Host header.
- Converted malformed JSON to `400` and malformed encoded gallery metadata to `422`.
- Added a read-only gallery change-plan endpoint that reuses commit candidate discovery. The editor shows metadata, actual public/private destination, and active/replaced files before replacement confirmation.
- Changed the document language to Korean and documented editor commands, ports, security, content roots, trash recovery, and the publication validation gate.

## TDD evidence

The new regressions were first observed failing for:

- missing record relationships, cross-kind duplicate IDs, referenced-record deletion, and two independent storage instances racing;
- PNG bytes submitted to a `.jpg` metadata-only destination;
- hostile Host/Origin and malformed JSON;
- malformed percent-encoded metadata and exact read-only gallery planning.

After implementation, focused and complete suites passed.

## Verification

- `npm run test:run`: 17 files passed, 142 tests passed, 2 skipped.
- `npm run validate`: passed.
- `npm run build`: TypeScript and Vite production build passed.
- `npm run e2e`: 6 tests passed.
- `git diff --check`: passed (only Git LF/CRLF notices).
- Dist scan for editor API endpoints, private/staged roots, trash paths, and editor ports returned no matches.

The repository has no `scripts/verify-archive.cjs`; the requested archive verification command was therefore unavailable, and the equivalent validation/build/dist checks above were used.

## Whole-branch re-review fixes

The follow-up Important and Minor findings were resolved on 2026-07-20.

- Replaced the combined-only gallery preview with shared prepared planners for metadata-only saves, combined image saves, create, public/private migration, staged replacement, and deletion. Each mutation now executes a plan produced by the same builder used by its read-only endpoint.
- Authoritative plans contain the metadata path, exact public/private destination or move, staged source when present, all exact image candidates that the commit will trash, and delete trash actions. Title-only changes contain only `src/content/gallery.yaml` and no false image write.
- Added metadata, combined-image, and delete planning API routes. Returned paths are workspace-relative; responses contain no image bytes, fingerprints, backup names, or absolute paths.
- The editor now invalidates and refetches plans when item metadata, file selection, or delete intent changes. It ignores stale responses, displays pending/errors, disables submission until the current plan is ready, renders only server-provided changes, and uses that plan for destructive confirmation.
- `Sec-Fetch-Site: cross-site` is now rejected independently, including when the request supplies an otherwise allowed development `Origin`.
- README now documents the `src/content/staged-images/` lifecycle and explicitly states that staged files are not published.

### Re-review TDD evidence

The new storage tests first failed because `planItem` and `planTrashItem` did not exist. API tests then failed with 404/422 for metadata, combined, and delete planning routes, and the allowed-Origin/cross-site request incorrectly returned 200. UI tests first failed because the static guessed list had no pending, error, invalidation, stale-response, or authoritative delete behavior. Each focused group was observed GREEN after its minimal implementation.

### Re-review verification

- Focused storage/API/UI suites: 4 files passed, 86 tests passed, 1 skipped.
- `npm run test:run`: 17 files passed, 152 tests passed, 2 skipped.
- `npm run validate`: passed.
- `npm run build`: TypeScript and Vite production build passed.
- `npm run e2e`: 6 tests passed.
- `git diff --check`: passed with only Git LF/CRLF conversion notices.
- Dist scan for editor API endpoints, private/staged roots, trash paths, and editor ports returned no matches.
