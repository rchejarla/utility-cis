# Job Scheduler Migration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the three existing `setInterval` schedulers out of the API process into a BullMQ-backed worker, add tenant-configurable automation, and add the deferred SLA breach sweep. Each step ships independently behind a per-job `USE_LEGACY_SCHEDULERS_<NAME>` flag so we can roll back without data loss.

**Spec:** `docs/superpowers/specs/2026-04-24-job-scheduler-migration-design.md` — read it first, the pattern split (#1 single-query vs #2 dispatcher-fanout) is load-bearing.

**Tech Stack:** Additions are `bullmq@^5`, `ioredis@^5` (transitive), `@bull-board/fastify@^5` (dev-only). No new Prisma dependency — the config surface is additive columns on `TenantConfig`.

---

## File Structure

### Created

| Path | Responsibility |
|---|---|
| `packages/api/src/lib/redis.ts` | Shared ioredis connection for BullMQ. |
| `packages/api/src/lib/queues.ts` | Queue names + `Queue` instances (exported, imported by both API and worker). |
| `packages/api/src/worker.ts` | Worker process entry — registers cron jobs, instantiates `Worker` consumers, handles SIGTERM. |
| `packages/api/src/workers/suspension-worker.ts` | BullMQ worker for `suspension-transitions`. |
| `packages/api/src/workers/notification-worker.ts` | BullMQ worker for `notification-send` (with quiet-hours join). |
| `packages/api/src/workers/sla-breach-worker.ts` | BullMQ worker for `sla-breach-sweep` (new job). |
| `packages/api/src/workers/delinquency-dispatcher.ts` | Hourly cron that enqueues per-tenant delinquency jobs. |
| `packages/api/src/workers/delinquency-worker.ts` | Per-tenant consumer of `delinquency-tenant` queue. |
| `packages/api/src/services/automation-config.service.ts` | `getAutomationConfig(utilityId)`, `isSchedulerEnabled`, `isInQuietHours`, `localHour` helpers. |
| `packages/api/src/routes/automation-config.ts` | `GET /api/v1/settings/automation`, `PATCH /api/v1/settings/automation`. |
| `packages/api/src/__tests__/services/automation-config.service.test.ts` | Unit tests for config helpers (timezone math, quiet-hours edge cases). |
| `packages/api/src/__tests__/services/sla-breach-sweep.service.test.ts` | Unit tests for sweep (flipping, enabled-flag respect, terminal-status skip). |
| `packages/shared/src/validators/automation-config.ts` | Zod + types for the automation config surface. |
| `packages/web/app/settings/automation/page.tsx` | Settings UI — timezone, scheduler toggles, quiet hours, daily run hour. |
| `docs/superpowers/specs/2026-04-24-job-scheduler-migration-design.md` | Design spec (already written). |
| `docs/superpowers/plans/2026-04-24-job-scheduler-migration.md` | This file. |

### Modified

| Path | Change |
|---|---|
| `packages/shared/prisma/schema.prisma` | Add 5 columns to `TenantConfig`: `timezone`, `schedulersEnabled`, `delinquencyRunHourLocal`, `notificationQuietStart`, `notificationQuietEnd`. |
| `packages/shared/prisma/migrations/<TS>_tenant_automation_config/migration.sql` | Prisma-generated migration for the 5 columns with defaults. |
| `packages/api/src/app.ts` | Gate existing `startSuspensionScheduler`/`startNotificationSendJob`/`startDelinquencyScheduler` behind per-job `USE_LEGACY_SCHEDULERS_*` env flags. Final step removes the block entirely. |
| `packages/api/src/services/service-suspension.service.ts` | Add `sweepSuspensionsAllTenants(now)` single-query function (pattern #1). Keep existing `transitionSuspensions(utilityId, now)` for the legacy path until final step. |
| `packages/api/src/services/notification.service.ts` | Add `processPendingNotificationsWithQuietHours(now)` with tenant_config join. Keep existing drain function for legacy path. |
| `packages/api/src/services/delinquency.service.ts` | Extract per-tenant evaluation into a pure `evaluateDelinquencyForTenant(utilityId, now)` function the worker can call. |
| `packages/api/src/services/service-request.service.ts` | Add `sweepBreachedSRs(now)` single-query (flip `slaBreached` where `sla_due_at < now`). |
| `packages/api/src/services/tenant-config.service.ts` | Extend `getTenantConfig` to include new automation fields; ensure defaults kick in for rows missing them. |
| `packages/web/components/sidebar.tsx` | Add "Automation" entry to Settings submenu. |
| `packages/web/app/settings/page.tsx` | Add Automation tile to settings landing if it renders a grid. |
| `package.json` (root) | Add `dev:worker` and `start:worker` turbo pipelines. |
| `packages/api/package.json` | Add `bullmq`, `ioredis`, `@bull-board/fastify` deps + `dev:worker` / `start:worker` scripts. |
| `docs/specs/18-theme-and-configuration.md` | Document the new `/settings/automation` page under tenant configuration. |

---

## Task 1: Redis connection + queue module + worker scaffold

**Goal:** Land the worker process with no jobs wired. Proves the deployment topology before any business logic moves.

**Files:**
- Create: `packages/api/src/lib/redis.ts`
- Create: `packages/api/src/lib/queues.ts`
- Create: `packages/api/src/worker.ts`
- Modify: `packages/api/package.json`
- Modify: `package.json` (root, turbo pipelines)

- [ ] **Step 1.1:** Add `bullmq`, `ioredis`, `@bull-board/fastify` to `packages/api/package.json`. Add `"dev:worker": "tsx watch src/worker.ts"` and `"start:worker": "node dist/worker.js"` scripts. Run `pnpm install`.

- [ ] **Step 1.2:** Create `lib/redis.ts` exporting `redisConnection` with `maxRetriesPerRequest: null` and `REDIS_URL` env var (default `redis://localhost:6379`).

- [ ] **Step 1.3:** Create `lib/queues.ts` with `QUEUE_NAMES` const (`suspensionTransitions`, `notificationSend`, `slaBreachSweep`, `delinquencyDispatch`, `delinquencyTenant`) and factory `getQueue(name)` that memoizes `Queue` instances.

- [ ] **Step 1.4:** Create `worker.ts` — imports `redisConnection`, logs "worker started", registers SIGTERM handler that closes all workers and the connection. No actual workers yet. Exit if `DISABLE_SCHEDULERS=true`.

- [ ] **Step 1.5:** Run `pnpm --filter api build` and `pnpm --filter api start:worker` manually — verify the process starts, logs startup, and shuts down cleanly on Ctrl+C.

- [ ] **Verification:** `pnpm --filter api exec tsc --noEmit` clean; `pnpm --filter api dev:worker` starts without error; SIGTERM exits within 2s.

---

## Task 2: Migrate suspension scheduler to BullMQ (pattern #1)

**Goal:** First job conversion. Prove the single-query pattern end-to-end with the smallest existing job.

**Files:**
- Create: `packages/api/src/workers/suspension-worker.ts`
- Modify: `packages/api/src/services/service-suspension.service.ts`
- Modify: `packages/api/src/worker.ts`
- Modify: `packages/api/src/app.ts`

- [ ] **Step 2.1:** In `service-suspension.service.ts`, add `sweepSuspensionsAllTenants(now: Date)` — two `updateMany` calls, each filtering by a join against `tenant_config` for `suspensionEnabled` (keyed under `schedulersEnabled.suspension`). Use Prisma's raw query for the JSON key check: `tc."schedulers_enabled" ->> 'suspension' != 'false'` (null and missing both count as enabled).

- [ ] **Step 2.2:** Write a unit test that seeds two tenants (one with `schedulersEnabled.suspension=false`, one default), a PENDING suspension in each past-start-date, and asserts only the enabled tenant's row flips.

- [ ] **Step 2.3:** Create `workers/suspension-worker.ts` — a BullMQ `Worker` on `suspensionTransitions` queue, handler calls `sweepSuspensionsAllTenants(new Date())`, logs `{ activated, completed }` when nonzero.

- [ ] **Step 2.4:** In `worker.ts`, register the suspension queue's repeatable job: `queue.add("run-sweep", {}, { repeat: { pattern: "0 * * * *" }, jobId: "suspension-cron" })`. The `jobId` makes the repeatable config idempotent — re-running `worker.ts` doesn't add duplicate cron rows.

- [ ] **Step 2.5:** In `app.ts`, gate the existing `startSuspensionScheduler(app.log)` behind `process.env.USE_LEGACY_SCHEDULERS_SUSPENSION === "true"`. Default: disabled.

- [ ] **Verification:** Integration test with `DISABLE_SCHEDULERS=true` still passes; manual run of `dev:worker` shows the hourly cron firing (use `*/1 * * * *` for one-off verification then revert to hourly); legacy env-flag path still works (confirmed once manually).

---

## Task 3: TenantConfig schema + defaults

**Goal:** Add the automation columns. Backfill defaults for existing tenants.

**Files:**
- Modify: `packages/shared/prisma/schema.prisma`
- Create: `packages/shared/prisma/migrations/<TS>_tenant_automation_config/migration.sql`
- Modify: `packages/api/src/services/tenant-config.service.ts`

- [ ] **Step 3.1:** Add 5 columns to `TenantConfig` model (see spec §3.4 for exact types and defaults).

- [ ] **Step 3.2:** Run `pnpm --filter shared prisma migrate dev --name tenant_automation_config`. Inspect the generated SQL — verify defaults are `DEFAULT 'UTC'`, `DEFAULT '{}'::jsonb`, `DEFAULT 3`, `DEFAULT '22:00'`, `DEFAULT '07:00'`.

- [ ] **Step 3.3:** In `tenant-config.service.ts`, update `getTenantConfig` to return the new fields. Ensure `schedulersEnabled` defaults to `{}` when null and that callers treat missing keys as enabled.

- [ ] **Step 3.4:** Run `pnpm --filter shared build` so generated Prisma types reach the API package.

- [ ] **Verification:** `pnpm --filter api exec tsc --noEmit` clean; `SELECT column_name FROM information_schema.columns WHERE table_name = 'tenant_config'` includes the 5 new columns.

---

## Task 4: Automation config helpers + routes

**Files:**
- Create: `packages/shared/src/validators/automation-config.ts`
- Create: `packages/api/src/services/automation-config.service.ts`
- Create: `packages/api/src/routes/automation-config.ts`
- Create: `packages/api/src/__tests__/services/automation-config.service.test.ts`
- Modify: `packages/shared/src/validators/index.ts`
- Modify: `packages/api/src/app.ts`

- [ ] **Step 4.1:** In `validators/automation-config.ts`, define `AutomationConfigDTO` and `AutomationConfigPatch` Zod schemas. `timezone` validates as non-empty IANA (a cheap `/^[A-Za-z_]+\/[A-Za-z_/]+$|^UTC$/` regex is enough; full IANA validation is overkill). `HH:mm` via regex.

- [ ] **Step 4.2:** In `automation-config.service.ts`, implement:
    - `getAutomationConfig(utilityId)` — returns the 5 fields.
    - `patchAutomationConfig(utilityId, patch, userId)` — updates, emits audit event.
    - `isSchedulerEnabled(cfg, name)` — reads `schedulersEnabled[name]`, defaults `true`.
    - `localHour(utcNow, timezone)` — uses `Intl.DateTimeFormat` with `timeZone` option, returns `0-23`.
    - `isInQuietHours(utcNow, cfg)` — handles wrap-around ("22:00" to "07:00").

- [ ] **Step 4.3:** Unit-test every edge case: DST boundary days, wrap-around quiet hours, missing scheduler key in JSON, `UTC` timezone (no offset).

- [ ] **Step 4.4:** In `routes/automation-config.ts`, register `GET /api/v1/settings/automation` (requires `tenant_profile:VIEW`) and `PATCH` (requires `tenant_profile:EDIT`). Use `withTenant(utilityId, ...)` so RLS applies.

- [ ] **Step 4.5:** Register the route module in `app.ts`.

- [ ] **Verification:** Integration test of GET/PATCH round-trip; helper unit tests green.

---

## Task 5: `/settings/automation` UI

**Files:**
- Create: `packages/web/app/settings/automation/page.tsx`
- Modify: `packages/web/components/sidebar.tsx`
- Modify: `packages/web/app/settings/page.tsx` (if it renders a grid — add a tile)

- [ ] **Step 5.1:** Build the settings page using the existing Indigo Wash tokens and shared form primitives. Sections: General (timezone select), Schedulers (4 toggle switches with per-scheduler one-liner "runs hourly" / "every 10 seconds" / etc.), Quiet Hours (two `<input type="time">`), Daily Runs (integer input with min/max).

- [ ] **Step 5.2:** Wire save via `apiClient.patch("/api/v1/settings/automation", ...)`. Use existing toast pattern for success/error.

- [ ] **Step 5.3:** Reuse `PageDescription` with a one-liner: "Control when and whether background automation runs for your utility."

- [ ] **Step 5.4:** Add sidebar entry under Settings: "Automation".

- [ ] **Verification:** Manual — save, reload, values persist. `pnpm --filter web exec tsc --noEmit` clean.

---

## Task 6: Migrate notification-send with quiet-hours

**Files:**
- Create: `packages/api/src/workers/notification-worker.ts`
- Modify: `packages/api/src/services/notification.service.ts`
- Modify: `packages/api/src/worker.ts`
- Modify: `packages/api/src/app.ts`

- [ ] **Step 6.1:** Add `processPendingNotificationsWithQuietHours(now)` in `notification.service.ts`. The WHERE joins `tenant_config` and excludes rows where the tenant's current local time falls inside `[notificationQuietStart, notificationQuietEnd]`. SMS-only quiet hours; email is always eligible. Test: a notification queued during quiet hours stays pending until the window ends.

- [ ] **Step 6.2:** Create `workers/notification-worker.ts` — 10-second BullMQ cron. Handler calls the new function. Maintains the `sendJobRunning` skip-if-in-flight behavior via BullMQ's built-in concurrency=1.

- [ ] **Step 6.3:** Register in `worker.ts` with `{ repeat: { pattern: "*/10 * * * * *" }, jobId: "notification-send-cron" }`.

- [ ] **Step 6.4:** Gate legacy `startNotificationSendJob` behind `USE_LEGACY_SCHEDULERS_NOTIFICATION`.

- [ ] **Verification:** Seed a tenant with quiet hours `"00:00"`-`"23:59"` (effectively always quiet), queue an SMS, run a tick, assert it stays `PENDING`. Reset quiet hours, tick again, assert it sends.

---

## Task 7: Migrate delinquency with dispatcher + per-tenant fan-out (pattern #2)

**Files:**
- Create: `packages/api/src/workers/delinquency-dispatcher.ts`
- Create: `packages/api/src/workers/delinquency-worker.ts`
- Modify: `packages/api/src/services/delinquency.service.ts`
- Modify: `packages/api/src/worker.ts`
- Modify: `packages/api/src/app.ts`

- [ ] **Step 7.1:** In `delinquency.service.ts`, extract the per-tenant loop body from `evaluateAll(utilityId)` into a `evaluateDelinquencyForTenant(utilityId, now)` function — should already be close to this shape. The existing `startDelinquencyScheduler` stays gated behind a legacy flag.

- [ ] **Step 7.2:** Create `workers/delinquency-dispatcher.ts` — hourly cron. Reads `tenant_config` where `delinquencyEnabled=true`, filters for tenants whose `localHour(now, timezone) === delinquencyRunHourLocal`, enqueues one `evaluate` job per tenant with `jobId: \`delinquency:${utilityId}:${ymdh(now)}\`` for idempotency.

- [ ] **Step 7.3:** Create `workers/delinquency-worker.ts` — BullMQ `Worker` on `delinquency-tenant` with concurrency 5. Handler calls `evaluateDelinquencyForTenant(job.data.utilityId, new Date())`.

- [ ] **Step 7.4:** Register both in `worker.ts`: dispatcher cron `{ pattern: "0 * * * *", jobId: "delinquency-dispatch-cron" }` + the consumer.

- [ ] **Step 7.5:** Gate legacy `startDelinquencyScheduler` behind `USE_LEGACY_SCHEDULERS_DELINQUENCY`.

- [ ] **Verification:** Unit test for `evaluateDelinquencyForTenant` (already covered by existing delinquency tests — rename imports, confirm they still pass). Manual: set a tenant's `delinquencyRunHourLocal` to the current local hour, run the dispatcher once, see a per-tenant job flow through the worker.

---

## Task 8: Add SLA breach sweep (new job)

**Files:**
- Create: `packages/api/src/workers/sla-breach-worker.ts`
- Create: `packages/api/src/__tests__/services/sla-breach-sweep.service.test.ts`
- Modify: `packages/api/src/services/service-request.service.ts`
- Modify: `packages/api/src/worker.ts`

- [ ] **Step 8.1:** Add `sweepBreachedSRs(now: Date)` in `service-request.service.ts`. Single `updateMany` filtering by the tenant_config join, open statuses, `sla_due_at < now`, `sla_breached = false`. Emit one audit event per flipped row (the existing `auditUpdate` helper — wrap the `updateMany` or loop the affected ids, whichever is cleaner in the existing patterns).

- [ ] **Step 8.2:** Decision point: do we need per-row audit events, or is a single "sweep run" audit sufficient? The SR detail timeline already reads from the audit log, so per-row is the correct choice for user visibility. Implement per-row.

- [ ] **Step 8.3:** Unit test: seeds one open SR past due, one in terminal status past due (COMPLETED), one open not-yet-due; asserts only the first flips.

- [ ] **Step 8.4:** Create `workers/sla-breach-worker.ts` on the `slaBreachSweep` queue, every 5 minutes. Log `{ flipped }` when nonzero.

- [ ] **Step 8.5:** Register in `worker.ts` with `{ pattern: "*/5 * * * *", jobId: "sla-breach-cron" }`.

- [ ] **Verification:** Integration: create an SR with `sla_due_at` in the past, wait one tick, reload — queue filter now counts it as breached; detail page timeline shows the new audit entry.

---

## Task 9: Remove legacy paths

**Goal:** After a soak period, delete the `setInterval` schedulers and the `USE_LEGACY_*` env flags. This is the "done" step — only run after the worker has been stable in prod for at least one billing cycle.

**Files:**
- Modify: `packages/api/src/app.ts` — remove the schedulers block entirely.
- Delete: `packages/api/src/schedulers/suspension-scheduler.ts`
- Modify: `packages/api/src/services/delinquency.service.ts` — remove `startDelinquencyScheduler`, keep `evaluateDelinquencyForTenant`.
- Modify: `packages/api/src/services/notification.service.ts` — remove `startNotificationSendJob`, keep `processPendingNotificationsWithQuietHours`.
- Remove mentions from any docs.

- [ ] **Step 9.1:** Delete legacy functions and gates.
- [ ] **Step 9.2:** Grep for `USE_LEGACY_SCHEDULERS` — remove every hit.
- [ ] **Step 9.3:** Update `docs/specs/18-theme-and-configuration.md` to reflect the final state.

- [ ] **Verification:** `pnpm --filter api test` green; deployment runbook updated.

---

## Task 10: Documentation

**Files:**
- Modify: `docs/specs/18-theme-and-configuration.md` — new Automation section with field docs and UI screenshot path.
- Modify: `docs/design/utility-cis-architecture.md` — add "Background jobs" subsection pointing at the worker process and the queue map.
- Modify: `README.md` (root) — two-line deployment note: API + worker are separate processes.

- [ ] **Step 10.1:** Write the Automation settings doc.
- [ ] **Step 10.2:** Add the architecture subsection.
- [ ] **Step 10.3:** Update README deployment section.

- [ ] **Verification:** Docs land in the same PR as Task 9 so they reflect final state, not intermediate.

---

## Sequencing notes

- Tasks 1 → 2 are the foundation; don't start 3 until 2 is proven end-to-end in dev.
- Tasks 3 → 4 → 5 form the tenant-config stack — ship them together as one commit series; UI without routes is useless and routes without UI is a support burden.
- Tasks 6, 7, 8 are independent of each other. Can parallelize between subagents once Task 5 is merged.
- Task 9 waits on production soak; don't include it in the initial PR series.
- Task 10 bundles with Task 9.

## Testing discipline

- Unit tests for all service functions (sweep, evaluate, helpers).
- No tests for BullMQ glue — trust the library.
- Integration tests run with `DISABLE_SCHEDULERS=true` so ticks don't race assertions.
- Manual verification of dev:worker per task is required; screenshot Bull Board (or log output) in the PR description.
