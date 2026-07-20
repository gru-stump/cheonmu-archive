# Gallery Staged Candidate Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure a confirmed POST/PUT replacement removes every owned active normalized image candidate without deleting another gallery item's files.

**Architecture:** POST records each owned active candidate it actually observed as a canonical root/path/content-fingerprint entry in a non-public stage manifest beside the staged image. PUT validates that manifest, rechecks ownership and fingerprints, moves the exact prior metadata image plus confirmed candidates to recoverable trash, installs the stage, and restores every move on failure.

**Tech Stack:** TypeScript, Node.js filesystem/crypto promises, Express, Supertest, Vitest, Vite.

**Status:** Implemented and verified on 2026-07-20; evidence is recorded in `.superpowers/sdd/editor-task-3-report.md`.

## Global Constraints

- Strict RED/GREEN before production changes.
- Candidate cleanup is limited to the current item's exact prior metadata path and normalized candidates confirmed during POST.
- Paths referenced by another metadata item are never cleanup candidates.
- Staged/private bytes and manifests never enter `public/` or `dist/`.
- Preserve the combined endpoint and commit locally without pushing.

---

### Task 1: Candidate cleanup regressions

**Files:**
- Modify: `editor/gallery-storage.test.ts`
- Modify: `scripts/public-gallery.test.ts`

**Interfaces:**
- Exercises existing `POST /api/editor/gallery/image`, `PUT /api/editor/gallery/:id`, and `createGalleryStorage()` failure injection.
- Proves public legacy/orphan candidates are removed only at successful PUT and absent from the next Vite build.

- [ ] Add an API sequence with exact legacy metadata PNG plus orphan normalized PNG, POST a JPEG with overwrite confirmation, PUT the returned path, and assert both old files are recoverably trashed while only JPEG remains.
- [ ] Add a build sequence after successful PUT and assert `dist/images/work.png` is absent.
- [ ] Add an ownership sequence where another item references `/images/work.png`; assert POST/PUT for ID `work` preserves that file and metadata.
- [ ] Add a staged PUT failure injection and assert exact old plus orphan candidate, stage, and YAML are restored before retry succeeds.
- [ ] Run the named regressions and require failures showing the orphan remains or the unrelated file is mishandled.

### Task 2: Confirmed candidate manifest

**Files:**
- Modify: `editor/gallery-storage.ts`

**Interfaces:**
- Stage manifest shape: `{ candidates: Array<{ root: 'public' | 'private'; path: string; sha256: string }> }`.
- POST writes `<id>.json` atomically beside the staged image.
- PUT accepts only canonical, still-owned candidates whose current SHA-256 matches the POST observation.

- [ ] Add canonical stage-manifest path checking, SHA-256 fingerprinting, parsing, and validation.
- [ ] Replace absolute active-candidate discovery with owned root/path descriptors while retaining exact prior-path handling.
- [ ] Atomically replace the staged image and manifest on POST; restore the previous stage on failure.
- [ ] In staged PUT, combine the exact previous path with validated confirmed candidates, move all to trash, install the stage, and roll every move back on failure.
- [ ] Remove the manifest after successful metadata commit and rerun focused tests to GREEN.

### Task 3: Verification and handoff

**Files:**
- Modify: `.superpowers/sdd/editor-task-3-report.md`

- [ ] Run focused storage/build suites, full Vitest, validation, build, Playwright, dist scan, and cached diff check.
- [ ] Append root cause, ownership/fingerprint safety, RED/GREEN evidence, and exact counts to the report.
- [ ] Commit with a focused fix message; do not push; confirm a clean worktree.
