# Job Scheduler Migration — Design Spec

**Date:** 2026-04-24
**Scope:** Move all background schedulers out of the API process into a dedicated BullMQ-backed worker. Introduce tenant-configurable automation (enable/disable, timezone, quiet hours, run-hour, audit retention). Add SLA breach sweep. Ship production-grade from day one.

---

## 1. Goals and non-goals

### Goals

- **Remove the single-instance constraint.** Today the API process runs three `setInterval` schedulers. Horizontal API scaling would double-fire. After migration, the API process runs zero timers; a separate worker process owns all scheduled work and is correct under N replicas.
- **Production-grade from ship 1.** That means: retries with DLQ, atomic `updateMany` + audit transactions, IANA timezone validation, explicit idempotency keys, per-queue priorities for tenant fairness, missed-tick recovery, health checks, Prometheus metrics + OTel spans, testcontainers-backed integration tests, configurable audit retention, and typed columns for every config knob.
- **Make per-tenant behavior configurable without exposing cron syntax.** Utility admins get `/settings/automation` with enable/disable, timezone, quiet hours, daily run hour, and audit retention days. No cron fields.
- **Land the SLA breach sweep** that Module 14 Slice B deferred.
- **Keep the same operational footprint for infra.** BullMQ uses the Redis instance already in `start_db.bat`. No new container required for ship 1.

### Non-goals

- **Per-tenant custom cadence.** Not exposing cron. Engineering-gated override if an edge case ever needs it.
- **Workflow orchestration.** Not Temporal — these jobs are stateless sweeps and enqueue-fanout, not multi-step workflows.
- **User-facing job dashboard.** Bull Board is operations tooling; System Admin role only, internal network only.
- **OTel collector deployment.** Ship 1 instruments spans and exposes metrics; collector + Grafana dashboards land in the ship 2 follow-up (see §7).
- **HA Redis topology.** Ship 1 assumes the single Redis instance in the current stack. Sentinel / ElastiCache failover is ship 2 infra.

---

## 2. Stack choices

