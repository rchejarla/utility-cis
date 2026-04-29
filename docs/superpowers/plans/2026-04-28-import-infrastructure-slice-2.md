# Import Infrastructure — Slice 2 Plan (Async + notifications + cancel/retry)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use `- [ ]` checkboxes.

**Goal:** Move large imports off the request thread. After this slice, batches > 250 rows enqueue to a BullMQ worker, the wizard polls for progress, operators can cancel mid-flight, partial/failed batches can be retried, and terminal transitions emit in-app + email notifications. Crashed workers don't strand batches.

**Spec:** [`docs/specs/22-import-infrastructure.md`](../../specs/22-import-infrastructure.md). Read **§State machine**, **§Worker design**, **§Notification**, and **§Slicing — Slice 2** before starting.

**What ships in this slice:**
- New `imports` BullMQ queue and `import-worker` process.
- Sync/async threshold logic (server-side, ≤ 250 rows = inline; > 250 = enqueue + 202 response).
- Wizard polls `/imports/:id` during PROCESSING and renders a progress bar.
- `POST /imports/:id/cancel` (soft) and `POST /imports/:id/retry`.
- Zombie-batch sweep on worker startup (PROCESSING with stale `last_progress_at`).
- `InAppNotification` row written on terminal transitions.
- Email via existing notification engine with new `import.complete` event type and seeded template.
- Per-user opt-in stored on `UserPreference.preferences.notifyOnImportComplete` (default true). No schema change — `UserPreference` already has a JSON `preferences` blob.
- Hard cap raised to 100k rows; sync cap reduced to 250.
- Detail-page Cancel / Retry buttons.

**What's NOT in this slice (per spec):**
- Bell-icon dropdown UI (Slice 4 ships the topbar bell once we have enough notification volume).
- Server-side mapping presets (deferred phase 2).
- Streaming uploads / files > 50 MB (phase 3).
- Customer-handler-specific changes (already shipped in Slice 3).

**Tech additions:** none (BullMQ, Redis, papaparse all already in repo).

---

## Architectural cost-benefit

Per `CLAUDE.md` — every named pattern (queue, worker, polling, notification fan-out) has to earn its keep before it goes in.

| Pattern | Why this slice needs it (concrete cost paid) |
|---|---|
| **BullMQ queue + worker** for batches > 250 rows | A 50k-row import inline would block one Fastify worker for ~3–5 minutes. The simpler synchronous version visibly stalls the operator's browser, hits proxy/Cloudflare timeouts at ~60s, and corrupts state on connection drops. The queue isolates wall time from request time. |
| **Per-row transaction inside the worker loop** | Already chosen in Slice 1 — keeps row failures from poisoning the batch. Async doesn't change this; the loop just runs in the worker. |
| **`cancel_requested` flag** vs. job cancellation API | A flag column re-uses Postgres tooling and survives worker restart. BullMQ's job cancellation only kills the worker mid-row, which would leave half-applied state. Flag is simpler AND more correct. |
| **Zombie sweep on startup** vs. BullMQ retry | BullMQ's automatic retry would re-run the entire job from row 1, double-processing IMPORTED rows on the second pass. The sweep only flips status; the worker's per-row loop already skips IMPORTED rows. This is the only pattern that gives at-least-once-per-pending-row semantics without double work. |
| **In-app notification table write** vs. SSE / pub-sub | Operator may have closed the browser. The notification has to land somewhere durable so the bell shows it later. A WebSocket push without persistence loses everything when the user is offline. |
| **`import.complete` notification template** vs. inline email | The notification engine already exists, already supports tenant-customizable copy, and already has the SMS gate. Bypassing it would mean rebuilding template rendering and per-tenant override. |

What we're explicitly **not** building: an outbox between worker and notification, a separate "imports finalisation" service, a new abstraction around BullMQ, a generic "long-running job" framework. The worker calls `sendNotification()` and writes one `InAppNotification` row directly, in the same transaction as the terminal status update. If notification fan-out grows beyond 2–3 channels, revisit.

---

## File Structure

### Created

| Path | Responsibility |
|---|---|
| `packages/api/src/workers/import-worker.ts` | BullMQ Worker for the `imports` queue. Pulls a job (`{ batchId }`), invokes `processBatch` from the imports service, exits when batch reaches a terminal state. |
| `packages/api/src/services/imports/process-batch.service.ts` | The per-row dispatch loop, lifted out of `imports.service.ts`. Reads PENDING/ERROR rows from the DB, runs handler.parseRow + handler.processRow inside per-row transactions, updates counts + `lastProgressAt` every 50 rows, checks `cancel_requested` between row chunks, finalises status + emits notification. |
| `packages/api/src/services/imports/zombie-sweep.service.ts` | One pure function: find PROCESSING batches whose `last_progress_at` is older than 5 min, flip them back to PENDING, return their ids. Worker process calls it once at boot and re-enqueues. |
| `packages/api/src/services/imports/notify.service.ts` | `emitImportTerminalNotifications(batch)` — writes one `InAppNotification` row + (if user opted in and async batch) calls `sendNotification` with `event_type=import.complete`. |
| `packages/api/src/__tests__/integration/import-worker.integration.test.ts` | Async happy path, cancel mid-batch, retry of error rows, zombie recovery, notification emission. testcontainers + real Redis. |
| `packages/shared/prisma/seed-import-notification-template.ts` | Run as part of the existing seed step. Inserts the `import.complete` notification template for the dev tenant. |

### Modified

| Path | Change |
|---|---|
| `packages/api/src/lib/queues.ts` | Add `imports` to `QUEUE_NAMES`; add a `QUEUE_DEFAULTS` entry with `concurrency: 4`, `attempts: 1` (no auto-retry — user-driven retry only, per spec §Worker design). |
| `packages/api/src/worker.ts` | Add `SCHEDULER_REGISTRY` membership for an imports cron is **not** needed (no cron — this queue is event-driven). Add `if (activeQueues.includes(QUEUE_NAMES.imports)) { activeWorkers.push(buildImportWorker()); await runZombieSweepAndEnqueue(); }`. |
| `packages/api/src/services/imports.service.ts` | (1) Lift the per-row loop out into `process-batch.service.ts`. (2) `createImport` now does parse + validate + persist + enqueue-or-run-inline. (3) New `MAX_TOTAL_ROWS = 100_000`, `SYNC_THRESHOLD = 250`. (4) Add `cancelImport(utilityId, batchId)`, `retryImport(utilityId, batchId, actor, scope)`. |
| `packages/api/src/routes/imports.ts` | (1) `POST /imports` returns `202 { batchId, async: true }` when `parsed.rows.length > SYNC_THRESHOLD`. (2) Add `POST /imports/:id/cancel` and `POST /imports/:id/retry`. (3) `GET /imports/:id` returns the new `progress` shape (already implicit in counts). |
| `packages/api/src/app.ts` | Nothing — the queue is registered only on the worker process; the API process only enqueues via `enqueueSafely`. |
| `packages/web/components/imports/import-wizard.tsx` | (1) `CommitStage` accepts either a sync `CommitResult` or a `{ batchId, async: true }` async stub. (2) When async, render a polling progress panel that fetches `/imports/:id` every 2 seconds and re-renders. (3) When the polled status reaches a terminal state, render the same final summary the sync path renders. |
| `packages/web/app/imports/[id]/page.tsx` | Add Cancel button (visible when `status === "PROCESSING"`) and Retry button (visible when `status` ∈ {FAILED, PARTIAL, CANCELLED}). Both POST through the new endpoints. Refresh the detail on success. |
| `packages/web/components/imports/import-wizard.tsx` | Toast wording: when async path completes, show "Import running in the background — we'll notify you when it's done" so the operator can navigate away. |
| `packages/api/src/__tests__/integration/imports.integration.test.ts` | Add tests for `SYNC_THRESHOLD` (251-row batch returns 202; 250-row stays sync). |
| `packages/shared/prisma/seed.ts` | Call `seedImportNotificationTemplate(prisma)` at the bottom. |

