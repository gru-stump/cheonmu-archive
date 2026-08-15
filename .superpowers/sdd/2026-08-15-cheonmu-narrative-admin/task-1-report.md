# Admin Task 1 report

## Delivered

- Added the isolated `admin/` React 19, Vite, TypeScript app and root convenience scripts.
- Added an `AuthGate` that restores the Supabase session, responds to auth-state changes, sends email magic links, and signs out.
- The gate reads the server-stored `owner_profiles` membership through RLS and fails closed while session or membership resolution is pending, absent, or erroneous.
- Added the protected route shell for `/`, `/drafts`, `/memory`, `/schedules`, and `/settings`; the Korean labels are UTF-8 text and the shell remains usable on narrow screens.
- Added Vercel SPA configuration with no secrets. Browser-visible configuration is limited to `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`.
- Reserved the documented same-origin `/api/narrative/*` boundary for a later Vercel server proxy; this task deliberately adds no sensitive Edge API implementation or deployment configuration.

## TDD evidence

- RED 1: `npm --prefix admin run test -- --run src/auth/AuthGate.test.tsx` failed because `./AuthGate` did not exist.
- RED 2: owner logout test failed because no owner logout control existed.
- RED 3: a sign-out during an in-flight owner lookup could have let the stale lookup render private content; the regression test failed as expected.
- RED 4: a stale owner-lookup rejection after sign-out could replace the correct signed-out screen with an access-denied screen; the regression test failed as expected.
- GREEN: the focused suite passes 6/6 tests covering signed-out secrecy and magic-link input, deferred owner resolution, a non-owner allowlist denial, owner logout, and stale owner lookup settlement after sign-out.

## Fresh verification

- `npm --prefix admin run test -- --run` — 1 file, 6 tests passed.
- `npm --prefix admin run build` — TypeScript check and Vite production build passed.
- Credential-name scan of `admin/dist` for `SERVICE_ROLE|OPENAI_API_KEY|ANTHROPIC_API_KEY|GITHUB_TOKEN` — no matches.
- `npm run test:run` — 30 files, 350 passed, 3 skipped.
- `npm run build` — root TypeScript check and Vite production build passed.
- `git diff --check` — clean.

## Self-review and concern

The allowlist decision uses an authenticated user ID plus the RLS-protected `owner_profiles` row; it does not trust an email allowlist or a browser environment value. Independent review found and this task fixed two Minor issues: stale membership failure now also respects session versioning, and the generated admin lockfile no longer links the parent app. The only deferred integration is the deliberate one: a Vercel server implementation for `/api/narrative/*` must be added before later sensitive Edge action clients are introduced. No deployment or secret configuration was performed.

## Independent review

The initial review reported no Critical or Important findings and two Minor findings. The scoped re-review of the fixes marked both ADDRESSED and found no new Critical or Important breakage. It also independently confirmed `npm --prefix admin ci --ignore-scripts` installs the standalone lockfile successfully.
