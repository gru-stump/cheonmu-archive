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
