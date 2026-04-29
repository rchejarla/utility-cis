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
