import { Prisma } from "@utility-cis/shared/src/generated/prisma";
import {
  parseCsvText,
  type CanonicalFieldDef,
} from "@utility-cis/shared";
import { prisma } from "../lib/prisma.js";
import { writeAuditRow } from "../lib/audit-wrap.js";
import { uploadAttachment } from "./attachment.service.js";
import { getKindHandler } from "../imports/registry.js";
import { processBatch } from "./imports/process-batch.service.js";
import { emitImportTerminalNotifications } from "./imports/notify.service.js";
import { enqueueSafely, QUEUE_NAMES } from "../lib/queues.js";
import { IMPORT_WORKER_JOB_NAME } from "../workers/import-worker.js";

/**
 * Generic bulk-import engine. Drives every kind handler through the
 * same pipeline:
 *
 *   1. Validate kind, mapping, and file inputs.
 *   2. Persist the original file via the existing Attachment table —
 *      one polymorphic row keyed (entityType="ImportBatch", entityId=batch.id).
 *   3. Parse the file with `papaparse` (shared between client and
 *      server so the operator's preview is the truth).
 *   4. Apply the mapping to produce canonical-field-keyed row objects.
 *   5. Create an `ImportBatch` row and one `ImportRow` per parsed line.
 *   6. Run handler.prepareBatch once (cache lookups, derive defaults).
 *   7. Per-row dispatch: handler.parseRow → handler.processRow inside
 *      a per-row $transaction. Update the `import_row` status with the
 *      result. Errors are recorded per-row, not bubbled up.
 *   8. Finalise the ImportBatch status: COMPLETE / PARTIAL / FAILED.
 *
 * Slice 1 is sync-only; the row-count cap is 10000 (`MAX_SYNC_ROWS`)
 * so wall time stays within HTTP timeout budgets. Slice 2 will move
 * the per-row dispatch loop into a BullMQ worker for batches > 250
 * rows and lift the cap.
 */

/** Batches with > SYNC_THRESHOLD_ROWS rows enqueue to the imports
 * worker; smaller ones run inline before the HTTP response returns. */
export const SYNC_THRESHOLD_ROWS = 250;
/** Hard cap per batch in phase 1 — covers ~500k rows of typical CSV
 * over the 50 MB upload limit. Streaming uploads are a phase 3 concern. */
export const MAX_TOTAL_ROWS = 100_000;

export interface CreateImportInput {
  kind: string;
  source: "AMR" | "AMI" | "MANUAL_UPLOAD" | "API";
  fileName: string;
  fileType: string; // MIME
  fileBuffer: Buffer;
  /**
   * Mapping from source header name → canonical field name. Headers
   * not in the map are treated as "ignore". Required canonical fields
   * must each appear exactly once.
   */
  mapping: Record<string, string>;
}

export type CreateImportResult =
  | (CreateImportSyncResult & { async: false })
  | {
      async: true;
      batchId: string;
      recordCount: number;
      attachmentId: string;
    };

export interface CreateImportSyncResult {
  batchId: string;
  status: "COMPLETE" | "PARTIAL" | "FAILED";
  recordCount: number;
  importedCount: number;
  errorCount: number;
  errors: Array<{
    rowIndex: number;
    errorCode: string;
    errorMessage: string;
  }>;
  attachmentId: string;
}