- **BullMQ ^5** — TypeScript-first, Redis-backed, distributed locks, cron primitives, DLQ support, mature.
- **ioredis ^5** — required by BullMQ. Single shared `redisConnection` with `maxRetriesPerRequest: null` (BullMQ's blocking commands require it) and `enableOfflineQueue: false` in prod (fail fast on enqueue during Redis outage instead of silently buffering in memory).
- **`@bull-board/fastify` ^5** — operations dashboard. Disabled unless `BULL_BOARD_ENABLED=true` AND gated behind the System Admin role.
- **`prom-client` ^15** — Prometheus metrics endpoint on the worker process.
- **`@opentelemetry/api` ^1** — span creation (no SDK / exporter yet; spans become real data when the OTel collector lands in ship 2).
- **`@vvo/tzdb` ^6** — IANA timezone validation at write time. Node's built-in `Intl` handles runtime conversion.
- **`testcontainers` ^10** — integration tests spin up ephemeral Redis (and Postgres where needed). Works in GitHub Actions out of the box.
- **Base image:** `node:22-bookworm-slim`. Full ICU tzdata required for `Intl.DateTimeFormat` to do correct DST math. Alpine is rejected — its stripped ICU silently returns wrong local times.

**Rejected:**

- **JobRunr** — Java only; requires a JVM sidecar. Operational weight > benefit.
- **pg-boss** — valid but abandons the existing Redis and has a smaller ecosystem.
- **Raw `setInterval` in a separate process** — doesn't solve multi-instance.
- **Alpine base images** — ICU dependency.

---

## 3. Architecture

### 3.1 Process topology

```
┌───────────────────────────┐                    ┌───────────────────┐
│ API process (Fastify)     │                    │ Redis (BullMQ)    │
│ HTTP: 3001                │──enqueue ad hoc───▶│ queues + locks +  │
│ NO setInterval, NO cron   │                    │ job history       │
│ /metrics exposed          │                    └─────────┬─────────┘
└───────────────────────────┘                              │
                                                           │ BRPOPLPUSH
┌───────────────────────────┐                              ▼
│ Worker process            │                    ┌───────────────────┐
│ main: worker.ts           │◀───consume jobs────│                   │
│ HTTP: 3002                │                    └───────────────────┘
│ /health/live  /health/ready                    
│ /metrics                  │
│ Bull Board (gated)        │
└───────────────────────────┘
```

- **Single binary, two entry points.** `src/index.ts` starts Fastify. New `src/worker.ts` registers queues + workers. Same Prisma client, same services, same types. Deploy as two services with different commands.
- **Worker exposes HTTP** on port 3002 for health + metrics + Bull Board. Not for business traffic.
- **Health endpoints.** `/health/live` returns 200 while the process is up. `/health/ready` returns 200 iff `redis.ping()` and `SELECT 1` both succeed within 2 seconds. Kubernetes uses the former for restarts and the latter for deploy gating.
- **Graceful shutdown.** SIGTERM handler runs two-phase: stop polling queues first, then `worker.close()` on each worker with a 60-second drain timeout. k8s `terminationGracePeriodSeconds` set to 90 so rolling deploys don't orphan jobs.
- **Config validation.** Single `src/config.ts` module loads + validates every env var through Zod at startup. Fail fast on missing or malformed config, never at first use. No untyped `process.env.X` references elsewhere in the code.

### 3.2 Queues

One queue per logical job family. Per-queue retry and priority policies. Per-queue `removeOnComplete`/`removeOnFail` age-based retention so Redis memory stays bounded.

The "Job name" column is the BullMQ job label (the first argument to `queue.add(name, data, opts)`). It's queue-scoped metadata — Bull Board lists it, logs include it, and worker handlers can branch on it. Each queue here carries a single job kind, so the name is mostly a readability label rather than a discriminator.

| Queue | Job name | Concurrency | Cadence | Retries | Backoff | DLQ |
|---|---|---|---|---|---|---|
| `suspension-transitions` | `transition-suspensions` | 1 | `0 * * * *` | 3 | exponential, 30s base | `dlq-suspension` |
| `notification-send` | `process-notification-batch` | 1 | `*/10 * * * * *` | 5 | exponential, 5s base | `dlq-notification-send` |
| `sla-breach-sweep` | `sweep-for-sla-breaches` | 1 | `*/5 * * * *` | 3 | exponential, 60s base | `dlq-sla-breach` |
| `delinquency-dispatch` | `dispatch-delinquency` | 1 | `0 * * * *` | 2 | fixed, 60s | `dlq-delinquency-dispatch` |
| `delinquency-tenant` | `evaluate` | 5 | on demand | 3 | exponential, 30s base | `dlq-delinquency-tenant` |
| `audit-retention` | `sweep-expired-audits` | 1 | `0 4 * * *` | 2 | fixed, 5m | `dlq-audit-retention` |

BullMQ's `failed` event moves exhausted jobs into the matching `dlq-*` queue. A separate `dlq-monitor` handler emits a Prometheus `dlq_depth{queue}` gauge and logs at `error` level. Operators replay DLQ jobs from Bull Board.

Job records retained in Redis: `removeOnComplete: { age: 86400, count: 1000 }` (24 hours or 1000 jobs per queue, whichever hits first). Failed jobs retained 7 days for post-mortem.

### 3.3 Pattern split per job

**Pattern #1 — single cross-tenant query in one transaction.** One `UPDATE ... RETURNING` + one `auditLog.createMany` inside a single `prisma.$transaction`. No Node-side tenant loop.

Applies to: `suspension-transitions`, `notification-send`, `sla-breach-sweep`, `audit-retention`.

Example (SLA breach sweep):

```ts
export async function sweepSlaBreaches(now: Date): Promise<{ flipped: number }> {
  return prisma.$transaction(async (tx) => {
    const affected = await tx.$queryRaw<{ id: string; utility_id: string; request_number: string }[]>`
      UPDATE service_requests sr
      SET sla_breached = true, updated_at = now()
      FROM tenant_config tc
      WHERE tc.utility_id = sr.utility_id
        AND tc.sla_breach_sweep_enabled = true
        AND sr.status NOT IN ('COMPLETED','CANCELLED')
        AND sr.sla_due_at < ${now}
        AND sr.sla_breached = false
      RETURNING sr.id, sr.utility_id, sr.request_number
    `;
    if (affected.length === 0) return { flipped: 0 };
    await tx.auditLog.createMany({
      data: affected.map((r) => ({
        utilityId: r.utility_id,
        entityType: "service_request",
        entityId: r.id,
        action: "sla_breached",
        source: "scheduler:sla-breach-sweep",
        metadata: { requestNumber: r.request_number, breachedAt: now.toISOString() },
      })),
    });
    return { flipped: affected.length };
  }, { timeout: 30_000, isolationLevel: "ReadCommitted" });
}
```

`RETURNING` gives us exact affected rows without a second query. `createMany` writes all audits in one INSERT. Transaction guarantees atomicity — rows and audits land together or neither does.

**Pattern #2 — dispatcher fan-out with tenant-local hour gate + missed-tick recovery.** Hourly dispatcher enqueues one job per eligible tenant. Dispatcher reads `delinquencyLastRunAt` to catch missed runs after a worker outage (bounded to at most one catch-up per tenant per day).

```ts
async function dispatchDelinquency(queue: Queue, nowUtc: Date) {
  const candidates = await prisma.tenantConfig.findMany({
    where: { delinquencyEnabled: true },
    select: {
      utilityId: true,
      timezone: true,
      delinquencyRunHourLocal: true,
      delinquencyLastRunAt: true,
    },
  });
  const due = candidates.filter((c) => {
    const hoursSinceLast = c.delinquencyLastRunAt
      ? (nowUtc.getTime() - c.delinquencyLastRunAt.getTime()) / 3_600_000
      : Infinity;
    const localHourNow = localHour(nowUtc, c.timezone);
    const onSchedule = localHourNow === c.delinquencyRunHourLocal;
    const missedToday = hoursSinceLast >= 23;
    return onSchedule || missedToday;
  });
  const jobs = due.map((c) => ({
    name: "evaluate",
    data: { utilityId: c.utilityId, priority: priorityFor(c) },
    opts: {
      priority: priorityFor(c),
      jobId: `delinquency:${c.utilityId}:${formatInTimeZone(nowUtc, "UTC", "yyyyMMddHH")}`,
    },
  }));
  await queue.addBulk(jobs);
}
```

Priorities weight by tenant size so large tenants don't starve small ones:
- `priority: 1` for tenants with < 1000 accounts
- `priority: 2` for 1000-10k
- `priority: 3` for > 10k

BullMQ processes lower-priority numbers first. Applies only to `delinquency-tenant`; the single-query sweeps don't need priority.

Idempotency key `delinquency:<utilityId>:<UTC-yyyyMMddHH>` deduplicates within an hour. Deploy-time double-dispatch is a no-op.

The consumer updates `delinquencyLastRunAt` to `now()` on success so the next dispatcher tick knows it ran.

### 3.4 Tenant configuration surface

Extension of `TenantConfig`. Typed columns — not a JSON blob. Every automation knob gets a discrete column with constraints, which means DB-level enforcement and clean indexing.

```prisma
model TenantConfig {
  // ... existing fields ...

  // Automation
  timezone                     String   @default("UTC")              // IANA, validated at write time
  suspensionEnabled            Boolean  @default(true)
  notificationSendEnabled      Boolean  @default(true)
  slaBreachSweepEnabled        Boolean  @default(true)
  delinquencyEnabled           Boolean  @default(true)
  delinquencyRunHourLocal      Int      @default(3)                  // 0-23
  delinquencyLastRunAt         DateTime?                             // missed-tick tracking
  notificationQuietStart       String   @default("22:00")            // HH:mm, tenant-local, SMS only
  notificationQuietEnd         String   @default("07:00")            // HH:mm
  schedulerAuditRetentionDays  Int      @default(365)                // per-tenant retention for scheduler-emitted audits
}
```

Adding a new scheduler = one additive migration with a `*Enabled` column. Trivial.

UI: `/settings/automation`. Sections:

- **General** — timezone select (IANA list from tzdb, searchable).
- **Schedulers** — four toggles with plain-English one-liners ("Suspension transitions · hourly", "SLA breach sweep · every 5 minutes", etc.).
- **Quiet hours** — two `<input type="time">`. Explicit note: "SMS only; email is always eligible."
- **Daily run hour** — integer 0-23 in tenant-local time.
- **Audit retention** — integer days input with 90/180/365/730/-day helper pills and min 30, max 2555 (7 years).

RBAC: existing `tenant_profile:VIEW` / `tenant_profile:EDIT` permissions.

### 3.5 Telemetry

Every job handler is wrapped in:

```ts
async function withTelemetry<T>(queueName: string, fn: () => Promise<T>): Promise<T> {
  const span = tracer.startSpan(`job.${queueName}`, { attributes: { queue: queueName } });
  const start = Date.now();
  try {
    const result = await fn();
    jobDurationHistogram.observe({ queue: queueName, outcome: "success" }, (Date.now() - start) / 1000);
    jobAttemptsCounter.inc({ queue: queueName, outcome: "success" });
    return result;
  } catch (err) {
    span.recordException(err as Error);
    jobDurationHistogram.observe({ queue: queueName, outcome: "failed" }, (Date.now() - start) / 1000);
    jobAttemptsCounter.inc({ queue: queueName, outcome: "failed" });
    throw err;
  } finally {
    span.end();
  }
}
```

Metrics (exposed at `/metrics` on the worker):

- `job_duration_seconds{queue,outcome}` — histogram, buckets at 0.1, 0.5, 1, 5, 30, 60, 300 seconds.
- `job_attempts_total{queue,outcome}` — counter.
- `job_lag_seconds{queue}` — gauge of time from scheduled-at to started-at. Surfaces worker saturation.
- `queue_depth{queue,state}` — gauge scraped from BullMQ's `getWaitingCount()` / `getActiveCount()` / `getDelayedCount()` / `getFailedCount()`.
- `dlq_depth{queue}` — gauge of messages in each DLQ.
- `tenant_automation_enabled{scheduler}` — gauge count of tenants with each scheduler enabled.

Spans currently have no SDK or exporter wired. When the OTel collector ships in ship 2, flipping `OTEL_EXPORTER_OTLP_ENDPOINT` in the worker env is sufficient to start emitting.

### 3.6 Audit retention policy

Scheduler-emitted audits have `source` prefixed with `scheduler:` (e.g., `source: "scheduler:sla-breach-sweep"`). User-emitted audits have `source: "user:<cisUserId>"` or similar. Retention only applies to scheduler sources — user audits stay under whatever compliance policy already governs them.

Daily `audit-retention` cron at 04:00 UTC runs a single cross-tenant query:

```sql
DELETE FROM audit_log al
USING tenant_config tc
WHERE al.utility_id = tc.utility_id
  AND al.source LIKE 'scheduler:%'
  AND al.created_at < now() - (tc.scheduler_audit_retention_days || ' days')::interval
```

Runs in batches of 10k rows with `DELETE ... WHERE id IN (SELECT id ... LIMIT 10000)` to avoid long-running locks. Loops until the batch returns zero rows or the tick runs longer than 10 minutes, at which point it exits and the next day's run resumes.

Retention applies to `audit_log` only; BullMQ job history retention in Redis is handled separately by `removeOnComplete` / `removeOnFail` options on job enqueue (see §3.2).

### 3.7 Redis resilience posture

- `ioredis` config: `maxRetriesPerRequest: null`, `enableOfflineQueue: false`, `reconnectOnError` returns `true` for all errors.
- API enqueue: wrapped in a helper that catches enqueue failures, logs at `error` level, and **does not** return an error to the HTTP caller. Scheduled work is eventually-consistent; an enqueue failure is no worse than a job running late. Exception: enqueues that are part of a user-visible synchronous flow (none currently exist in this migration, but worth documenting).
- Worker: if Redis disconnection exceeds 5 minutes, the worker calls `process.exit(1)`. The orchestrator restarts the pod; on restart, Redis reconnect is the normal path.
- Missed cron ticks during Redis outage: repeatable jobs are backed by Redis state. If Redis is out for > `cron interval`, that tick is lost. Missed-tick recovery in the delinquency dispatcher (§3.3) handles the only case where that matters — the other queues are idempotent sweeps that catch up on the next tick naturally.
- Two distinct Redis clients in the codebase, with different config:
  - `lib/cache-redis.ts` — best-effort cache (RBAC, rate schedules). Tolerates offline; 500ms timeouts; `enableOfflineQueue: true`.
  - `lib/queue-redis.ts` — BullMQ. Fail-fast; `maxRetriesPerRequest: null`, `enableOfflineQueue: false`. Required by BullMQ's blocking commands.

### 3.8 Schedule lifecycle

Cron schedules are **persistent state in Redis**, not in-memory state in the worker process. Important consequences:

- **Worker restart is a no-op for the schedule.** When a worker restarts, the scheduler config is already in Redis — calling `upsertJobScheduler` with the same id is idempotent. Workers re-establish polling against the existing delayed jobs immediately.
- **Schedules survive code deletion.** If we remove a queue from code without explicit cleanup, its scheduler entry stays in Redis and continues to fire jobs that no consumer drains. The dlq-monitor would catch them, but it's churn.
- **Solution: stale-scheduler reconciliation on every worker boot.** On startup, the worker enumerates all registered schedulers via `queue.getJobSchedulers()` and deletes any whose ID isn't in the code-defined `SCHEDULER_REGISTRY`. Idempotent, runs in milliseconds, prevents Redis-resident orphans.
- **Schedule changes (cron pattern, timezone) propagate via `upsertJobScheduler`.** Same scheduler ID with different config = updated schedule. During rolling deploys, the new pod's startup writes the new config; old pods keep using the old config in their cached scheduler instance until they're rotated out — but since cron computation is centralized in Redis, both pods see the same next-fire time. No flapping.
- **No work catches up after extended downtime.** If a 5-minute cron was missed for 30 minutes, on worker restart you get **one** sweep, not six. BullMQ tracks "next scheduled time," not "every individual missed tick." This is correct for our idempotent sweeps and incorrect for delinquency, which is why the delinquency dispatcher has explicit `delinquencyLastRunAt` missed-tick recovery (§3.3).
- **Inspection / management.** Bull Board (gated, internal-VPC only) lists all schedulers as a first-class concept with their next-fire times. Operators can pause / delete from the UI for incident response.

### 3.9 Containerization

The plan deploys API and worker as **two services from one image**, with different `CMD` overrides. Same Dockerfile, same build, same TypeScript artifacts. This is standard for monorepo apps with a worker — see §3.1 for topology.

- **Base image:** `node:22-bookworm-slim`. Required for full ICU (timezone data); Alpine ships stripped ICU and silently returns wrong local times.
- **Build stage:** `node:22-bookworm` (full Node + pnpm + dev deps + tsc). Compiles all packages.
- **Runtime stage:** `node:22-bookworm-slim` (minimal Node + production deps + `dist/` + `prisma/` schema). Smaller, fewer attack vectors.
- **`CMD` overrides** at deploy time, not in the Dockerfile. The Dockerfile leaves `CMD` empty; deployment manifests specify `node dist/index.js` (API) or `node dist/worker.js` (worker).
- **Migrations as a one-shot Job/initContainer**: same image, `CMD ["node", "dist/scripts/migrate.js"]` (or `pnpm prisma migrate deploy`). Runs before either Deployment rolls out new code, then exits. Keeps schema changes out of the API/worker startup paths.
- **Image tag invariant:** API and worker Deployments always reference the same image tag per deploy. Atomic rollouts; never let them drift.
- **Resource sizing (initial guess, refine via observation):**
  - API: `requests: 250m / 512Mi`, `limits: 1cpu / 1Gi`
  - Worker: `requests: 100m / 256Mi`, `limits: 500m / 512Mi`
  - Migration init: `requests: 100m / 256Mi`, `limits: 500m / 512Mi`
- **Replicas:** API `replicas=3`, Worker `replicas=2`. The `WORKER_QUEUES` env var enables future per-queue worker Deployments without code changes — set it to `"all"` (default) on the single worker Deployment, or to specific queue names if a particular queue justifies its own pool.

---

## 4. Migration order and rollback

Each step ships independently behind per-job `USE_LEGACY_SCHEDULERS_<NAME>` env flag. At any point we can flip a flag and revert to the in-process `setInterval` path without data loss.

| # | Ship | Rollback |
|---|---|---|
| 0 | Logging foundation: extract shared `pino` logger, rename `lib/redis.ts` → `lib/cache-redis.ts`, replace ~23 stray `console.*` calls with structured logger calls | Pure refactor; revert commit |
| 1 | Worker infra (queue-redis client, queue module, worker entry, config module, health server, metrics, telemetry wrapper, stale-scheduler cleanup, Bull Board gated) | Delete worker.ts, stop deploying the worker service |
| 2 | Suspension migration + testcontainers + retry + DLQ | `USE_LEGACY_SCHEDULERS_SUSPENSION=true`, redeploy API |
| 3 | `TenantConfig` schema migration + `getAutomationConfig` + IANA validation helpers | Additive migration; old code ignores new columns |
| 4 | `/settings/automation` UI + API routes | Hide nav entry |
| 5 | Notification-send migration with quiet hours in WHERE | `USE_LEGACY_SCHEDULERS_NOTIFICATION=true` |
| 6 | Delinquency dispatcher + per-tenant fanout + priorities + missed-tick recovery | `USE_LEGACY_SCHEDULERS_DELINQUENCY=true` |
| 7 | SLA breach sweep (new job, default-enabled) | Set `slaBreachSweepEnabled=false` across tenants; no table changes to roll back |
| 8 | Audit retention cleanup job | Pause the queue via Bull Board; rows accumulate but nothing breaks |
| 9 | Remove legacy paths + `USE_LEGACY_*` flags (post-soak, final step) | Final; only after weeks of prod stability |
| 10 | Docs | N/A |

Ship 1 = steps 0-8. Ship 2 hardening = OTel collector integration, HA Redis migration, Grafana dashboards, load/chaos testing, plus the API audit-pipeline refactor (in-transaction direct writes; delete the EventEmitter/audit-writer machinery). Steps 9-10 bundle with the ship 1 final cleanup PR after soak.

---

## 5. Operational concerns

- **Deployment.** API and worker as two services from one image. API command: `node dist/index.js`. Worker command: `node dist/worker.js`. Kubernetes: API `replicas=3`, worker `replicas=2` (BullMQ locks make multi-worker correct).
- **Config.** All env vars loaded + validated through `src/config.ts` at boot. Missing `REDIS_URL` or `DATABASE_URL` halts startup — never silently default.
- **Env vars:**
  - `REDIS_URL` — shared by API and worker.
  - `DISABLE_SCHEDULERS` — worker only; skips queue registration. Used by test runners.
  - `USE_LEGACY_SCHEDULERS_SUSPENSION` / `_NOTIFICATION` / `_DELINQUENCY` — temporary per-job fallback during ship 1. All removed in step 9.
  - `BULL_BOARD_ENABLED` — dev/staging only. Gated behind System Admin role regardless.
  - `WORKER_HTTP_PORT` — default 3002.
- **Health probes.** `/health/live` for k8s `livenessProbe`; `/health/ready` for `readinessProbe`. Worker is "ready" = Redis + DB both reachable.
- **Tests.** Integration tests use Testcontainers for Redis and Postgres. GitHub Actions natively supports Docker and Testcontainers. End-to-end job test per queue: enqueue → consume → assert DB state. Shutdown test: start worker, enqueue a long-running job, send SIGTERM mid-flight, assert clean exit. Reconnect test: kill Redis container, bring it back, assert worker resumes without restart.
- **Monitoring (ship 1).** Prometheus metrics at `/metrics`. Pino logs remain structured JSON. When the OTel collector lands in ship 2, `OTEL_EXPORTER_OTLP_ENDPOINT` env flip starts emitting traces.
- **Capacity planning.** Single worker replica handles ~100 jobs/second on current hardware. At 10k tenants with hourly delinquency (~5% due per hour = 500 jobs/hour), queue depth stays near zero. Scale worker replicas by observing `queue_depth` and `job_lag_seconds`.
- **Timezone data.** Base image `node:22-bookworm-slim` ships full ICU. Verified by integration test that `Intl.DateTimeFormat` correctly returns `"03"` for `America/Los_Angeles` on a DST boundary day. Alpine images are rejected.

---

## 6. Risks

- **Redis becomes a hard dependency.** Before: Redis down = API + schedulers still work. After: Redis down = scheduled work pauses. Mitigation: BullMQ auto-reconnects; worker exits after 5 min disconnection so orchestrator restarts it; enqueue failures don't propagate to user-facing HTTP responses. Ship 2 moves Redis to Sentinel / ElastiCache with automatic failover.
- **Audit table growth from sweep jobs.** A 10k-SR breach sweep writes 10k audits. At 5-minute cadence that's 10k × 288 = 2.88M audits per day under worst case. Mitigation: audit retention policy (§3.6), typical retention 90-365 days, retention sweep bounded to 10min per night.
- **DST boundary days.** If a tenant's `delinquencyRunHourLocal` is 02:30 on a spring-forward day, that local time doesn't exist. Rule: skip that day's run, log a `scheduler.dst_skip` event, resume next day. Documented in runbook.
- **Legacy `setInterval` + BullMQ double-fire during migration window.** While both paths coexist (steps 2-8), misconfigured env flags could run both. Mitigation: each legacy starter emits a warning log line on startup that includes the env flag name; ops greps logs during soak to verify only one path is live per job. Final step removes the legacy code entirely.
- **Tenant timezone change mid-flight.** If a tenant updates their timezone while a `delinquency-tenant` job sits in the queue, the job runs with the old timezone-context. Acceptable — tenants don't change timezone daily; the mispriced case is one off-by-an-hour evaluation.
- **BullMQ repeatable-job semantics churn.** Historical BullMQ releases have changed cron parsing behavior. Mitigation: pin to a specific minor version; upgrade test exercises every repeatable-job definition before bumping.

---

## 7. Ship 2 — deferred hardening

These extend ship 1 without changing its functional behavior:

1. **OTel collector.** Deploy OTel collector alongside workers. Set `OTEL_EXPORTER_OTLP_ENDPOINT` and the spans instrumented in ship 1 start flowing. Add Prisma + Fastify auto-instrumentation for request traces.
2. **Grafana dashboards.** Pre-built dashboards for `job_duration_seconds`, `queue_depth`, `dlq_depth`, `job_lag_seconds`. Alerts on DLQ > 0 for 15 min, queue depth > 1000, job lag > 5 min.
3. **HA Redis.** Move to Sentinel (self-hosted) or ElastiCache with automatic failover (AWS). Update `REDIS_URL` to the Sentinel / cluster endpoint; BullMQ handles the rest.
4. **Load and chaos testing.** k6 load test for queue throughput under synthetic 100k-tenant fan-out. Kill-Redis, kill-worker, kill-DB chaos tests validate recovery matches the documented behavior.
5. **API audit pipeline refactor.** Replace the `events/audit-writer.ts` EventEmitter + serial drain with in-transaction `tx.auditLog.create(...)` calls inside service mutations — same atomicity guarantee as the scheduler's audit writes from ship 1. Delete the EventEmitter machinery. Net code reduction; closes the existing fire-and-forget atomicity gap on the API side. This is **not** an outbox-pattern introduction — there's no external dispatch to isolate; direct in-transaction writes are sufficient. Outbox arrives only when external dispatch (SIEM, webhooks, RAMS) actually lands.
6. **Optional: priority quotas.** If fairness priorities (§3.3) aren't sufficient, add per-tenant rate limits on `delinquency-tenant` so one tenant can't enqueue enough work to starve others even at its assigned priority.
