# Narrative Admin Plain-Language UX Implementation Plan

> **For the implementing agent:** REQUIRED SUB-SKILL: Use superpowers:executing-plans and implement this plan inline, task by task. Do not create subagents. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the entire Cheonmu owner admin understandable to a non-developer, with safe model selection, automatic pricing, KRW budgets, secret deletion, timestamped human-readable generation state, and confirmed immediate access generation.

**Architecture:** Keep the browser on the existing same-origin `NarrativeApi`; extend that boundary with allowlisted model-catalog and secret-deletion commands. Put provider network calls and Vault operations in `manage-settings`, put atomic state changes and dashboard projections in additive migration 022, and let `run-schedules` wake the existing fenced worker after an access job is queued. Build human status/currency/time formatting as pure admin modules and consume them across pages.

**Tech Stack:** React 19, TypeScript, Vite, Vitest/Testing Library, Supabase Postgres/pgTAP, Supabase Edge Functions/Deno, Vercel Functions, Playwright.

**Spec:** `docs/superpowers/specs/2026-08-16-narrative-admin-plain-language-ux-design.md`

## Global Constraints

- Do not create or dispatch subagents; execute inline because the owner explicitly prohibited additional subagents.
- Use strict RED → GREEN TDD for every production behavior change.
- Add only migration `202608140022_plain_language_admin.sql`; do not edit migrations 001–021.
- Never expose API keys, Vault IDs, service-role credentials, dispatch tokens, raw provider errors, prompt bodies, or provider response bodies.
- Use `Asia/Seoul` for display and database timestamps as the source of truth.
- Do not perform a paid provider generation during implementation or verification.
- Keep regular cron schedules disabled in the deployed project unless the owner separately approves activation.
- Model prices come from a versioned server catalog with official source URLs and an exact `verifiedAt` date. OpenAI GPT-5 mini baseline is input `$0.25` and output `$2.00` per million tokens, verified from `https://developers.openai.com/api/docs/models/gpt-5-mini` on 2026-08-16. Anthropic catalog entries must use `https://platform.claude.com/docs/en/about-claude/pricing` and live `/v1/models` availability.
- Preserve the existing ivory/ink/red/green/plum visual language, 44px touch targets, keyboard focus, and read-only preview guarantees.

---

### Task 1: Shared display and provider catalog foundations

**Files:**
- Create: `admin/src/lib/narrativeDisplay.ts`
- Create: `admin/src/lib/narrativeDisplay.test.ts`
- Create: `shared/narrative/provider-catalog.ts`
- Create: `shared/narrative/provider-catalog.test.ts`
- Modify: `admin/src/api/narrativeApi.ts`

**Interfaces:**
- Produces: `formatSeoulTimestamp(iso, now)`, `formatKrw(value)`, `microsToKrw(micros, krwPerUsd)`, `krwToMicros(krw, krwPerUsd)`, `generationStatusCopy(item)`.
- Produces: `ProviderCatalogEntry`, `providerCatalog`, `catalogModels(providerKey, liveIds?)`, and `estimateMaximumGenerationMicros(entry)`.
- Later tasks consume `ModelOption`, `ModelCatalogResponse`, expanded dashboard timestamps, and `AccessEstimate` from `NarrativeApi`.

- [ ] **Step 1: Write failing display tests**

```ts
expect(formatSeoulTimestamp('2026-08-16T13:14:00Z', new Date('2026-08-16T13:20:00Z')))
  .toEqual({ relative: '오늘 오후 10:14', exact: '2026.08.16 22:14' });
expect(generationStatusCopy({ source: 'access', state: 'failed/dead-letter', attemptCount: 3, failureCode: 'provider_outcome_unknown' }))
  .toEqual({ title: '접속 이야기 생성 중단', description: 'AI 요청 결과를 확인하지 못해 안전하게 중단했습니다.', action: '설정과 API 키를 확인해 주세요.' });
expect(microsToKrw(1_000_000, 1380)).toBe(1380);
expect(krwToMicros(10_000, 1380)).toBe(7_246_377);
```

- [ ] **Step 2: Run display tests and verify RED**

Run: `npm --prefix admin run test:run -- src/lib/narrativeDisplay.test.ts`

