# Final Editor Review Design

## Scope

This hardening pass closes the final persistence, image-validation, browser-boundary, preview, error-mapping, localization, and operator-documentation gaps without changing the public archive model or weakening prior private/staged image protections.

## Prospective archive validation and serialization

A new editor archive-persistence module owns one mutation queue per canonical workspace root for the lifetime of the Node process. Every Markdown and gallery mutation enters that shared queue before loading current content. Inside the queue, the storage builds a prospective `ArchiveContent` snapshot, applies exactly one proposed write or deletion in memory, collects current public image paths plus any public destination installed by the same transaction, and calls the existing `validateArchiveContent` function.

Validation completes before the first temporary file, trash link, image link, unlink, or rename. Any error therefore produces zero disk changes. Duplicate IDs across records, profiles, documents, and gallery are rejected. Missing record `related` IDs are rejected, including record deletion that would strand references. Errors are translated into stable field maps such as `id`, `related`, `image`, or `archive`, while preserving the same validation messages used by the publish gate. Direct storage calls and API calls use the same boundary; different storage instances for the same root still serialize through the global coordinator.

## Gallery image correctness and planning

Metadata-only gallery saves inspect the actual source bytes and compare their signature-derived extension to the submitted destination path before any link or metadata write. A PNG cannot be renamed to `.jpg` without JPEG bytes.

Gallery storage exposes read-only planning methods backed by the same candidate ownership and path-resolution helpers used by commit. A plan request describes metadata-only, combined-image, or delete intent and returns only workspace-relative logical paths with actions (`metadata`, `destination`, `trash`, or `stage`). It never returns image bytes, absolute paths, fingerprints, backups, or private contents. Plans include `src/content/gallery.yaml`, the exact public or private destination, the exact active/current file, and owned normalized replacement candidates determinable at planning time. Another item's image remains excluded exactly as it is during commit.

The UI requests a plan after a valid gallery draft/file signature is available and when delete intent changes. It renders the returned path/action list before save or overwrite confirmation, so private destinations are labeled `src/content/private-images/...` rather than guessed as public paths. Stale plan responses are ignored through a request generation token.

## Loopback request boundary and problem responses

The editor service applies a guard before body parsers and routes. `Host` must be exactly `127.0.0.1:4174` or `localhost:4174`. `Origin`, when present, must be exactly `http://127.0.0.1:5173` or `http://localhost:5173`. `Sec-Fetch-Site: cross-site` is always rejected; requests without `Origin` are accepted only for absent or trusted fetch-site values so command-line and test clients remain usable. Rejections return JSON 403 responses. IPv6 is not accepted because the service binds only IPv4 loopback.

The Vite proxy uses `changeOrigin: true`, preserving the browser workflow while presenting the backend's allowed Host. Express JSON syntax failures return 400 problem JSON. Malformed percent encoding or JSON in `X-Gallery-Metadata` returns a gallery validation problem (422), never 500.

## Minor corrections and documentation

The public document language changes to Korean. README documents `npm run editor`, ports and loopback security assumptions, public/private/staged storage roots, recoverable `.trash` behavior, and the validation/test/build publish gate.

## Verification

Strict RED/GREEN cycles cover prospective Markdown/gallery saves and referenced record deletion, cross-kind duplicate IDs, concurrency serialization, extension/content mismatch rollback, Host/Origin/Sec-Fetch rejection and proxy compatibility, malformed request mapping, public/private/replacement/delete plans, UI changed-file rendering, build/public integrity, language, and documentation. Final gates are focused suites, full Vitest, content validation, TypeScript/Vite build, Playwright, dist scans, and cached diff validation.
