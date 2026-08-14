# Cheonmu Narrative Publishing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish only approved narrative versions into the existing archive with recoverable GitHub commits and visible deployment status.

**Architecture:** A server-only publisher transforms a locked approved draft version into existing Markdown frontmatter/body, validates it before writing, serializes GitHub commits, and records Actions/Pages status separately from commit status.

**Tech Stack:** Supabase Edge Functions, GitHub REST API, existing TypeScript content validation, GitHub Actions, Vitest, Playwright

**Spec:** `docs/superpowers/specs/2026-08-14-cheonmu-autonomous-narrative-design.md`

## Global Constraints

- Publish the locked approved version, never a mutable working copy.
- Strip prompts, raw responses, private memory, cost and audit data.
- Serialize repository writes and use idempotency keys.
- Never overwrite a conflicting file automatically.
- Distinguish commit success, workflow success and Pages deployment success.

---

### Task 1: Existing-schema Markdown transformer

**Files:**
- Create: `shared/narrative/publish-record.ts`
- Create: `shared/narrative/publish-record.test.ts`
- Modify: `src/content/schema.ts`
- Modify: `scripts/validate-content.ts`

**Interfaces:**
- Produces: `toPublishedRecord(approvedVersion, publication): { path: string; source: string }`.

- [ ] **Step 1: Write a failing golden-file test**

```ts
const published = toPublishedRecord(approvedFixture, { id: 'rainy-return', recordNumber: '08', relationshipStage: 7 });
expect(published.path).toBe('src/content/records/08-rainy-return.md');
expect(published.source).toMatchSnapshot();
expect(published.source).not.toMatch(/prompt|costMicros|rawResponse|privateMemory/);
```

- [ ] **Step 2: Run the test and confirm missing transformer failure**

Run: `npm run test:run -- shared/narrative/publish-record.test.ts`

- [ ] **Step 3: Implement mapping to the existing record schema**

Require a unique ID, record number, title, summary, stage, date, status `confirmed`, characters, tags, related records, representative quote and body. Reject unresolved canon-change candidates and broken related IDs before rendering YAML frontmatter.

- [ ] **Step 4: Validate the rendered fixture through the real content validator**

Add a test-only input seam to `validate-content.ts`; parse the generated source with the same frontmatter/schema path used by production.

- [ ] **Step 5: Run validation and tests**

