# Cheonmu Narrative Generation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Generate private, canon-aware drafts through a fake provider first, then interchangeable OpenAI or Anthropic adapters, with idempotent schedules.

**Architecture:** Canon and approved memories are selected into a bounded context snapshot. One orchestrator reserves budget, calls exactly one configured provider, validates structured output, runs deterministic continuity gates, reconciles usage, and stores an immutable draft version.

**Tech Stack:** Supabase Edge Functions (TypeScript/Deno), Zod, Vitest, Supabase Cron

**Spec:** `docs/superpowers/specs/2026-08-14-cheonmu-autonomous-narrative-design.md`

## Global Constraints

- Read canon according to the Cheonmu source priority; never promote an unresolved claim automatically.
- Use one director call for both characters.
- Persist the context version IDs used by every generation.
- A rejected draft never becomes narrative memory.
- Retry at most once and reserve budget again before retrying.

---

### Task 1: Canon snapshot and bounded memory selection

**Files:**
- Create: `scripts/export-narrative-canon.ts`
- Create: `scripts/export-narrative-canon.test.ts`
- Create: `supabase/functions/_shared/context.ts`
- Create: `supabase/functions/_shared/context.test.ts`
- Create: `supabase/seed/canon-snapshot.json`
- Modify: `package.json`

**Interfaces:**
- Produces script: `npm run narrative:canon`.
- Produces: `selectNarrativeContext(input): ContextSelection` with ordered `versionIds`, `fixedCanon`, `continuity`, `recent`, `feedback`.

- [ ] **Step 1: Test that exports include the latest confirmed relationship stage and exclude hidden prose bodies**

```ts
const snapshot = await exportNarrativeCanon(fixtureRoot);
expect(snapshot.currentRelationshipStage).toBe(7);
expect(JSON.stringify(snapshot)).not.toContain('privateBody');
```

- [ ] **Step 2: Test deterministic memory ordering and token-budget truncation**

```ts
expect(selectNarrativeContext({ memories, tokenBudget: 500, tags: ['치료실'] }).versionIds).toEqual(['canon-v1', 'promise-v3', 'recent-v4', 'feedback-v2']);
```

- [ ] **Step 3: Run tests and confirm missing exports fail**

Run: `npm run test:run -- scripts/export-narrative-canon.test.ts supabase/functions/_shared/context.test.ts`

- [ ] **Step 4: Implement export and selection**

Export structured facts from profiles, documents, record frontmatter, `world.yaml`, reveal plan, unresolved canon and continuity ledger. Selection order is fixed canon, blocking feedback, tagged approved continuity, recent approved summaries; trim only the tail and always return selected version IDs.

- [ ] **Step 5: Generate and inspect the deterministic snapshot**

Run: `npm run narrative:canon`

Run: `git diff --exit-code -- supabase/seed/canon-snapshot.json`

Expected: the second run creates no diff.

- [ ] **Step 6: Commit**

```powershell
git add package.json package-lock.json scripts/export-narrative-canon* supabase/functions/_shared/context* supabase/seed/canon-snapshot.json
git commit -m "feat: export bounded cheonmu canon context"
```

### Task 2: Provider contract, fake adapter, and continuity gates

**Files:**
- Create: `supabase/functions/_shared/provider.ts`
- Create: `supabase/functions/_shared/fake-provider.ts`
- Create: `supabase/functions/_shared/continuity.ts`
- Create: `supabase/functions/_shared/provider.test.ts`
- Create: `supabase/functions/_shared/continuity.test.ts`

**Interfaces:**
- Produces: `NarrativeProvider.generate(request): Promise<{ result: GenerationResult; usage: Usage; rawId: string }>`.
- Produces: `checkContinuity(result, context): { level: 'pass' | 'review' | 'block'; findings: Finding[] }`.

- [ ] **Step 1: Write failing adapter and gate tests**

```ts
const output = await new FakeNarrativeProvider(fixture).generate(request);
expect(output.result.kind).toBe('short_dialogue');
expect(checkContinuity(secretNamingFixture, stage7Context).level).toBe('block');
```

- [ ] **Step 2: Run tests and verify failures**

Run: `npm run test:run -- supabase/functions/_shared/provider.test.ts supabase/functions/_shared/continuity.test.ts`

- [ ] **Step 3: Implement the fake provider and deterministic gates**

The fake returns fixtures without network access. Gates check relationship stage, titles, direct forbidden reveal terms, unknown permanent entities, unresolved contradictions and rejected motifs. Findings include `code`, `level`, `message`, and supporting source IDs.

- [ ] **Step 4: Run tests**

