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
