# Narrative generation final-review fix report

Date: 2026-08-15

Base: `4e9b025`

Migration: `202608140012_generation_final_review_fixes.sql`

## Outcome

The six final-review findings are closed in one additive fix wave. Migrations 001-011 and the root-authored `progress.md` remain unchanged. No deployment, secret mutation, or paid provider request was performed.

## Root causes and fixes

1. The three legacy budget mutation RPCs inherited executable grants for browser roles. Migration 012 enumerates every extant overload by catalog name, revokes `PUBLIC`, `anon`, `authenticated`, and `service_role`, then grants only `service_role`. The same catalog-safe treatment covers both known names for the generic draft transition primitive. Trusted pricing and the private transaction functions remain server-owned and inaccessible to browser roles.
2. `authenticated` could call `transition_draft(uuid,text,text)` directly and bypass `review_draft_atomic`. The primitive is now service-role-only. Approvals and publication continue through the guarded atomic review RPC; blocked or old-policy versions remain in `reviewing` and create no continuity or publish side effects.
3. Approval inserted continuity memory with empty metadata, so tagged context selection could never recover it. An approval trigger now derives deterministic tags from structured setting and continuity fields, limits them to 20 values of 100 characters, records a token estimate and source version continuity ID, and backfills existing approved continuity. The database approval test and next-generation selection test prove approved matching memory is selected while rejected/active continuity is excluded.
4. `generate-draft`, `review-draft`, and `run-schedules` had no browser preflight or CORS response support. A shared exact-origin policy now handles `OPTIONS`, rejects disallowed origins, emits CORS headers on successful and error responses, never emits wildcard or credential authorization, and maps expired/invalid Supabase bearer responses to 401. Runtime origins are supplied as a comma-separated `NARRATIVE_ADMIN_ORIGINS` deployment setting.
5. The database dispatcher ran every five minutes even though the accepted cron grammar includes every minute. Migration 012 updates the named queue-only dispatcher to `* * * * *`; runtime tests cover accepted minutes 0, 1, 4, 5, and 59 and duplicate-dispatch idempotency.
6. Provider adapters validated the upstream response model and discarded it. `NarrativeProviderResponse` now requires nonblank `responseModel`; OpenAI and Anthropic retain the upstream canonical model without requiring equality to the configured alias. Finalization passes it through the service-only RPC and the insert trigger writes it to immutable `draft_versions.provider_response_model`. The legacy finalizer signature is removed.

## TDD evidence

RED before production edits:

- Focused Vitest: six expected provider-model contract failures; the three HTTP suites also failed until the shared CORS boundary existed.
- `generation_final_fixes.test.sql`: 8 of 20 assertions failed for the exposed budget/transition functions, bypass behavior, missing approval metadata, and five-minute cron.
- Generation-review and transaction-finalization pgTAP failed for the missing audit column/new finalizer signature.
- Schedule HTTP regression: 1 of 27 failed because a dispatch exception escaped without a CORS response.

Focused GREEN after root-cause fixes:

- Runtime/provider/CORS focus: 115/115 passed.
- SQL privilege/review/finalization focus: 194/194 passed.
- Schedule handler focus: 27/27 passed.
- Final approval-to-tagged-context SQL test: 21/21 passed.

## Final verification

- Clean local reset applied migrations 001 through 012 in order: PASS.
- All pgTAP: 11 files, 256 assertions: PASS.
- All Vitest: 30 files, 338 passed, 3 intentional skips: PASS.
- All five database concurrency programs: budget reservation, atomic review, attempt epoch, access trigger, and schedule queue: PASS.
- Real migration 010 to 011/current-head upgrade regression: PASS.
- Narrative TypeScript project: PASS.
- Standalone upgrade-test TypeScript check: PASS.
- `npm run validate`: PASS.
- `npm run build`: PASS (395 modules transformed).
- Canon export repeated hash: `0C3E2BFE2732094E2C1DA9563A502FEE6E65907C02318FDCF1EC222333B7503D` both times; tracked snapshot diff empty.
- Live catalog probe: budget mutations and generic transition are false for `PUBLIC`/`anon`/`authenticated`, true for `service_role`; the public finalizer is service-only; the private legacy transaction function is not executable by `service_role`.
- Live cron probe: exactly one active `narrative-schedule-dispatcher` at `* * * * *`.
- `git diff --check`: PASS.
- Prior-migration diff (001-011): empty.
- Root `progress.md` diff: empty.
- Changed-file scan for provider keys, JWTs, hosted Supabase URLs, and Supabase secret keys: clean.

## Self-review and operational note

The migration is additive and preserves the trusted transaction bodies. The provider audit trigger is deliberately scoped to genuinely provider-finalized rows (`generation_job_id` plus `provider_response_id`) so historical and synthetic non-provider draft fixtures remain valid; provider-finalized rows cannot omit the canonical response model. Draft-version immutability protects the audit field after insertion.

`NARRATIVE_ADMIN_ORIGINS` must be configured with exact Vercel admin origins before a deployed browser client uses these functions. An absent value fails closed for cross-origin requests. This work intentionally did not set deployment environment values.
