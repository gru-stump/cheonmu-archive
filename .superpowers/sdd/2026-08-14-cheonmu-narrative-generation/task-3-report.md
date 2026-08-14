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