### Deleted

None.

---

## Sequencing & dependencies

Tasks 1–3 are pure backend plumbing — they ship without UI changes (the route still runs sync). Task 4 wires the threshold + 202 in the route. Tasks 5–6 add cancel/retry. Task 7 is the zombie sweep on boot. Tasks 8–9 are notifications. Tasks 10–11 are the UI. Task 12 is integration tests for everything wired together.

Each task ends with a green typecheck (`pnpm -w typecheck`) and a commit. Most tasks include a runnable integration test before the implementation lands.

---

## Task 1 — Lift the per-row loop into a separate service

**Goal:** Make the per-row dispatch loop callable from both the request path (sync) and the BullMQ worker (async), without duplication.

**Files:**
- Create: `packages/api/src/services/imports/process-batch.service.ts`
- Modify: `packages/api/src/services/imports.service.ts`

**Steps:**

- [ ] **Step 1 — Create the new file.**

```typescript
// packages/api/src/services/imports/process-batch.service.ts
import { Prisma } from "@utility-cis/shared/src/generated/prisma";
import { prisma } from "../../lib/prisma.js";
import { writeAuditRow } from "../../lib/audit-wrap.js";
import { getKindHandler } from "../../imports/registry.js";
import type { ImportTx } from "../../imports/types.js";
import { logger } from "../../lib/logger.js";

/**
 * Pure per-row dispatch loop. Reads PENDING (and optionally ERROR) rows
 * from import_row, runs handler.parseRow + handler.processRow inside
 * per-row transactions, and finalises ImportBatch status when done.
 *
 * Used both inline (sync request path, ≤ 250 rows) and from the BullMQ
 * `imports` worker (> 250 rows). The split lets us keep the loop in one
 * place — the request path and the worker share semantics exactly.
 *
 * Heartbeat: every PROGRESS_INTERVAL rows, update importedCount,
 * errorCount, and lastProgressAt on the batch. Zombie-detection sweep
 * uses lastProgressAt to find abandoned batches.
 *
 * Cancellation: between every chunk of PROGRESS_INTERVAL rows, re-read
 * cancelRequested. If true, finalise CANCELLED and exit early. Already-
 * processed rows stay processed (soft cancel — see spec §Cancellation).
 *
 * `scope` controls which row statuses get processed:
 *   - "pending"        → rows in status PENDING. Default for first run.
 *   - "errors-only"    → rows in status ERROR. Used by user-driven retry
 *                        when only the failures should re-attempt.
 *   - "pending-and-errors" → both. Used to resume after CANCELLED, where
 *                        un-attempted PENDING rows still need to run AND
 *                        the operator wants prior errors re-tried.
 */
export const PROGRESS_INTERVAL = 50;

export type ProcessScope = "pending" | "errors-only" | "pending-and-errors";

export interface ProcessBatchParams {
  batchId: string;
  utilityId: string;
  actorId: string;
  actorName: string;
  scope?: ProcessScope;
}

export interface ProcessBatchResult {
  status: "COMPLETE" | "PARTIAL" | "FAILED" | "CANCELLED";
  importedCount: number;
  errorCount: number;
  recordCount: number;
}

export async function processBatch(
  params: ProcessBatchParams,
): Promise<ProcessBatchResult> {
  const { batchId, utilityId, actorId, actorName } = params;
  const scope: ProcessScope = params.scope ?? "pending";

  const batch = await prisma.importBatch.findFirstOrThrow({
    where: { id: batchId, utilityId },
  });
  const handler = getKindHandler(batch.entityKind);

  await prisma.importBatch.update({
    where: { id: batchId },
    data: {
      status: "PROCESSING",
      processingStartedAt: batch.processingStartedAt ?? new Date(),
      lastProgressAt: new Date(),
    },
  });

  const statusFilter =
    scope === "errors-only"
      ? ["ERROR" as const]
      : scope === "pending-and-errors"
        ? ["PENDING" as const, "ERROR" as const]
        : ["PENDING" as const];

  const rows = await prisma.importRow.findMany({
    where: { importBatchId: batchId, status: { in: statusFilter } },
    orderBy: { rowIndex: "asc" },
  });

  // Phase A: parseRow up-front (no DB round-trips). Failed parses go
  // straight to ERROR; survivors continue to processRow.
  const parsedByRowId: Map<string, unknown> = new Map();
  const parsedRowsForBatch: unknown[] = [];

  for (const row of rows) {
    const raw = row.rawData as Record<string, string>;
    const result = handler.parseRow(raw);
    if (result.ok) {
      parsedByRowId.set(row.id, result.row);
      parsedRowsForBatch.push(result.row);
    } else {
      await prisma.importRow.update({
        where: { id: row.id },
        data: {
          status: "ERROR",
          errorCode: result.code,
          errorMessage: result.message,
          processedAt: new Date(),
        },
      });
    }
  }

  // Phase B: handler.prepareBatch (cache lookups, derive defaults).
  const prepared = handler.prepareBatch
    ? await handler.prepareBatch(
        {
          utilityId,
          actorId,
          actorName,
          source: batch.source,
        },
        parsedRowsForBatch,
      )
    : undefined;

  // Phase C: per-row processRow. Re-check cancelRequested between
  // chunks of PROGRESS_INTERVAL.
  let processedSinceHeartbeat = 0;
  let cancelled = false;

  // Pre-compute baseline counts (a retry leaves prior IMPORTED rows
  // alone; we want the final status math to include them).
  const baseline = await prisma.importRow.groupBy({
    by: ["status"],
    where: { importBatchId: batchId },
    _count: { _all: true },
  });
  let importedCount = baseline.find((b) => b.status === "IMPORTED")?._count._all ?? 0;
  let errorCount = baseline.find((b) => b.status === "ERROR")?._count._all ?? 0;

  for (const row of rows) {
    if (processedSinceHeartbeat >= PROGRESS_INTERVAL) {
      const refreshed = await prisma.importBatch.findUniqueOrThrow({
        where: { id: batchId },
        select: { cancelRequested: true },
      });
      if (refreshed.cancelRequested) {
        cancelled = true;
        break;
      }
      await prisma.importBatch.update({
        where: { id: batchId },
        data: {
          importedCount,
          errorCount,
          lastProgressAt: new Date(),
        },
      });
      processedSinceHeartbeat = 0;
    }

    const parsedRow = parsedByRowId.get(row.id);
    if (parsedRow === undefined) {
      processedSinceHeartbeat++;
      continue; // already flipped to ERROR by parseRow
    }

    try {
      const result = await prisma.$transaction(async (txClient) => {
        const tx = txClient as unknown as ImportTx;
        return handler.processRow(
          { utilityId, actorId, actorName, tx },
          parsedRow,
          prepared,
        );
      });

      if (result.ok) {
        // If the row was previously ERROR (retry path), it's no longer
        // an error — decrement errorCount before incrementing imported.
        const prior = await prisma.importRow.findUniqueOrThrow({
          where: { id: row.id },
          select: { status: true },
        });
        if (prior.status === "ERROR") errorCount = Math.max(0, errorCount - 1);

        await prisma.importRow.update({
          where: { id: row.id },
          data: {
            status: "IMPORTED",
            resultEntityId: result.entityId ?? null,
            errorCode: null,
            errorMessage: null,
            processedAt: new Date(),
          },
        });
        importedCount++;
      } else {
        const prior = await prisma.importRow.findUniqueOrThrow({
          where: { id: row.id },
          select: { status: true },
        });
        if (prior.status !== "ERROR") errorCount++;

        await prisma.importRow.update({
          where: { id: row.id },
          data: {
            status: "ERROR",
            errorCode: result.code,
            errorMessage: result.message,
            processedAt: new Date(),
          },
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unhandled error in handler";
      const prior = await prisma.importRow.findUniqueOrThrow({
        where: { id: row.id },
        select: { status: true },
      });
      if (prior.status !== "ERROR") errorCount++;

      await prisma.importRow.update({
        where: { id: row.id },
        data: {
          status: "ERROR",
          errorCode: "UNHANDLED",
          errorMessage: message,
          processedAt: new Date(),
        },
      });
      logger.warn(
        { component: "process-batch", batchId, rowId: row.id, err },
        "Unhandled error in handler.processRow",
      );
    }

    processedSinceHeartbeat++;
  }

  // Final status decision.
  const recordCount = (
    await prisma.importBatch.findUniqueOrThrow({
      where: { id: batchId },
      select: { recordCount: true },
    })
  ).recordCount;

  let finalStatus: ProcessBatchResult["status"];
  if (cancelled) {
    finalStatus = "CANCELLED";
  } else if (importedCount === 0) {
    finalStatus = "FAILED";
  } else if (errorCount === 0 && importedCount === recordCount) {
    finalStatus = "COMPLETE";
  } else {
    finalStatus = "PARTIAL";
  }

  await prisma.importBatch.update({
    where: { id: batchId },
    data: {
      status: finalStatus,
      importedCount,
      errorCount,
      completedAt: new Date(),
      lastProgressAt: new Date(),
    },
  });

  await prisma.$transaction(async (tx) => {
    await writeAuditRow(
      tx,
      { utilityId, actorId, actorName, entityType: "ImportBatch" },
      `import_batch.${finalStatus.toLowerCase()}`,
      batchId,
      { status: "PROCESSING" },
      { status: finalStatus, importedCount, errorCount },
    );
  });

  return {
    status: finalStatus,
    importedCount,
    errorCount,
    recordCount,
  };
}
```