Expected: FAIL because `narrativeDisplay.ts` does not exist.

- [ ] **Step 3: Implement pure display functions**

Use `Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul' })`, reject invalid dates with `표시할 수 없는 시각`, and map every known source/state/failure code to Korean copy. Unknown codes return `생성 상태를 확인할 수 없습니다` without interpolating the raw value into default UI.

- [ ] **Step 4: Write failing provider catalog tests**

```ts
expect(catalogModels('openai', ['gpt-5-mini', 'whisper-1']).map((item) => item.id)).toEqual(['gpt-5-mini']);
expect(catalogModels('openai', null)[0]).toMatchObject({ id: 'gpt-5-mini', recommended: true, availability: 'unverified' });
expect(providerCatalog.find((item) => item.id === 'gpt-5-mini')).toMatchObject({
  inputPriceMicrosPerMillion: 250_000,
  outputPriceMicrosPerMillion: 2_000_000,
  verifiedAt: '2026-08-16',
});
```

- [ ] **Step 5: Run provider catalog tests and verify RED**

Run: `npm run test:run -- shared/narrative/provider-catalog.test.ts`

Expected: FAIL because `provider-catalog.ts` does not exist.

- [ ] **Step 6: Implement the allowlisted catalog and API types**

Define entries with exact IDs/prefix matchers, Korean labels, `quality`, `speed`, `cost`, token defaults, input/output prices, official source URL, and `verifiedAt`. Add these API shapes:

```ts
export interface ModelOption {
  id: string; label: string; description: string;
  quality: 'standard' | 'high'; speed: 'fast' | 'balanced'; cost: 'low' | 'medium' | 'high';
  recommended: boolean; availability: 'available' | 'unverified';
  maxInputTokens: number; maxOutputTokens: number; maxRevisionOutputTokens: number;
  inputPriceMicrosPerMillion: number; outputPriceMicrosPerMillion: number;
  pricingVerifiedAt: string;
}
export interface ModelCatalogResponse { providerKey: 'openai' | 'anthropic'; configured: boolean; live: boolean; models: ModelOption[] }
```

Expand dashboard queue rows with `createdAt`, `completedAt`, and `failedAt`; define `AccessEstimate { maximumCostMicros: number; maximumCostKrw: number; modelLabel: string }`.

- [ ] **Step 7: Run focused and type tests**

Run: `npm run test:run -- shared/narrative/provider-catalog.test.ts`

Run: `npm --prefix admin run test:run -- src/lib/narrativeDisplay.test.ts src/api/narrativeApi.test.ts`

Expected: all PASS.

- [ ] **Step 8: Commit**

```bash
git add shared/narrative/provider-catalog.ts shared/narrative/provider-catalog.test.ts admin/src/lib/narrativeDisplay.ts admin/src/lib/narrativeDisplay.test.ts admin/src/api/narrativeApi.ts
git commit -m "feat(admin): add plain-language display foundations"
```

### Task 2: Atomic settings operations and dashboard timestamps

**Files:**
- Create: `supabase/migrations/202608140022_plain_language_admin.sql`
- Create: `supabase/tests/plain_language_admin.test.sql`
- Create: `supabase/tests/plain_language_admin_concurrency.test.mjs`
- Modify: `package.json`

**Interfaces:**
- Produces service-only RPC `delete_narrative_secret(p_owner_id uuid, p_secret_kind text) returns jsonb`.
- Produces authenticated owner RPC `cancel_queued_generation_job(p_job_id uuid) returns jsonb`.
- Produces authenticated owner RPC `quote_narrative_access_cost() returns jsonb` with the active model label, KRW conversion snapshot, and maximum cost.
- Extends the service access-queue boundary with `p_confirmed_maximum_cost_micros`; it recomputes the quote under the same provider/budget/settings locks and rejects a stale or substituted confirmation before inserting a job.
- Replaces `get_narrative_dashboard()` with an equivalent owner-only projection that adds `createdAt`, `completedAt`, and `failedAt` without exposing payload or tokens.

- [ ] **Step 1: Write pgTAP RED for secret deletion**

