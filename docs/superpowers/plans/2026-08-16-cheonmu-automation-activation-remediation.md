# Cheonmu Automation Activation Remediation Plan

**Goal:** Close the three production blockers that currently prevent safe manual canaries and autonomous scheduled generation.

## Global constraints

- The worker calls only the existing trusted generation pipeline; it never bypasses context, continuity, pricing, budget, or immutable attempt-token rules.
- Browser input never supplies owner IDs, provider settings, prices, secrets, job bindings, or generation attempt tokens.
- Manual generation and automatic generation are independently controllable and fail closed.
- No paid API, deployment, real secret, or external mutation is part of this plan.

## Task 1: Split manual and automatic generation policy

- Add explicit owner settings for `manual_generation_enabled` and `schedule_automation_enabled`, with a safe migration from the legacy combined flag.
- Keep the active provider selection independent from schedule automation.
- Manual owner requests require manual enabled, pricing freshness, quota and budget checks.
- Cron/access/special/weekly sources require schedule automation enabled in addition to the same pricing and budget checks.
- Update Settings UI, same-origin API, Edge/RPC contracts, tests and operating guide.

## Task 2: Lease-based generation queue worker

- Add a service-only queue claim/renew/complete/fail lifecycle with immutable attempt token and bounded lease.
- Bind each queued job to its server-derived draft, mode, kind, idempotency key, schedule source and frozen owner/provider policy.
- A frequent dispatcher claims due jobs one at a time and invokes the existing generation orchestrator through a trusted internal command.
- Lost responses, expired workers, replacement claims and retries cannot make two provider calls or double-settle budget.
- Add actual two-connection races, fake-provider integration, dead-letter/retry visibility and bounded timeouts.

## Task 3: Owner access-trigger endpoint

- Add same-origin `POST /api/narrative/access`; the browser passes only its owner bearer token.
- The server invokes the authenticated access scheduler command and returns an existing or newly queued job.
- Repeated page loads remain idempotent; minimum interval, Seoul daily count, pricing, budget and schedule-automation policy are enforced in the database.
- Public archive access does not gain owner authority; the private Admin is the initial caller unless a later anonymous-safe design is separately approved.

## Verification and review

- TDD RED/GREEN for each task and independent task review/fix loops.
- Clean reset, all pgTAP, queue/access concurrency, upgrade, gateway, fake-provider E2E, root/Admin tests/build/E2E, Deno/typechecks, security/privilege/diff scans.
- Final whole-remediation review before any live canary or production activation.

## Out of scope

- Real credentials, paid model calls, live GitHub writes, deployment, external branch changes and production schedule activation.
