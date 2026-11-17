import type { Prisma } from "@utility-cis/shared/src/generated/prisma";
import type { SkipReason } from "@utility-cis/shared";
import { prisma } from "../lib/prisma.js";
import { processBatch } from "./imports/process-batch.service.js";
import { windowContaining } from "./billing-run/window.js";
import { listStops } from "./read-route.service.js";
import { readableRowsForPremises } from "./read-route/readable-rows.js";
import { recordSkips } from "./read-skip.service.js";

/**
 * Typing a route's readings in, then posting them as a whole (read routes
 * design §5.7).
 *
 * **Nothing posts to `meter_read` until submit.** A half-typed sheet is
 * not a reading event, and a billing run that caught one mid-entry would
 * bill some of a route and skip the rest. A saved row therefore lives in
 * `import_row`, in a file-less `ImportBatch` (`source: API`, no
 * `fileName`), one batch per `(route, read date)`; submit hands the
 * reading rows to `processBatch` and the `meter_read` handler, which
 * already resolves agreements, computes consumption and audits.
 *
 * Which route and date a batch is for is recorded in `import_batch.mapping`
 * (`{ kind, routeId, readDate }`): a batch has no column for either, and
 * adding two to a table every import kind shares would be a schema change
 * for the sake of one of them.
 *
 * **A coded row never reaches `processBatch`**: the handler rejects a row
 * with no number. Coded rows are held back as `SKIPPED` and recorded
 * through `recordSkips`, for only those meters with no reading anywhere in
 * the batch. `read_skip` has no register column, so a stop where one
 * register was read and another coded is a *read* meter; the reason for
 * the unread register is kept on its row, not invented into a skip.
 *
 * **Submit is idempotent on the batch's own status.** One conditional
 * `UPDATE` claims a `PENDING` batch; whoever loses it, and every later
 * call, is handed the stored counts and writes nothing.
 */

type Tx = Prisma.TransactionClient;
type Actor = { id: string; name: string };

const ENTRY_KIND = "read-route-entry";
/** Why a row was left out of the post: nothing was typed against it. */
const NOT_ENTERED = "NOT_ENTERED";

export interface EntryRow {
  rowId: string;
  /** 1-based, in the route's walking order. */
  rowIndex: number;
  sequence: number;
  premiseId: string;
  meterId: string;
  meterNumber: string;
  registerId: string | null;
  /** A label, not a count. */
  registerNumber: string | null;
  accountNumber: string;
  reading: string | null;
  skipReason: string | null;
  notes: string | null;
  status: "PENDING" | "IMPORTED" | "ERROR" | "SKIPPED";
  errorCode: string | null;
  errorMessage: string | null;
}

export interface EntrySubmitResult {
  batchId: string;
  status: string;
  importedCount: number;
  errorCount: number;
  skipsRecorded: number;
  /** Rows nobody typed anything against, left out of the post. */
  notEntered: number;
  /** True when this call wrote nothing because the batch had already been submitted. */
  alreadySubmitted: boolean;
}

function httpError(statusCode: number, code: string, message: string): Error {
  return Object.assign(new Error(message), { statusCode, code });
}

const isoDay = (d: Date) => d.toISOString().slice(0, 10);
const utcDay = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));

/** What `raw_data` holds for one staged row. Every value is a string: the handler `.trim()`s them. */
interface StagedRaw {
  meterNumber: string;
  readDatetime: string;
  reading: string;
  routeId: string;
  registerId: string;
  meterId: string;
  premiseId: string;
  sequence: string;
  registerNumber: string;
  accountNumber: string;
  skipReason: string;
  notes: string;
}

