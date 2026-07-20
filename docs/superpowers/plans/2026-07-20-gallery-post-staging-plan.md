# Gallery POST Staging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make POST image followed by PUT metadata safe, retryable, visibility-aware, and compatible with legacy interrupted state.

**Architecture:** POST writes validated bytes to a canonical non-public staging root without changing active content. PUT consumes the exact normalized stage in a compensating transaction that preserves the old image until metadata can commit, with a canonical submitted-path fallback for pre-fix interrupted state.

**Tech Stack:** TypeScript, Node.js filesystem promises, Express, Supertest, Vitest, Vite.

**Status:** Implemented and verified on 2026-07-20; completion evidence is recorded in `.superpowers/sdd/editor-task-3-report.md`.

## Global Constraints

- Strict RED→GREEN before production changes.
- Staged and private bytes never enter `public/` or `dist/`.
- Preserve signature/size/overwrite validation and canonical non-reparse path checks.
- Preserve the combined endpoint.
- Commit locally without pushing.

---

### Task 1: Full POST→PUT API regressions

**Files:**
- Modify: `editor/gallery-storage.test.ts`
- Modify: `scripts/public-gallery.test.ts`

**Interfaces:**
- Exercises existing POST response `{ path, width, height }` and metadata PUT response `GalleryItem`.

- [ ] Add Supertest sequences for legacy public PNG→JPEG private/public outcomes and existing private PNG→JPEG private outcome; assert final YAML/path, old trash, no stale public/private bytes, and stage cleanup.
- [ ] Add an interruption assertion immediately after POST proving old active bytes/YAML remain and replacement bytes are outside public.
- [ ] Add a Vite build after POST and after PUT proving staged/private marker bytes are absent from `dist/`.
- [ ] Run `npm run test:run -- editor/gallery-storage.test.ts scripts/public-gallery.test.ts -t "POST metadata|staged POST"` and observe failures caused by missing staging semantics and current PUT ENOENT.

### Task 2: Canonical POST staging

**Files:**
- Modify: `editor/gallery-storage.ts`

**Interfaces:**
- Extend `roots()` with canonical `stagedImages` under `src/content/staged-images`.
- `registerImage()` returns the same public path but installs bytes only under staging.

- [ ] Create/check the staging directory through the same canonical non-reparse directory guard.
- [ ] Include active exact/normalized and staged normalized candidates in overwrite conflict detection without trashing active candidates during POST.
- [ ] Atomically replace only prior staged candidates after validating roots again.
- [ ] Rerun the Task 1 RED command and confirm interruption/public-absence assertions turn green while PUT sequence remains RED.

### Task 3: PUT staged commit and retry compensation

**Files:**
- Modify: `editor/gallery-storage.test.ts`
- Modify: `editor/gallery-storage.ts`

**Interfaces:**
- `writeItem()` consumes only the staged path exactly matching `item.image`.
- On failure it restores stage, old active bytes, and unchanged metadata.

- [ ] Add an injected metadata-commit failure sequence followed by successful retry, asserting stage survives the failed PUT and is removed only after success.
- [ ] Observe RED with PUT unable to consume/restore a stage.
- [ ] Implement staged commit compensation and exact submitted-path fallback in both final roots for pre-fix interrupted state.
- [ ] Run the focused storage/API sequence and existing visibility/rollback tests; require GREEN.

### Task 4: Final verification and handoff

**Files:**
- Modify: `.superpowers/sdd/editor-task-3-report.md`

- [ ] Run focused suites, full Vitest, content validation, build, Playwright, dist scan, and diff check.
- [ ] Append root cause, RED/GREEN evidence, interruption/retry guarantees, and exact counts to the Task 3 report.
- [ ] Commit with `fix: stage legacy gallery uploads`; do not push; confirm clean worktree.
