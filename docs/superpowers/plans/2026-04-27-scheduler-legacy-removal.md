# Scheduler Legacy Removal — Implementation Plan (Task 11)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use `- [ ]` checkboxes.

**Goal:** Remove the three `setInterval`-based legacy schedulers and their `USE_LEGACY_SCHEDULERS_*` config flags now that the BullMQ worker process has been running on the new path. Pure deletion — no new behavior; no new abstractions; no replacement code. Closes out [the scheduler migration plan](./2026-04-24-job-scheduler-migration.md) Task 11 line item.

**Spec:** [`docs/superpowers/specs/2026-04-24-job-scheduler-migration-design.md`](../specs/2026-04-24-job-scheduler-migration-design.md) — read §3.1 (architecture intent: worker process owns all schedulers) and §6 (legacy code marked for removal post-soak).

**Status of dependencies (audit 2026-04-27):** Ship 1's Tasks 0-9 are merged. The new worker path is live. The three `USE_LEGACY_SCHEDULERS_*` flags currently default to false; legacy code only runs when explicitly opted in. Pre-production codebase — no soak window applies; tests are the safety net.

**Why this is a separate plan from Ship 1:** the original plan deferred legacy removal until "after a production soak period." That gate doesn't apply pre-production. The flags are dead weight (and a footgun — flipping `USE_LEGACY_SCHEDULERS_DELINQUENCY=true` would silently double-fire jobs alongside the worker). Removing them is hygiene.

---

## File Structure

### Deleted

| Path | Reason |
|---|---|
| `packages/api/src/schedulers/suspension-scheduler.ts` | Replaced by `workers/suspension-worker.ts`. |
| `packages/api/src/schedulers/` (the directory itself) | Empty after the file above is removed. |

### Modified