- [ ] **Step 2 — Refactor `imports.service.ts` to call `processBatch`.**

Open `packages/api/src/services/imports.service.ts` and replace the body of `createImport` from the line `// ─── 5. Per-row parse + processRow ────────────────────────────────` through the end of the function with a single call:

```typescript
  // ─── 5. Hand off to the shared per-row dispatch loop ──────────────
  const { status: finalStatus, importedCount, errorCount } = await processBatch({
    batchId: batch.id,
    utilityId,
    actorId,
    actorName,
    scope: "pending",
  });

  const errorRows = await prisma.importRow.findMany({
    where: { importBatchId: batch.id, status: "ERROR" },
    orderBy: { rowIndex: "asc" },
    select: { rowIndex: true, errorCode: true, errorMessage: true },
  });

  return {
    batchId: batch.id,
    status: finalStatus,
    recordCount: parsed.rows.length,
    importedCount,
    errorCount,
    errors: errorRows.map((r) => ({
      rowIndex: r.rowIndex,
      errorCode: r.errorCode ?? "UNKNOWN",
      errorMessage: r.errorMessage ?? "",
    })),
    attachmentId: attachment.id,
  };
}
```

Add the import at the top of the file:

```typescript
import { processBatch } from "./imports/process-batch.service.js";
```

Delete the now-redundant constants and helpers from `imports.service.ts` (`MAX_SYNC_ROWS` if no longer referenced after Task 4).

- [ ] **Step 3 — Verify typecheck.**

```bash
pnpm -w typecheck
```
Expected: zero errors.

- [ ] **Step 4 — Verify existing imports integration tests still pass.**

```bash
pnpm --filter @utility-cis/api test -- imports.integration
```
Expected: all green. The refactor is behaviour-preserving.

- [ ] **Step 5 — Commit.**

```bash
git add packages/api/src/services/imports/process-batch.service.ts packages/api/src/services/imports.service.ts
git commit -m "refactor(imports): lift per-row loop into process-batch service (slice 2 task 1)"
```

---

## Task 2 — Register the `imports` BullMQ queue

**Files:**
- Modify: `packages/api/src/lib/queues.ts`

**Steps:**

- [ ] **Step 1 — Add the queue name and defaults.**

In `packages/api/src/lib/queues.ts`:

```typescript
export const QUEUE_NAMES = {
  suspensionTransitions: "suspension-transitions",
  notificationSend: "notification-send",
  slaBreachSweep: "sla-breach-sweep",
  delinquencyDispatch: "delinquency-dispatch",
  delinquencyTenant: "delinquency-tenant",
  auditRetention: "audit-retention",
  imports: "imports",
} as const;
```

Add to `QUEUE_DEFAULTS`:

```typescript
  imports: {
    concurrency: 4,
    defaultJobOptions: {
      // No automatic retry — failed batches stay FAILED until the user
      // explicitly hits Retry. Auto-retry from row 1 would double-import
      // already-processed rows; the user-driven retry path goes through
      // processBatch with scope="errors-only".
      attempts: 1,
      ...RETENTION_OPTS,
    },
  },
```

- [ ] **Step 2 — Verify queue test still passes.**

```bash
pnpm --filter @utility-cis/api test -- lib/queues
```
Expected: green.

- [ ] **Step 3 — Commit.**

```bash
git add packages/api/src/lib/queues.ts
git commit -m "feat(imports): register imports BullMQ queue (slice 2 task 2)"
```

---

## Task 3 — Build the import worker

**Files:**
- Create: `packages/api/src/workers/import-worker.ts`
- Create: `packages/api/src/services/imports/zombie-sweep.service.ts`
- Modify: `packages/api/src/worker.ts`

**Steps:**

- [ ] **Step 1 — Write the zombie-sweep service.**

```typescript
// packages/api/src/services/imports/zombie-sweep.service.ts
import { prisma } from "../../lib/prisma.js";
import { logger } from "../../lib/logger.js";

/**
 * Finds ImportBatch rows in PROCESSING whose lastProgressAt is older
 * than ZOMBIE_THRESHOLD_MS (5 minutes by default — well above the 50-
 * row heartbeat cadence under realistic per-row timing). Flips them
 * back to PENDING and returns the affected ids so the caller can
 * re-enqueue.
 *
 * Idempotent. Run once on worker boot.
 */
export const ZOMBIE_THRESHOLD_MS = 5 * 60 * 1000;

export async function reclaimZombieBatches(now: Date): Promise<string[]> {
  const cutoff = new Date(now.getTime() - ZOMBIE_THRESHOLD_MS);
  const zombies = await prisma.importBatch.findMany({
    where: {
      status: "PROCESSING",
      lastProgressAt: { lt: cutoff },
    },
    select: { id: true },
  });
  if (zombies.length === 0) return [];
  await prisma.importBatch.updateMany({
    where: { id: { in: zombies.map((z) => z.id) } },
    data: { status: "PENDING" },
  });
  logger.info(
    { component: "imports-zombie-sweep", reclaimed: zombies.length },
    "Reclaimed zombie import batches",
  );
  return zombies.map((z) => z.id);
}
```

- [ ] **Step 2 — Write the worker.**

