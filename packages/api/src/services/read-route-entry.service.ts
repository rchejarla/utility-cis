import type { Prisma } from "@utility-cis/shared/src/generated/prisma";
import type { EntryRowWire, EntrySubmitResultWire, SkipReason } from "@utility-cis/shared";
import { prisma } from "../lib/prisma.js";
import { processBatch } from "./imports/process-batch.service.js";
import { windowContaining } from "./billing-run/window.js";
import { listStops } from "./read-route.service.js";
import { readableRowsForPremises } from "./read-route/readable-rows.js";
import { historyForRows, historyKey } from "./read-route/reading-band.js";
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
 *
 * **A refused stop is corrected, not retyped.**
 * `reopenEntryForCorrections` puts the batch and its `ERROR` rows back to
 * `PENDING` and leaves `IMPORTED` and `SKIPPED` rows alone, which is also
 * what stops the second submit re-posting what already posted.
 *
 * **A batch of this kind must never be run through the generic imports
 * paths.** Every guard here — the billed-period refusal, holding coded and
 * blank rows back, recording the skips — sits above `processBatch`, so the
 * imports Retry button and the zombie sweep's re-enqueue would post the
 * readings with none of it. `entrySheetOf` is how those two recognise one.
 */

type Tx = Prisma.TransactionClient;
type Actor = { id: string; name: string };

const ENTRY_KIND = "read-route-entry";
/** Why a row was left out of the post: nothing was typed against it. */
const NOT_ENTERED = "NOT_ENTERED";

/*
 * Both shapes come from `@utility-cis/shared`, where they are Zod
 * schemas the routes' integration suite parses a real HTTP body
 * through. Declared here by hand until 2026-11-17, beside a web page
 * that would have declared them a third time — and nothing anywhere
 * compared the three.
 */
export type EntryRow = EntryRowWire;
export type EntrySubmitResult = EntrySubmitResultWire;

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

interface StagedRow {
  id: string;
  rowIndex: number;
  rawData: Prisma.JsonValue;
  status: EntryRow["status"];
  errorCode: string | null;
  errorMessage: string | null;
}

/**
 * The staged rows as the screen reads them: each one's address, what the
 * meter last read, and the band §5.7 holds a wild number against.
 *
 * None of the three is in `raw_data`, and none belongs there — the
 * staged row is what will be posted, and these are what the typist is
 * looking at while deciding what to post. They are resolved on the way
 * out instead, which also means a sheet opened last week shows today's
 * address.
 *
 * **Always handed the whole batch**, never one row, even when the caller
 * wants one back: `historyForRows` decides whether a meter's
 * register-less reads belong to its single register by counting the
 * registers it was given, so a single-row call would merge them onto a
 * two-register meter and show the wrong history beside the input.
 */
async function decorate(
  utilityId: string,
  rows: StagedRow[],
  onDate: Date,
): Promise<EntryRow[]> {
  const staged = rows.map((row) => ({ row, raw: row.rawData as unknown as StagedRaw }));
  const premiseIds = [...new Set(staged.map((s) => s.raw.premiseId))];
  const [premises, history] = await Promise.all([
    premiseIds.length
      ? prisma.premise.findMany({
          where: { utilityId, id: { in: premiseIds } },
          select: { id: true, addressLine1: true, city: true },
        })
      : Promise.resolve([]),
    historyForRows(
      utilityId,
      staged.map((s) => ({ meterId: s.raw.meterId, registerId: s.raw.registerId || null })),
      onDate,
    ),
  ]);
  const address = new Map(premises.map((p) => [p.id, `${p.addressLine1}, ${p.city}`]));

  return staged.map(({ row, raw }) => {
    const registerId = raw.registerId || null;
    const past = history.get(historyKey(raw.meterId, registerId));
    return {
      rowId: row.id,
      rowIndex: row.rowIndex,
      sequence: Number(raw.sequence),
      premiseId: raw.premiseId,
      address: address.get(raw.premiseId) ?? "",
      meterId: raw.meterId,
      meterNumber: raw.meterNumber,
      registerId,
      registerNumber: raw.registerNumber || null,
      accountNumber: raw.accountNumber,
      lastReading: past?.lastReading ?? null,
      lastReadDate: past?.lastReadDate ?? null,
      band: past?.band ?? null,
      reading: raw.reading || null,
      skipReason: raw.skipReason || null,
      notes: raw.notes || null,
      status: row.status,
      errorCode: row.errorCode,
      errorMessage: row.errorMessage,
    };
  });
}

