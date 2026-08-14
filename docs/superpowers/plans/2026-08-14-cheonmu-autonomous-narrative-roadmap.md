# Cheonmu Autonomous Narrative Roadmap

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the approved autonomous narrative system as four independently testable increments.

**Architecture:** Keep the existing GitHub Pages archive unchanged until the publishing increment. Add a separate Vercel-hosted React administrator, Supabase database/auth/cron/functions, and provider-neutral shared contracts.

**Tech Stack:** React 19, TypeScript, Vite, Supabase Auth/Postgres/Cron/Edge Functions, Vitest, Playwright, GitHub REST API, GitHub Actions

**Spec:** `docs/superpowers/specs/2026-08-14-cheonmu-autonomous-narrative-design.md`

## Global Constraints

- Only one of OpenAI or Anthropic may be active at a time; there is no automatic provider failover.
- Every model call must reserve budget atomically before network I/O.
- Every generated artifact remains private until an explicit owner decision.
- Only approved public artifacts may enter `src/content/` and the GitHub Pages pipeline.
- Existing canon priority, relationship stage, voice, title, and reveal-gate rules remain authoritative.
- Store timestamps in UTC and display them in `Asia/Seoul`.
- Keep all provider, Supabase service-role, and GitHub write credentials server-side.

## Ordered plans

1. `2026-08-14-cheonmu-narrative-foundation.md` — contracts, database, owner auth, atomic budget ledger.
2. `2026-08-14-cheonmu-narrative-generation.md` — canon snapshots, memory selection, provider adapters, generation and schedules.
3. `2026-08-14-cheonmu-narrative-admin.md` — responsive authenticated administrator and review workflow.
4. `2026-08-14-cheonmu-narrative-publishing.md` — Markdown publication, GitHub commit, deployment tracking and release verification.

Each plan must pass its own verification before the next begins. Plans 2–4 consume the stable interfaces produced by plan 1; plan 4 also consumes approved draft versions produced by plans 2–3.