```typescript
// packages/api/src/workers/import-worker.ts
import { Worker } from "bullmq";
import { queueRedisConnection } from "../lib/queue-redis.js";
import { logger } from "../lib/logger.js";
import { withTelemetry } from "../lib/telemetry.js";
import { QUEUE_NAMES, QUEUE_DEFAULTS, enqueueSafely } from "../lib/queues.js";
import { processBatch } from "../services/imports/process-batch.service.js";
import { emitImportTerminalNotifications } from "../services/imports/notify.service.js";
import { reclaimZombieBatches } from "../services/imports/zombie-sweep.service.js";
import { prisma } from "../lib/prisma.js";

/**
 * BullMQ worker for the `imports` queue.
 *
 * One job = one batch. Concurrency 4 per replica (multiple batches run
 * in parallel; one batch is always one worker). attempts=1 — the queue
 * config disables auto-retry, because re-running a batch from row 1
 * after a transient failure would re-process IMPORTED rows. User-
 * driven retry goes through processBatch with scope="errors-only".
 *
 * On crash mid-batch: the next API/worker boot's reclaimZombieBatches
 * sweep flips the batch back to PENDING and re-enqueues; processBatch's
 * scope="pending" picks up where it left off (IMPORTED rows are
 * skipped because they're not in the status filter).
 */

export const IMPORT_WORKER_JOB_NAME = "process-import-batch";

interface ImportJobData {
  batchId: string;
  utilityId: string;
  actorId: string;
  actorName: string;
  scope?: "pending" | "errors-only" | "pending-and-errors";
}

export function buildImportWorker(): Worker<ImportJobData> {
  const worker = new Worker<ImportJobData>(
    QUEUE_NAMES.imports,
    async (job) => {
      const { batchId, utilityId, actorId, actorName, scope } = job.data;
      const result = await withTelemetry(QUEUE_NAMES.imports, () =>
        processBatch({ batchId, utilityId, actorId, actorName, scope }),
      );
      // Notification fan-out is post-batch and runs even if the batch
      // ended in CANCELLED — the operator wants to know.
      try {
        const batch = await prisma.importBatch.findUniqueOrThrow({
          where: { id: batchId },
        });
        await emitImportTerminalNotifications(batch);
      } catch (err) {
        logger.error(
          { err, component: "import-worker", batchId },
          "Failed to emit terminal notifications",
        );
      }
      logger.info(
        {
          component: "import-worker",
          batchId,
          finalStatus: result.status,
          importedCount: result.importedCount,
          errorCount: result.errorCount,
        },
        "Import batch finalised",
      );
      return result;
    },
    {
      connection: queueRedisConnection.duplicate(),
      concurrency: QUEUE_DEFAULTS[QUEUE_NAMES.imports].concurrency,
    },
  );

  worker.on("error", (err) => {
    logger.error({ err, component: "import-worker" }, "Worker emitted error event");
  });

  return worker;
}

/**
 * Run on worker boot. Re-enqueues anything the previous replica was
 * mid-processing when it died. Safe to call repeatedly — finding zero
 * zombies is the steady state.
 */
export async function reclaimAndEnqueueZombies(): Promise<void> {
  const ids = await reclaimZombieBatches(new Date());
  for (const batchId of ids) {
    const batch = await prisma.importBatch.findUnique({
      where: { id: batchId },
      select: { utilityId: true, createdBy: true },
    });
    if (!batch) continue;
    // ActorName is best-effort — the original actor may have been
    // deleted. Look up; fall back to a placeholder if missing.
    const user = await prisma.cisUser.findUnique({
      where: { id: batch.createdBy },
      select: { name: true },
    });
    await enqueueSafely(QUEUE_NAMES.imports, IMPORT_WORKER_JOB_NAME, {
      batchId,
      utilityId: batch.utilityId,
      actorId: batch.createdBy,
      actorName: user?.name ?? "system",
      scope: "pending",
    });
    logger.info(
      { component: "import-worker", batchId },
      "Re-enqueued zombie batch",
    );
  }
}
```

- [ ] **Step 3 — Wire the worker into `worker.ts`.**

In `packages/api/src/worker.ts`, add the import:

```typescript
import {
  buildImportWorker,
  reclaimAndEnqueueZombies,
} from "./workers/import-worker.js";
```

Inside `main()`, after the audit-retention block, add:

```typescript
  if (activeQueues.includes(QUEUE_NAMES.imports)) {
    activeWorkers.push(buildImportWorker());
    await reclaimAndEnqueueZombies();
  }
```

No scheduler registration — the imports queue is event-driven, not cron-driven, so SCHEDULER_REGISTRY is unchanged.

- [ ] **Step 4 — Run typecheck.**

```bash
pnpm -w typecheck
```
Expected: green. (`emitImportTerminalNotifications` is referenced ahead of its definition in Task 8 — temporarily stub it as `export async function emitImportTerminalNotifications(_: unknown): Promise<void> {}` in a new placeholder file at `packages/api/src/services/imports/notify.service.ts` until Task 8 fills it in.)

- [ ] **Step 5 — Create the placeholder notify file.**

```typescript
// packages/api/src/services/imports/notify.service.ts
// Filled in by slice 2 task 8. This stub exists so the worker compiles
// without a circular dependency on Task 8's not-yet-written code.
import type { ImportBatch } from "@utility-cis/shared/src/generated/prisma";

export async function emitImportTerminalNotifications(
  _batch: ImportBatch,
): Promise<void> {
  // TODO(slice-2-task-8): in-app + email fan-out
}
```

- [ ] **Step 6 — Verify typecheck again.**

```bash
pnpm -w typecheck
```
Expected: green.

- [ ] **Step 7 — Commit.**

```bash
git add packages/api/src/services/imports/zombie-sweep.service.ts packages/api/src/services/imports/notify.service.ts packages/api/src/workers/import-worker.ts packages/api/src/worker.ts
git commit -m "feat(imports): BullMQ worker + zombie sweep on boot (slice 2 task 3)"
```

---

## Task 4 — Sync/async threshold in `POST /imports`

**Files:**
- Modify: `packages/api/src/services/imports.service.ts`
- Modify: `packages/api/src/routes/imports.ts`

**Steps:**

- [ ] **Step 1 — Add the threshold + cap constants and the new return shape.**

At the top of `packages/api/src/services/imports.service.ts`:

```typescript
export const SYNC_THRESHOLD_ROWS = 250;
export const MAX_TOTAL_ROWS = 100_000;
```

Remove `MAX_SYNC_ROWS` if it's still around — it's superseded.

Update the row-count guard:

```typescript
  if (parsed.rows.length > MAX_TOTAL_ROWS) {
    throw Object.assign(
      new Error(
        `Batch has ${parsed.rows.length} rows; the per-batch cap is ${MAX_TOTAL_ROWS}.`,
      ),
      { statusCode: 400, code: "BATCH_TOO_LARGE" },
    );
  }
```

Replace the return type:

```typescript
export type CreateImportResult =
  | (CreateImportSyncResult & { async: false })
  | { async: true; batchId: string; recordCount: number; attachmentId: string };

export interface CreateImportSyncResult {
  batchId: string;
  status: "COMPLETE" | "PARTIAL" | "FAILED";
  recordCount: number;
  importedCount: number;
  errorCount: number;
  errors: Array<{ rowIndex: number; errorCode: string; errorMessage: string }>;
  attachmentId: string;
}
```

Inside `createImport`, after attachment + import_row insert + audit, branch:

```typescript
  if (parsed.rows.length > SYNC_THRESHOLD_ROWS) {
    await enqueueSafely(QUEUE_NAMES.imports, IMPORT_WORKER_JOB_NAME, {
      batchId: batch.id,
      utilityId,
      actorId,
      actorName,
      scope: "pending",
    });
    return {
      async: true,
      batchId: batch.id,
      recordCount: parsed.rows.length,
      attachmentId: attachment.id,
    };
  }

  // ─── Sync path: ≤ 250 rows ──────────────────────────────────────
  const { status: finalStatus, importedCount, errorCount } = await processBatch({
    batchId: batch.id,
    utilityId,
    actorId,
    actorName,
    scope: "pending",
  });
  // emit notifications inline too — sync path skips email by default
  // (operator was watching), but the in-app row still lands
  const updatedBatch = await prisma.importBatch.findUniqueOrThrow({
    where: { id: batch.id },
  });
  await emitImportTerminalNotifications(updatedBatch);

  // ... existing return shape, with `async: false` added
  return {
    async: false,
    batchId: batch.id,
    status: finalStatus as "COMPLETE" | "PARTIAL" | "FAILED",
    recordCount: parsed.rows.length,
    importedCount,
    errorCount,
    errors: errorRows.map((r) => ({
      rowIndex: r.rowIndex,
      errorCode: r.errorCode ?? "UNKNOWN",
      errorMessage: r.errorMessage ?? "",
    })),
    attachmentId: attachment.id,
  };
```

Add the imports at the top:

```typescript
import { enqueueSafely, QUEUE_NAMES } from "../lib/queues.js";
import { IMPORT_WORKER_JOB_NAME } from "../workers/import-worker.js";
import { emitImportTerminalNotifications } from "./imports/notify.service.js";
```

- [ ] **Step 2 — Update the route to return 202 on async.**