Assert that deletion with a wrong owner fails, `openai|anthropic|github` are the only kinds, the Vault secret is removed, the provider is disabled, `manual_generation_enabled=false`, `schedule_automation_enabled=false`, existing drafts/memory/budget rows remain, an audit event is inserted, and only `service_role` can execute the mutation RPC.

- [ ] **Step 2: Write pgTAP RED for cost quotation, cancellation, and timestamps**

Assert that the quote is derived only from the owner's active provider, current catalog pricing, token caps, and KRW rate. Assert that access queueing accepts the exact confirmed micro-USD amount, returns `stale_cost_confirmation` when any locked pricing/model/token input changed, and creates no job on mismatch. Assert that an owner may cancel only their own `queued` job before `provider_dispatch_recorded_at`, cannot cancel running/completed/other-owner jobs, and dashboard JSON includes ISO `createdAt/completedAt/failedAt` while excluding `payload`, attempt tokens, provider response IDs, and secrets.

- [ ] **Step 3: Run pgTAP and verify RED**

Run: `npx supabase test db supabase/tests/plain_language_admin.test.sql`

Expected: FAIL because migration 022 functions/projection do not exist.

- [ ] **Step 4: Write the two-connection RED**

Race `delete_narrative_secret` against `claim_generation_worker_job` for the same owner and assert both transactions terminate without deadlock; either claim uses the pre-delete valid snapshot or deletion wins and no provider claim is returned. Race cancel against claim and assert exactly one wins.

- [ ] **Step 5: Implement migration 022**

Use the established lock order `provider_settings → budget_periods → narrative_admin_settings` for deletion and access quotation/queueing. Delete Vault material and change provider/policies in the same transaction. Preserve all historical content. Recompute and compare the confirmed access maximum cost inside the queue transaction; never trust the browser or Vercel calculation. In cancellation, lock the exact job and require `status='queued'`, no active worker token, and no provider dispatch record. Recreate dashboard with owner checks and allowlisted fields.

- [ ] **Step 6: Run clean DB verification**

Run: `npx supabase db reset`

Run: `npx supabase test db supabase/tests/plain_language_admin.test.sql`

Run: `node supabase/tests/plain_language_admin_concurrency.test.mjs`

Expected: reset PASS, pgTAP PASS, both races PASS without deadlock.

- [ ] **Step 7: Add and run 021→022 upgrade coverage**

Extend the existing upgrade harness to stop at 021, seed one configured provider plus completed/failed/queued jobs, apply 022, and assert settings/provider/history are preserved and the new RPC/projection works.

Run: `npm run test:db:upgrade`

Expected: PASS and restore the database to head.

- [ ] **Step 8: Commit**

```bash
git add supabase/migrations/202608140022_plain_language_admin.sql supabase/tests/plain_language_admin.test.sql supabase/tests/plain_language_admin_concurrency.test.mjs package.json
git commit -m "feat(db): add safe owner settings operations"
```

### Task 3: Provider model lookup and secret deletion server boundaries

**Files:**
- Modify: `supabase/functions/manage-settings/index.ts`
- Modify: `supabase/functions/manage-settings/index.test.ts`
- Modify: `admin/src/server/narrativeHandler.ts`
- Modify: `admin/src/server/narrativeHandler.test.ts`
- Modify: `admin/src/api/narrativeApi.ts`
- Modify: `admin/src/api/narrativeApi.test.ts`

**Interfaces:**
- `GET /api/narrative/settings/models?provider=openai|anthropic` → `ModelCatalogResponse`.
- `DELETE /api/narrative/settings/secret/:kind` with an empty body → `{ configured: false, generationPaused: true }`.
- `NarrativeApi.listModels(providerKey)` and `NarrativeApi.deleteSecret(kind)`.

- [ ] **Step 1: Write manage-settings RED tests**

Test owner authentication, exact provider allowlist, missing-key fallback, OpenAI `GET https://api.openai.com/v1/models` bearer request, Anthropic `GET https://api.anthropic.com/v1/models` with `x-api-key` and `anthropic-version`, 10-second request/body timeout, live-ID intersection with the catalog, sanitized upstream failure, and delete RPC projection with no secret/Vault fields.

- [ ] **Step 2: Run Edge tests and verify RED**