function toEntryRow(row: {
  id: string;
  rowIndex: number;
  rawData: Prisma.JsonValue;
  status: EntryRow["status"];
  errorCode: string | null;
  errorMessage: string | null;
}): EntryRow {
  const raw = row.rawData as unknown as StagedRaw;
  return {
    rowId: row.id,
    rowIndex: row.rowIndex,
    sequence: Number(raw.sequence),
    premiseId: raw.premiseId,
    meterId: raw.meterId,
    meterNumber: raw.meterNumber,
    registerId: raw.registerId || null,
    registerNumber: raw.registerNumber || null,
    accountNumber: raw.accountNumber,
    reading: raw.reading || null,
    skipReason: raw.skipReason || null,
    notes: raw.notes || null,
    status: row.status,
    errorCode: row.errorCode,
    errorMessage: row.errorMessage,
  };
}

async function entryBatch(utilityId: string, batchId: string) {
  const batch = await prisma.importBatch.findFirst({
    where: { id: batchId, utilityId, entityKind: "meter_read", source: "API" },
  });
  const mapping = batch?.mapping as { kind?: string; routeId?: string; readDate?: string } | null;
  if (!batch || mapping?.kind !== ENTRY_KIND || !mapping.routeId || !mapping.readDate) {
    throw httpError(404, "ENTRY_NOT_FOUND", `Entry batch ${batchId} not found`);
  }
  return { batch, routeId: mapping.routeId, readDate: new Date(mapping.readDate) };
}

/**
 * Meters that already have a **billed** read in the window `day` falls in
 * for this route's cycle. A new read there would sit behind a posted bill:
 * the period is frozen, and nothing else in the read path refuses it
 * (`billed_at` is checked on delete and on resolve, never on create).
 * A cycle with no window (non-monthly) is judged on the day alone.
 */
async function metersBilledInWindow(
  utilityId: string,
  routeId: string,
  day: Date,
  meterIds: string[],
): Promise<Set<string>> {
  if (meterIds.length === 0) return new Set();
  const route = await prisma.readRoute.findFirst({
    where: { id: routeId, utilityId },
    select: { billingCycle: { select: { billDayOfMonth: true, frequency: true } } },
  });
  if (!route) throw httpError(404, "ROUTE_NOT_FOUND", `Read route ${routeId} not found`);
  let from = day;
  let to = day;
  try {
    const w = windowContaining(route.billingCycle, day);
    from = w.periodStart;
    to = w.periodEnd;
  } catch (err) {
    if ((err as { code?: string }).code !== "UNSUPPORTED_FREQUENCY") throw err;
  }
  const billed = await prisma.meterRead.findMany({
    where: {
      utilityId,
      meterId: { in: meterIds },
      billedAt: { not: null },
      readDate: { gte: from, lte: to },
    },
    select: { meterId: true },
  });
  return new Set(billed.map((r) => r.meterId));
}

/**
 * Open entry for a route on a date. Idempotent: the batch already opened
 * for that `(route, date)` is returned, in whatever state it is in — a
 * submitted one included, so reopening a posted route shows what was
 * posted and cannot stage a second set of reads for the same day.
 */
