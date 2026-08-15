# Cheonmu Generation Browser and Review Remediation Plan

**Goal:** Restore safe browser access to the private Edge Functions and restore the owner's generated-to-reviewing workflow without reopening generic state or budget mutation paths.

## Task 1: Browser gateway and CORS contract

- Allow the standard Supabase browser request headers: `authorization`, `apikey`, `x-client-info`, and `content-type`.
- Configure `generate-draft`, `review-draft`, and `run-schedules` so OPTIONS and authentication failures follow the same exact-origin policy rather than a gateway wildcard.
- Keep the origin allowlist fail-closed through `NARRATIVE_ADMIN_ORIGINS`.
- Test through the actual local Supabase gateway, not only direct handler unit tests.

## Task 2: Narrow submit-for-review transition

- Add an owner-authenticated RPC that permits only `generated -> reviewing`.
- Derive ownership from the locked draft; require the expected current version/state and reject stale, blocked, or foreign drafts.
- Keep the generic transition RPC and budget mutation RPCs unavailable to authenticated users.
- Add Edge/SQL integration tests covering the normal workflow and all forbidden transitions.

## Verification

- Focused RED/GREEN tests.
- Local gateway browser preflight and invalid-token probes.
- Clean database reset, all pgTAP, all concurrency tests, full Vitest, typechecks, validation, production build, upgrade regression, privilege/secret/diff checks.
- Independent review, with fixes if necessary before this remediation is considered complete.

## Out of scope

- Admin UI, deployment, production secrets, paid provider calls, and publication workers.
