# Cheonmu Narrative Admin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the responsive, single-owner administrator for monitoring, generating, reviewing, remembering and configuring the narrative system.

**Architecture:** A separate Vite React app deploys to Vercel. Supabase Auth protects every route; browser data access is RLS-scoped, while sensitive generation and review actions use authenticated Edge Functions.

**Tech Stack:** React 19, TypeScript, Vite, React Router, Supabase JS, Vitest, Testing Library, Playwright, Vercel

**Spec:** `docs/superpowers/specs/2026-08-14-cheonmu-autonomous-narrative-design.md`

## Global Constraints

- No provider or GitHub credential enters the browser bundle.
- Routes are unusable until an authenticated owner session is confirmed.
- PC and mobile expose equivalent review and approval capability.
- Destructive deletion is separate from reversible archive.
- All dates render in `Asia/Seoul`.

---

### Task 1: Admin shell, authentication, and deployment boundary

**Files:**
- Create: `admin/package.json`
- Create: `admin/vite.config.ts`
- Create: `admin/tsconfig.json`
- Create: `admin/index.html`
- Create: `admin/src/main.tsx`
- Create: `admin/src/app/AdminApp.tsx`
- Create: `admin/src/auth/AuthGate.tsx`
- Create: `admin/src/auth/AuthGate.test.tsx`
- Create: `admin/src/lib/supabase.ts`
- Create: `admin/vercel.json`
- Modify: `package.json`

**Interfaces:**
- Produces `AuthGate`, authenticated routes `/`, `/drafts`, `/memory`, `/schedules`, `/settings`.

- [x] **Step 1: Write failing authentication tests**

```tsx
render(<AuthGate client={signedOutClient}><p>비공개</p></AuthGate>);
expect(screen.queryByText('비공개')).not.toBeInTheDocument();
expect(screen.getByRole('button', { name: '로그인 링크 받기' })).toBeInTheDocument();
```

- [x] **Step 2: Scaffold the separate app and confirm the test fails**

Run: `npm --prefix admin install`

Run: `npm --prefix admin run test -- --run src/auth/AuthGate.test.tsx`

- [x] **Step 3: Implement owner authentication**

Use email magic-link login, session restoration, logout, and a server-stored allowlisted owner check. Render no private route before both session and owner membership resolve. Configure Vercel SPA rewrites without adding secrets to `vercel.json`.

- [x] **Step 4: Verify build contains only publishable Supabase environment variables**

Run: `npm --prefix admin run test -- --run && npm --prefix admin run build`

Run: `rg "SERVICE_ROLE|OPENAI_API_KEY|ANTHROPIC_API_KEY|GITHUB_TOKEN" admin/dist`

Expected: tests/build PASS and secret scan has no matches.

- [x] **Step 5: Commit**

```powershell
git add admin package.json package-lock.json
git commit -m "feat: scaffold private narrative admin"
```

### Task 2: Today dashboard and draft review workflow

**Files:**
- Create: `admin/src/features/today/TodayPage.tsx`
- Create: `admin/src/features/today/TodayPage.test.tsx`
- Create: `admin/src/features/drafts/DraftListPage.tsx`
- Create: `admin/src/features/drafts/DraftReviewPage.tsx`
- Create: `admin/src/features/drafts/DraftReviewPage.test.tsx`
- Create: `admin/src/api/narrativeApi.ts`
- Create: `admin/src/api/narrativeApi.test.ts`

**Interfaces:**
- Produces `NarrativeApi.listDrafts`, `getDraft`, `generate`, `saveManualVersion`, `review`, `retryPublish`.

- [ ] **Step 1: Write dashboard and stale-review tests**

Assert the dashboard shows daily/monthly spent, reserved and remaining microdollars, next schedule, last success and failures. Assert review sends `expectedVersionId` and a stale `409` preserves local edits while prompting reload.

- [ ] **Step 2: Run tests and confirm missing pages fail**

Run: `npm --prefix admin run test -- --run src/features/today/TodayPage.test.tsx src/features/drafts/DraftReviewPage.test.tsx`

- [ ] **Step 3: Implement list, detail and review actions**

The review page displays final text, automated findings with source IDs, context versions, canon-change candidates and version history. Buttons are exactly: `직접 수정`, `부분 AI 수정`, `비공개 정사 승인`, `승인하고 게시`, `거절`, `보관`.

- [ ] **Step 4: Add focused partial revision**