Run: `npm run validate && npm run test:run -- shared/narrative/publish-record.test.ts scripts/content-validation-path.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```powershell
git add shared/narrative/publish-record* src/content/schema.ts scripts/validate-content.ts scripts/content-validation-path.test.ts
git commit -m "feat: render approved narratives as archive records"
```

### Task 2: GitHub publisher and serialized publish queue

**Files:**
- Create: `supabase/functions/_shared/github-publisher.ts`
- Create: `supabase/functions/_shared/github-publisher.test.ts`
- Create: `supabase/functions/publish-draft/index.ts`
- Create: `supabase/functions/publish-draft/index.test.ts`
- Create: `supabase/migrations/202608140004_publication_jobs.sql`

**Interfaces:**
- Produces: `GitHubPublisher.createFile({ path, content, message, branch })`.
- Produces authenticated endpoint `publish-draft` and one-at-a-time publication queue.

- [ ] **Step 1: Write mocked GitHub tests**

Cover `201` success, existing path, `409` conflict, `422` validation, `401/403` credential failure and network timeout. Assert no update request is sent when the path already exists with different content.

- [ ] **Step 2: Write publication state tests**

Assert only `approved` enters `publishing`; successful commit records SHA and becomes `published`; failure becomes `publish_failed`; retry returns to `publishing`; the same approved version and idempotency key never create two commits.

- [ ] **Step 3: Run tests and confirm failures**

Run: `npm run test:run -- supabase/functions/_shared/github-publisher.test.ts supabase/functions/publish-draft/index.test.ts`

- [ ] **Step 4: Implement least-privilege server-only publication**

Read owner/repository/branch and credential only from server settings. Base64-encode UTF-8 content, use a deterministic commit message `content: publish narrative <record-id>`, and process one queue row under a database advisory lock.

- [ ] **Step 5: Verify tests without a real GitHub token**

Run: `npm run test:run && npx supabase test db`

Expected: PASS with mocked GitHub HTTP.

- [ ] **Step 6: Commit**

```powershell
git add supabase/functions/_shared/github-publisher* supabase/functions/publish-draft supabase/migrations/202608140004_publication_jobs.sql
git commit -m "feat: publish approved narratives through github"
```

### Task 3: Workflow and Pages deployment tracking

**Files:**
- Create: `supabase/functions/check-publication/index.ts`
- Create: `supabase/functions/check-publication/index.test.ts`
- Modify: `.github/workflows/deploy.yml`
- Modify: `admin/src/features/drafts/DraftReviewPage.tsx`
- Modify: `admin/src/features/drafts/DraftReviewPage.test.tsx`

**Interfaces:**
- Produces publication phases `commit_created`, `workflow_running`, `workflow_failed`, `deployed`.

- [ ] **Step 1: Write tracking tests**

Mock GitHub Actions responses for queued, in-progress, success and failure. Associate runs by commit SHA, not by newest workflow. Assert the admin displays commit and deployment statuses separately and links only safe GitHub/Pages URLs.

- [ ] **Step 2: Run focused tests and confirm failure**

Run: `npm run test:run -- supabase/functions/check-publication/index.test.ts`

Run: `npm --prefix admin run test -- --run src/features/drafts/DraftReviewPage.test.tsx`

- [ ] **Step 3: Implement status polling with bounded lifetime**

Poll only nonterminal publication rows, use increasing intervals, stop after the configured observation window, and leave timed-out rows retriable without changing narrative approval.

- [ ] **Step 4: Harden the existing workflow**

Keep `validate`, unit tests, build and e2e as required gates. Add concurrency keyed by commit/ref without cancellation, and expose the deployed URL through the existing Pages deployment output. Do not add write credentials to workflow logs.

- [ ] **Step 5: Verify workflow and UI**

Run: `npm run validate && npm run test:run && npm run build && npm run e2e`

Run: `npm --prefix admin run test -- --run && npm --prefix admin run build`

Expected: PASS.

- [ ] **Step 6: Commit**

```powershell
git add supabase/functions/check-publication .github/workflows/deploy.yml admin/src/features/drafts
git commit -m "feat: track narrative deployment status"
```

### Task 4: Security audit, live canary, and operating guide

**Files:**
- Create: `docs/narrative-operations.md`
- Create: `scripts/check-narrative-secrets.ts`
- Create: `scripts/check-narrative-secrets.test.ts`
- Modify: `package.json`
- Modify: `README.md`

**Interfaces:**
- Produces `npm run narrative:security` and the owner runbook.

- [ ] **Step 1: Write a failing secret-leak test**

Test fixture files containing service-role JWT shapes, `sk-` provider keys, GitHub tokens, full authorization headers and raw prompt fields. Assert the scanner reports file and rule without echoing the secret value.

- [ ] **Step 2: Implement the scanner and operating guide**

Scan tracked source, `dist`, and `admin/dist`; exclude fixture hashes, never print matched values. Document owner creation, signup disablement, RLS verification, Vault secrets, provider/model pricing verification, account hard limits, fake-provider reset, schedule enablement order, key rotation, failed publication recovery and emergency automation shutdown.

- [ ] **Step 3: Run the complete local gate**

Run: `npm run narrative:security && npm run validate && npm run test:run && npm run build && npm run e2e`

Run: `npm --prefix admin run test -- --run && npm --prefix admin run build && npm --prefix admin run e2e`

Run: `npx supabase db reset && npx supabase test db`

Expected: PASS.

- [ ] **Step 4: Perform the controlled live canary**

With the monthly and daily test budget set to the smallest approved nonzero amount, enable one provider and manual generation only. Generate one short dialogue, verify provider-reported usage equals the reconciled ledger entry, reject it, and confirm only feedback memory is written. Then generate one fixture-safe dialogue, approve and publish it to a temporary branch, verify Actions and rendered preview, and remove the temporary branch through the GitHub UI after recording the results.

- [ ] **Step 5: Enable production schedules progressively**

Enable daily generation first. After one successful day and ledger review, enable access-triggered generation; then weekly; then special dates. Record each activation and rollback instruction in `docs/narrative-operations.md`.

- [ ] **Step 6: Commit documentation and security gate**

```powershell
git add README.md package.json package-lock.json docs/narrative-operations.md scripts/check-narrative-secrets*
git commit -m "docs: add narrative operations and security gate"
```

