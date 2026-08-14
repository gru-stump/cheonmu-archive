# Task 3 Report: Generation orchestration and memory promotion

## Status

Implemented the authenticated `generate-draft` and `review-draft` Edge Functions, injected/testable `runGeneration` and `applyReview` cores, durable frozen generation/review state, and atomic memory/publish promotion. Only the fake narrative provider is wired; no external model credentials or network calls were added.

## Delivered behavior

- Generation follows authenticate/authorize → idempotency → select/freeze context → reserve worst-case budget → one provider call → runtime parse → continuity gate → reconciliation → immutable version storage.
- Completed duplicates return their stored result; in-flight duplicates and stale transitions return 409. Budget blocks return 402 with budget status and never call the provider.
- `new`, `revise_selection`, `major_event_scene_plan`, and `major_event_draft` are supported; database and core gates enforce prior major-event approval.
- Blocked continuity results and source-backed findings remain private and are never promoted automatically.
- Review decisions use expected state/version plus durable idempotency. Reject writes feedback only; private approval writes continuity only; public approval writes continuity and exactly one queued publish job in one transaction.
- The service-role RPC path derives ownership from locked jobs/drafts; no endpoint accepts a caller-supplied owner ID.

## Schema and runtime

- Added migration `202608140004_generation_review.sql` for frozen context IDs, findings, provider response IDs, review actions, relational memory status/source fields, publish queue, RLS/grants, and atomic RPCs.
- Added Deno import mapping and explicit `.ts` imports so the functions boot in the local Edge runtime.
- Hardened the seeded local auth fixture with the empty token fields required by GoTrue `/user` authentication.

## Verification

- Focused generation/review Vitest: 24 passed.
- Full Vitest: 28 files, 250 passed, 3 skipped.
- pgTAP after local database reset: 5 files, 117 passed.
- Concurrency: budget reservation race passed; concurrent public approval race produced one review, one continuity write, and one publish job.
- Narrative TypeScript check: passed.
- Application production build: passed.
- Served local functions with authenticated fixture: generation returned `generated` with one version and one reconciliation; private approval returned `approved_private` with one continuity memory and zero publish jobs.

## Concerns / follow-up

- Context selection requires canonical/approved memory rows to be populated; the served verification inserted an explicit canonical fixture.
- Publish workers and real provider adapters remain intentionally deferred to Task 4.
- No reviewer/subagent was used, per the task constraint; self-review found and fixed completed-duplicate ordering and in-flight duplicate handling before final verification.

## Fix Round 1

Addressed every Critical and Important review finding with RED/GREEN coverage:

- Approval now requires `continuity_level = 'review'` and persisted policy `cheonmu-continuity-v1` in both the core and atomic review RPC. Blocked, null/unchecked, pass, and old-policy versions cannot create review actions, continuity memory, or publish jobs. The HTTP endpoint rejects caller policy input and always supplies the server constant.
- Added migration `202608140005_generation_transaction_hardening.sql`. Success finalization now reconciles trusted usage, inserts the immutable policy-stamped version/findings/context, completes the job, legally advances the draft, and advances a successful major-event phase in one transaction. The old split `store_generation_result` writer is removed.
- Failure finalization now derives settlement from frozen trusted rates and parsed usage, charges the full reservation when usage is missing/invalid/out of bounds, stores only a stable failure code, legally returns the draft to `queued`, terminates the job as `failed`, and releases the idempotency key atomically.
- Provider/model caps and rates are active owner settings. Request pricing/token overrides are rejected; the TypeScript and SQL estimators independently verify worst-case and actual costs, ignore provider-reported money for accounting, and enforce actual tokens/cost within the reservation.
- Context freeze no longer advances major-event workflow state. A 402 clears frozen/idempotency fields and leaves the phase/draft queued for same-job retry; a failed provider attempt leaves an auditable failed job and permits a new queued job to reuse the key.
- The provider consumes the content, structured claims/continuity facts, and exact version IDs returned by the frozen job snapshot. The continuity gate is rebuilt from that frozen snapshot with source IDs for relationship stage, forbidden reveals, permanent entities/settings, approved continuity, rejected motifs, and voice/title rules.
- Mode/kind and revision-payload coherence are enforced before selection. REST persistence conflicts require an exact stable `P0001` code; unknown infrastructure/provider/parser details are reduced to stable client errors and retained only in server-side audit logging.

### Fix Round 1 verification

- Focused generation/review/provider/context Vitest: 40 passed.
- Fresh local database reset plus all pgTAP: 6 files, 163 passed, including atomic rollback, phase-safe 402 retry, conservative failure settlement, immutable frozen-content persistence, and non-approvable-version cases.
- Budget and review concurrency: both passed; concurrent approvals leave exactly one review action, continuity memory, and publish job.
- Full Vitest: 28 files, 258 passed, 3 skipped.
- Narrative TypeScript check and application production build: passed.
- Real local Edge runtime with fake provider: generation returned HTTP 200 / `review`; private approval returned HTTP 200 / `approved_private`; persisted draft state was `approved_private`.
- `git diff --check`: passed. No subagent or external reviewer was used.