Require a selected passage, revision instruction, maximum output tokens and a confirmation showing estimated maximum cost. Store the result as a new immutable draft version; never overwrite the selected version.

- [ ] **Step 5: Verify tests and responsive semantic layout**

Run: `npm --prefix admin run test -- --run`

Expected: PASS, including keyboard-accessible dialogs and status messages.

- [ ] **Step 6: Commit**

```powershell
git add admin/src/api admin/src/features/today admin/src/features/drafts
git commit -m "feat: add narrative dashboard and review"
```

### Task 3: Memory, schedules, provider, and budget settings

**Files:**
- Create: `admin/src/features/memory/MemoryPage.tsx`
- Create: `admin/src/features/memory/MemoryPage.test.tsx`
- Create: `admin/src/features/schedules/SchedulesPage.tsx`
- Create: `admin/src/features/schedules/SchedulesPage.test.tsx`
- Create: `admin/src/features/settings/SettingsPage.tsx`
- Create: `admin/src/features/settings/SettingsPage.test.tsx`
- Create: `supabase/functions/manage-settings/index.ts`
- Create: `supabase/functions/manage-settings/index.test.ts`

**Interfaces:**
- Consumes owner-scoped tables and authenticated settings Edge Function.

- [ ] **Step 1: Write tests for all safety constraints**

Assert rejected drafts create feedback only; fixed canon is read-only; schedule times display Seoul time; activating one provider deactivates the other transactionally; stale pricing prevents enabling automation; decreasing a budget below spent+reserved is rejected. Assert settings responses never return stored provider or GitHub secret values.

- [ ] **Step 2: Run tests and confirm failures**

Run: `npm --prefix admin run test -- --run src/features/memory src/features/schedules src/features/settings`

- [ ] **Step 3: Implement memory and schedule management**

Separate fixed canon, continuity, recent, feedback and unresolved callbacks. Provide enable/disable and correction history, not in-place destructive edits. Schedules show active, last run, next run, minimum interval and special dates.

- [ ] **Step 4: Implement safe settings**

Provider/model settings include USD per-million input/output prices, verified date, max tokens and one active provider. Budget settings include monthly, daily, manual-count, warning/risk thresholds and KRW reference rate. Implement `manage-settings` as the only secret-write path: it verifies the owner, writes secrets to server-side storage, records an audit event, and returns only `configured: true`. Secret entry fields always return empty after save and display only `연결됨` state.

- [ ] **Step 5: Verify the complete admin**

Run: `npm --prefix admin run test -- --run && npm --prefix admin run build`

Expected: PASS.

- [ ] **Step 6: Commit**

```powershell
git add admin/src/features/memory admin/src/features/schedules admin/src/features/settings
git commit -m "feat: manage narrative memory schedules and budgets"
```

### Task 4: Admin end-to-end owner journey

**Files:**
- Create: `admin/e2e/owner-journey.spec.ts`
- Create: `admin/playwright.config.ts`
- Create: `admin/src/styles/tokens.css`
- Create: `admin/src/styles/admin.css`
- Modify: `admin/package.json`

**Interfaces:**
- Verifies the full private UI against local Supabase and fake provider.

- [ ] **Step 1: Write the owner journey**

The test signs in with the local test owner, triggers an access-time short dialogue after the minimum interval, sees budget reservation and reconciliation, edits one line, approves privately, creates and rejects another draft, configures a special date, and confirms no publish job exists. A second flow approves a major-event proposal, generates and approves its scene plan, generates the draft, and verifies that no phase can be skipped.

- [ ] **Step 2: Add mobile coverage**

Repeat review and approval at a 390×844 viewport; assert all actions are keyboard reachable, dialogs trap focus, and status changes use live regions.

- [ ] **Step 3: Run and observe failure before fixtures/styles are complete**

Run: `npm --prefix admin run e2e`

- [ ] **Step 4: Add restrained archive-aligned styling and stable fixtures**

Reuse the existing ivory, black, dark red and character color tokens conceptually without importing the public app bundle. Honor `prefers-reduced-motion`; keep the mobile action bar visible without covering text.

- [ ] **Step 5: Run full admin verification**

Run: `npm --prefix admin run test -- --run && npm --prefix admin run build && npm --prefix admin run e2e`

Expected: PASS.

- [ ] **Step 6: Commit**

```powershell
git add admin
git commit -m "test: cover narrative admin owner journey"
```
