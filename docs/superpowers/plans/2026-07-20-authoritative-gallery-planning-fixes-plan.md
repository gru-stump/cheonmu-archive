# Authoritative Gallery Planning Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every gallery mutation and its persistent UI preview consume the same authoritative storage planning logic, while closing the Fetch Metadata and staged-image documentation gaps.

**Architecture:** Gallery storage will resolve metadata, combined-image, and delete intents into internal prepared plans containing exact locations, prospective metadata, sources, destinations, and trash candidates. Read-only methods project those plans to workspace-relative audit entries; commit methods execute plans built by the same functions inside the shared mutation queue. React will request plans on every valid dirty/delete intent and render only the latest authoritative response.

**Tech Stack:** TypeScript, Node filesystem promises, Express 5, React 19, Vitest/Testing Library, Playwright.

## Global Constraints

- Preserve the shared canonical-root mutation queue and prospective archive validation.
- Planning endpoints are read-only and return paths/actions only, never bytes, fingerprints, backups, or absolute paths.
- Use strict RED/GREEN for every production behavior change.
- Do not push.

---

### Task 1: Shared storage planning

**Files:**
- Modify: `editor/gallery-storage.ts`
- Test: `editor/gallery-storage.test.ts`

**Interfaces:**
- Produces: `planItem(item)`, `planItemWithImage(item, bytes)`, and `planTrashItem(id)` returning `GalleryChangePlan`.
- Internal builders return prepared metadata/combined/delete operations used by both plan methods and commit methods.

- [ ] **Step 1: Write failing storage tests** for title-only metadata, private/public migration, staged same-path replacement, combined candidates, and delete. Assert exact workspace-relative entries and no disk mutation.
- [ ] **Step 2: Run focused tests and verify RED** because metadata/delete planners do not exist and combined planning differs from commit branches.
- [ ] **Step 3: Add internal prepared-plan builders** that resolve the prospective item list, source/destination, staged source/manifest, exact trash candidates, and audit entries.
- [ ] **Step 4: Make commit methods execute prepared plans** from those same builders, retaining rollback and overwrite checks.
- [ ] **Step 5: Run focused storage tests and verify GREEN**, then run all gallery-storage tests.

### Task 2: Plan API and strict Fetch Metadata

**Files:**
- Modify: `editor/server.ts`
- Modify: `src/editor/api.ts`
- Test: `editor/server.test.ts`
- Test: `editor/gallery-storage.test.ts`

**Interfaces:**
- `PUT /api/editor/gallery/:id/plan` accepts JSON metadata.
- `PUT /api/editor/gallery/:id/image/plan` accepts raw image bytes plus encoded metadata.
- `DELETE /api/editor/gallery/:id/plan` plans deletion.
- `EditorApi.planGallery({ item, file?, deleting })` selects the matching endpoint.

- [ ] **Step 1: Write failing API tests** for all three intents, malformed input, and an allowed Origin paired with `Sec-Fetch-Site: cross-site`.
- [ ] **Step 2: Run focused API tests and verify RED.**
- [ ] **Step 3: Add plan routes and client methods**, mapping all storage validation errors without mutation.
- [ ] **Step 4: Reject cross-site Fetch Metadata independently of Origin acceptance.**
- [ ] **Step 5: Run focused API/security tests and verify GREEN.**

### Task 3: Persistent authoritative UI plan

**Files:**
- Modify: `src/editor/EditorApp.tsx`
- Modify: `src/editor/api.ts`
- Test: `src/editor/GalleryForm.test.tsx`
- Test: `src/editor/EditorApp.test.tsx`

**Interfaces:**
- UI state: latest `GalleryChangePlan`, loading status, error, and monotonically increasing request token.
- Save/delete is enabled only when the current operation has a matching authoritative plan.

- [ ] **Step 1: Write failing UI tests** for title-only metadata, migration, same-path replacement, delete, pending/error states, invalidation, and stale-response suppression.
- [ ] **Step 2: Run focused UI tests and verify RED** against the static guessed list.
- [ ] **Step 3: Fetch plans in an effect** keyed by validated item, selected file, and delete intent; clear stale plans immediately on edits and ignore stale completions.
- [ ] **Step 4: Render only server audit entries** with action/visibility labels and use the current plan for destructive confirmation and commit.
- [ ] **Step 5: Run focused UI tests and verify GREEN.**

### Task 4: Documentation, report, and gates

**Files:**
- Modify: `README.md`
- Modify: `.superpowers/sdd/final-editor-review-fixes-report.md`

- [ ] **Step 1: Add a README lifecycle paragraph** explaining staging, confirmation/commit cleanup, replacement trash, and non-publication of `src/content/staged-images/`.
- [ ] **Step 2: Run focused and full unit tests, `npm run validate`, `npm run build`, `npm run e2e`, dist scan, and `git diff --check`.**
- [ ] **Step 3: Append exact results and review-fix details to the final report.**
- [ ] **Step 4: Stage, inspect, and commit all fixes without pushing.**