export async function createImport(
  utilityId: string,
  actorId: string,
  actorName: string,
  input: CreateImportInput,
): Promise<CreateImportResult> {
  // ─── 1. Validate inputs ────────────────────────────────────────────
  const handler = getKindHandler(input.kind);

  validateMapping(input.mapping, handler.canonicalFields);

  // ─── 2. Parse the file ─────────────────────────────────────────────
  // Decode bytes → text. We only support utf-8 in slice 1; vendors
  // exporting Latin-1 or UTF-16 CSVs will surface as garbled headers
  // and the operator will re-export. (Detect-and-transcode is a
  // phase 3 polish.)
  const text = input.fileBuffer.toString("utf-8");
  const parsed = parseCsvText(text);

  if (parsed.headers.length === 0) {
    throw Object.assign(
      new Error("File has no header row"),
      { statusCode: 400, code: "EMPTY_FILE" },
    );
  }
  if (parsed.rows.length === 0) {
    throw Object.assign(
      new Error("File has a header row but no data rows"),
      { statusCode: 400, code: "NO_DATA_ROWS" },
    );
  }
  if (parsed.rows.length > MAX_TOTAL_ROWS) {
    throw Object.assign(
      new Error(
        `Batch has ${parsed.rows.length} rows; the per-batch cap is ${MAX_TOTAL_ROWS}.`,
      ),
      { statusCode: 400, code: "BATCH_TOO_LARGE" },
    );
  }

  // Apply mapping: invert it to canonical → sourceHeader, then
  // re-key each parsed row.
  const canonicalToHeader = new Map<string, string>();
  for (const [sourceHeader, canonical] of Object.entries(input.mapping)) {
    if (canonical && canonical !== "ignore") {
      canonicalToHeader.set(canonical, sourceHeader);
    }
  }
  const mappedRows = parsed.rows.map((srcRow) => {
    const out: Record<string, string> = {};
    for (const [canonical, header] of canonicalToHeader) {
      out[canonical] = srcRow[header] ?? "";
    }
    return out;
  });

  // ─── 3. Persist the original file ──────────────────────────────────
  // We need the batch id before we save the attachment so the
  // (entityType, entityId) is stable. Create the batch first with
  // PROCESSING status, save the attachment afterwards. If the
  // attachment save fails, we'll mark the batch FAILED.
  // ─── 4. Create the batch + import_row rows ────────────────────────
  const batch = await prisma.importBatch.create({
    data: {
      utilityId,
      entityKind: handler.kind,
      source: input.source,
      fileName: input.fileName,
      recordCount: parsed.rows.length,
      status: "PENDING",
      mapping: input.mapping as Prisma.InputJsonValue,
      lastProgressAt: new Date(),
      createdBy: actorId,
    },
  });

  const attachment = await uploadAttachment(
    utilityId,
    actorId,
    "ImportBatch",
    batch.id,
    input.fileName,
    input.fileType,
    input.fileBuffer,
  );

  // ImportRow rows are inserted in bulk; rowIndex is 1-based to match
  // what operators see in their CSV (header row is row 0 implicitly).
  await prisma.importRow.createMany({
    data: mappedRows.map((row, i) => ({
      importBatchId: batch.id,
      rowIndex: i + 1,
      rawData: row as Prisma.InputJsonValue,
      status: "PENDING" as const,
    })),
  });

  // Record batch creation in audit.
  await prisma.$transaction(async (tx) => {
    await writeAuditRow(
      tx,
      { utilityId, actorId, actorName, entityType: "ImportBatch" },
      "import_batch.created",
      batch.id,
      null,
      { kind: handler.kind, source: input.source, recordCount: parsed.rows.length },
    );
  });

  // ─── 5. Sync vs. async dispatch ───────────────────────────────────
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

  // Sync path: ≤ 250 rows. Run the per-row loop inline.
  const { status: finalStatus, importedCount, errorCount } = await processBatch({
    batchId: batch.id,
    utilityId,
    actorId,
    actorName,
    scope: "pending",
  });

  // Sync path emits the in-app notification too — operator was watching
  // and won't get email (gated by recordCount > SYNC_THRESHOLD inside
  // notify.service), but the bell-icon row still lands.
  const updatedBatch = await prisma.importBatch.findUniqueOrThrow({
    where: { id: batch.id },
  });
  await emitImportTerminalNotifications(updatedBatch);

  const errorRows = await prisma.importRow.findMany({
    where: { importBatchId: batch.id, status: "ERROR" },
    orderBy: { rowIndex: "asc" },
    select: { rowIndex: true, errorCode: true, errorMessage: true },
  });

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
}

function validateMapping(
  mapping: Record<string, string>,
  canonicalFields: CanonicalFieldDef[],
): void {
  const requiredFields = canonicalFields.filter((f) => f.required).map((f) => f.name);
  const valid = new Set(canonicalFields.map((f) => f.name).concat("ignore"));

  // Every mapped value must be a known canonical field or "ignore".
  for (const [header, canonical] of Object.entries(mapping)) {
    if (!valid.has(canonical)) {
      throw Object.assign(
        new Error(`Mapping for header "${header}" → "${canonical}" is not a known canonical field`),
        { statusCode: 400, code: "INVALID_MAPPING" },
      );
    }
  }

  // Required canonicals must each appear at least once and at most once.
  const counts = new Map<string, number>();
  for (const canonical of Object.values(mapping)) {
    if (canonical !== "ignore") {
      counts.set(canonical, (counts.get(canonical) ?? 0) + 1);
    }
  }
  for (const required of requiredFields) {
    const n = counts.get(required) ?? 0;
    if (n === 0) {
      throw Object.assign(
        new Error(`Required canonical field "${required}" is not mapped`),
        { statusCode: 400, code: "MAPPING_MISSING_REQUIRED" },
      );
    }
    if (n > 1) {
      throw Object.assign(
        new Error(`Canonical field "${required}" is mapped to ${n} headers; must be exactly one`),
        { statusCode: 400, code: "MAPPING_DUPLICATE" },
      );
    }
  }
}

