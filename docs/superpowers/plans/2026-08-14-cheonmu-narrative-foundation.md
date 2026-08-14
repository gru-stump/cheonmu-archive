# Cheonmu Narrative Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create the shared domain contracts, single-owner Supabase data model, and atomic budget ledger without making real AI calls.

**Architecture:** A new `shared/` package defines provider-neutral types. Supabase migrations enforce ownership, legal state transitions, idempotent jobs, and budget reservation; a separate Vite app under `admin/` proves authenticated access.

**Tech Stack:** TypeScript, Zod, React 19, Vite, Supabase Auth/Postgres, pgTAP, Vitest

**Spec:** `docs/superpowers/specs/2026-08-14-cheonmu-autonomous-narrative-design.md`

## Global Constraints

- One owner account; public signup is disabled in hosted Supabase settings.
- All narrative tables use RLS and owner-scoped policies.
- USD microdollars (`bigint`, one USD = 1,000,000 units) are the canonical cost unit.
- Budget is reserved before provider I/O and reconciled after a response.
- Store UTC `timestamptz`; clients render `Asia/Seoul`.

---

### Task 1: Shared contracts and validation

**Files:**
- Create: `shared/narrative/contracts.ts`
- Create: `shared/narrative/contracts.test.ts`
- Modify: `package.json`
- Modify: `tsconfig.json`

**Interfaces:**
- Produces: `DraftKind`, `DraftStatus`, `GenerationRequest`, `GenerationResult`, `Usage`, `parseGenerationResult(value)`.

- [ ] **Step 1: Add a failing contract test**

```ts
import { describe, expect, it } from 'vitest';
import { parseGenerationResult } from './contracts';

it('rejects a result without dialogue and continuity metadata', () => {
  expect(() => parseGenerationResult({ title: '비 오는 날' })).toThrow();
});
```

- [ ] **Step 2: Run the focused test and confirm the missing-module failure**

Run: `npm run test:run -- shared/narrative/contracts.test.ts`

Expected: FAIL because `shared/narrative/contracts.ts` does not exist.

- [ ] **Step 3: Define the exact provider-neutral contracts**

```ts
import { z } from 'zod';

export const draftKinds = ['short_dialogue', 'daily_event', 'major_event_proposal'] as const;
export const draftStatuses = ['queued', 'generating', 'generated', 'reviewing', 'rejected', 'archived', 'approved_private', 'approved', 'publishing', 'published', 'publish_failed'] as const;
export type DraftKind = typeof draftKinds[number];
export type DraftStatus = typeof draftStatuses[number];
export interface Usage { inputTokens: number; outputTokens: number; costMicros?: number }
export interface GenerationRequest { kind: DraftKind; seed?: string; maxInputTokens: number; maxOutputTokens: number; contextVersionIds: string[] }
const resultSchema = z.object({
  title: z.string().min(1), kind: z.enum(draftKinds), setting: z.object({ time: z.string(), place: z.string() }),
  body: z.string().min(1), emotionalStart: z.string().min(1), emotionalEnd: z.string().min(1),
  continuityUsed: z.array(z.string()), continuityCandidates: z.array(z.string()),
  canonChangeCandidates: z.array(z.string()), unresolvedCallbacks: z.array(z.string()), riskFlags: z.array(z.string()),
});
export type GenerationResult = z.infer<typeof resultSchema>;
export const parseGenerationResult = (value: unknown): GenerationResult => resultSchema.parse(value);
```

Add `shared/**/*.ts` to `tsconfig.json` and add Zod to runtime dependencies only if the existing root dependency does not satisfy the import.

- [ ] **Step 4: Run contracts and existing tests**