Run: `npm run test:run -- supabase/functions/manage-settings/index.test.ts`

Expected: FAIL because only secret writes are supported.

- [ ] **Step 3: Implement discriminated commands in manage-settings**

Accept strict bodies:

```ts
{ action: 'write-secret', kind, value }
{ action: 'list-models', providerKey }
{ action: 'delete-secret', kind }
```

Authenticate before Vault/model access. Resolve Vault material server-side, never return it, and filter provider IDs through `catalogModels`. A missing key returns the fallback catalog with `configured:false`; an authentication rejection returns sanitized `connectionIssue:'invalid_key'`; a timeout or transient provider failure returns `connectionIssue:'temporarily_unavailable'`. Neither case exposes the raw provider response. Deletion calls the service-only 022 RPC.

- [ ] **Step 4: Write same-origin and client RED tests**

Assert exact routes/methods, owner bearer forwarding, empty DELETE body, response allowlists, provider query validation, 401/403 preservation, and generic 500 for raw provider/DB failures.

- [ ] **Step 5: Implement API/client methods**

Add the two handler routes before generic settings routes. Make `listModels` GET and `deleteSecret` DELETE. Keep all browser calls same-origin.

- [ ] **Step 6: Run focused tests and Deno check**

Run: `npm run test:run -- supabase/functions/manage-settings/index.test.ts`

Run: `npm --prefix admin run test:run -- src/server/narrativeHandler.test.ts src/api/narrativeApi.test.ts`

Run: `npx deno check supabase/functions/manage-settings/index.ts`

Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add supabase/functions/manage-settings/index.ts supabase/functions/manage-settings/index.test.ts admin/src/server/narrativeHandler.ts admin/src/server/narrativeHandler.test.ts admin/src/api/narrativeApi.ts admin/src/api/narrativeApi.test.ts
git commit -m "feat(admin): expose safe model and secret controls"
```

### Task 4: Simple settings and KRW budget UI

**Files:**
- Modify: `admin/src/features/settings/SettingsPage.tsx`
- Modify: `admin/src/features/settings/SettingsPage.test.tsx`
- Modify: `admin/src/styles.css`
- Modify: `admin/src/preview/localPreviewApi.ts`
- Modify: `admin/src/e2e-fixtures/e2eFixtureApi.ts`

**Interfaces:**
- Consumes `NarrativeApi.listModels`, `deleteSecret`, display/currency helpers, and existing `saveSettings`/`saveSecret`.
- Produces no new network contract.

- [ ] **Step 1: Write UI RED tests for simple settings**

Assert the default view shows provider, key status, model `<select>`, model explanation, monthly/daily KRW inputs, quick buttons `5천원/1만원/3만원`, two policy switches, and save. Assert technical prices/token limits are absent until `고급 설정` is expanded.

- [ ] **Step 2: Write model selection and budget RED tests**

Select `gpt-5-mini`, assert its catalog price/token values are passed to `saveSettings`, type `10,000` won, assert deterministic micro-USD conversion, and show an approximate generation count using maximum cost. Test invalid/negative/under-reserved budgets inline without submitting.

- [ ] **Step 3: Write secret lifecycle RED tests**

Assert registered keys render only `연결됨`, replacement inputs are password fields, delete requires confirmation, success marks disconnected and both policy toggles off, failure preserves prior visible state, and preview/read-only mode disables all mutations.

- [ ] **Step 4: Run focused tests and verify RED**

Run: `npm --prefix admin run test:run -- src/features/settings/SettingsPage.test.tsx`

Expected: FAIL on missing select/KRW/advanced/delete behavior.

- [ ] **Step 5: Implement the settings UI**

Split internal components in the same file only if each stays under roughly 120 lines: `ProviderCard`, `KrwBudgetFields`, `AdvancedSettings`, `SecretControl`. Load models when provider/key state changes, preserve the current configured model if the live list temporarily fails, and show fallback availability copy.

- [ ] **Step 6: Add responsive and accessible styling**

Use a two-column desktop `.simple-settings-grid`, one-column mobile layout, 44px controls, visible focus, units inside field wrappers, and a destructive confirmation style for deletion. Do not rely on color alone.

- [ ] **Step 7: Run focused/full admin verification**

Run: `npm --prefix admin run test:run -- src/features/settings/SettingsPage.test.tsx src/preview/localPreviewApi.test.ts`

Run: `npm --prefix admin run build`

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add admin/src/features/settings/SettingsPage.tsx admin/src/features/settings/SettingsPage.test.tsx admin/src/styles.css admin/src/preview/localPreviewApi.ts admin/src/e2e-fixtures/e2eFixtureApi.ts
git commit -m "feat(admin): simplify provider and budget settings"
```

