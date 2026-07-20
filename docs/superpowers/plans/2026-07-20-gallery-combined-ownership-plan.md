# Gallery Combined Ownership Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent the combined gallery save endpoint from trashing normalized image candidates owned by another metadata item while retaining legitimate orphan cleanup and rollback.

**Architecture:** The combined transaction will pass current gallery metadata into its candidate resolver. The resolver always includes the current item's exact previous file, but includes normalized candidates across public/private roots only when no other item references their logical image path; the existing multi-candidate trash/restore transaction remains unchanged.

**Tech Stack:** TypeScript, Node.js filesystem promises, Express, Supertest, Vitest, Vite.

**Status:** Implemented and verified on 2026-07-20; evidence is recorded in `.superpowers/sdd/editor-task-3-report.md`.

## Global Constraints

- Strict RED/GREEN before production changes.
- Preserve another item's metadata-referenced bytes in either image root.
- Preserve cleanup of unowned normalized orphans and exact previous images.
- Preserve complete combined-transaction rollback on metadata failure.
- Verify both public images and metadata survive a real production build.
- Commit locally without pushing.

---

### Task 1: Combined endpoint regressions

**Files:**
- Modify: `editor/gallery-storage.test.ts`
- Modify: `scripts/public-gallery.test.ts`

**Interfaces:**
- Exercises `createGalleryStorage().writeItemWithImage()` and `PUT /api/editor/gallery/:id/image`.

- [ ] Add a storage success case where `other-work` references `/images/work.png` and combined JPEG save for `work` installs `/images/work.jpg` while preserving the PNG and both metadata entries.
- [ ] Add a combined API case with the same ownership relationship and binary metadata headers.
- [ ] Add an unowned normalized orphan case proving combined replacement still trashes the orphan and exact prior file.
- [ ] Add a metadata-failure case proving installed target removal and restoration/preservation of every preexisting owned file.
- [ ] Add a Vite build case proving both the owner PNG and new JPEG plus their public metadata remain in `dist`.
- [ ] Run named regressions and require RED caused by the owner PNG being removed.

### Task 2: Ownership-filtered candidate resolver

**Files:**
- Modify: `editor/gallery-storage.ts`

**Interfaces:**
- Change `replacementCandidates(locations, items, id, existingItem?)` to consult `referencedByAnotherItem()` before adding normalized paths.
- Keep exact `storedImagePath(existingItem)` ownership unconditional for the current item.

- [ ] Pass the current item array into `replacementCandidates()`.
- [ ] Skip each normalized logical path when `referencedByAnotherItem(items, id, publicPath)` is true, in both public and private roots.
- [ ] Leave the combined transaction's candidate move, metadata commit, and reverse restoration order unchanged.
- [ ] Rerun focused storage/API/build suites to GREEN.

### Task 3: Verification and handoff

**Files:**
- Modify: `.superpowers/sdd/editor-task-3-report.md`

- [ ] Run focused suites, full Vitest, validation, build, Playwright, dist scan, and cached diff check.
- [ ] Append root cause, RED/GREEN evidence, ownership/orphan/rollback guarantees, and exact counts to the report.
- [ ] Commit the focused fix; do not push; confirm a clean worktree.