### Remaining scope

- Real provider adapters, retry scheduling, and publish workers remain intentionally deferred; this task still wires only the deterministic fake provider.

## Fix Round 2

- Added migration `202608140006_generation_service_boundary.sql`. Context freeze, reserve/start, success finalization, failure finalization, and abort are now service-role-only; `PUBLIC`, `anon`, and `authenticated` execute privileges are revoked. The owner review RPC remains authenticated and retains its locked owner/version/policy checks.
- The Edge adapter now maintains separate user and service clients. Authentication, authorization, idempotency lookup, policy loading, and context selection use the caller token; generation mutation RPCs use only the server-side service credential and continue to derive ownership from locked jobs/drafts without an owner parameter.
- Added idempotent `abort_generation_attempt(job_id, idempotency_key, sanitized_code)`. It resets an unreserved frozen attempt to queued, conservatively settles a committed reservation and marks that job failed, clears the frozen idempotency key, handles repeated/terminal calls, and returns a completed immutable result without reverting it when finalization already committed.
- Every post-freeze failure path now routes through abort, including freeze commit/response loss, frozen-response validation, reserve commit/response loss or malformed response, 402, provider/parse/usage/continuity failure, and finalization response loss. A completed abort result recovers the committed version; major-event phases are never reverted or advanced by cleanup.
- `GenerationRequest` now carries the exact generation mode. Tests distinguish `major_event_scene_plan` from `major_event_draft` provider requests while retaining bounded explicit revision payloads.
- Database conflict mapping uses an exact `P0001` allowlist for duplicate generation, stale transition/version, workflow prerequisite, mode-kind, active-setting, and context-budget conflicts. Unknown infrastructure text remains a sanitized 500.

### Fix Round 2 verification

- Focused generation/review/provider/context Vitest: 53 passed.
- Fresh reset plus all pgTAP: 6 files, 175 passed, including execute privileges, an actual authenticated denial, service-role success, unreserved/reserved abort, completed no-op recovery, and phase preservation.
- Budget and review concurrency: passed.
- Full Vitest: 28 files, 271 passed, 3 skipped.
- Narrative TypeScript check and production build: passed.
- Local Edge runtime: direct authenticated reserve RPC returned 403; the same owner generated through the Edge service path with HTTP 200 / `review`, then reviewed to HTTP 200 / `approved_private`.
- `git diff --check`: passed. No subagent or external reviewer was used.

## Fix Round 3

- Added migration `202608140007_generation_attempt_epoch.sql` and an indexed nullable `generation_jobs.attempt_token`. The trusted Edge core creates one UUID before freeze; freeze persists and returns it, and reserve, success finalization, and abort all require the exact immutable token.
- Tokenless generation RPC signatures are no longer callable. Their proven atomic transaction bodies were renamed to private internal functions with all client execute grants revoked; only token-scoped service-role wrappers remain exposed. The obsolete tokenless failure writer was removed.
- A losing same-key freeze cleanup and a delayed cleanup from an earlier retry now return `{ outcome: "stale" }` without changing the live job, draft, budget, frozen context, or idempotency key. Exact-token abort still conservatively settles failures, while exact-token abort after committed success still recovers the immutable completed result.
- `stale_attempt` is an explicit storage race conflict mapped narrowly to HTTP 409. Null tokens are rejected at every mutation boundary, and the Edge validates that the token returned by freeze exactly matches the one it generated.

### Fix Round 3 TDD and verification

- RED: focused generation tests failed 3 regressions because freeze-loss cleanup had no attempt identity. GREEN: focused generation suite passed 38 tests, including concurrent loser and delayed-abort simulations.
- Clean seeded Supabase reset applied all seven additive migrations; all pgTAP passed: 7 files / 194 assertions. Attempt-epoch coverage proves stale freeze, reserve, finalize, and delayed abort cannot mutate a replacement.
- All concurrency scripts passed: shared budget reservation, atomic public review, and a real two-connection duplicate freeze race whose losing abort preserved the winner.
- Full Vitest passed: 28 files, 274 passed, 3 skipped. Narrative TypeScript check and production build passed. `git diff --check` passed.
- Local fake Edge verification returned `generated` / `review`; the database contained one immutable version, one reconciliation, and the completed attempt token needed for response-loss recovery.

### Fix Round 3 self-review

- Confirmed browser/authenticated callers have no execute privilege on tokenized or internal generation mutations; the owner review boundary is unchanged.
- Confirmed every post-freeze cleanup receives the locally generated token, blocked reservations release it atomically, completed attempts retain it, and stale/no-op cleanup never masks the original sanitized response.
- Confirmed no Task 4 provider, retry worker, or publishing scope was introduced. No subagent or external reviewer was used.
