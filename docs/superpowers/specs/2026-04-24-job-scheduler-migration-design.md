# Job Scheduler Migration — Design Spec

**Date:** 2026-04-24
**Scope:** Move all background schedulers out of the API process into a dedicated BullMQ-backed worker. Introduce tenant-configurable automation (enable/disable, timezone, quiet hours, run-hour). Add SLA breach sweep. Retain current behavior for tenants who haven't touched the config.

---

## 1. Goals and non-goals

### Goals

- **Remove the single-instance constraint.** Today, `startSuspensionScheduler` / `startDelinquencyScheduler` / `startNotificationSendJob` all run inside the API process using `setInterval`. Horizontal API scaling would double-fire jobs. After migration, the API process runs zero timers; a separate worker process owns all scheduled work.
- **Make per-tenant behavior configurable without exposing cron syntax.** Utility admins get a small, discoverable Automation settings page — enable/disable, timezone, quiet hours for outbound comms, daily run hour. No cron fields.
- **Land the SLA breach sweep** that Module 14 Slice B deferred — the queue filter on `sla_breached=true` is currently stale until someone manually edits an SR.
- **Keep the same operational footprint.** BullMQ uses the Redis instance already in `start_db.bat`. No new infra.

### Non-goals

- **Per-tenant custom cadence.** Not exposing cron. If a tenant genuinely needs custom cadence (e.g., a massive utility wanting 1-minute breach sweeps), that's an engineering-gated override, not a self-service setting.
- **Workflow orchestration.** Not Temporal — the jobs are stateless sweeps and enqueue-fanout, not multi-step workflows with compensating actions.
- **Job dashboards for utility admins.** Bull Board is an engineering dashboard, not a user-facing surface. It lives behind admin auth on the API host or a separate internal URL.
- **Retry storms for notification-send.** We keep the existing `attempts < MAX_ATTEMPTS` gating — BullMQ retries replace the in-process retry loop, not stack on top of it.

---

## 2. Chosen stack — BullMQ

**Why BullMQ over alternatives:**

- **Redis already provisioned.** `start_db.bat` launches Redis; we've been using it for session/cache only. BullMQ uses the same connection. No new container.
- **TypeScript-first.** Native types, no `@types/*` sidecar needed. Works cleanly with our ESM build.
- **Repeatable jobs with cron expressions.** Platform-owned cadence stays a simple literal: `{ pattern: "*/5 * * * *" }`.
- **Distributed job locks.** Multiple workers can run without double-firing — the worker pool coordinates through Redis, no leader election needed from us.
- **Bull Board.** One-line Fastify plugin gives us a queue-inspection UI for free.

**What we reject:**

- **JobRunr** — Java-only; would require a JVM sidecar and either direct writes to its Postgres tables or a thin Java proxy. Too much operational weight for the benefit.
- **pg-boss** — valid alternative (Postgres-backed, no Redis for jobs) but throws away the existing Redis and has a smaller ecosystem than BullMQ.
- **Raw `setInterval` in a separate Node process** — doesn't solve the multi-instance problem; two workers would still double-fire.

---

## 3. Architecture

### 3.1 Process topology

```
┌───────────────────┐    enqueue/       ┌───────────────────┐
│  API process      │───"dispatch"──────▶│  Redis (BullMQ)   │
│  (Fastify)        │    ad-hoc jobs    │  queues + locks   │
│                   │                   └─────────┬─────────┘
│  • HTTP routes    │                             │
│  • NO setInterval │                             │ BRPOPLPUSH /
│  • NO scheduler   │                             │ wait-for-job
│    state          │                             ▼
└───────────────────┘                   ┌───────────────────┐
                                        │  Worker process   │
                                        │  (same binary,    │
                                        │  entry = worker.ts)│
                                        │  • cron jobs      │
                                        │  • queue consumers│
                                        │  • same Prisma    │
                                        └───────────────────┘
```

