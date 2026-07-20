# Gallery Review Hardening Design

## Goal

Close the four Task 3 review gaps without changing the public archive contract: legacy images must not survive replacement or unpublishing, visibility migration must be failure-atomic, saved private images need a safe loopback-only preview, and asynchronous signature reads must never apply stale state.

## Storage transaction design

Gallery replacement will build one candidate set from both image roots. It includes the existing item's exact metadata path, even when its basename is unrelated to the item ID, plus normalized PNG/JPG/JPEG/WebP paths for the ID. Both the combined PUT path and legacy POST path use this resolver. Every displaced image receives a recoverable trash hard link before removal.

Metadata-only visibility migration will record each side effect: destination link creation, source removal, and metadata commit. If any step fails, compensation restores the source when necessary and removes the destination before returning the original error. An injectable filesystem operation boundary will cover failure behavior without introducing test-only production methods.

## Private preview design

The gallery store will expose a read operation that accepts an item ID, verifies the item exists and is private, resolves the image strictly inside the canonical non-reparse private image root, inspects its signature, and returns bytes plus the matching MIME type. The loopback editor server alone exposes this through `GET /api/editor/gallery/:id/image`, with `Cache-Control: no-store` and `X-Content-Type-Options: nosniff`. Public items return not found and production Vite output contains no editor route or private bytes.

`GalleryForm` uses the loopback URL only for a saved private item. Public saved items continue using the public asset URL, while a newly selected local file continues to use its object URL.

## Asynchronous selection design

File selection immediately records the selected file, marks the draft dirty, marks signature inspection pending, and prevents save. Each read receives a monotonically increasing generation token. File replacement, navigation, reset, delete, and successful save invalidate prior generations. Resolution applies through a functional state update using the latest draft ID, and only when both token and selected-file identity still match. Thus ID edits are preserved, newer files win, and navigation cannot be overwritten by an older read.

## Test design

Strict TDD will add and observe failures for:

- legacy metadata basenames in combined replacement, unpublishing, original POST private replacement, and production artifact removal;
- an injected source-unlink failure during private-to-public migration;
- private preview HTTP headers/bytes, public denial, reparse rejection, and private/public `GalleryForm` URLs;
- delayed signature resolution across ID edits, newer file selection, and navigation.

Focused suites will turn green after each implementation. Final gates are the full unit suite, content validation, production build, Playwright, distribution absence scan, and diff check.
