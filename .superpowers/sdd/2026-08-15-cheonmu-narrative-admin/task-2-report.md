# Admin Task 2 report

## Outcome

- Replaced the Today and Draft placeholders with authenticated dashboard, draft list, and draft detail/review routes.
- Added `NarrativeApi.listDrafts`, `getDraft`, `generate`, `saveManualVersion`, `review`, and `retryPublish`, plus the narrow dashboard and archive methods. Every browser request targets same-origin `/api/narrative/*` and obtains the current owner bearer token from an injected provider.
- Added a Vercel same-origin handler that validates the bearer token with Supabase Auth, independently requires the RLS-visible `owner_profiles` row, and uses only the anon key plus the user token. It never uses a service-role/provider/GitHub credential.
- The handler submits `generated -> reviewing` through the existing `submit_draft_for_review` RPC before approval/rejection and before generated-state editing/revision, then delegates approval/rejection to the existing guarded `review-draft` Edge endpoint.
- Added additive migration `202608140014_admin_draft_workflow.sql` with narrow authenticated owner commands for immutable manual versions, confirmed partial-revision queueing, reversible archive, publish retry, and dashboard reads. Each mutation derives `auth.uid()`, locks the draft/latest version, checks the expected state/version, and rejects blocked latest versions except through the existing rejection path.
- Partial revision persists the source version, selected passage, instruction, requested maximum output tokens, and confirmed maximum cost. The service-only generation freeze narrows its immutable policy snapshot and budget reservation to that confirmed token ceiling; successful generation still appends through the existing atomic finalizer.
- The review screen renders final prose, finding source IDs, context version IDs, canon-change candidates, and complete version history. Its dialogs trap focus, close on Escape, restore trigger focus, and status/conflict messages use live-region roles. A stale 409 preserves editor state and exposes an explicit reload action.
- Blocked latest versions remain fully inspectable and expose only rejection with feedback; edit, AI revision, approvals, archive, publish, and retry controls are absent.
- Dashboard monetary values are integer microdollars, dates are rendered in `Asia/Seoul`, and the next run is derived from either a queued job or the next enabled Seoul daily/weekly schedule.

## Strict RED evidence

1. `npm --prefix admin run test -- --run src/features/today/TodayPage.test.tsx src/features/drafts/DraftReviewPage.test.tsx`
   - RED: 2 files failed with 0 tests because `TodayPage`, `DraftReviewPage`, and `narrativeApi` did not exist. This was the expected missing-feature failure before implementation.
2. `npm --prefix admin run test -- --run src/server/narrativeHandler.test.ts`
   - RED: 1 file failed with 0 tests because the same-origin handler did not exist.
3. `npx supabase test db`
   - RED: the new workflow suite reported the four missing RPC contracts and stopped after 4 of 14 planned assertions; all 12 pre-existing pgTAP files remained green. This was expected before migration 014.
4. `npm run test:run -- supabase/functions/generate-draft/index.test.ts`
   - RED: 1 of 54 failed with `GenerationError: invalid_provider_setting`; the existing policy equality rejected a database-frozen owner-requested revision ceiling. This proved the new test reached the trusted freeze validation.
5. Owner allowlist regression: the focused handler run failed 3 of 5 while expectations required the new membership lookup; the decisive assertion observed an authenticated non-owner receive 200 instead of 403. The minimal handler membership check made all 5 pass.
6. Edge conflict regression: the focused handler run failed 1 of 6 because a sanitized `stale_review` 409 was incorrectly converted to 500. Stable 409 propagation made all 6 pass.
7. Dashboard schedule regression: the workflow pgTAP suite failed exactly assertion 7 of 25 because an enabled schedule without a prequeued job returned no next run. The Seoul cron derivation made all 25 workflow assertions pass.
8. Upgrade verification initially failed with actual migration head `202608140014` versus fixture expectation `202608140013`. Updating the upgrade fixture to the additive head and asserting the new manual-version privilege boundary made the real 010-to-current upgrade pass.

## GREEN and full verification evidence

- Focused UI/API slice: 3 files, 9 tests passed after the first implementation.
- Same-origin handler: 1 file, 6 tests passed, covering missing auth, non-owner denial, submission-before-review, retained revision confirmation, database conflict mapping, and Edge 409 preservation.
- Generation orchestrator: 54/54 passed, including the requested output ceiling and matching reservation.
- Full admin: 5 files, 21 tests passed.
- Admin production build: TypeScript and Vite passed; 89 modules transformed.
- Root Vitest: 30 files, 351 passed, 3 intentional skips.
- Root production build: passed; 395 modules transformed.
- Content validation: passed.
- Narrative TypeScript project: `npx tsc --noEmit -p tsconfig.narrative.json` passed.
- Vercel handler/server boundary typecheck: isolated TypeScript 7 `--ignoreConfig` check passed.
- Clean local reset: migrations 001 through 014 and seed applied successfully.
- pgTAP: 13 files, 306 assertions passed; the Task 2 workflow file contributes 25 behavior/privilege assertions.
- Database concurrency: all five programs passed (budget reservation, review, generation attempt, access schedule, schedule queue).
- Actual local gateway browser/auth probes: all three existing Edge functions passed.
- Real migration 010-to-current upgrade and seeded-head restoration: passed.
- Admin bundle secret-name scan for `SERVICE_ROLE|OPENAI_API_KEY|ANTHROPIC_API_KEY|GITHUB_TOKEN`: no matches.
- Browser source mutation scan: no narrative table insert/update/delete; the only `.from(...)` is Task 1's read-only owner membership lookup.
- `git diff --cached --check`: clean.
- Migrations 001-013 diff: empty.
- Protected admin `progress.md` diff: empty (preserved byte-for-byte).

## Files

- Admin API/runtime: `admin/api/narrative/[...path].ts`, `admin/src/api/narrativeApi.ts`, `admin/src/server/narrativeHandler.ts` and their tests.
- Admin UI: `TodayPage.tsx`, `DraftListPage.tsx`, `DraftReviewPage.tsx` and focused tests; route shell, responsive functional CSS, session token shape, Supabase client, and test cleanup were updated.
- Generation: `supabase/functions/generate-draft/index.ts` and its focused test now honor a trusted owner-requested revision output cap.
- Database: migration 014, `admin_draft_workflow.test.sql`, and the current-head upgrade fixture.

## Self-review and concerns

- Self-review caught and fixed two boundary defects before handoff: token validation without an independent owner-profile check, and stable Edge 409 responses being collapsed to 500. It also caught that a queued-job-only dashboard could not show the next enabled schedule.
- The migration preserves generic transition/budget RPC restrictions and does not grant authenticated callers service primitives. Manual versions remain insert-only under the existing immutable trigger; archive never deletes; retry requeues the existing exact-version publish job.
- No paid provider, publication, deployment, or secret-setting call was made. Runtime deployment still requires server-only `SUPABASE_URL` and `SUPABASE_ANON_KEY` plus the existing browser `VITE_SUPABASE_*` values. The publish worker itself remains outside Task 2; retry only restores the already-approved exact-version job to its queue.
- Styling is intentionally functional and restrained because Task 4 owns final visual polish.