// ─── List / detail / row queries ────────────────────────────────────

export async function listImports(
  utilityId: string,
  query: {
    page?: number;
    limit?: number;
    kind?: string;
    status?: string;
    source?: string;
    createdBy?: string;
  },
) {
  const page = Math.max(1, query.page ?? 1);
  const limit = Math.max(1, Math.min(500, query.limit ?? 20));
  const where: Prisma.ImportBatchWhereInput = { utilityId };
  if (query.kind) where.entityKind = query.kind;
  if (query.status) where.status = query.status as Prisma.ImportBatchWhereInput["status"];
  if (query.source) where.source = query.source as Prisma.ImportBatchWhereInput["source"];
  if (query.createdBy) where.createdBy = query.createdBy;

  const [data, total] = await Promise.all([
    prisma.importBatch.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.importBatch.count({ where }),
  ]);

  return {
    data,
    meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
  };
}

export async function getImport(utilityId: string, batchId: string) {
  const batch = await prisma.importBatch.findFirstOrThrow({
    where: { id: batchId, utilityId },
  });
  // Resolve the attachment (original file) if any.
  const attachment = await prisma.attachment.findFirst({
    where: { utilityId, entityType: "ImportBatch", entityId: batchId },
    select: { id: true, fileName: true, fileSize: true, fileType: true },
  });
  return { batch, attachment };
}

export async function getImportRows(
  utilityId: string,
  batchId: string,
  query: {
    page?: number;
    limit?: number;
    status?: string;
  },
) {
  // Verify the batch belongs to the tenant.
  await prisma.importBatch.findFirstOrThrow({
    where: { id: batchId, utilityId },
    select: { id: true },
  });

  const page = Math.max(1, query.page ?? 1);
  const limit = Math.max(1, Math.min(500, query.limit ?? 50));
  const where: Prisma.ImportRowWhereInput = { importBatchId: batchId };
  if (query.status) where.status = query.status as Prisma.ImportRowWhereInput["status"];

  const [data, total] = await Promise.all([
    prisma.importRow.findMany({
      where,
      orderBy: { rowIndex: "asc" },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.importRow.count({ where }),
  ]);

  return {
    data,
    meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
  };
}

export async function getErrorSummary(utilityId: string, batchId: string) {
  await prisma.importBatch.findFirstOrThrow({
    where: { id: batchId, utilityId },
    select: { id: true },
  });

  // Group error rows by errorCode. Prisma doesn't support GROUP BY
  // directly on an enum filter, so use $queryRaw.
  const rows = await prisma.$queryRaw<Array<{ error_code: string; count: bigint }>>`
    SELECT error_code, COUNT(*) AS count
    FROM import_row
    WHERE import_batch_id = ${batchId}::uuid AND status = 'ERROR'
    GROUP BY error_code
    ORDER BY count DESC
  `;
  return rows.map((r) => ({
    errorCode: r.error_code ?? "UNKNOWN",
    count: Number(r.count),
  }));
}

export async function errorsAsCsv(utilityId: string, batchId: string): Promise<string> {
  await prisma.importBatch.findFirstOrThrow({
    where: { id: batchId, utilityId },
    select: { id: true },
  });

  const errorRows = await prisma.importRow.findMany({
    where: { importBatchId: batchId, status: "ERROR" },
    orderBy: { rowIndex: "asc" },
    select: { rowIndex: true, rawData: true, errorCode: true, errorMessage: true },
  });

  if (errorRows.length === 0) {
    return "row_index,error_code,error_message\n";
  }

  // Discover the union of canonical field keys across error rows so
  // the export shows the operator the source values that errored.
  const fieldKeys = new Set<string>();
  for (const r of errorRows) {
    for (const k of Object.keys(r.rawData as Record<string, string>)) {
      fieldKeys.add(k);
    }
  }
  const fieldHeaders = [...fieldKeys].sort();

  const escape = (v: string | number | null) => {
    if (v === null || v === undefined) return "";
    const s = String(v);
    if (s.includes(",") || s.includes('"') || s.includes("\n")) {
      return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
  };

  const headerLine = ["row_index", ...fieldHeaders, "error_code", "error_message"]
    .map(escape)
    .join(",");
  const lines = errorRows.map((r) => {
    const data = r.rawData as Record<string, string>;
    return [
      String(r.rowIndex),
      ...fieldHeaders.map((h) => data[h] ?? ""),
      r.errorCode ?? "",
      r.errorMessage ?? "",
    ]
      .map(escape)
      .join(",");
  });
  return [headerLine, ...lines].join("\n") + "\n";
}