| Path | Change |
|---|---|
| `packages/api/src/app.ts` | Remove the three legacy imports (lines 39-41) and the three `if (config.USE_LEGACY_SCHEDULERS_*) { ... }` gating blocks (lines 137-154). Drop the warn-level "LEGACY scheduler active" log lines that were inside those blocks. |
| `packages/api/src/config.ts` | Remove the three `USE_LEGACY_SCHEDULERS_*` Zod fields (lines 53-55). Remove the matching `truthyString` parsing if no other field uses it; otherwise leave the helper. |
| `packages/api/src/services/service-suspension.service.ts` | Remove `transitionSuspensions` and `listTenantsWithActiveHolds` exports (these are *only* called by the legacy scheduler; once the scheduler is gone they're dead code). The new `sweepSuspensionsAllTenants` stays. |
| `packages/api/src/services/notification.service.ts` | Remove `startNotificationSendJob` (line 511) and its private helper `processPendingNotifications` (line 467) and the file-scope `sendJobRunning` flag (line 509). The new `processPendingNotificationsWithQuietHours` (line 361) stays. |
| `packages/api/src/services/delinquency.service.ts` | Remove `startDelinquencyScheduler` (line 244). The new `evaluateDelinquencyForTenant` (line 134) stays. `evaluateAll` (line 11) stays — it's still called by `evaluateDelinquencyForTenant`. |
| `packages/api/src/__tests__/services/service-suspension.service.test.ts` | Remove the `describe("transitionSuspensions", ...)` block and any `listTenantsWithActiveHolds` references. Keep tests against `sweepSuspensionsAllTenants`. |
| `packages/api/src/__tests__/services/notification.service.test.ts` (if any tests reference `startNotificationSendJob` or the private `processPendingNotifications`) | Remove those tests. |
| `packages/api/src/__tests__/services/delinquency.service.test.ts` (if any tests reference `startDelinquencyScheduler`) | Remove those tests. |
| `docs/specs/13-notifications.md` | Update the "Background processing" section: drop reference to the in-process `setInterval` job; cite the worker process instead. |
| `docs/specs/11-delinquency.md` | Same. |
| `docs/specs/05-service-agreement.md` (the suspension scheduler is documented under service-agreement, not its own spec) | Same. |
| `docs/superpowers/plans/2026-04-24-job-scheduler-migration.md` | Tick Task 11 in §Cross-cutting verification (post-soak removal complete). Update §Known Drift item #6 to note Task 11 is now closed. |

---

## Task 1: Remove legacy suspension scheduler

**Goal:** Delete `packages/api/src/schedulers/suspension-scheduler.ts`, the `USE_LEGACY_SCHEDULERS_SUSPENSION` flag, and the dead service exports it pulled. The worker path takes over.

**Files:**
- Delete: `packages/api/src/schedulers/suspension-scheduler.ts`
- Modify: `packages/api/src/app.ts`, `packages/api/src/config.ts`, `packages/api/src/services/service-suspension.service.ts`, `packages/api/src/__tests__/services/service-suspension.service.test.ts`

**Steps:**
- [ ] **1.1** Delete `packages/api/src/schedulers/suspension-scheduler.ts`.
- [ ] **1.2** In `app.ts`: remove the import on line 39 (`import { startSuspensionScheduler } from "./schedulers/suspension-scheduler.js";`) and the `if (config.USE_LEGACY_SCHEDULERS_SUSPENSION) { startSuspensionScheduler(app.log); ... }` block around line 137-141.
- [ ] **1.3** In `config.ts`: remove `USE_LEGACY_SCHEDULERS_SUSPENSION: truthyString,` from the Zod schema (line 53).
- [ ] **1.4** In `service-suspension.service.ts`: remove the `transitionSuspensions` (line 360) and `listTenantsWithActiveHolds` (line 405) exports. These were only called by the deleted scheduler. Verify with grep that no other production code path imports them.
- [ ] **1.5** In `__tests__/services/service-suspension.service.test.ts`: delete the imports on line 31 and the `describe("transitionSuspensions", ...)` block (line 265 onward — the inner test cases starting line 278). Tests covering `sweepSuspensionsAllTenants` stay.
- [ ] **1.6** Run `pnpm --filter @utility-cis/api exec tsc --noEmit`. Should be clean. If any other file referenced the deleted exports, that's a sign the audit missed a caller — investigate before proceeding.
- [ ] **1.7** Run `pnpm --filter @utility-cis/api test -- service-suspension`. Verify tests pass.

**Verification:** Suspension worker continues to run from the BullMQ queue with no behavior change. Manually start the worker process and confirm `suspension-cron` job fires on schedule. Suspension service tests pass.

---

## Task 2: Remove legacy notification-send job

**Goal:** Delete `startNotificationSendJob`, the private `processPendingNotifications` helper, and the `USE_LEGACY_SCHEDULERS_NOTIFICATION` flag. The worker path takes over.

**Files:**
- Modify: `packages/api/src/app.ts`, `packages/api/src/config.ts`, `packages/api/src/services/notification.service.ts`, any test files referencing the deleted functions.

**Steps:**
- [ ] **2.1** In `app.ts`: remove the import on line 40 and the gating block around lines 143-148.
- [ ] **2.2** In `config.ts`: remove `USE_LEGACY_SCHEDULERS_NOTIFICATION: truthyString,` (line 54).
- [ ] **2.3** In `notification.service.ts`: remove `startNotificationSendJob` (line 511 to end of function), the file-scope `sendJobRunning` boolean (line 509), and the private `processPendingNotifications` (line 467). The new `processPendingNotificationsWithQuietHours` (line 361) stays — it's the worker's entry point.
- [ ] **2.4** Search for any test referring to `processPendingNotifications` (the legacy version, no `WithQuietHours` suffix). Verify with `grep -n "processPendingNotifications\b" packages/api/src/__tests__/`. Remove or update.
- [ ] **2.5** `pnpm --filter @utility-cis/api exec tsc --noEmit`. Clean.
- [ ] **2.6** `pnpm --filter @utility-cis/api test -- notification`. Pass.

**Verification:** Worker's `notification-send` queue continues firing every 10 seconds (per `NOTIFICATION_SCHEDULER_ID = "notification-send-cron"`). Verify a pending notification gets sent through the worker path.

---

## Task 3: Remove legacy delinquency scheduler

**Goal:** Delete `startDelinquencyScheduler` and the `USE_LEGACY_SCHEDULERS_DELINQUENCY` flag. The worker path takes over via `evaluateDelinquencyForTenant`.

**Files:**
- Modify: `packages/api/src/app.ts`, `packages/api/src/config.ts`, `packages/api/src/services/delinquency.service.ts`, test files.

**Steps:**
- [ ] **3.1** In `app.ts`: remove the import on line 41 and the gating block around lines 149-154.
- [ ] **3.2** In `config.ts`: remove `USE_LEGACY_SCHEDULERS_DELINQUENCY: truthyString,` (line 55).
- [ ] **3.3** In `delinquency.service.ts`: remove `startDelinquencyScheduler` (line 244 to end). Keep `evaluateAll` (line 11) — it's called by `evaluateDelinquencyForTenant` (line 134). Keep `evaluateDelinquencyForTenant`, `resolveAccount`, `escalateAccount`.
- [ ] **3.4** Search tests for `startDelinquencyScheduler` references. Remove if any.
- [ ] **3.5** Type-check + run delinquency tests.

**Verification:** `delinquency-dispatch-cron` continues to fire on the worker; per-tenant fan-out via `delinquencyTenant` queue continues to consume.

---

## Task 4: Final cleanup

**Goal:** Remove the now-empty `schedulers/` directory, drop the `truthyString` helper if it's no longer used, update spec docs.

**Files:**
- Delete: `packages/api/src/schedulers/` (the directory itself if empty)
- Modify: `packages/api/src/config.ts` (truthyString helper if unused), spec docs.

**Steps:**
- [ ] **4.1** `ls packages/api/src/schedulers/`. If empty, delete the directory.
- [ ] **4.2** In `config.ts`: check if `truthyString` is still referenced by any other Zod field. If not, delete the helper. If yes (e.g., `BULL_BOARD_ENABLED` or `DISABLE_SCHEDULERS` use it), leave it.
- [ ] **4.3** Update `docs/specs/13-notifications.md` "Background processing" section — drop any reference to the in-process `setInterval` job; cite the worker process and the BullMQ queue (`notification-send`).
- [ ] **4.4** Same for `docs/specs/11-delinquency.md` and `docs/specs/05-service-agreement.md` (suspension scheduler is documented under service-agreement).
- [ ] **4.5** In `docs/superpowers/plans/2026-04-24-job-scheduler-migration.md`: at the bottom of §Cross-cutting verification, add a checked item *"Task 11 (legacy code removal) — completed YYYY-MM-DD per `2026-04-27-scheduler-legacy-removal.md`"*. Update §Known Drift item #6 to note Task 11 is now closed.

**Verification:** Repository grep returns zero matches for `USE_LEGACY_SCHEDULERS_`, `startSuspensionScheduler`, `startNotificationSendJob`, `startDelinquencyScheduler`, `transitionSuspensions`, `listTenantsWithActiveHolds`, `processPendingNotifications` (without the `WithQuietHours` suffix). The `packages/api/src/schedulers/` directory does not exist.

---

## Task 5: End-to-end verification

**Goal:** Confirm the deletions didn't break anything subtle.

**Steps:**
- [ ] **5.1** `pnpm --filter @utility-cis/api exec tsc --noEmit` — clean.
- [ ] **5.2** `pnpm --filter @utility-cis/api test` — full unit test suite passes.
- [ ] **5.3** `pnpm --filter @utility-cis/api test:integration` — testcontainers integration tests for the five worker queues pass.
- [ ] **5.4** Manual smoke test: start API process. Start worker process. Verify `/health/ready` on both responds 200. Verify `/metrics` on the worker shows `job_duration_seconds` samples for each scheduler ID after one tick.
- [ ] **5.5** Manual smoke test: trigger a single suspension transition (insert a row with `startDate = now() - interval '1 minute'` directly in DB on a tenant with `suspensionEnabled = true`); wait one cron tick; verify the row flips to ACTIVE and an audit row is emitted with `source = 'scheduler:suspension-transitions'`.
- [ ] **5.6** Final commit message uses `chore(worker): scheduler migration Task 11 — legacy code removal` to match the prior task-numbered commit pattern.

**Verification:** All schedulers run from the worker process only. No legacy code remains. Repository is smaller by ~200 lines + 1 file + the `schedulers/` directory. CI green.

---

## Notes for the executing agent

1. **This is pure deletion work.** No new abstractions, no rewrites, no clever consolidation. Per CLAUDE.md guidance on architectural discipline — if you find yourself wanting to refactor something else "while you're in there," stop and ship the deletion first.
2. **The dead exports in `service-suspension.service.ts` (Task 1.4) are tricky.** A quick grep tells you nothing imports them in production code, but if you find tests importing them, the right move is to remove the tests rather than reanimate the dead code. Tests existed to validate the legacy scheduler's behavior; that scheduler is gone.
3. **Don't touch `evaluateAll` in `delinquency.service.ts`.** It looks like dead code if you only follow the legacy-scheduler call chain, but `evaluateDelinquencyForTenant` (the worker's entry point) still calls it. Reading line 138 carefully prevents this mistake.
4. **The `truthyString` helper might still be in use.** Don't reflexively delete it in Task 4.2 — `BULL_BOARD_ENABLED` and `DISABLE_SCHEDULERS` may still be using it. Grep before deleting.
5. **Spec doc updates (Task 4.3-4.4) matter.** The on-call runbook references "the in-process notification scheduler" — that's wrong post-removal. Get the docs current.
6. **Single-engineer effort is ~half a day.** With subagent-driven development each task is small enough to dispatch as one subagent invocation. Sequential, not parallelizable — Task 2 depends on Task 1 only loosely (different files), but the pattern is identical so doing them serially doesn't lose anything.
