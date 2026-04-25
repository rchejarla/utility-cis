# Job Scheduler Migration — Implementation Plan (Ship 1)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use `- [ ]` checkboxes.

**Goal:** Move all three existing `setInterval` schedulers into a BullMQ-backed worker process, add tenant-configurable automation with audit retention, add the deferred SLA breach sweep, and ship production-grade (retries + DLQ, atomic transactions, IANA timezone validation, explicit idempotency, priorities, missed-tick recovery, health checks, Prometheus metrics + OTel spans, testcontainers integration tests).

**Spec:** `docs/superpowers/specs/2026-04-24-job-scheduler-migration-design.md` — read first. The pattern split (#1 single-query-in-transaction vs #2 dispatcher-fanout) and the retention policy are load-bearing.

**Ship 1 covers tasks 1-8** (functional migration + telemetry hooks + retention). **Ship 2 (deferred):** OTel collector integration, HA Redis, Grafana dashboards, load/chaos testing. **Tasks 9-10** (legacy removal + docs) ship after a production soak period.

**Tech stack additions:** `bullmq@^5`, `ioredis@^5`, `@bull-board/fastify@^5`, `prom-client@^15`, `@opentelemetry/api@^1`, `@vvo/tzdb@^6`, `testcontainers@^10`. Base image pinned to `node:22-bookworm-slim`.

---

## File Structure

### Created

| Path | Responsibility |
|---|---|
| `packages/api/src/config.ts` | Zod-validated env-var loader, imported at process start by both `index.ts` and `worker.ts`. |
| `packages/api/src/lib/redis.ts` | Shared `redisConnection` with production ioredis settings (`maxRetriesPerRequest: null`, `enableOfflineQueue: false`). |
| `packages/api/src/lib/queues.ts` | Queue names (`QUEUE_NAMES` const), per-queue retry/backoff/priority defaults, `getQueue(name)` memoized factory, `enqueueSafely` helper that catches Redis-down enqueue errors. |
| `packages/api/src/lib/telemetry.ts` | Prometheus `Registry`, metric definitions, `withTelemetry(queueName, fn)` wrapper, `tracer` from `@opentelemetry/api`. |
| `packages/api/src/lib/health-server.ts` | Tiny HTTP server (port 3002) exposing `/health/live`, `/health/ready`, `/metrics`. |
| `packages/api/src/lib/iana-tz.ts` | `isValidIANA(tz)` check against `@vvo/tzdb`, `localHour(utcNow, tz)`, `formatInTimeZone(date, tz, pattern)`. |
| `packages/api/src/worker.ts` | Worker entry. Loads config, opens Redis, registers queues + workers + dispatchers, starts health server, handles SIGTERM. |
| `packages/api/src/workers/suspension-worker.ts` | BullMQ worker for `suspension-transitions`. |
| `packages/api/src/workers/notification-worker.ts` | BullMQ worker for `notification-send`. |
| `packages/api/src/workers/sla-breach-worker.ts` | BullMQ worker for `sla-breach-sweep`. |
| `packages/api/src/workers/delinquency-dispatcher.ts` | Hourly cron. Reads tenant config, enqueues per-tenant jobs with priority + idempotency keys, handles missed-tick recovery. |
| `packages/api/src/workers/delinquency-worker.ts` | Per-tenant consumer of `delinquency-tenant`. Updates `delinquencyLastRunAt` on success. |
| `packages/api/src/workers/audit-retention-worker.ts` | Daily retention sweep for `scheduler:%` audit rows. |
| `packages/api/src/workers/dlq-monitor.ts` | Subscribes to `failed` events across queues, moves exhausted jobs into matching `dlq-*` queue, updates `dlq_depth` gauge. |
| `packages/api/src/services/automation-config.service.ts` | `getAutomationConfig`, `patchAutomationConfig`, `isSchedulerEnabled`, `isInQuietHours`, `priorityForTenant`. |
| `packages/api/src/routes/automation-config.ts` | `GET /api/v1/settings/automation`, `PATCH /api/v1/settings/automation`. |
| `packages/api/src/__tests__/lib/iana-tz.test.ts` | IANA validation, localHour DST-boundary cases, formatInTimeZone. |
| `packages/api/src/__tests__/services/automation-config.service.test.ts` | quiet-hours wrap-around, missing-config defaults, priority buckets. |
| `packages/api/src/__tests__/integration/worker-suspension.test.ts` | Testcontainers Redis + Postgres; enqueue → consume → assert DB state + audit rows. |
| `packages/api/src/__tests__/integration/worker-sla-breach.test.ts` | Testcontainers; flipped rows + audits land atomically. |
| `packages/api/src/__tests__/integration/worker-notification.test.ts` | Testcontainers; quiet-hours suppression, retry behavior on provider failure. |
| `packages/api/src/__tests__/integration/worker-delinquency.test.ts` | Testcontainers; dispatcher fan-out, priority ordering, missed-tick recovery. |
| `packages/api/src/__tests__/integration/worker-audit-retention.test.ts` | Testcontainers; retention respects per-tenant days, only touches `scheduler:%` sources, batched. |
| `packages/api/src/__tests__/integration/worker-shutdown.test.ts` | Testcontainers; enqueue long-running job, SIGTERM mid-flight, assert clean exit + job completes. |
| `packages/api/src/__tests__/integration/worker-redis-reconnect.test.ts` | Testcontainers; pause Redis container, resume, assert worker drains queue without restart. |
| `packages/shared/src/validators/automation-config.ts` | Zod schemas. |
| `packages/web/app/settings/automation/page.tsx` | Settings UI. |

### Modified

| Path | Change |
|---|---|
| `packages/shared/prisma/schema.prisma` | Add 10 columns to `TenantConfig`: `timezone`, `suspensionEnabled`, `notificationSendEnabled`, `slaBreachSweepEnabled`, `delinquencyEnabled`, `delinquencyRunHourLocal`, `delinquencyLastRunAt`, `notificationQuietStart`, `notificationQuietEnd`, `schedulerAuditRetentionDays`. |
| `packages/shared/prisma/migrations/<TS>_tenant_automation_config/migration.sql` | Generated migration with defaults. |
| `packages/api/src/app.ts` | Gate existing `startSuspensionScheduler` / `startNotificationSendJob` / `startDelinquencyScheduler` behind per-job `USE_LEGACY_SCHEDULERS_*` env flags. Register `automation-config` routes. Expose `/metrics` from the API process too. |
| `packages/api/src/services/service-suspension.service.ts` | Add `sweepSuspensionsAllTenants(now)` — single `$transaction` doing `UPDATE ... RETURNING` + `auditLog.createMany`. |
| `packages/api/src/services/notification.service.ts` | Add `processPendingNotificationsWithQuietHours(now)` — single query with tenant-config join for enabled + quiet-hours filter. |
| `packages/api/src/services/delinquency.service.ts` | Extract `evaluateDelinquencyForTenant(utilityId, now)` pure function (already close — clean up the call boundary). |
| `packages/api/src/services/service-request.service.ts` | Add `sweepBreachedSRs(now)` with `RETURNING` + atomic `createMany`. |
| `packages/api/src/services/tenant-config.service.ts` | Return new automation fields; validate IANA timezone on write. |
| `packages/api/src/services/audit.service.ts` (or equivalent) | Add `sweepExpiredSchedulerAudits(now)`. |
| `packages/api/package.json` | Add deps, `dev:worker`, `start:worker` scripts, `test:integration` script. |
| `package.json` (root) | Turbo pipeline entries for `dev:worker`, `start:worker`, `test:integration`. |
| `packages/web/components/sidebar.tsx` | "Automation" under Settings. |
| `packages/shared/src/validators/index.ts` | Re-export `automation-config`. |
| `.github/workflows/*.yml` (if present) | Ensure Docker available for testcontainers; add `test:integration` job. |
| `Dockerfile` / `Dockerfile.worker` (if present, or create) | Pin base to `node:22-bookworm-slim`. Worker image runs `node dist/worker.js`. |

---

## Task 1: Worker infrastructure

**Goal:** Deployable worker process with health endpoints, metrics, config validation, Redis, queue scaffolding, DLQ monitor, graceful shutdown. No business logic yet.

**Files:**
- Create: `config.ts`, `lib/redis.ts`, `lib/queues.ts`, `lib/telemetry.ts`, `lib/health-server.ts`, `lib/iana-tz.ts`, `worker.ts`, `workers/dlq-monitor.ts`
- Modify: `packages/api/package.json`, `package.json`, `Dockerfile.worker` (create if missing)

- [ ] **1.1** Add deps to `packages/api/package.json`: `bullmq`, `ioredis`, `@bull-board/fastify`, `prom-client`, `@opentelemetry/api`, `@vvo/tzdb`. Dev deps: `testcontainers`. Add scripts: `dev:worker: tsx watch src/worker.ts`, `start:worker: node dist/worker.js`, `test:integration: vitest run --config vitest.integration.config.ts`. Run `pnpm install`.

- [ ] **1.2** Create `config.ts`. Define Zod schema for: `NODE_ENV`, `DATABASE_URL`, `REDIS_URL`, `DISABLE_SCHEDULERS`, `USE_LEGACY_SCHEDULERS_SUSPENSION`, `USE_LEGACY_SCHEDULERS_NOTIFICATION`, `USE_LEGACY_SCHEDULERS_DELINQUENCY`, `BULL_BOARD_ENABLED`, `WORKER_HTTP_PORT` (default 3002). Export typed `config` object. Parse at module load; throw on invalid.

- [ ] **1.3** Create `lib/redis.ts`. Export `redisConnection` with `maxRetriesPerRequest: null`, `enableOfflineQueue: false` in production, `reconnectOnError: () => true`. Log connect / ready / error / end events at appropriate levels.

- [ ] **1.4** Create `lib/telemetry.ts`. Define metrics: `jobDurationHistogram`, `jobAttemptsCounter`, `jobLagGauge`, `queueDepthGauge`, `dlqDepthGauge`, `tenantAutomationGauge`. Export `withTelemetry(queueName, fn)` wrapper that creates span + records histogram + counter on success/failure. Export `registry` for `/metrics` endpoint.

- [ ] **1.5** Create `lib/health-server.ts`. Tiny `http.createServer` exposing `/health/live` (200 always), `/health/ready` (200 iff redis `ping()` and `prisma.$queryRaw\`SELECT 1\`` both succeed within 2s; else 503), `/metrics` (dump `registry.metrics()`).

- [ ] **1.6** Create `lib/iana-tz.ts`. Export `isValidIANA(tz)` (check against `tzdb.getTimeZones()`), `localHour(utcDate, tz)` (uses `Intl.DateTimeFormat` with `timeZone` option, returns 0-23 number), `formatInTimeZone(date, tz, pattern)` (small homegrown `yyyyMMddHH` formatter, sufficient for idempotency keys — don't pull in `date-fns-tz` yet).

- [ ] **1.7** Create `lib/queues.ts`. Export `QUEUE_NAMES` enum, per-queue `JobsOptions` defaults (retries + backoff per spec §3.2), `getQueue(name)` memoized factory with `removeOnComplete: { age: 86400, count: 1000 }` and `removeOnFail: { age: 604800 }`. Export `enqueueSafely(queueName, name, data, opts)` — wraps `queue.add` in try/catch, logs Redis-down enqueue failures at error level, returns null on failure.

- [ ] **1.8** Create `workers/dlq-monitor.ts`. One BullMQ `QueueEvents` listener per primary queue. On `failed` with `attemptsMade >= maxAttempts`, move the job payload to `dlq-<queue>` queue and increment `dlqDepthGauge`. Log at error level with job id + error.

- [ ] **1.9** Create `worker.ts`. Load config. Open Redis. Start health server. Register DLQ monitors. Set up SIGTERM handler: close each worker with 60s drain timeout, quit Redis, exit 0. Register Bull Board **only if** `config.BULL_BOARD_ENABLED` — serve at `/admin/queues`. If `config.DISABLE_SCHEDULERS`, skip queue registration (used by tests that import the worker module).

- [ ] **1.10** Create `Dockerfile.worker` (if not present). `FROM node:22-bookworm-slim`. Install deps. Build. CMD `["node", "dist/worker.js"]`.

- [ ] **1.11** Integration test: start worker via `pnpm --filter api dev:worker` in one terminal; verify `/health/live`, `/health/ready`, `/metrics` respond; SIGTERM shuts down within 2s.

- [ ] **Verification:** `pnpm --filter api exec tsc --noEmit` clean. Worker starts, health endpoints respond, metrics endpoint lists `job_duration_seconds` etc. (no samples yet), SIGTERM exit code 0.

---

## Task 2: Suspension migration (first real job, proves pattern #1 end-to-end)

**Files:**
- Create: `workers/suspension-worker.ts`, `__tests__/integration/worker-suspension.test.ts`
- Modify: `services/service-suspension.service.ts`, `worker.ts`, `app.ts`

- [ ] **2.1** In `service-suspension.service.ts`, add `sweepSuspensionsAllTenants(now: Date): Promise<{ activated: number; completed: number }>`. Inside `prisma.$transaction` with `ReadCommitted` isolation:
    - Two `$queryRaw<{id, utility_id}[]>` `UPDATE ... FROM tenant_config tc ... WHERE tc.suspension_enabled = true AND ... RETURNING id, utility_id`.
    - One `auditLog.createMany` per updated set with `source: "scheduler:suspension-transitions"` and `action` `"suspension.activated"` or `"suspension.completed"`.
    - Return counts.

- [ ] **2.2** Unit test `sweepSuspensionsAllTenants`: two tenants (one `suspensionEnabled=false`), PENDING rows past startDate in each, assert only enabled tenant's row flips and audit row exists with scheduler source.

- [ ] **2.3** Create `workers/suspension-worker.ts`. BullMQ `Worker` on `suspension-transitions`. Handler wraps `sweepSuspensionsAllTenants(new Date())` in `withTelemetry`. Log `{ activated, completed }` when nonzero (not on empty ticks).

- [ ] **2.4** In `worker.ts`, register the suspension worker and the repeatable job via `queue.upsertJobScheduler("suspension-cron", { pattern: "0 * * * *", tz: "UTC" }, { name: "transition-suspensions" })`.

- [ ] **2.5** In `app.ts`, wrap the existing `startSuspensionScheduler(app.log)` call in `if (config.USE_LEGACY_SCHEDULERS_SUSPENSION) { ... }`. Legacy starter also logs `"LEGACY scheduler active — USE_LEGACY_SCHEDULERS_SUSPENSION=true"` at warn level on start.

- [ ] **2.6** Create `__tests__/integration/worker-suspension.test.ts` using Testcontainers. Start ephemeral Redis + Postgres; run Prisma migrate; seed two tenants; enqueue one `transition-suspensions` job; await completion; assert DB state and audit rows match. Also test: disabled tenant is skipped; empty sweep is a no-op; audit metadata includes `now` timestamp.

- [ ] **Verification:** Legacy path still works with flag on (manual toggle test). New path is the default. `pnpm --filter api test:integration` passes on CI.

---

## Task 3: TenantConfig schema + automation config helpers

**Files:**
- Modify: `packages/shared/prisma/schema.prisma`, `services/tenant-config.service.ts`
- Create: `packages/shared/prisma/migrations/<TS>_tenant_automation_config/migration.sql`, `services/automation-config.service.ts`, `validators/automation-config.ts`, `__tests__/services/automation-config.service.test.ts`

- [ ] **3.1** Add 10 columns to `TenantConfig` in `schema.prisma` per spec §3.4. Run `pnpm --filter shared prisma migrate dev --name tenant_automation_config`. Inspect generated SQL — confirm defaults are literal (`DEFAULT 'UTC'`, `DEFAULT true`, `DEFAULT 3`, `DEFAULT '22:00'`, `DEFAULT '07:00'`, `DEFAULT 365`).

- [ ] **3.2** Update `tenant-config.service.ts`: return new fields from `getTenantConfig`; on `patchTenantConfig`, validate `timezone` with `isValidIANA` and HH:mm fields with regex. Reject invalid at the service boundary (Zod in the validator catches most, but service-layer defense matches project convention).

- [ ] **3.3** Create `validators/automation-config.ts`. `AutomationConfigDTO` Zod schema with the 10 fields. `AutomationConfigPatch` partial. HH:mm regex `/^([01]\d|2[0-3]):[0-5]\d$/`. `delinquencyRunHourLocal` is `z.number().int().min(0).max(23)`. `schedulerAuditRetentionDays` is `z.number().int().min(30).max(2555)`.

- [ ] **3.4** Create `services/automation-config.service.ts`:
    - `getAutomationConfig(utilityId)` — wraps `getTenantConfig` but returns only the automation subset.
    - `patchAutomationConfig(utilityId, patch, userId)` — validates, writes, emits audit with `source: "user:${userId}"`.
    - `isSchedulerEnabled(cfg, scheduler)` — reads the per-scheduler column.
    - `isInQuietHours(utcNow, cfg)` — compares `localHour(utcNow, cfg.timezone)` against `notificationQuietStart`/`End`, handles wrap-around.
    - `priorityForTenant(accountCount)` — returns 1/2/3 per spec §3.3.

- [ ] **3.5** Test every edge: wrap-around quiet hours (22:00 → 07:00), DST spring-forward (02:30 doesn't exist in `America/New_York` on that day), tzdb validation rejects bogus names, priority boundary cases.

- [ ] **3.6** Export the validator from `packages/shared/src/validators/index.ts`. Run `pnpm --filter shared build`.

- [ ] **Verification:** Schema migrated. Unit tests green. `tsc --noEmit` clean across api + shared + web.

---

## Task 4: Automation config routes

**Files:**
- Create: `routes/automation-config.ts`, `__tests__/integration/automation-config-routes.test.ts`
- Modify: `app.ts`

- [ ] **4.1** In `routes/automation-config.ts`, register:
    - `GET /api/v1/settings/automation` — requires `tenant_profile:VIEW`. Returns `AutomationConfigDTO`.
    - `PATCH /api/v1/settings/automation` — requires `tenant_profile:EDIT`. Validates with `AutomationConfigPatch`. Wrapped in `withTenant` for RLS.
- [ ] **4.2** Register in `app.ts`.
- [ ] **4.3** Integration test the round-trip: PATCH each field, GET, assert persistence + audit row.
- [ ] **Verification:** Routes respond with correct shape; unauthorized roles get 403.

---

## Task 5: `/settings/automation` UI

**Files:**
- Create: `packages/web/app/settings/automation/page.tsx`
- Modify: `packages/web/components/sidebar.tsx`, `packages/web/app/settings/page.tsx` (add tile if grid exists)

- [ ] **5.1** Page sections per spec §3.4:
    - **General** — timezone select. Import tzdb list, searchable.
    - **Schedulers** — four toggles. Each shows plain-English cadence ("hourly", "every 5 minutes", etc.).
    - **Quiet hours** — two `<input type="time">`. Note line: "SMS only; email is always eligible."
    - **Daily run hour** — number input 0-23.
    - **Audit retention** — number input 30-2555 days, with helper pills (90 / 180 / 365 / 730).

- [ ] **5.2** Follow existing CIS aesthetic (tokens, DM Sans, `PageDescription`). No new component primitives.

- [ ] **5.3** Save wires `apiClient.patch("/api/v1/settings/automation", ...)`, uses existing toast system.

- [ ] **5.4** Sidebar entry "Automation" under Settings.

- [ ] **Verification:** Manual — save, reload, values persist. Invalid timezone rejected with visible error. `pnpm --filter web exec tsc --noEmit` clean.

---

## Task 6: Notification-send migration with quiet hours

**Files:**
- Create: `workers/notification-worker.ts`, `__tests__/integration/worker-notification.test.ts`
- Modify: `services/notification.service.ts`, `worker.ts`, `app.ts`

- [ ] **6.1** Add `processPendingNotificationsWithQuietHours(now)` in `notification.service.ts`. WHERE joins `tenant_config`; excludes rows where channel is SMS and the tenant's current `localHour` falls inside `[notificationQuietStart, notificationQuietEnd]`. Runs inside `$transaction` only where atomicity matters (the per-row status updates already use this pattern — confirm + keep).

- [ ] **6.2** Create `workers/notification-worker.ts`. BullMQ `Worker`, concurrency 1 (BullMQ replaces the old `sendJobRunning` boolean guard). Wraps handler in `withTelemetry`.

- [ ] **6.3** Register in `worker.ts` via `queue.upsertJobScheduler("notification-send-cron", { pattern: "*/10 * * * * *", tz: "UTC" }, { name: "process-notification-batch" })`.

- [ ] **6.4** Gate legacy `startNotificationSendJob` behind `USE_LEGACY_SCHEDULERS_NOTIFICATION`.

- [ ] **6.5** Integration test: seed tenant with quiet hours covering "now", queue an SMS, run tick, assert `PENDING`; widen quiet-hours window to exclude now, tick again, assert sent. Email is sent regardless of quiet hours. Retry test: mock provider fails 3 times, assert 5 attempts then DLQ.

- [ ] **Verification:** Integration green. Metrics show `job_attempts_total{queue="notification-send",outcome="success"}` increments.

---

## Task 7: Delinquency — dispatcher + per-tenant fan-out

**Files:**
- Create: `workers/delinquency-dispatcher.ts`, `workers/delinquency-worker.ts`, `__tests__/integration/worker-delinquency.test.ts`
- Modify: `services/delinquency.service.ts`, `worker.ts`, `app.ts`

- [ ] **7.1** Extract `evaluateDelinquencyForTenant(utilityId, now)` in `delinquency.service.ts`. On success, update `tenant_config.delinquencyLastRunAt = now`.

- [ ] **7.2** Create `workers/delinquency-dispatcher.ts`. Hourly cron. Reads all `tenant_config` rows where `delinquencyEnabled = true`. Computes eligibility per spec §3.3 (on schedule OR missed-tick catch-up). Calls `enqueueSafely` with priority + deterministic `jobId: delinquency:<utilityId>:<UTC-yyyyMMddHH>`.

- [ ] **7.3** Create `workers/delinquency-worker.ts`. BullMQ `Worker` on `delinquency-tenant`, concurrency 5. Handler wraps `evaluateDelinquencyForTenant(data.utilityId, new Date())` in `withTelemetry`.

- [ ] **7.4** Register both in `worker.ts`: dispatcher cron via `queue.upsertJobScheduler("delinquency-dispatch-cron", { pattern: "0 * * * *", tz: "UTC" }, { name: "dispatch-delinquency" })` plus the consumer worker on `delinquency-tenant`.

- [ ] **7.5** Gate legacy `startDelinquencyScheduler` behind `USE_LEGACY_SCHEDULERS_DELINQUENCY`.

- [ ] **7.6** Integration test:
    - Three tenants with different `delinquencyRunHourLocal`; dispatcher enqueues only the one whose local hour matches.
    - Missed-tick recovery: set `delinquencyLastRunAt` to 25 hours ago; dispatcher enqueues even if local hour doesn't match.
    - Priority ordering: enqueue tenants with varying account counts; assert large-tenant job runs after small-tenant jobs when workers are saturated.
    - Idempotency: call dispatcher twice within same hour; only one job per tenant enqueued.

- [ ] **Verification:** All integration tests green. Bull Board shows per-tenant jobs with priorities.

---

## Task 8: SLA breach sweep (new job)

**Files:**
- Create: `workers/sla-breach-worker.ts`, `__tests__/integration/worker-sla-breach.test.ts`, `__tests__/services/sweep-breached-srs.test.ts`
- Modify: `services/service-request.service.ts`, `worker.ts`

- [ ] **8.1** Add `sweepBreachedSRs(now)` in `service-request.service.ts`. `$transaction` with `UPDATE service_requests ... FROM tenant_config tc WHERE tc.sla_breach_sweep_enabled = true AND status NOT IN terminal AND sla_due_at < now AND sla_breached = false RETURNING id, utility_id, request_number` + `auditLog.createMany` with `source: "scheduler:sla-breach-sweep"` and action `"service_request.sla_breached"`.

- [ ] **8.2** Unit test: three SRs seeded — one open past-due (should flip), one COMPLETED past-due (should not), one open not-due (should not). Assert only first flips; audit entry exists.

- [ ] **8.3** Create `workers/sla-breach-worker.ts`. Cron every 5 minutes.

- [ ] **8.4** Register in `worker.ts` via `queue.upsertJobScheduler("sla-breach-cron", { pattern: "*/5 * * * *", tz: "UTC" }, { name: "sweep-for-sla-breaches" })`.

- [ ] **8.5** Integration test: seed open SR with past `sla_due_at`, enqueue sweep, assert flipped + audit. Detail page timeline (via existing queries) shows the new event.

- [ ] **Verification:** Queue filter `sla_breached=true` now reflects reality within 5 minutes of due-date elapse.

---

## Task 9: Audit retention cleanup

**Files:**
- Create: `workers/audit-retention-worker.ts`, `__tests__/integration/worker-audit-retention.test.ts`
- Modify: `services/audit.service.ts` (or wherever audit write helpers live), `worker.ts`

- [ ] **9.1** Add `sweepExpiredSchedulerAudits(now)` in the audit service. Loops batches of 10k deletes: `DELETE FROM audit_log WHERE id IN (SELECT id FROM audit_log al JOIN tenant_config tc ON al.utility_id = tc.utility_id WHERE al.source LIKE 'scheduler:%' AND al.created_at < now() - (tc.scheduler_audit_retention_days || ' days')::interval LIMIT 10000)`. Exits when batch returns 0 or elapsed > 10 min.

- [ ] **9.2** Create `workers/audit-retention-worker.ts`. Daily cron at 04:00 UTC.

- [ ] **9.3** Register in `worker.ts` via `queue.upsertJobScheduler("audit-retention-cron", { pattern: "0 4 * * *", tz: "UTC" }, { name: "sweep-expired-audits" })`.

- [ ] **9.4** Integration test:
    - Seed tenant with `schedulerAuditRetentionDays=90`; seed scheduler audits dated 60, 100, 200 days ago + user audit dated 500 days ago; run sweep; assert only the 100- and 200-day scheduler audits are deleted.
    - Multi-tenant retention: tenant A 90 days, tenant B 365 days; assert each tenant's audits age out at their own threshold.
    - Batching: seed 25k eligible rows; assert three batches run; all 25k deleted.

- [ ] **Verification:** Integration green. Audit table growth budget holds under synthetic load.

---

## Task 10: Sequencing + final gates

- Tasks 1-2 are foundation. Don't start 3 until 2 is end-to-end green.
- Tasks 3-5 ship as one commit series (schema + service + UI land together).
- Tasks 6, 7, 8 are independent. Can parallelize between subagents after 5 merges.
- Task 9 depends on 3 (needs the retention column). Can ship alongside or after 6-8.

### Cross-cutting verification before declaring ship 1 done:

- [ ] All `USE_LEGACY_SCHEDULERS_*` flags default off; legacy path triggers only when explicitly set.
- [ ] Every worker handler passes through `withTelemetry` — metrics visible on `/metrics`.
- [ ] Every DB mutation from a worker is inside a `$transaction` if it also writes audit rows.
- [ ] Every idempotency key uses UTC-formatted timestamps.
- [ ] Every cron `jobId` is deterministic (`<name>-cron`).
- [ ] Testcontainers integration tests pass locally and on GitHub Actions.
- [ ] Graceful shutdown test passes.
- [ ] Redis reconnect test passes.
- [ ] Bull Board loads only with `BULL_BOARD_ENABLED=true` and System Admin auth.
- [ ] No untyped `process.env.X` reference outside `config.ts`.

---

## Deferred to Ship 2 (post-soak)

Not part of this plan, tracked separately:

1. **OTel collector.** Deploy collector, set `OTEL_EXPORTER_OTLP_ENDPOINT` in worker env. Add Prisma + Fastify auto-instrumentation.
2. **Grafana dashboards + alerts.** Dashboards for all metrics. Alerts: DLQ depth > 0 for 15 min; queue depth > 1000; job lag > 5 min; Redis disconnect > 1 min.
3. **HA Redis.** Sentinel (self-hosted) or ElastiCache with automatic failover.
4. **Load + chaos testing.** k6 for queue throughput at 100k-tenant synthetic fan-out. Chaos: kill-Redis, kill-worker, kill-DB.
5. **Priority quotas.** If basic priorities aren't enough for fairness, add per-tenant rate limits.
6. **Final legacy removal + docs.** Delete `USE_LEGACY_SCHEDULERS_*` paths and the three legacy `start*` functions. Update `docs/specs/18-theme-and-configuration.md` and `docs/design/utility-cis-architecture.md`.