/** The batch's rows, in walking order, as the screen reads them. */
async function entryRowsOf(utilityId: string, batchId: string, onDate: Date): Promise<EntryRow[]> {
  const rows = await prisma.importRow.findMany({
    where: { importBatchId: batchId },
    orderBy: { rowIndex: "asc" },
  });
  return decorate(utilityId, rows, onDate);
}

/**
 * The route and day a batch is a typed-in sheet for, or null when it is
 * an ordinary file import.
 *
 * Exported because the generic imports machinery has to tell the two
 * apart: every guard this feature has sits above `processBatch`, so a
 * batch of this kind driven through the framework's own re-run paths
 * posts readings with none of them.
 */
export function entrySheetOf(batch: { mapping: Prisma.JsonValue | null }): {
  routeId: string;
  readDate: string;
} | null {
  const mapping = batch.mapping as { kind?: string; routeId?: string; readDate?: string } | null;
  if (mapping?.kind !== ENTRY_KIND || !mapping.routeId || !mapping.readDate) return null;
  return { routeId: mapping.routeId, readDate: mapping.readDate };
}

async function entryBatch(utilityId: string, batchId: string) {
  const batch = await prisma.importBatch.findFirst({
    where: { id: batchId, utilityId, entityKind: "meter_read", source: "API" },
  });
  const sheet = batch && entrySheetOf(batch);
  if (!batch || !sheet) {
    throw httpError(404, "ENTRY_NOT_FOUND", `Entry batch ${batchId} not found`);
  }
  return { batch, routeId: sheet.routeId, readDate: new Date(sheet.readDate) };
}

/**
 * The batch opened for this `(route, day)`, in whatever state it is in.
 * Takes the caller's `tx` because both callers read it under the
 * `read_route` row lock that makes "find or create" and "find and
 * reopen" one decision.
 */
