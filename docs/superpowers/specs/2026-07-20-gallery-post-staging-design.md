# Gallery POST Staging Design

## Goal

Make the documented legacy `POST image → PUT metadata` workflow safe for new, legacy public, and private gallery items across extension changes, interruptions, failures, and retries.

## Staging boundary

`POST /api/editor/gallery/image` validates ID, size, signature, dimensions, and overwrite confirmation exactly as before, but writes the normalized bytes under canonical `src/content/staged-images/`. This directory is outside Vite's `public/` input and is rejected if it or the selected file is a reparse target. Existing active image bytes and YAML remain unchanged until PUT, so an interrupted two-call workflow cannot publish private bytes or break the saved preview.

Only one staged normalized PNG/JPG/JPEG/WebP candidate per ID is retained. Explicit overwrite replaces a prior stage recoverably; no-overwrite returns 409 when either active or staged candidates exist. POST continues returning the eventual `/images/<id>.<signature-extension>` path.

## PUT commit transaction

`PUT /api/editor/gallery/:id` first looks for a staged file matching the submitted normalized image path. When present, it validates the staged signature/path, recoverably trashes the active metadata image, installs the stage in the submitted visibility root, and atomically writes YAML. Every side effect is compensated on failure: the new final file is removed, the stage is restored for retry, and the old active image is restored.

When no stage exists, metadata-only migration keeps its existing behavior. If the previous metadata path is already missing because an older POST installed the submitted path directly, PUT may resolve that exact submitted path canonically in either final root and complete the migration. It never searches arbitrary basenames or relaxes root/reparse checks.

The combined image+metadata PUT remains unchanged and continues to commit in one request.

## Verification

Full Supertest sequences cover legacy public and private items, signature-driven extension changes, POST interruption, PUT failure and retry, stage cleanup, recoverable old bytes, final metadata, and absence of private replacement bytes from `public/`. A Vite integration build between POST and PUT and after PUT proves staged/private bytes are absent from `dist/`.