- **Single binary, two entry points.** `packages/api/src/index.ts` starts Fastify; a new `packages/api/src/worker.ts` registers queues + workers. Same dependencies, same Prisma client, same services — just a different `main`. Deploy as two services (`api` and `api-worker`) with different start commands.
- **Redis connection reused.** Shared `redisConnection` module; both API and worker import from it.
- **No HTTP on the worker.** The worker doesn't listen on any port except the optional Bull Board (dev-only, gated by env var).
- **Graceful shutdown.** Workers handle `SIGTERM` by finishing in-flight jobs before exiting (BullMQ's `worker.close()` does this).

### 3.2 Queue shape

One queue per logical job family. We deliberately do *not* consolidate into a single queue — each queue gets its own concurrency knob.

| Queue name | Jobs | Concurrency | Cadence (cron) |
|---|---|---|---|
| `suspension-transitions` | `run-sweep` (no payload) | 1 | `0 * * * *` hourly |
| `notification-send` | `process-batch` (no payload) | 1 | `*/10 * * * * *` every 10s |
| `sla-breach-sweep` | `run-sweep` (no payload) | 1 | `*/5 * * * *` every 5 min |
| `delinquency-dispatch` | `dispatch` (no payload) | 1 | `0 * * * *` hourly |
| `delinquency-tenant` | `evaluate` `{ utilityId }` | 5 | dispatched on demand |

Three of the queues are pure "fire a sweep, no fanout" — pattern #1 single cross-tenant query. Delinquency is pattern #2: a dispatcher cron job enqueues per-tenant jobs, the worker pool drains them concurrently.

### 3.3 Pattern split per job

**Pattern #1 — single cross-tenant query.** The worker handler runs one `updateMany` scoped by tenant config via a join. No Node-side tenant loop.

Applies to: `suspension-transitions`, `notification-send`, `sla-breach-sweep`.

Example (SLA breach sweep):

```ts
export async function sweepSlaBreaches(now: Date): Promise<{ flipped: number }> {
  const result = await prisma.$executeRaw`
    UPDATE service_requests sr
    SET sla_breached = true, updated_at = now()
    FROM tenant_config tc
    WHERE tc.utility_id = sr.utility_id
      AND tc.sla_breach_sweep_enabled = true
      AND sr.status NOT IN ('COMPLETED','CANCELLED')
      AND sr.sla_due_at < ${now}
      AND sr.sla_breached = false
  `;
  return { flipped: Number(result) };
}
```

Quiet-hours for notification-send is the same shape — join `tenant_config`, filter where the tenant's current local time is outside the quiet window.

**Pattern #2 — dispatcher fan-out.** One cron enqueues N tenant-specific jobs, where N is only the tenants whose local time currently matches their configured `delinquencyRunHourLocal` (typically <10% of the tenant base per hour).

```ts
// delinquency-dispatcher (cron handler, runs hourly)
async function dispatchDelinquency(queue: Queue) {
  const candidates = await prisma.tenantConfig.findMany({
    where: { delinquencyEnabled: true },
    select: { utilityId: true, timezone: true, delinquencyRunHourLocal: true },
  });
  const nowUtc = new Date();
  const due = candidates.filter((c) =>
    localHour(nowUtc, c.timezone) === c.delinquencyRunHourLocal,
  );
  await queue.addBulk(
    due.map((c) => ({
      name: "evaluate",
      data: { utilityId: c.utilityId },
      opts: { jobId: `delinquency:${c.utilityId}:${ymdh(nowUtc)}` }, // idempotency
    })),
  );
}
```

The `jobId` is deterministic per `(tenant, hour)` so a repeated dispatch (e.g., cron fires twice during a deploy) doesn't double-enqueue — BullMQ dedupes by jobId.

### 3.4 Tenant config surface

One table, extending the existing `TenantConfig`:

```prisma
model TenantConfig {
  // ... existing fields ...

  // Automation / scheduler tenant config
  timezone                     String  @default("UTC")       // IANA TZ
  schedulersEnabled            Json    @default("{}")        // { suspension: true, notificationSend: true, slaBreachSweep: true, delinquency: true }
  delinquencyRunHourLocal      Int     @default(3)           // 0-23, tenant-local
  notificationQuietStart       String  @default("22:00")     // "HH:mm", tenant-local
  notificationQuietEnd         String  @default("07:00")     // "HH:mm", tenant-local
}
```

Defaults match current behavior (everything enabled, no quiet hours effect because "22:00-07:00" still covers normal business hours; tenants who want stricter can tighten).

The `schedulersEnabled` is a JSON blob rather than four booleans because we expect to add more jobs over time and don't want a migration every time. Unknown keys default to `true` in the helper.

UI: new `/settings/automation` page under the existing Settings group. Sections: General (timezone), Schedulers (4 toggles + per-scheduler summary of cadence), Quiet Hours (two HH:mm inputs for notifications), Daily Runs (integer hour 0-23 for delinquency). RBAC: existing `tenant_profile:EDIT` permission covers it.

### 3.5 Redis connection

```ts
// packages/api/src/lib/redis.ts
import IORedis from "ioredis";
export const redisConnection = new IORedis(
  process.env.REDIS_URL ?? "redis://localhost:6379",
  { maxRetriesPerRequest: null }, // required by BullMQ
);
```

BullMQ requires `maxRetriesPerRequest: null` so the blocking `BRPOP` command doesn't time out under pressure. Both API and worker use this connection for queue enqueue/consume; the existing session/cache code (if any uses ioredis) keeps a separate connection.

### 3.6 Graceful shutdown

```ts
// worker.ts
const workers = [suspensionWorker, notificationWorker, breachWorker, delinquencyDispatcher, delinquencyEvaluator];
process.on("SIGTERM", async () => {
  await Promise.all(workers.map((w) => w.close()));
  await redisConnection.quit();
  process.exit(0);
});
```

In-flight jobs complete; new jobs stay in Redis for the next worker instance to pick up. This lets us rolling-deploy without data loss.

---

## 4. Migration order and rollback

Each step ships independently. At any point we can roll back to the previous step without data loss — BullMQ queues are idempotent and the in-process schedulers remain callable until we remove them.

| Step | What ships | Rollback |
|---|---|---|
| 1 | Worker infra + BullMQ deps + Redis module + `worker.ts` entry + empty `suspension-transitions` queue | Delete worker.ts, revert package.json |
| 2 | Migrate suspension scheduler to pattern #1 (single query). Keep old `setInterval` path behind `USE_LEGACY_SCHEDULERS=true` env fallback for one release cycle | Set `USE_LEGACY_SCHEDULERS=true`, restart API |
| 3 | TenantConfig schema migration + defaults backfill + `getAutomationConfig` service helper | Migration is additive; rollback = ignore new columns |
| 4 | `/settings/automation` UI + API routes for config read/patch | Hide nav entry; routes still accept old shape |
| 5 | Migrate notification-send to pattern #1, add quiet-hours join | Flip `USE_LEGACY_SCHEDULERS=true` for notification-send only (per-job flag) |
| 6 | Migrate delinquency to pattern #2 (dispatcher + per-tenant queue) | Same per-job flag |
| 7 | Add SLA breach sweep (new job, pattern #1, enabled-by-default) | Feature flag off; table unchanged |
| 8 | Remove `USE_LEGACY_SCHEDULERS` paths and the old `startSuspensionScheduler` etc. | Final step; only after weeks of prod soak |

---

## 5. Operational concerns

- **Deployment.** The worker runs as a separate process. In a dev environment we can start it in-process via `pnpm --filter api dev:worker`. In prod, two systemd units (`api.service` and `api-worker.service`) or two Kubernetes deployments with the same image but different commands. A healthy scale-out is `replicas=N` on the API and `replicas=1` on the worker for now (BullMQ locks prevent double-fire, but single-worker-replica sidesteps the need to think about concurrency per queue across replicas).
- **Env vars.** `REDIS_URL` (shared), `DISABLE_SCHEDULERS` (kept for tests — means "don't register cron jobs"), `USE_LEGACY_SCHEDULERS` (temporary fallback, per-step), `BULL_BOARD_ENABLED` (dev/staging only).
- **Tests.** Vitest integration tests run with `DISABLE_SCHEDULERS=true` so nothing auto-fires. Per-job tests call `runSuspensionSweep(now)` directly as a pure function — the BullMQ wiring is dumb glue that doesn't need its own test coverage.
- **Monitoring.** Bull Board exposed on `localhost:3001/admin/queues` in dev (behind admin auth). In prod, rely on pino logs: each handler logs `{ queue, jobId, durationMs, result }` on success; BullMQ emits `failed` events that we forward to pino at `error` level.
- **Idempotency.** The single-query pattern is naturally idempotent (re-running an `updateMany` with the same WHERE hits zero additional rows). Per-tenant delinquency jobs use deterministic `jobId` per `(tenant, hour)` so deploy restarts don't double-fire.

---

## 6. Risks

- **Redis availability becomes a hard dependency.** Today if Redis is down, the API still serves requests; schedulers still fire. After migration, Redis-down means no scheduled work runs. Mitigation: BullMQ reconnects automatically; add a worker-liveness check and alerting; accept that scheduled work pauses during Redis outages.
- **Legacy `setInterval` + BullMQ double-fire during step 2–6.** While both paths coexist, a misconfigured env flag could run both. Mitigation: each legacy starter reads `process.env.USE_LEGACY_SCHEDULERS_<NAME>` (per-job) and logs a warning if both paths are registered. Final step removes the legacy code entirely.
- **Tenant timezone drift.** If a tenant changes timezone between dispatch and execution, a `delinquency-tenant` job that was queued for "3 AM local" runs at a slightly wrong local time. Acceptable — tenants don't change timezone daily; the worst case is one off-by-an-hour evaluation.
- **BullMQ version pinning.** We pin to a specific BullMQ minor version; upgrades require validating that the repeatable-job semantics haven't changed (a known BullMQ churn point historically).