async function openedBatch(
  tx: Tx,
  utilityId: string,
  routeId: string,
  dayText: string,
): Promise<{ id: string } | null> {
  return tx.importBatch.findFirst({
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
    const existing = await openedBatch(tx, utilityId, routeId, dayText);
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

  return { batchId, rows: await entryRowsOf(utilityId, batchId, day) };
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
  /*
   * Decorated against the whole batch and then picked out, not
   * decorated alone: see `decorate`'s note on why one row is not enough
   * to resolve a multi-register meter's history.
   */
  const all = rows.map((r) => (r.id === updated.id ? updated : r));
  const decorated = await decorate(utilityId, all, readDate);
  return decorated.find((r) => r.rowId === updated.id)!;
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

  // A throw from here on leaves the batch PROCESSING on purpose: past the
  // first write, which rows posted is not something to guess at, and the
  // imports zombie sweep owns a batch that stopped reporting progress.
  const rows = await prisma.importRow.findMany({
    where: { importBatchId: batchId },
    orderBy: { rowIndex: "asc" },
  });
  const staged = rows.map((r) => ({ row: r, raw: r.rawData as unknown as StagedRaw }));
  const readingRows = staged.filter((s) => s.raw.reading !== "");
  const codedRows = staged.filter((s) => s.raw.reading === "" && s.raw.skipReason !== "");
  const blankRows = staged.filter((s) => s.raw.reading === "" && s.raw.skipReason === "");

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
    /*
     * This *replaces* `frozen.length` rather than adding to it, and that
     * is right only because `processBatch` derives its own baseline from
     * a `groupBy` over every row of the batch
     * (`process-batch.service.ts:112-118`): the rows just set to ERROR
     * above are already counted in what it returns. Narrow that baseline
     * to the rows it actually processed and this line silently
     * undercounts.
     */
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
  /*
   * One `recordSkips` call per meter, though it takes a list of them.
   *
   * It refuses the whole call when any one meter already has a read in
   * the window, and a real sheet groups naturally — ten `LOCKED_GATE`
   * codes with no notes are one reason and one note — so a single meter
   * read off-route earlier in the window would cost every skip batched
   * with it. One refusal has to cost one stop.
   */
  let skipsRecorded = 0;
  let skipErrors = 0;
  for (const [meterId, m] of skippedMeters) {
    try {
      skipsRecorded += await prisma.$transaction((tx) =>
        recordSkips(tx, utilityId, actor, {
          routeId,
          readDate,
          meterIds: [meterId],
          skipReason: m.reason,
          notes: m.notes || undefined,
        }),
      );
    } catch (err) {
      const e = err as { code?: string; message?: string; statusCode?: number };
      if (!e.statusCode) throw err;
      await prisma.importRow.updateMany({
        where: { id: { in: m.rowIds } },
        data: { status: "ERROR", errorCode: e.code ?? "SKIP_REFUSED", errorMessage: e.message ?? "Skip refused" },
      });
      skipErrors += m.rowIds.length;
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
      // Added to, not assigned. A resubmit after `reopenEntryForCorrections`
      // runs the skip loop again over coded rows whose `read_skip` already
      // exists, and `recordSkips` reports a duplicate as nothing written;
      // assigning would then report a sheet's recorded skips as zero.
      exceptionCount: { increment: skipsRecorded },
      completedAt: new Date(),
      lastProgressAt: new Date(),
    },
  });
  return storedResult(utilityId, batchId, false);
}

/**
 * Reopen a posted sheet so the stops it refused can be corrected. One
 * rejected row on a 48-stop route otherwise means retyping the route:
 * `openEntry` hands the posted batch back, `saveEntryRow` refuses it and
 * `submitEntry` reports it as already submitted.
 *
 * Admits only a batch holding at least one `ERROR` row. A sheet that
 * posted cleanly has nothing to correct, and reopening one could not be
 * told apart from posting it a second time.
 *
 * The `ERROR` rows go back to `PENDING` with their error cleared;
 * `IMPORTED` and `SKIPPED` rows are left exactly as they are, and that is
 * what prevents a re-post — `processBatch` selects `PENDING` rows and
 * nothing else, the same mechanism the double-submit protection already
 * rests on, so no second guard is added here.
 */
export async function reopenEntryForCorrections(
  utilityId: string,
  actor: Actor,
  routeId: string,
  readDateInput: Date,
): Promise<{ batchId: string; rows: EntryRow[] }> {
  void actor;
  const day = utcDay(readDateInput);
  const dayText = isoDay(day);

  const batchId = await prisma.$transaction(async (tx) => {
    // The lock `openEntry` takes, for the same reason: two callers must not
    // both find the batch correctable and both reopen it.
    await tx.$queryRaw`SELECT id FROM read_route WHERE id = ${routeId}::uuid AND utility_id = ${utilityId}::uuid FOR UPDATE`;
    const batch = await openedBatch(tx, utilityId, routeId, dayText);
    if (!batch) {
      throw httpError(404, "ENTRY_NOT_FOUND", `No entry has been opened for route ${routeId} on ${dayText}`);
    }
    const refused = await tx.importRow.count({
      where: { importBatchId: batch.id, status: "ERROR" },
    });
    if (refused === 0) {
      throw httpError(
        409,
        "ENTRY_NOTHING_TO_CORRECT",
        `The entry for route ${routeId} on ${dayText} has no refused row to correct`,
      );
    }
    await tx.importRow.updateMany({
      where: { importBatchId: batch.id, status: "ERROR" },
      data: { status: "PENDING", errorCode: null, errorMessage: null },
    });
    await tx.importBatch.update({
      where: { id: batch.id },
      data: { status: "PENDING", completedAt: null },
    });
    return batch.id;
  });

  return { batchId, rows: await entryRowsOf(utilityId, batchId, day) };
}
