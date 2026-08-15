# Narrative generation browser/review remediation report

Date: 2026-08-15

Base: `19116d3`

Migration: `202608140013_generation_browser_review_remediation.sql`

## Outcome

The browser-facing function handlers now accept the four standard Supabase request headers, validate bearer credentials inside the application boundary, and apply the configured exact-origin policy to every handler-produced response. All three functions disable runtime JWT interception so invalid and expired credentials reach the same sanitized handler path.

The owner workflow now has one additive authenticated database command for `generated -> reviewing`. It checks the locked draft owner, exact expected state, exact expected version, and latest version before changing state. Generic transition and budget mutation RPCs remain service-only. Approval still flows through `review_draft_atomic`; blocked content may enter review solely so the owner can inspect, reject, and record feedback, but both private and public approval remain impossible.

No Edge wrapper was added for submission because there is no existing admin UI/API contract that requires one. No deployment, production secret change, paid provider request, publishing work, or admin UI work was performed. Migrations 001-012 and the root-authored generation `progress.md` are unchanged.

## TDD evidence

RED before production changes:

- The three focused HTTP suites failed their browser preflights with 403 when `apikey` and `x-client-info` were requested (3 expected failures).
- Malformed bearer cases proved that whitespace/multi-token credentials could reach dependencies, and `run-schedules` called authentication dependencies even when the header was absent or malformed.
- The first actual local gateway probe observed stock Kong answering preflight itself with `200` and wildcard origin, proving that handler-only tests did not characterize the real path.
- The new pgTAP workflow test failed because `submit_draft_for_review(uuid,uuid,text)` did not exist.

GREEN after the minimal fixes:

- Focused handler/CORS/auth suites: 100/100 passed.
- Actual local Supabase gateway probe: all three functions passed standard preflight, missing/invalid-token sanitization, valid-user handler reachability, and disallowed-origin actual-request rejection.
- Owner submission and guarded review pgTAP: 25/25 passed.

## Forthcoming admin UI RPC contract

The future authenticated admin client should call Supabase RPC `submit_draft_for_review` with only:

```ts
await supabase.rpc('submit_draft_for_review', {
  p_draft_id: draftId,
  p_expected_version_id: latestVersionId,
  p_expected_state: 'generated',
})
```

On success, the returned draft is in `reviewing`. The client may then invoke the existing `review-draft` Edge command with the same version ID and `expectedState: 'reviewing'`. It must never call `transition_draft` or any budget RPC. `stale_review_submission` means the client must refetch; `review target not found` deliberately does not disclose foreign drafts.

## Stock Supabase gateway CORS boundary

Local Supabase CLI 2.114.0 places a stock Kong 2.8.1 CORS plugin in front of `/functions/v1/*`. That plugin terminates preflight with non-credentialed wildcard CORS and may overwrite upstream CORS metadata on actual responses. `config.toml` exposes per-function JWT verification but no supported Kong CORS configuration. A local-only Kong rewrite was intentionally rejected because it would not represent hosted Supabase.

The application authorization boundary remains fail-closed: direct handler tests prove exact-origin response headers, disallowed actual requests return handler-owned 403 before authentication/data access, missing/invalid tokens return only `{"error":"authentication_required"}`, and valid user tokens must pass Supabase Auth before any owner-scoped query. Cost/risk: browser-direct calls still expose stock gateway wildcard metadata even though no credentialed access or application data is granted by it. The forthcoming Vercel admin should use a same-origin server proxy if eliminating browser-direct gateway exposure is required.

## Full verification

- Clean local reset applied migrations 001 through 013 and seed data: PASS.
- All pgTAP: 12 files, 281 assertions: PASS.
- All Vitest: 30 files, 350 passed, 3 intentional skips: PASS.
- All five live database concurrency programs: PASS.
- Actual local gateway browser/auth probes for three functions: PASS.
- Real migration 010-to-current (013) upgrade and seeded-head restoration: PASS.
- Narrative TypeScript project: PASS.
- Standalone upgrade-test TypeScript check with TypeScript 7 `--ignoreConfig`: PASS.
- `npm run validate`: PASS.
- `npm run build`: PASS (395 modules transformed).
- Live privilege probe: authenticated can execute only the narrow submit RPC; anon/service cannot; generic transition remains service-only; authenticated budget mutation count is zero.
- Prior migration diff (001-012): empty.
- Root generation `progress.md` diff: empty.
- Concrete provider/Supabase key, JWT, and hosted Supabase URL scan: clean.

## Review and concerns

Self-review found no Critical or Important defect. The submission RPC is `SECURITY DEFINER` with an empty search path, authenticates before lookup, locks the target draft, compares `auth.uid()` to the locked owner without trusting owner input, verifies the latest locked version, and exposes no caller-selected next state. The full workflow test proves a blocked generated version can be inspected and explicitly rejected into one blocking feedback memory, while private/public approvals both fail and no continuity memory or publication job is created. Cost of this ruling: blocked drafts briefly use `reviewing` as an inspection state rather than remaining terminally `generated`; the guarded atomic policy remains the sole approval boundary.

Independent narrow re-review found no Critical, Important, or Minor issues. It confirmed both original remediation findings are closed, the authoritative blocked-content workflow is enforced, gateway-test cleanup is complete, and the operator contract documents the deployment requirements and stock-Kong limitation.

Operational requirements remain: set `NARRATIVE_ADMIN_ORIGINS` to exact admin origins before browser use, keep `verify_jwt=false` paired with the in-handler Supabase Auth validation, and prefer a same-origin Vercel proxy for the future admin surface.