export async function openEntry(
  utilityId: string,
  actor: Actor,
  routeId: string,
  readDateInput: Date,
): Promise<{ batchId: string; rows: EntryRow[] }> {
  const day = utcDay(readDateInput);
  const dayText = isoDay(day);

  const route = await prisma.readRoute.findFirst({
    where: { id: routeId, utilityId },
    select: { origin: true },
  });
  if (!route) throw httpError(404, "ROUTE_NOT_FOUND", `Read route ${routeId} not found`);
  if (route.origin !== "LOCAL") {
    throw httpError(
      400,
      "ROUTE_IS_EXTERNAL",
      `Route ${routeId} belongs to a vendor's reading system; there is nothing to enter here`,
    );
  }

  const batchId = await prisma.$transaction(async (tx) => {
    // Serialises two openers of one route: without it both find nothing and both create.
    await tx.$queryRaw`SELECT id FROM read_route WHERE id = ${routeId}::uuid AND utility_id = ${utilityId}::uuid FOR UPDATE`;
    const existing = await tx.importBatch.findFirst({
      where: {
        utilityId,
        entityKind: "meter_read",
        source: "API",
        AND: [
          { mapping: { path: ["kind"], equals: ENTRY_KIND } },
          { mapping: { path: ["routeId"], equals: routeId } },
          { mapping: { path: ["readDate"], equals: dayText } },
        ],
      },
      orderBy: { createdAt: "desc" },
      select: { id: true },
    });
    if (existing) return existing.id;

    const stops = await listStops(utilityId, routeId);
    const stopOf = new Map(stops.map((s) => [s.premiseId, s.sequence]));
    const readable = await readableRowsForPremises(utilityId, [...stopOf.keys()], day);
    // Walking order is the stops', not the rows': the rows are sorted by premise id.
    const ordered = [...readable].sort((a, b) => stopOf.get(a.premiseId)! - stopOf.get(b.premiseId)!);

    const batch = await tx.importBatch.create({
      data: {
        utilityId,
        entityKind: "meter_read",
        source: "API",
        fileName: null,
        recordCount: ordered.length,
        status: "PENDING",
        mapping: { kind: ENTRY_KIND, routeId, readDate: dayText },
        createdBy: actor.id,
      },
    });
    await tx.importRow.createMany({
      data: ordered.map((r, i) => {
        const raw: StagedRaw = {
          meterNumber: r.meterNumber,
          readDatetime: `${dayText}T12:00:00.000Z`,
          reading: "",
          routeId,
          registerId: r.registerId ?? "",
          meterId: r.meterId,
          premiseId: r.premiseId,
          sequence: String(stopOf.get(r.premiseId)),
          registerNumber: r.registerNumber ?? "",
          accountNumber: r.accountNumber,
          skipReason: "",
          notes: "",
        };
        return { utilityId, importBatchId: batch.id, rowIndex: i + 1, rawData: raw as unknown as Prisma.InputJsonValue };
      }),
    });
    return batch.id;
  });

  const rows = await prisma.importRow.findMany({
    where: { importBatchId: batchId },
    orderBy: { rowIndex: "asc" },
  });
  return { batchId, rows: rows.map(toEntryRow) };
}

/**
 * Stage one row: a reading, or a code for why there is none, or (neither)
 * clear it. Writes `import_row` only; no `meter_read`.
 *
 * Refused with 400 `READ_BILLED` if the meter already has a billed read in
 * the period: typing a number behind a posted bill is a mistake to catch
 * at the keyboard, not at submit. Submit checks again, because billing can
 * run between the two.
 */
export async function saveEntryRow(
  utilityId: string,
  actor: Actor,
  batchId: string,
  input: {
    meterId: string;
    registerId: string | null;
    reading?: number;
    skipReason?: SkipReason;
    notes?: string;
  },
): Promise<EntryRow> {
  void actor;
  const { batch, routeId, readDate } = await entryBatch(utilityId, batchId);
  if (batch.status !== "PENDING") {
    throw httpError(409, "ENTRY_CLOSED", `Entry batch ${batchId} has been submitted`);
  }
  if (input.reading !== undefined && input.skipReason !== undefined) {
    throw httpError(400, "ENTRY_ROW_AMBIGUOUS", "A row is a reading or a code for why there is none, not both");
  }
  if (input.reading !== undefined && (!Number.isFinite(input.reading) || input.reading < 0)) {
    throw httpError(400, "INVALID_READING", "A reading must be a number, zero or more");
  }

  const rows = await prisma.importRow.findMany({ where: { importBatchId: batchId } });
  const row = rows.find((r) => {
    const raw = r.rawData as unknown as StagedRaw;
    return raw.meterId === input.meterId && (raw.registerId || null) === input.registerId;
  });
  if (!row) {
    throw httpError(404, "ENTRY_ROW_NOT_FOUND", `Meter ${input.meterId} is not a row of this sheet`);
  }

  if (input.reading !== undefined) {
    const billed = await metersBilledInWindow(utilityId, routeId, readDate, [input.meterId]);
    if (billed.has(input.meterId)) {
      throw httpError(
        400,
        "READ_BILLED",
        `Meter ${input.meterId} already has a billed read in this period; a new read cannot be entered behind a posted bill`,
      );
    }
  }

  const raw = row.rawData as unknown as StagedRaw;
  const next: StagedRaw = {
    ...raw,
    reading: input.reading === undefined ? "" : String(input.reading),
    skipReason: input.skipReason ?? "",
    notes: input.skipReason ? (input.notes ?? "") : "",
  };
  const updated = await prisma.importRow.update({
    where: { id: row.id },
    data: { rawData: next as unknown as Prisma.InputJsonValue },
  });
  return toEntryRow(updated);
}