Run: `npm run test:run -- supabase/functions/_shared/*.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add supabase/functions/_shared
git commit -m "feat: add narrative provider and continuity gates"
```

### Task 3: Generation orchestrator and memory promotion

**Files:**
- Create: `supabase/functions/generate-draft/index.ts`
- Create: `supabase/functions/generate-draft/index.test.ts`
- Create: `supabase/functions/review-draft/index.ts`
- Create: `supabase/functions/review-draft/index.test.ts`

**Interfaces:**
- Consumes budget RPCs and `NarrativeProvider`.
- Produces authenticated endpoints `generate-draft` and `review-draft`.

- [ ] **Step 1: Test the ordered orchestration**

Assert: authenticated owner → idempotency lookup → context selection → budget reservation → one provider call → parse → continuity gate → usage reconciliation → immutable draft version. Assert a blocked result is stored privately and never promoted. Cover generation modes `new`, `revise_selection`, `major_event_scene_plan`, and `major_event_draft`; the two major-event modes must reject requests whose preceding workflow phase is not approved.

- [ ] **Step 2: Test approval semantics**

```ts
await reviewDraft({ action: 'reject', reason: '호칭이 맞지 않음' });
expect(memoryWrites).toEqual([{ kind: 'feedback', text: '호칭이 맞지 않음' }]);
```

For `approve_private`, assert approved continuity is written but no publish job exists. For `approve_public`, assert continuity and one queued publish job exist atomically.

- [ ] **Step 3: Run tests and confirm failures**

Run: `npm run test:run -- supabase/functions/generate-draft/index.test.ts supabase/functions/review-draft/index.test.ts`

- [ ] **Step 4: Implement both functions with injected dependencies**

Keep HTTP parsing thin; implement `runGeneration(deps, command)` and `applyReview(deps, command)` as testable functions. Return `409` for duplicate or stale state transitions and `402` with budget status for blocked calls.

- [ ] **Step 5: Verify local function calls with fake provider**

Run: `npx supabase functions serve --env-file supabase/.env.test`

From a second terminal, invoke one authenticated fixture request and confirm one `generated` draft and one reconciled ledger entry.

- [ ] **Step 6: Commit**

```powershell
git add supabase/functions/generate-draft supabase/functions/review-draft
git commit -m "feat: orchestrate private narrative drafts"
```

### Task 4: Real adapters and idempotent schedules

**Files:**
- Create: `supabase/functions/_shared/openai-provider.ts`
- Create: `supabase/functions/_shared/anthropic-provider.ts`
- Create: `supabase/functions/_shared/provider-contract.test.ts`
- Create: `supabase/functions/run-schedules/index.ts`
- Create: `supabase/functions/run-schedules/index.test.ts`
- Create: `supabase/migrations/202608140003_narrative_cron.sql`

**Interfaces:**
- Both adapters implement `NarrativeProvider`.
- `run-schedules` inserts jobs using unique `(schedule_key, scheduled_for)` and never calls a provider directly.

- [ ] **Step 1: Write provider contract tests using mocked HTTP responses**

Run the same cases against both adapters: valid structured result, malformed result, timeout, 429, usage present, usage absent. Assert neither adapter retries internally.

- [ ] **Step 2: Write schedule tests**

At `2026-08-14T00:00:00Z`, invoke the scheduler twice and assert only one Seoul-date daily job. Assert warning budget skips weekly, risk skips all automatic jobs, and manual jobs are never created by cron. Add an access-trigger test that returns the existing recent job until the minimum interval passes, creates one short-dialogue job after the interval, and remains idempotent across repeated page loads.

- [ ] **Step 3: Implement adapters and scheduler**

Use direct HTTPS calls from the Edge Function, server-side secrets, explicit abort timeouts, structured-output instructions, and provider response IDs. Choose the adapter from the single active `provider_settings` row; reject zero or multiple active rows. Implement access-trigger evaluation as an authenticated server command that queues work only after checking last success, next allowed time, daily call count, budget state, and the idempotency key.

- [ ] **Step 4: Add Cron migration**

Schedule one frequent dispatcher in UTC; the dispatcher evaluates each owner schedule in `Asia/Seoul`. Store the function URL and service credential in Supabase Vault, not migration text.

- [ ] **Step 5: Run all generation tests without real credentials**

Run: `npm run test:run && npx supabase test db`

Expected: PASS with mocked HTTP and fake provider only.

- [ ] **Step 6: Commit**

```powershell
git add supabase/functions/_shared supabase/functions/run-schedules supabase/migrations/202608140003_narrative_cron.sql
git commit -m "feat: add model adapters and narrative schedules"
```