### Task 5: Plain-language pages, timestamped status, and immediate access

**Files:**
- Modify: `admin/src/features/today/TodayPage.tsx`
- Modify: `admin/src/features/today/TodayPage.test.tsx`
- Modify: `admin/src/features/drafts/DraftListPage.tsx`
- Modify: `admin/src/features/drafts/DraftReviewPage.tsx`
- Modify: `admin/src/features/memory/MemoryPage.tsx`
- Modify: `admin/src/features/schedules/SchedulesPage.tsx`
- Modify: corresponding four `*.test.tsx` files
- Modify: `admin/src/components/AdminStatusBadge.tsx`
- Modify: `admin/src/styles.css`
- Modify: `admin/src/server/narrativeHandler.ts`
- Modify: `admin/src/server/narrativeHandler.test.ts`
- Modify: `supabase/functions/run-schedules/index.ts`
- Modify: `supabase/functions/run-schedules/index.test.ts`

**Interfaces:**
- `GET /api/narrative/access/estimate` → `AccessEstimate`, sourced from the authenticated database quote RPC.
- `POST /api/narrative/access` with `{ maximumCostConfirmed: true, confirmedMaximumCostMicros }` → `{ id, scheduledFor, dispatchState }`.
- `POST /api/narrative/jobs/:id/cancel` with no body → `{ status: 'cancelled' }`.
- `run-schedules` queues once, validates persisted owner/job binding, then wakes `run-generation-worker` with the runtime dispatch secret; a wake failure leaves the same queued job and never creates a replacement.

- [ ] **Step 1: Write Today-page RED for human status and timestamps**

Use fixed `now` and assert `Generation queue`, `access · queued · attempt 0`, and raw failure codes are absent. Assert `이야기 생성 현황`, `접속 이야기 생성 대기 중`, `2026.08.16 22:14`, retry/completion text, safe technical disclosure, and a cancel button only for eligible queued jobs.

- [ ] **Step 2: Write access estimate/confirmation RED**

Assert clicking `접속 이야기 만들기` first shows model and maximum KRW cost, does not call `triggerAccess`, cancellation closes the dialog, confirmation sends the exact quoted micros, and the page polls the same job through completed/failed state.

- [ ] **Step 3: Write server/Edge RED for immediate dispatch**

Test stale/mismatched cost as 409, including a pricing/model change between quote and confirmation; body substitution rejection; one persisted job under duplicate confirmation; exact worker wake token never entering the browser response; worker wake failure returning `dispatchState:'delayed'`; and no second queue insertion.

- [ ] **Step 4: Run focused RED tests**

Run: `npm --prefix admin run test:run -- src/features/today/TodayPage.test.tsx src/server/narrativeHandler.test.ts`

Run: `npm run test:run -- supabase/functions/run-schedules/index.test.ts`

Expected: FAIL on missing copy, estimate, confirmation, and worker wake.

- [ ] **Step 5: Implement estimate, confirmation, wake, polling, and cancel**

Read the estimate from `quote_narrative_access_cost()` at the same-origin server boundary. Submit only the confirmed micro-USD amount; `run-schedules` passes it to the database queue RPC, which recomputes it under locks and rejects stale confirmation before queueing. After a successful atomic queue, have `run-schedules` invoke the worker server-to-server. Poll dashboard with bounded intervals (1s, 2s, 3s, then 5s; stop after 2 minutes but leave manual refresh) and never issue another access request while polling.

- [ ] **Step 6: Replace jargon across remaining pages**

Use a single terminology map:

```ts
canon: '확정 설정'; continuity: '이어지는 사실'; feedback: '수정 지침'; unresolved: '아직 정하지 않은 설정';
generated: '검토 필요'; approved_private: '비공개 승인'; published: '공개 완료'; archived: '보관됨';
pass: '문제 없음'; review: '확인 필요'; block: '승인 불가';
```

