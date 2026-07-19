# Task 8 Report: End-to-end verification and GitHub Pages deployment

Status: DONE

## Implemented

- Added Playwright configuration that serves the production preview at `/cheonmu-archive/` and isolates browser tests under `e2e/`.
- Added exact-Korean accessible-name browser coverage for the confirmed record cinematic, mobile gallery lightbox, and loaded public artwork on home/gallery pages.
- Added a shared `resolvePublicAssetUrl` helper and applied it to every image consumer so public assets resolve under both the GitHub Pages base path and the root development base without duplicate slashes.
- Added a `main`-triggered GitHub Pages workflow that installs dependencies and Chromium, validates content, runs Vitest, builds, runs Playwright, uploads `dist/`, and deploys with the required Pages permissions.
- Added the local preview script and documented install, development, validation, test, build, e2e, and owner deployment workflows in `README.md`.
- Restricted Vitest discovery to unit-test locations so the unit runner cannot collect Playwright specs.

## TDD evidence

- RED: the initial `npm run e2e` discovered Vitest files because Playwright had no test-directory configuration.
- GREEN: after adding Playwright configuration, the two initial critical-path tests passed.
- RED: loaded-pixel assertions reported `naturalWidth === 0` for home and gallery artwork under `/cheonmu-archive/`; the new helper unit suite also failed because the helper did not exist.
- GREEN: the focused helper suite passed 3 tests, including Pages-base and duplicate-slash cases, and the strengthened Playwright suite passed 3 tests after rebuilding.

## Verification

- `npm run validate`: passed (`Content validation passed.`).
- `npm run test:run`: 11 test files passed, 43 tests passed.
- `npm run build`: TypeScript and Vite production build passed; 387 modules transformed.
- `npm run e2e`: 3 Playwright tests passed.
- Visual viewport gate: rendered and inspected home, timeline, one confirmed record, both profiles, and gallery at 1440, 768, and 390 pixels; all 18 available combinations had no page errors, horizontal overflow, or broken images.
- Draft-record visual check: intentionally not applicable under the human override because all eight current public records are confirmed.
- `dist/` scan: no editor/private filenames, routes, or application markers; `index.html` uses `/cheonmu-archive/` asset paths.
- `git diff --check`: passed with no whitespace errors.

## Self-review

- Confirmed workflow deployment triggers only on `main` pushes or explicit manual dispatch and uses `pages: write` plus `id-token: write`.
- Confirmed artifact upload is gated behind content validation, unit tests, production build, and browser tests.
- Confirmed exact Korean accessible names remain the browser-test contract; no generic dialog selector replaced them.
- Confirmed all public image surfaces use the shared base-aware resolver and remote absolute URLs remain unchanged.
- Confirmed no push, merge, or Pages enablement was performed.

Concerns: None.