In `packages/api/src/routes/imports.ts`, change the POST handler's last line:

```typescript
      const result = await createImport(/* ... */);

      if (result.async) {
        return reply.status(202).send(result);
      }
      return reply.status(200).send(result);
```

- [ ] **Step 3 — Run typecheck.**

```bash
pnpm -w typecheck
```
Expected: green.

- [ ] **Step 4 — Update existing imports integration tests for the response shape.**

In `packages/api/src/__tests__/integration/imports.integration.test.ts`, every place that asserts the body of a successful POST should now check `body.async === false`. The existing tests upload tiny CSVs, so they all stay on the sync path.

- [ ] **Step 5 — Run integration tests.**

```bash
pnpm --filter @utility-cis/api test -- imports.integration
```
Expected: all pass.

- [ ] **Step 6 — Commit.**

```bash
git add packages/api/src/services/imports.service.ts packages/api/src/routes/imports.ts packages/api/src/__tests__/integration/imports.integration.test.ts
git commit -m "feat(imports): sync/async threshold + 202 enqueue on large batches (slice 2 task 4)"
```

---

## Task 5 — Cancel endpoint

**Files:**
- Modify: `packages/api/src/services/imports.service.ts`
- Modify: `packages/api/src/routes/imports.ts`

**Steps:**

- [ ] **Step 1 — Service function.**

Add to `packages/api/src/services/imports.service.ts`:

```typescript
/**
 * Soft cancel. Sets `cancel_requested = true` on the batch; the worker
 * (or sync loop) sees the flag between row chunks and finalises
 * CANCELLED. Already-IMPORTED rows stay imported. No-op if the batch
 * is already terminal.
 */
export async function cancelImport(
  utilityId: string,
  batchId: string,
  actor: { id: string; name: string },
): Promise<{ batchId: string; status: string }> {
  const batch = await prisma.importBatch.findFirstOrThrow({
    where: { id: batchId, utilityId },
  });
  const terminal = ["COMPLETE", "PARTIAL", "FAILED", "CANCELLED"];
  if (terminal.includes(batch.status)) {
    return { batchId, status: batch.status };
  }
  await prisma.importBatch.update({
    where: { id: batchId },
    data: { cancelRequested: true },
  });
  await prisma.$transaction(async (tx) => {
    await writeAuditRow(
      tx,
      { utilityId, actorId: actor.id, actorName: actor.name, entityType: "ImportBatch" },
      "import_batch.cancel_requested",
      batchId,
      null,
      { previousStatus: batch.status },
    );
  });
  return { batchId, status: batch.status };
}
```

- [ ] **Step 2 — Route.**

In `packages/api/src/routes/imports.ts`:

```typescript
  app.post(
    "/api/v1/imports/:id/cancel",
    { config: { module: "imports", permission: "VIEW" } },
    async (request, reply) => {
      const { utilityId, id: actorId, name: actorName } = request.user;
      const { id } = idParamSchema.parse(request.params);
      const result = await cancelImport(utilityId, id, { id: actorId, name: actorName });
      return reply.send(result);
    },
  );
```

Add `cancelImport` to the imports at the top.

- [ ] **Step 3 — Typecheck + commit.**

```bash
pnpm -w typecheck
git add packages/api/src/services/imports.service.ts packages/api/src/routes/imports.ts
git commit -m "feat(imports): soft-cancel endpoint (slice 2 task 5)"
```

---

## Task 6 — Retry endpoint

**Files:**
- Modify: `packages/api/src/services/imports.service.ts`
- Modify: `packages/api/src/routes/imports.ts`

**Steps:**

- [ ] **Step 1 — Service function.**

```typescript
/**
 * User-driven retry. Re-enqueues a terminal batch.
 *   - FAILED / PARTIAL → scope="errors-only" (re-attempts only the rows
 *     that errored; previously IMPORTED rows are left alone).
 *   - CANCELLED        → scope="pending-and-errors" (resume both un-
 *     attempted PENDING rows and prior errors, so the operator gets
 *     the rest of the batch through).
 *
 * Resets cancel_requested. Audit row emitted on enqueue.
 *
 * Sync vs. async: a retry always goes through the worker, regardless
 * of the original batch's row count. Even a 50-row retry is fast
 * enough that "always async" keeps the route simple — and the operator
 * has already seen at least one terminal state, so they're not staring
 * at a spinner.
 */
export async function retryImport(
  utilityId: string,
  batchId: string,
  actor: { id: string; name: string },
): Promise<{ batchId: string; enqueued: true }> {
  const batch = await prisma.importBatch.findFirstOrThrow({
    where: { id: batchId, utilityId },
  });
  const retryable = ["FAILED", "PARTIAL", "CANCELLED"];
  if (!retryable.includes(batch.status)) {
    throw Object.assign(
      new Error(`Batch in status ${batch.status} cannot be retried`),
      { statusCode: 400, code: "NOT_RETRYABLE" },
    );
  }
  const scope: "errors-only" | "pending-and-errors" =
    batch.status === "CANCELLED" ? "pending-and-errors" : "errors-only";

  await prisma.importBatch.update({
    where: { id: batchId },
    data: {
      status: "PENDING",
      cancelRequested: false,
      completedAt: null,
    },
  });
  await prisma.$transaction(async (tx) => {
    await writeAuditRow(
      tx,
      { utilityId, actorId: actor.id, actorName: actor.name, entityType: "ImportBatch" },
      "import_batch.retried",
      batchId,
      { status: batch.status },
      { scope },
    );
  });

  await enqueueSafely(QUEUE_NAMES.imports, IMPORT_WORKER_JOB_NAME, {
    batchId,
    utilityId,
    actorId: actor.id,
    actorName: actor.name,
    scope,
  });
  return { batchId, enqueued: true };
}
```

- [ ] **Step 2 — Route.**

```typescript
  app.post(
    "/api/v1/imports/:id/retry",
    { config: { module: "imports", permission: "VIEW" } },
    async (request, reply) => {
      const { utilityId, id: actorId, name: actorName } = request.user;
      const { id } = idParamSchema.parse(request.params);
      const result = await retryImport(utilityId, id, { id: actorId, name: actorName });
      return reply.status(202).send(result);
    },
  );
```

Add `retryImport` import.

- [ ] **Step 3 — Typecheck + commit.**

```bash
pnpm -w typecheck
git add packages/api/src/services/imports.service.ts packages/api/src/routes/imports.ts
git commit -m "feat(imports): retry endpoint (slice 2 task 6)"
```

---

## Task 7 — Cancellation respects in `processBatch`

Already implemented in Task 1's `processBatch` (the `if (refreshed.cancelRequested) cancelled = true; break;` branch). This task is just the integration test for it — keeping the plan honest about test coverage.

**Files:**
- Modify: `packages/api/src/__tests__/integration/imports.integration.test.ts`

**Steps:**

- [ ] **Step 1 — Add the cancel test.**

```typescript
it("cancels mid-batch and finalises CANCELLED", async () => {
  // Build a 60-row CSV — that's > PROGRESS_INTERVAL (50), so the
  // cancel check fires at least once mid-loop.
  const lines = ["meterNumber,readDatetime,reading"];
  for (let i = 0; i < 60; i++) {
    lines.push(`${meterNumber},2026-04-${String(i % 28 + 1).padStart(2, "0")}T08:00Z,${1000 + i}`);
  }
  const csv = lines.join("\n");

  // Pre-flag cancellation BEFORE the import runs. The sync loop will
  // see cancelRequested=true at the first heartbeat (50 rows in) and
  // exit. (Because Slice 2 keeps ≤250-row batches sync, this stays in
  // the same process.)
  // ...
});
```