Translate publication states to Korean, add explanatory descriptions, and keep raw values only in technical disclosures. Reuse `formatSeoulTimestamp` everywhere.

- [ ] **Step 7: Run all page and boundary tests**

Run: `npm --prefix admin run test:run -- src/features/today/TodayPage.test.tsx src/features/drafts/DraftListPage.test.tsx src/features/drafts/DraftReviewPage.test.tsx src/features/memory/MemoryPage.test.tsx src/features/schedules/SchedulesPage.test.tsx src/server/narrativeHandler.test.ts`

Run: `npm run test:run -- supabase/functions/run-schedules/index.test.ts supabase/functions/run-generation-worker/index.test.ts`

Expected: all PASS.

- [ ] **Step 8: Commit**

```bash
git add admin/src supabase/functions/run-schedules/index.ts supabase/functions/run-schedules/index.test.ts
git commit -m "feat(admin): explain narrative work in plain Korean"
```

### Task 6: End-to-end verification, deployment, and production smoke test

**Files:**
- Modify: `admin/e2e/owner-journey.spec.ts`
- Modify: `admin/e2e/mobile-layout.spec.ts`
- Modify: `admin/e2e/screenshot-matrix.spec.ts`
- Modify: `scripts/test-admin-owner-journey.mjs`
- Modify: `scripts/test-generation-worker-integration.mjs`
- Modify: `docs/operations/narrative-production-runbook.ko.md`

**Interfaces:**
- Consumes every prior task; produces no new production API.

- [ ] **Step 1: Add E2E RED coverage**

Cover owner login, fallback/live model select without exposing a key, KRW quick budget, advanced disclosure, failed key deletion preserving state, successful fake-key deletion pausing policies, timestamped dashboard, cost confirmation, exactly one fake-provider invocation, completion, draft visibility, queued cancellation, mobile controls, and technical-detail disclosure.

- [ ] **Step 2: Run E2E RED**

Run: `npm --prefix admin run e2e -- owner-journey.spec.ts mobile-layout.spec.ts`

Expected: FAIL on the new flows before fixture/server wiring is complete.

- [ ] **Step 3: Complete deterministic fixtures and operator docs**

Use fake provider/Vault fixtures only. Document model-catalog verification dates, how to update prices from official sources, secret deletion effects, immediate access behavior, cron independence, and a production smoke sequence that never invokes a paid model without explicit approval.

- [ ] **Step 4: Run the complete local matrix once**

Run sequentially:

```bash
npx supabase db reset
npx supabase test db
npm run test:db:concurrency
npm run test:db:upgrade
npm run test:gateway
npm run test:run
npm --prefix admin run test:run
npm run validate
npm run build
npm --prefix admin run build
npm run narrative:security
npm run e2e
npm --prefix admin run e2e
```

Expected: all PASS. If the preserved local preview occupies the fixed editor test port, stop only that exact verified listener, run the exact full test, and restart the same preview configuration; do not kill broad Node processes.

- [ ] **Step 5: Run security and migration invariants**

Verify only migration 022 was added, schema diff is empty after reset, new mutation RPCs are service-only or exact owner-only as designed, authenticated table grants remain read-only, bundles contain no secrets/Vault IDs/raw prompts, and UTF-8 Korean copy is intact.

- [ ] **Step 6: Commit final verification changes**

```bash
git add admin/e2e scripts docs/operations/narrative-production-runbook.ko.md
git commit -m "test(admin): verify plain-language owner workflow"
```

- [ ] **Step 7: Deploy Supabase and Vercel**

Apply migration 022, deploy only changed Edge functions, set no new paid-provider secret, push `main`, and wait for the Vercel status attached to the exact commit to report success. Confirm the Vercel project Root Directory remains `admin`.

- [ ] **Step 8: Perform a read-only production smoke test**

With an owner session, verify settings GET/model-list GET, dashboard timestamps, draft list, memory, schedules, and secret status. Do not click access confirmation and do not delete the real key in production during smoke testing. Report any action that still requires explicit owner approval.