async function storedResult(
  utilityId: string,
  batchId: string,
  alreadySubmitted: boolean,
): Promise<EntrySubmitResult> {
  const batch = await prisma.importBatch.findFirstOrThrow({ where: { id: batchId, utilityId } });
  const notEntered = await prisma.importRow.count({
    where: { importBatchId: batchId, errorCode: NOT_ENTERED },
  });
  return {
    batchId,
    status: batch.status,
    importedCount: batch.importedCount,
    errorCount: batch.errorCount,
    // `exceptionCount` is otherwise unused by this kind; here it is the skips written.
    skipsRecorded: batch.exceptionCount,
    notEntered,
    alreadySubmitted,
  };
}

/**
 * Post the sheet as a whole: readings first, through `processBatch`, then
 * skips for the meters that got no reading. A second call, or the loser of
 * a race, writes nothing and reports the batch's stored counts.
 */
export async function submitEntry(
  utilityId: string,
  actor: Actor,
  batchId: string,
): Promise<EntrySubmitResult> {
  const { routeId, readDate } = await entryBatch(utilityId, batchId);

  // The claim. Everything below runs for exactly one caller.
  const claimed = await prisma.importBatch.updateMany({
    where: { id: batchId, utilityId, status: "PENDING" },
    data: { status: "PROCESSING", processingStartedAt: new Date(), lastProgressAt: new Date() },
  });
  if (claimed.count === 0) return storedResult(utilityId, batchId, true);

  const rows = await prisma.importRow.findMany({
    where: { importBatchId: batchId },
    orderBy: { rowIndex: "asc" },
  });
  const staged = rows.map((r) => ({ row: r, raw: r.rawData as unknown as StagedRaw }));
  const readingRows = staged.filter((s) => s.raw.reading !== "");
  const codedRows = staged.filter((s) => s.raw.reading === "" && s.raw.skipReason !== "");
  const blankRows = staged.filter((s) => s.raw.reading === "" && s.raw.skipReason === "");

  try {
    // Held back from processBatch, which would reject each for having no number.
    if (blankRows.length) {
      await prisma.importRow.updateMany({
        where: { id: { in: blankRows.map((s) => s.row.id) } },
        data: {
          status: "SKIPPED",
          errorCode: NOT_ENTERED,
          errorMessage: "Nothing was entered for this row",
          processedAt: new Date(),
        },
      });
    }
    if (codedRows.length) {
      await prisma.importRow.updateMany({
        where: { id: { in: codedRows.map((s) => s.row.id) } },
        data: { status: "SKIPPED", processedAt: new Date() },
      });
    }

    // A period billed since the row was typed: refused here, per row, as an
    // import row would be, so its neighbours still post.
    const billed = await metersBilledInWindow(utilityId, routeId, readDate, [
      ...new Set(readingRows.map((s) => s.raw.meterId)),
    ]);
    const frozen = readingRows.filter((s) => billed.has(s.raw.meterId));
    if (frozen.length) {
      await prisma.importRow.updateMany({
        where: { id: { in: frozen.map((s) => s.row.id) } },
        data: {
          status: "ERROR",
          errorCode: "READ_BILLED",
          errorMessage: "The meter already has a billed read in this period; nothing was posted for this row",
          processedAt: new Date(),
        },
      });
    }
    // The batch's records are the rows that are posted as readings.
    await prisma.importBatch.update({ where: { id: batchId }, data: { recordCount: readingRows.length } });

    let status: string;
    let importedCount = 0;
    let errorCount = frozen.length;
    if (readingRows.length - frozen.length > 0) {
      const result = await processBatch({
        batchId,
        utilityId,
        actorId: actor.id,
        actorName: actor.name,
      });
      status = result.status;
      importedCount = result.importedCount;
      errorCount = result.errorCount;
    } else {
      status = frozen.length > 0 ? "FAILED" : "COMPLETE";
    }

    // Skips: a meter is skipped only if no row of it, in any register, carries a number.
    const readMeters = new Set(readingRows.map((s) => s.raw.meterId));
    // One entry per meter, set by its first coded row; later rows of the
    // same meter ride along with it.
    const skippedMeters = new Map<string, { reason: SkipReason; notes: string; rowIds: string[] }>();
    for (const s of codedRows) {
      if (readMeters.has(s.raw.meterId)) {
        await prisma.importRow.update({
          where: { id: s.row.id },
          data: {
            errorMessage: `Register not read (${s.raw.skipReason}); the meter's other register was read, so no skip was recorded`,
          },
        });
        continue;
      }
      const held = skippedMeters.get(s.raw.meterId);
      if (held) held.rowIds.push(s.row.id);
      else {
        skippedMeters.set(s.raw.meterId, {
          reason: s.raw.skipReason as SkipReason,
          notes: s.raw.notes,
          rowIds: [s.row.id],
        });
      }
    }
    // `recordSkips` takes one reason and one note for the lot.
    const byReason = new Map<string, { reason: SkipReason; notes: string; meters: Map<string, string[]> }>();
    for (const [meterId, m] of skippedMeters) {
      const key = `${m.reason} ${m.notes}`;
      const group = byReason.get(key) ?? { reason: m.reason, notes: m.notes, meters: new Map() };
      group.meters.set(meterId, m.rowIds);
      byReason.set(key, group);
    }

    let skipsRecorded = 0;
    let skipErrors = 0;
    for (const group of byReason.values()) {
      try {
        skipsRecorded += await prisma.$transaction((tx) =>
          recordSkips(tx, utilityId, actor, {
            routeId,
            readDate,
            meterIds: [...group.meters.keys()],
            skipReason: group.reason,
            notes: group.notes || undefined,
          }),
        );
      } catch (err) {
        const e = err as { code?: string; message?: string; statusCode?: number };
        if (!e.statusCode) throw err;
        const ids = [...group.meters.values()].flat();
        await prisma.importRow.updateMany({
          where: { id: { in: ids } },
          data: { status: "ERROR", errorCode: e.code ?? "SKIP_REFUSED", errorMessage: e.message ?? "Skip refused" },
        });
        skipErrors += ids.length;
      }
    }

    errorCount += skipErrors;
    if (skipErrors > 0 && status === "COMPLETE") status = "PARTIAL";
    await prisma.importBatch.update({
      where: { id: batchId },
      data: {
        status: status as "COMPLETE" | "PARTIAL" | "FAILED" | "CANCELLED",
        importedCount,
        errorCount,
        exceptionCount: skipsRecorded,
        completedAt: new Date(),
        lastProgressAt: new Date(),
      },
    });
    return storedResult(utilityId, batchId, false);
  } catch (err) {
    // Left PROCESSING on purpose: past the first write, which rows posted is
    // not something to guess at here, and the imports zombie sweep owns a
    // batch that stopped reporting progress.
    throw err;
  }
}