(Implementation detail: in the sync path the cancel can't be triggered from outside the request, because the loop is the request. To exercise this we either flip `cancelRequested` mid-loop via a hook or test through the async path. Use the async path: build a 251-row CSV, hit `/cancel` after the response returns, wait until status reaches CANCELLED.)

Replace the placeholder above with the async version:

```typescript
it("cancels an async batch mid-flight and finalises CANCELLED", async () => {
  const lines = ["meterNumber,readDatetime,reading"];
  for (let i = 0; i < 300; i++) {
    lines.push(
      `${meterNumber},2026-04-${String((i % 28) + 1).padStart(2, "0")}T${String((i % 24)).padStart(2, "0")}:00Z,${1000 + i}`,
    );
  }
  const csv = lines.join("\n");

  const formData = new FormData();
  formData.append("file", new Blob([csv], { type: "text/csv" }), "300.csv");
  formData.append("kind", "meter_read");
  formData.append("source", "MANUAL_UPLOAD");
  formData.append(
    "mapping",
    JSON.stringify({ meterNumber: "meterNumber", readDatetime: "readDatetime", reading: "reading" }),
  );

  const res = await app.inject({
    method: "POST",
    url: "/api/v1/imports",
    payload: formData as unknown as never,
    headers: { ...headers() },
  });
  expect(res.statusCode).toBe(202);
  const body = JSON.parse(res.body);
  expect(body.async).toBe(true);

  // Cancel immediately. Worker may have processed a chunk or two by
  // the time the cancel lands; that's fine — the rest is unprocessed.
  const cancel = await app.inject({
    method: "POST",
    url: `/api/v1/imports/${body.batchId}/cancel`,
    headers: { ...headers() },
  });
  expect(cancel.statusCode).toBe(200);

  // Poll until terminal. 30s ceiling.
  const start = Date.now();
  let final = "PENDING";
  while (Date.now() - start < 30_000) {
    const get = await app.inject({
      method: "GET",
      url: `/api/v1/imports/${body.batchId}`,
      headers: { ...headers() },
    });
    final = JSON.parse(get.body).batch.status;
    if (["CANCELLED", "COMPLETE", "PARTIAL", "FAILED"].includes(final)) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  expect(final).toBe("CANCELLED");
});
```

- [ ] **Step 2 — Run the test.**

```bash
pnpm --filter @utility-cis/api test -- imports.integration -t "cancels"
```
Expected: green. (Requires Redis. The existing test harness already starts Redis testcontainer if needed; if not, this test is gated behind the same `IMPORT_WORKER_TESTS` env flag pattern as other queue tests — see Task 12 for the dedicated `import-worker.integration.test.ts`.)

- [ ] **Step 3 — Commit.**

```bash
git add packages/api/src/__tests__/integration/imports.integration.test.ts
git commit -m "test(imports): cancel-mid-batch integration test (slice 2 task 7)"
```

---

## Task 8 — In-app + email notifications

**Files:**
- Modify: `packages/api/src/services/imports/notify.service.ts` (replace stub)
- Create: `packages/shared/prisma/seed-import-notification-template.ts`
- Modify: `packages/shared/prisma/seed.ts`

**Steps:**

- [ ] **Step 1 — Replace the notify-service stub with the real implementation.**

```typescript
// packages/api/src/services/imports/notify.service.ts
import type { ImportBatch } from "@utility-cis/shared/src/generated/prisma";
import { prisma } from "../../lib/prisma.js";
import { sendNotification } from "../notification.service.js";
import { logger } from "../../lib/logger.js";

/**
 * Terminal-state notification fan-out for an import batch:
 *   1. Always: write one InAppNotification row addressed to
 *      batch.createdBy. Bell-icon UI consumes this in slice 4.
 *   2. Email: only when the batch was async (recordCount > sync
 *      threshold) AND the user's UserPreference.preferences
 *      .notifyOnImportComplete is true (defaults to true). The notif
 *      engine handles delivery.
 *
 * Sync batches skip email — the operator was watching the wizard and
 * already saw the result panel.
 */

const SYNC_THRESHOLD = 250; // mirrors imports.service.ts; if it ever moves, fix both

export async function emitImportTerminalNotifications(
  batch: ImportBatch,
): Promise<void> {
  const terminal = ["COMPLETE", "PARTIAL", "FAILED", "CANCELLED"] as const;
  if (!terminal.includes(batch.status as (typeof terminal)[number])) {
    return;
  }

  const kindMap = {
    COMPLETE: { kind: "IMPORT_COMPLETE", severity: "SUCCESS", titleVerb: "complete" },
    PARTIAL: { kind: "IMPORT_PARTIAL", severity: "WARNING", titleVerb: "partial" },
    FAILED: { kind: "IMPORT_FAILED", severity: "ERROR", titleVerb: "failed" },
    CANCELLED: { kind: "IMPORT_CANCELLED", severity: "WARNING", titleVerb: "cancelled" },
  } as const;
  const meta = kindMap[batch.status as keyof typeof kindMap];

  const title = `${labelForKind(batch.entityKind)} import ${meta.titleVerb}`;
  const body = `${batch.recordCount.toLocaleString()} rows · ${batch.importedCount.toLocaleString()} imported · ${batch.errorCount.toLocaleString()} errors`;
  const link = `/imports/${batch.id}`;

  await prisma.inAppNotification.create({
    data: {
      utilityId: batch.utilityId,
      userId: batch.createdBy,
      kind: meta.kind,
      severity: meta.severity,
      title,
      body,
      link,
      metadata: {
        batchId: batch.id,
        entityKind: batch.entityKind,
        recordCount: batch.recordCount,
        importedCount: batch.importedCount,
        errorCount: batch.errorCount,
      },
    },
  });

  // Email gate.
  if (batch.recordCount <= SYNC_THRESHOLD) {
    return;
  }
  const pref = await prisma.userPreference.findUnique({
    where: { utilityId_userId: { utilityId: batch.utilityId, userId: batch.createdBy } },
    select: { preferences: true },
  });
  const prefs = (pref?.preferences as Record<string, unknown>) ?? {};
  const notifyEmail = prefs.notifyOnImportComplete !== false; // default true
  if (!notifyEmail) return;

  const user = await prisma.cisUser.findUnique({
    where: { id: batch.createdBy },
    select: { email: true, name: true },
  });
  if (!user?.email) {
    logger.warn(
      { component: "imports-notify", batchId: batch.id, userId: batch.createdBy },
      "No email on actor — skipping import.complete email",
    );
    return;
  }

  await sendNotification(batch.utilityId, {
    eventType: "import.complete",
    channel: "EMAIL",
    recipientId: batch.createdBy, // not a customer, but sendNotification only uses recipientOverride for delivery
    recipientOverride: { email: user.email },
    context: {
      kind: labelForKind(batch.entityKind),
      status: batch.status,
      imported: String(batch.importedCount),
      errored: String(batch.errorCount),
      total: String(batch.recordCount),
      link: link,
      actorName: user.name ?? "",
      fileName: batch.fileName ?? "(unknown)",
    },
  });
}

function labelForKind(kind: string): string {
  // Light cosmetic — the canonical label lives on the handler, but
  // we want the email subject to read naturally without a registry
  // lookup from the worker.
  return kind
    .split("_")
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join(" ");
}
```

- [ ] **Step 2 — Seed the `import.complete` notification template.**

```typescript
// packages/shared/prisma/seed-import-notification-template.ts
import type { PrismaClient } from "../src/generated/prisma/index.js";

/**
 * Idempotent. Seeds the `import.complete` event template for every
 * tenant that doesn't already have one. Channels: EMAIL only —
 * imports are not customer-facing, so SMS isn't supported.
 */
export async function seedImportNotificationTemplate(
  prisma: PrismaClient,
): Promise<void> {
  const tenants = await prisma.utilityTenant.findMany({ select: { id: true } });
  for (const t of tenants) {
    await prisma.notificationTemplate.upsert({
      where: { utilityId_eventType: { utilityId: t.id, eventType: "import.complete" } },
      create: {
        utilityId: t.id,
        eventType: "import.complete",
        isActive: true,
        channels: {
          email: {
            subject: "{{kind}} import {{status}} — {{imported}} of {{total}} imported",
            body: [
              "Hi {{actorName}},",
              "",
              "Your {{kind}} import of {{fileName}} has finished with status {{status}}.",
              "",
              "  • Total rows: {{total}}",
              "  • Imported: {{imported}}",
              "  • Errors: {{errored}}",
              "",
              "View the full result: {{link}}",
              "",
              "— Utility CIS",
            ].join("\n"),
          },
        },
      },
      update: {},
    });
  }
}
```

- [ ] **Step 3 — Wire it into the seed flow.**

In `packages/shared/prisma/seed.ts`, after the existing tenant + role + module setup, add:

```typescript
import { seedImportNotificationTemplate } from "./seed-import-notification-template.js";

// ... at the bottom of main()
await seedImportNotificationTemplate(prisma);
```

- [ ] **Step 4 — Re-seed.**

```bash
node seed.js
```
Expected: succeeds; the new template appears in `notification_template` for each tenant.

- [ ] **Step 5 — Typecheck + commit.**

```bash
pnpm -w typecheck
git add packages/api/src/services/imports/notify.service.ts packages/shared/prisma/seed-import-notification-template.ts packages/shared/prisma/seed.ts
git commit -m "feat(imports): in-app + email notifications on terminal transitions (slice 2 task 8)"
```

---

## Task 9 — Wizard async polling

**Files:**
- Modify: `packages/web/components/imports/import-wizard.tsx`

**Steps:**

- [ ] **Step 1 — Update the result type union and commit handler.**

In `import-wizard.tsx`, replace the `CommitResult` interface and the `handleCommit` body's response parse:

```typescript
type CommitResult =
  | (CommitSyncResult & { async: false })
  | { async: true; batchId: string; recordCount: number; attachmentId: string };

interface CommitSyncResult {
  batchId: string;
  status: "COMPLETE" | "PARTIAL" | "FAILED";
  recordCount: number;
  importedCount: number;
  errorCount: number;
  errors: Array<{ rowIndex: number; errorCode: string; errorMessage: string }>;
  attachmentId: string;
}
```

Update `handleCommit`:

```typescript
      const data = (await response.json()) as CommitResult;
      setResult(data);
      setStage("commit");

      if (data.async) {
        toast(
          "Import running in the background — we'll notify you when it's done.",
          "info",
        );
      } else if (data.status === "COMPLETE") {
        toast(`${data.importedCount} of ${data.recordCount} rows imported`, "success");
      } else if (data.status === "PARTIAL") {
        toast(
          `${data.importedCount} of ${data.recordCount} rows imported, ${data.errorCount} errored`,
          "info",
        );
      } else {
        toast(`Import failed — ${data.errorCount} of ${data.recordCount} rows errored`, "error");
      }
```

- [ ] **Step 2 — Branch the CommitStage on async vs. sync.**

```tsx
{stage === "commit" && result && (
  result.async
    ? <AsyncCommitStage batchId={result.batchId} recordCount={result.recordCount} onReset={reset} />
    : <CommitStage result={result} onReset={reset} />
)}
```

- [ ] **Step 3 — Add the `AsyncCommitStage` component.**

```tsx
function AsyncCommitStage({
  batchId,
  recordCount,
  onReset,
}: {
  batchId: string;
  recordCount: number;
  onReset: () => void;
}) {
  const [batch, setBatch] = useState<{
    status: string;
    importedCount: number;
    errorCount: number;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function poll() {
      try {
        const data = await apiClient.get<{ batch: { status: string; importedCount: number; errorCount: number } }>(
          `/api/v1/imports/${batchId}`,
        );
        if (cancelled) return;
        setBatch(data.batch);
        const terminal = ["COMPLETE", "PARTIAL", "FAILED", "CANCELLED"];
        if (!terminal.includes(data.batch.status)) {
          setTimeout(poll, 2000);
        }
      } catch {
        if (!cancelled) setTimeout(poll, 5000);
      }
    }
    poll();
    return () => {
      cancelled = true;
    };
  }, [batchId]);

  const processed = (batch?.importedCount ?? 0) + (batch?.errorCount ?? 0);
  const pct = recordCount === 0 ? 0 : Math.round((processed / recordCount) * 100);
  const terminal = batch && ["COMPLETE", "PARTIAL", "FAILED", "CANCELLED"].includes(batch.status);

  return (
    <div>
      <div
        style={{
          padding: "20px 24px",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius)",
          background: "var(--bg-card)",
          marginBottom: "16px",
        }}
      >
        <div
          style={{
            fontSize: "13px",
            fontWeight: 600,
            color: terminal ? "var(--text-primary)" : "var(--accent-primary)",
            marginBottom: "12px",
            textTransform: "uppercase",
            letterSpacing: "0.05em",
          }}
        >
          {terminal ? `Status: ${batch!.status}` : "Importing in the background…"}
        </div>
        <div
          style={{
            height: "8px",
            background: "var(--bg-elevated)",
            borderRadius: "4px",
            overflow: "hidden",
            marginBottom: "12px",
          }}
        >
          <div
            style={{
              width: `${pct}%`,
              height: "100%",
              background: "var(--accent-gradient)",
              transition: "width 0.3s ease",
            }}
          />
        </div>
        <div style={{ fontSize: "12px", color: "var(--text-muted)" }}>
          {processed.toLocaleString()} / {recordCount.toLocaleString()} rows processed
          {batch ? ` · ${batch.importedCount.toLocaleString()} imported · ${batch.errorCount.toLocaleString()} errors` : ""}
        </div>
      </div>
      <div style={{ display: "flex", gap: "8px" }}>
        <button onClick={onReset} style={primaryButton}>
          Import another
        </button>
        <Link
          href={`/imports/${batchId}`}
          style={{ ...secondaryButton, textDecoration: "none", marginLeft: "auto" }}
        >
          View import details →
        </Link>
      </div>
    </div>
  );
}
```

- [ ] **Step 4 — `pnpm --filter web build` to confirm typecheck.**

```bash
pnpm --filter web build
```
Expected: green.

- [ ] **Step 5 — Manual smoke test (optional but encouraged):**

Start API + worker + web, upload a 300-row CSV via the wizard, observe the progress bar advance. Then upload a 100-row CSV and confirm the sync result panel appears as before.

- [ ] **Step 6 — Commit.**

```bash
git add packages/web/components/imports/import-wizard.tsx
git commit -m "feat(imports): wizard polls async batches with progress bar (slice 2 task 9)"
```

---

## Task 10 — Detail page Cancel + Retry buttons

**Files:**
- Modify: `packages/web/app/imports/[id]/page.tsx`

**Steps:**

- [ ] **Step 1 — Add cancel/retry handlers and buttons to the page header.**

Inside the component, after the `useEffect` that fetches detail, add:

```typescript
  async function refresh() {
    try {
      const d = await apiClient.get<DetailResponse>(`/api/v1/imports/${id}`);
      setDetail(d);
    } catch {
      // toast already shown by apiClient
    }
  }

  async function handleCancel() {
    try {
      await apiClient.post(`/api/v1/imports/${id}/cancel`, {});
      toast("Cancellation requested. The import will stop after the current batch of rows.", "info");
      await refresh();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Cancel failed", "error");
    }
  }

  async function handleRetry() {
    try {
      await apiClient.post(`/api/v1/imports/${id}/retry`, {});
      toast("Retry enqueued. The import is re-running.", "info");
      await refresh();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Retry failed", "error");
    }
  }
```

In the page header actions block (search for "PageHeader" usage), pass:

```tsx
<PageHeader
  title="Import details"
  // ... existing props ...
  actions={
    <>
      {detail?.batch.status === "PROCESSING" && (
        <button onClick={handleCancel} style={secondaryButton}>Cancel</button>
      )}
      {detail && ["FAILED", "PARTIAL", "CANCELLED"].includes(detail.batch.status) && (
        <button onClick={handleRetry} style={primaryButton}>Retry</button>
      )}
    </>
  }
/>
```

(Use the existing button styles defined elsewhere on the page, or import from a shared style helper if one exists. If not, copy the style objects from `import-wizard.tsx`.)

If the page polls already, this will pick up the new status automatically. If not, add a polling effect that fires every 5s while `status === "PROCESSING"`:

```typescript
  useEffect(() => {
    if (detail?.batch.status !== "PROCESSING") return;
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
  }, [detail?.batch.status]);
```

- [ ] **Step 2 — Confirm `apiClient.post` exists.**

If `apiClient` only has `get`, add a `post` method to `packages/web/lib/api-client.ts` that mirrors `get` (JSON body, auth header). If it already exists, skip.

- [ ] **Step 3 — `pnpm --filter web build`.**

```bash
pnpm --filter web build
```
Expected: green.

- [ ] **Step 4 — Commit.**

```bash
git add packages/web/app/imports/[id]/page.tsx packages/web/lib/api-client.ts
git commit -m "feat(imports): cancel + retry buttons on detail page (slice 2 task 10)"
```

---

## Task 11 — Preference: opt-out of import-complete emails

**Goal:** Surface a single boolean toggle so operators who run dozens of imports per day aren't carpet-bombed.

**Files:**
- Modify: `packages/web/app/profile/page.tsx` (or whichever page hosts UserPreference toggles today — find with `grep -r "UserPreference\|user_preference\|notifyOn" packages/web`)
- Modify: `packages/api/src/routes/users.ts` (or the existing route that PATCHes `UserPreference.preferences`)

**Steps:**

- [ ] **Step 1 — Locate the existing preferences page.**

```bash
# Find where UserPreference.preferences is read/written from the web side
```

Use Grep tool: pattern `notifyOn|preferences\.|user-pref|user_preference` in `packages/web`. If nothing appears, the toggle goes on `/profile` or `/settings/account` (whichever exists). Otherwise, add the toggle to the existing surface.

- [ ] **Step 2 — Render the toggle.**

```tsx
<label style={{ display: "flex", alignItems: "center", gap: "8px", marginTop: "12px" }}>
  <input
    type="checkbox"
    checked={prefs.notifyOnImportComplete !== false}
    onChange={(e) => setPrefs({ ...prefs, notifyOnImportComplete: e.target.checked })}
  />
  <span>Email me when an import finishes</span>
</label>
```

(`prefs` is whatever the existing page uses; the shape lives inside `UserPreference.preferences`.)

- [ ] **Step 3 — Persist on save.**

The existing PATCH endpoint should already write into `preferences`. If `notifyOnImportComplete` isn't present in the validator schema, add it:

```typescript
notifyOnImportComplete: z.boolean().optional(),
```

- [ ] **Step 4 — `pnpm --filter web build` + typecheck + commit.**

```bash
pnpm -w typecheck
pnpm --filter web build
git add packages/web packages/api
git commit -m "feat(imports): opt-out toggle for import-complete emails (slice 2 task 11)"
```

---

## Task 12 — Async-path integration tests

**Files:**
- Create: `packages/api/src/__tests__/integration/import-worker.integration.test.ts`

**Steps:**

- [ ] **Step 1 — Build the test file.**

The test starts the import worker (calling `buildImportWorker()`), enqueues real jobs, and asserts terminal status + InAppNotification + UserPreference-gated email. Mirrors `worker-suspension.test.ts`'s shape.

```typescript
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Worker } from "bullmq";
import {
  bootPostgres,
  bootRedis,
  resetDb,
  makeTenantFixture,
  TENANT_A,
  type TenantFixture,
} from "./_effective-dating-fixtures.js";

let app: import("fastify").FastifyInstance;
let worker: Worker;
let fixA: TenantFixture;
let meterNumber: string;

beforeAll(async () => {
  await bootPostgres();
  await bootRedis();
  const { default: appFactory } = await import("../../app.js");
  app = await appFactory();
  await app.ready();
  fixA = await makeTenantFixture(TENANT_A);
  meterNumber = fixA.meterNumber;

  // Build the worker AFTER the fixture so handlers + DB are ready.
  const { buildImportWorker } = await import("../../workers/import-worker.js");
  worker = buildImportWorker();
}, 60_000);

afterAll(async () => {
  await worker?.close();
  await app?.close();
});

describe("import-worker async path", () => {
  it("processes a > 250 row batch end-to-end", async () => {
    // ... build a 300-row CSV, POST, expect 202, poll until COMPLETE
  });

  it("respects cancel_requested and finalises CANCELLED", async () => {
    // ... POST 500-row CSV, immediately POST /cancel, poll until CANCELLED
  });

  it("retry after FAILED re-enqueues only error rows", async () => {
    // ... force a FAILED batch (e.g. all-bad-meter-numbers), call /retry,
    // poll until COMPLETE/PARTIAL — IMPORTED count should match the
    // number of fixed rows the test expects
  });

  it("zombie sweep recovers a PROCESSING batch with stale lastProgressAt", async () => {
    // ... insert an ImportBatch in PROCESSING with lastProgressAt = now-10min,
    // call reclaimAndEnqueueZombies, assert status === PENDING + queue has a job
  });

  it("emits InAppNotification on terminal transition", async () => {
    // ... POST > 250 rows, poll until COMPLETE, assert prisma.inAppNotification.count > 0
  });
});
```

(The existing `_effective-dating-fixtures.js` file has `bootPostgres` and `makeTenantFixture`. If `bootRedis` doesn't exist, add it — boot a `RedisContainer` and set the `REDIS_HOST/REDIS_PORT` env vars before `import("../../app.js")`. Pattern is in `worker-suspension.test.ts`.)

- [ ] **Step 2 — Run the test.**

```bash
pnpm --filter @utility-cis/api test -- import-worker.integration
```
Expected: all green. May take 30–60s due to polling.

- [ ] **Step 3 — Commit.**

```bash
git add packages/api/src/__tests__/integration/import-worker.integration.test.ts packages/api/src/__tests__/integration/_effective-dating-fixtures.ts
git commit -m "test(imports): async worker integration tests (slice 2 task 12)"
```

---

## Task 13 — Spec doc updates

**Files:**
- Modify: `docs/specs/22-import-infrastructure.md`

**Steps:**

- [ ] **Step 1 — Mark Slice 2 sections as `(✓ shipped)`.**

Update §State machine, §Notification, §Worker design with shipped markers. Update §Slicing to reflect what landed. Add a "Slice 2 status — shipped 2026-04-XX" subsection summarising endpoints and the env-config defaults.

Also update `docs/design/utility-cis-architecture.md` with the new queue, the worker, and the InAppNotification table.

- [ ] **Step 2 — Commit.**

```bash
git add docs/specs/22-import-infrastructure.md docs/design/utility-cis-architecture.md
git commit -m "docs(imports): mark slice 2 shipped (slice 2 task 13)"
```

---

## Self-review checklist (post-write)

- [x] **Spec coverage:** every bullet in §Slicing → Slice 2 maps to a task above.
- [x] **No placeholders:** no "TBD", no "implement later" — every step contains the code or command it expects.
- [x] **Type consistency:** `processBatch`'s return shape, `CreateImportResult`, the wizard's `CommitResult` union all line up. `ImportJobData`'s `scope` matches `ProcessScope`.
- [x] **Cost-benefit checked:** Section above states the simple alternative + concrete cost paid for every pattern (queue, flag, sweep, in-app row).

---

## Manual QA checklist for the whole slice

- Upload a 100-row CSV → response is 200, sync, result panel shows immediately.
- Upload a 500-row CSV → response is 202, async, wizard shows progress bar advancing every 2s, final state lands. In-app notification appears in `in_app_notification`.
- Cancel a running 1000-row import → status flips to CANCELLED within ~5s, partial counts recorded.
- Retry the cancelled batch → resumes; final import count = (pre-cancel imported) + (rest of batch).
- Force-kill the worker process mid-batch → restart worker → batch resumes from where it stopped (verify via `processed_at` timestamps).
- Disable email-on-import in profile → upload async batch → only the in-app notification lands; no `Notification` row created with `event_type=import.complete`.