Run: `npm run test:run -- shared/narrative/contracts.test.ts && npm run test:run`

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add package.json package-lock.json tsconfig.json shared/narrative
git commit -m "feat: define narrative domain contracts"
```

### Task 2: Supabase schema, owner policies, and legal state transitions

**Files:**
- Create: `supabase/config.toml`
- Create: `supabase/migrations/202608140001_narrative_core.sql`
- Create: `supabase/tests/narrative_core.test.sql`
- Create: `supabase/seed.sql`

**Interfaces:**
- Produces tables: `owner_profiles`, `drafts`, `draft_versions`, `major_event_workflows`, `memory_items`, `generation_jobs`, `schedules`, `provider_settings`, `budget_periods`, `budget_entries`, `audit_events`.
- Produces SQL function: `transition_draft(p_draft_id uuid, p_expected text, p_next text) returns drafts`.

- [ ] **Step 1: Write failing pgTAP tests for owner isolation and transitions**

```sql
begin;
select plan(3);
select has_table('public', 'drafts', 'drafts exists');
select policies_are('public', 'drafts', array['owner can manage drafts']);
select throws_ok($$ select transition_draft(gen_random_uuid(), 'generated', 'published') $$, 'P0001', 'illegal draft transition');
select * from finish();
rollback;
```

- [ ] **Step 2: Start local Supabase and verify the schema test fails**

Run: `npx supabase start`

Run: `npx supabase test db`

Expected: FAIL because the tables and function do not exist.

- [ ] **Step 3: Add the migration**

Create enum/check constraints from `shared/narrative/contracts.ts`; give every private row an `owner_id uuid references auth.users(id)`. Add `unique(schedule_key, scheduled_for)` to `generation_jobs`, immutable `draft_versions`, and `major_event_workflows` phases `proposal`, `proposal_approved`, `scene_plan`, `scene_plan_approved`, `draft`, `final_approved`. Add RLS policies using `auth.uid() = owner_id`, and an explicit transition map in `transition_draft`. The only paths into `published` are `publishing -> published` and `publish_failed -> publishing`.

- [ ] **Step 4: Add deterministic local seed data**

Seed one disabled fake provider, one USD monthly budget period, and disabled schedules. Do not seed credentials or real email addresses.

- [ ] **Step 5: Run database tests twice to prove migrations and seeds are repeatable**

Run: `npx supabase db reset && npx supabase test db`

Run: `npx supabase db reset && npx supabase test db`

Expected: PASS both times.

- [ ] **Step 6: Commit**

```powershell
git add supabase
git commit -m "feat: add owner-scoped narrative database"
```

### Task 3: Atomic budget reservation and reconciliation

**Files:**
- Create: `supabase/migrations/202608140002_budget_ledger.sql`
- Create: `supabase/tests/budget_ledger.test.sql`
- Create: `shared/narrative/budget.ts`
- Create: `shared/narrative/budget.test.ts`

**Interfaces:**
- Produces: `estimateMaxCostMicros(pricing, inputLimit, outputLimit): number`.
- Produces SQL RPCs: `reserve_generation_budget(job_id, amount_micros)`, `reconcile_generation_budget(job_id, actual_micros, usage_json)`, `fail_generation_budget(job_id, charged_micros)`.

- [ ] **Step 1: Write boundary tests**

```ts
expect(estimateMaxCostMicros({ inputPerMillionMicros: 2_000_000, outputPerMillionMicros: 8_000_000 }, 10_000, 2_000)).toBe(36_000);
```

In pgTAP, create two jobs whose combined reservations exceed the daily cap and assert the second RPC raises `budget_limit_exceeded`.

- [ ] **Step 2: Run focused TypeScript and database tests and confirm failures**

Run: `npm run test:run -- shared/narrative/budget.test.ts`

Run: `npx supabase test db`

Expected: FAIL for missing calculator and RPCs.

- [ ] **Step 3: Implement integer-only estimation and transactional SQL RPCs**

```ts
export function estimateMaxCostMicros(p: { inputPerMillionMicros: number; outputPerMillionMicros: number }, input: number, output: number): number {
  return Math.ceil((p.inputPerMillionMicros * input + p.outputPerMillionMicros * output) / 1_000_000);
}
```

Lock the active `budget_periods` row `for update`; include existing reservations in daily and period totals; insert one reservation per job; make reconciliation idempotent by the unique job ID.

- [ ] **Step 4: Verify all foundation tests**

Run: `npm run test:run && npx supabase test db`

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add shared/narrative/budget* supabase/migrations/202608140002_budget_ledger.sql supabase/tests/budget_ledger.test.sql
git commit -m "feat: enforce atomic narrative budgets"
```
