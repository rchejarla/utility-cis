import { Prisma } from "@utility-cis/shared/src/generated/prisma";
import { prisma } from "../lib/prisma.js";
import { auditCreate } from "../lib/audit-wrap.js";
import { EVENT_TYPES } from "@utility-cis/shared";
import * as engine from "../lib/rate-engine/index.js";
import { loadBase } from "../lib/rate-engine-loaders/index.js";
import { buildRegistry } from "../lib/rate-engine-registry.js";
import type { Decimal as JsDecimal } from "../lib/rate-engine/decimal.js";

export interface CreateBillSegmentInput {
  /**
   * Both optional, and omitting them is the right default.
   *
   * A service period is a fact about reads, not a date range somebody
   * types: the meter was read on the 30th, so that is when the interval
   * ends, whatever the cycle's calendar says. Passing dates explicitly
   * remains possible — a correction sometimes needs it — but the UI no
   * longer asks, because asking is what produced periods that disagreed
   * with the meter.
   */
  periodStart?: Date;
  periodEnd?: Date;
  /**
   * The latest read this segment may close on. Defaults to now.
   *
   * A billing run passes its window end, because a run is a pass over a
   * period that has already closed: a read taken after the bill day
   * belongs to the next period, not this one. Without it the run
   * checked eligibility against the window and then rated against
   * today, so a meter read between the window closing and the run
   * executing was swept into the bill anyway. Ignored when explicit
   * dates are given, which name the interval outright.
   */
  asOf?: Date;
}

/** A service period, and the reads that bound it. */
export interface ServicePeriod {
  periodStart: Date;
  periodEnd: Date;
  /** The read that closes it — `periodEnd` is this read's own date. */
  closingReadId: string;
  /** How many unbilled reads fall inside, for the caller to report. */
  readCount: number;
}

/** Midnight UTC of the day after `d`, since read dates are `@db.Date`. */
function dayAfter(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1));
}

/**
 * The next service period for a service agreement, read to read.
 *
 * Ends on the newest unbilled read on or before `asOf` — that read *is*
 * the end of the interval. Starts the day after the last read already
 * billed, so consecutive periods abut with no gap and no overlap; with
 * nothing billed yet it starts at the agreement's own start date, since
 * service cannot be billed from before it existed.
 *
 * Why this rather than the cycle's calendar, which is what the code did
 * until now: with manual reading two accounts on one cycle are read on
 * different days, so a nominal 1/1–1/31 period describes neither of
 * them. Worse, a reader a day late left one window with no read — a
 * zero-usage bill — and the next with two, billing both intervals at
 * once and pushing the customer up a tier they never entered.
 *
 * `asOf` is the scheduling bound, normally a cycle's bill day: it stops
 * a read taken after the run from being swept into this period.
 */
export async function resolveServicePeriod(
  utilityId: string,
  saId: string,
  opts: { asOf?: Date } = {},
): Promise<ServicePeriod> {
  const asOf = opts.asOf ?? new Date();
  const sa = await prisma.serviceAgreement.findFirst({
    where: { id: saId, utilityId },
    select: { startDate: true },
  });
  if (!sa) {
    throw Object.assign(new Error(`Service agreement ${saId} not found`), {
      statusCode: 404,
      code: "SA_NOT_FOUND",
    });
  }

  // The read that closes the period. Newest first, because the interval
  // runs to the latest read taken, not the first one found.
  const closing = await prisma.meterRead.findFirst({
    where: {
      utilityId,
      serviceAgreementId: saId,
      billedAt: null,
      readDate: { lte: asOf },
    },
    orderBy: [{ readDate: "desc" }, { id: "desc" }],
    select: { id: true, readDate: true },
  });
  if (!closing) {
    throw Object.assign(
      new Error(
        `No unbilled meter read on or before ${asOf.toISOString().slice(0, 10)} for service agreement ${saId}, ` +
          "so there is no interval to bill. Import the read, or estimate it.",
      ),
      { statusCode: 400, code: "NO_READ_IN_WINDOW" },
    );
  }

  // Where the last billed interval ended. Not the newest read overall:
  // a read taken after the window stays for the next period.
  const lastBilled = await prisma.meterRead.findFirst({
    where: { utilityId, serviceAgreementId: saId, billedAt: { not: null } },
    orderBy: [{ readDate: "desc" }, { id: "desc" }],
    select: { readDate: true },
  });

  const periodStart = lastBilled ? dayAfter(lastBilled.readDate) : sa.startDate;
  if (periodStart > closing.readDate) {
    // The only way here is a backdated read: one taken before the last
    // interval closed, arriving afterwards. Billing it would overlap a
    // period already billed, which is rebill's job and not this one's.
    throw Object.assign(
      new Error(
        `The newest unbilled read for service agreement ${saId} is dated ` +
          `${closing.readDate.toISOString().slice(0, 10)}, before the end of the last billed period ` +
          `(${periodStart.toISOString().slice(0, 10)}). A backdated read needs a rebill, not a new segment.`,
      ),
      { statusCode: 409, code: "READ_PREDATES_BILLED_PERIOD" },
    );
  }

  const readCount = await prisma.meterRead.count({
    where: {
      utilityId,
      serviceAgreementId: saId,
      billedAt: null,
      readDate: { gte: periodStart, lte: closing.readDate },
    },
  });

  return {
    periodStart,
    periodEnd: closing.readDate,
    closingReadId: closing.id,
    readCount,
  };
}

export interface BillSegmentLineRow {
  id: string;
  label: string;
  kindCode: string;
  amount: string;       // serialized decimal
  quantity: string | null;
  /** What `quantity` is counted in, when the tariff names a unit. */
  unit: string | null;
  sourceScheduleId: string;
  sourceComponentId: string;
  sortOrder: number;
}

/**
 * One stored line, as an API caller sees it.
 *
 * Exported because two endpoints serve the same line — a segment, and
 * the bill that aggregates it — and they were mapping it separately.
 * Adding `unit` to one list of fields and not the other is how a
 * quantity reached the database in HCF and the bill dialog as a bare
 * number. One mapper cannot drift from itself.
 */
export function toBillSegmentLineRow(l: {
  id: string;
  label: string;
  kindCode: string;
  amount: Prisma.Decimal;
  quantity: Prisma.Decimal | null;
  unit: string | null;
  sourceScheduleId: string;
  sourceComponentId: string;
  sortOrder: number;
}): BillSegmentLineRow {
  return {
    id: l.id,
    label: l.label,
    kindCode: l.kindCode,
    amount: l.amount.toFixed(4),
    quantity: l.quantity ? l.quantity.toFixed(4) : null,
    unit: l.unit,
    sourceScheduleId: l.sourceScheduleId,
    sourceComponentId: l.sourceComponentId,
    sortOrder: l.sortOrder,
  };
}

export interface BillSegmentSummary {
  id: string;
  utilityId: string;
  serviceAgreementId: string;
  periodStart: Date;
  periodEnd: Date;
  subtotal: string;
  taxes: string;
  credits: string;
  total: string;
  minimumFloorApplied: boolean;
  segmentNumber: string;
  createdAt: Date;
}

export interface BillSegmentWithLines extends BillSegmentSummary {
  lines: BillSegmentLineRow[];
}

function decToFixedRequired(d: JsDecimal): string {
  return d.toFixed(4);
}

function segmentNumberPrefix(d: Date): string {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  return `SEG-${yyyy}${mm}-`;
}

/**
 * Allocate a per-tenant sequential segment number. The unique index on
 * (utility_id, segment_number) makes a tight race produce a 23505 that the
 * route layer can map to a 409 — but the human-in-the-loop create flow
 * makes a race almost impossible.
 */
async function nextSegmentNumber(
  tx: Prisma.TransactionClient,
  utilityId: string,
  now: Date,
): Promise<string> {
  const prefix = segmentNumberPrefix(now);
  const count = await tx.billSegment.count({
    where: { utilityId, segmentNumber: { startsWith: prefix } },
  });
  return `${prefix}${count + 1}`;
}

export async function createBillSegmentForServiceAgreement(
  utilityId: string,
  /**
   * Null when a schedule did this rather than a person — the audit
   * context has always taken `string | null` (the sweeps' convention),
   * and the billing dispatcher is the first caller to use it.
   */
  actorId: string | null,
  actorName: string,
  saId: string,
  input: CreateBillSegmentInput,
): Promise<BillSegmentWithLines> {
  /*
   * Either both dates or neither. Half a period is a typo, and
   * resolving the missing half would silently bill an interval nobody
   * asked for — which is the class of bug this whole change is about.
   */
  const explicit = input.periodStart !== undefined && input.periodEnd !== undefined;
  if (!explicit && (input.periodStart !== undefined || input.periodEnd !== undefined)) {
    throw Object.assign(
      new Error("Pass both periodStart and periodEnd, or neither to bill the next period from the reads"),
      { statusCode: 400, code: "INVALID_PERIOD" },
    );
  }

  const resolved = explicit
    ? { periodStart: input.periodStart as Date, periodEnd: input.periodEnd as Date }
    : await resolveServicePeriod(utilityId, saId, { asOf: input.asOf });

  if (resolved.periodEnd < resolved.periodStart) {
    throw Object.assign(new Error("periodEnd must be on/after periodStart"), {
      statusCode: 400,
      code: "INVALID_PERIOD",
    });
  }

  return auditCreate(
    { utilityId, actorId, actorName, entityType: "BillSegment" },
    EVENT_TYPES.BILL_SEGMENT_CREATED,
    async (tx) => {
      // 1. loadBase — assignments + components + snapshots
      const period = { startDate: resolved.periodStart, endDate: resolved.periodEnd };
      const base = await loadBase(tx as unknown as typeof prisma, saId, period, utilityId);

      if (base.assignments.length === 0) {
        throw Object.assign(
          new Error("Service agreement has no rate schedule assignments overlapping this period"),
          { statusCode: 400, code: "NO_ACTIVE_ASSIGNMENTS" },
        );
      }

      // 2. publish gate — every assigned schedule must be Published
      const unpublished = await tx.rateSchedule.findMany({
        where: {
          id: { in: base.assignments.map((a) => a.rateScheduleId) },
          publishedAt: null,
        },
        select: { id: true, code: true, version: true },
      });
      if (unpublished.length > 0) {
        const detail = unpublished.map((s) => `${s.code} v${s.version}`).join(", ");
        throw Object.assign(
          new Error(
            `Cannot bill against unpublished rate schedule(s): ${detail}. Publish them first.`,
          ),
          { statusCode: 409, code: "SCHEDULE_NOT_PUBLISHED" },
        );
      }

      // 3. manifest — collect schedule-driven keys
      const manifestKeys = engine.manifest(base);

      // 4. Pre-load meter-keyed vars (engine infers meter ids from
      //    meter:reads:* keys at rate time; we add them up-front so the
      //    engine doesn't have to call back into the registry).
      const spMeters = await tx.serviceAgreement.findUniqueOrThrow({
        where: { id: saId, utilityId },
        select: {
          servicePoints: {
            where: { endDate: null },
            include: { meters: { where: { removedDate: null }, select: { meterId: true } } },
          },
        },
      });
      const meterIds = spMeters.servicePoints.flatMap((sp) => sp.meters.map((m) => m.meterId));
      const meterKeys = meterIds.flatMap((id) => [`meter:reads:${id}`, `meter:size:${id}`]);

      // 5. registry + loadVariables
      const registry = buildRegistry(tx as unknown as typeof prisma, {
        utilityId,
        saId,
        accountId: base.sa.accountId,
        premiseId: base.sa.premiseId,
        period,
      });
      const vars = await registry.loadVariables([...manifestKeys, ...meterKeys]);

      // 6. rate
      const result = engine.rate({ base, vars });

      // 7. allocate segment number + persist BillSegment row
      const now = new Date();
      const segmentNumber = await nextSegmentNumber(tx, utilityId, now);
      const segment = await tx.billSegment.create({
        data: {
          utilityId,
          serviceAgreementId: saId,
          periodStart: resolved.periodStart,
          periodEnd: resolved.periodEnd,
          subtotal: new Prisma.Decimal(decToFixedRequired(result.totals.subtotal)),
          taxes: new Prisma.Decimal(decToFixedRequired(result.totals.taxes)),
          credits: new Prisma.Decimal(decToFixedRequired(result.totals.credits)),
          total: new Prisma.Decimal(decToFixedRequired(result.totals.total)),
          minimumFloorApplied: result.totals.minimumFloorApplied,
          segmentNumber,
        },
      });

      // 8. persist BillSegmentLine rows preserving engine order
      const lineRows = result.lines.map((line, idx) => ({
        utilityId,
        billSegmentId: segment.id,
        label: line.label,
        kindCode: line.kindCode,
        amount: new Prisma.Decimal(decToFixedRequired(line.amount)),
        quantity:
          line.quantity != null
            ? new Prisma.Decimal(decToFixedRequired(line.quantity))
            : null,
        unit: line.unit ?? null,
        sourceScheduleId: line.sourceScheduleId,
        sourceComponentId: line.sourceComponentId,
        sortOrder: (idx + 1) * 100,
      }));
      if (lineRows.length > 0) {
        await tx.billSegmentLine.createMany({ data: lineRows });
      }

      // 9. mark MeterReads consumed by the engine. The engine consumes
      //    every read for the meter that overlaps the period via
      //    MeterLoader, so we mark all reads in the period that aren't
      //    already billedAt.
      if (meterIds.length > 0) {
        await tx.meterRead.updateMany({
          where: {
            utilityId,
            meterId: { in: meterIds },
            readDate: { gte: resolved.periodStart, lte: resolved.periodEnd },
            billedAt: null,
          },
          data: { billedAt: now },
        });
      }

      return assembleSegmentWithLines(tx, utilityId, segment.id);
    },
  );
}

async function assembleSegmentWithLines(
  tx: Prisma.TransactionClient,
  utilityId: string,
  id: string,
): Promise<BillSegmentWithLines> {
  const segment = await tx.billSegment.findUniqueOrThrow({
    where: { id, utilityId },
    include: { lines: { orderBy: { sortOrder: "asc" } } },
  });
  return {
    id: segment.id,
    utilityId: segment.utilityId,
    serviceAgreementId: segment.serviceAgreementId,
    periodStart: segment.periodStart,
    periodEnd: segment.periodEnd,
    subtotal: segment.subtotal.toFixed(4),
    taxes: segment.taxes.toFixed(4),
    credits: segment.credits.toFixed(4),
    total: segment.total.toFixed(4),
    minimumFloorApplied: segment.minimumFloorApplied,
    segmentNumber: segment.segmentNumber,
    createdAt: segment.createdAt,
    lines: segment.lines.map(toBillSegmentLineRow),
  };
}

export async function listBillSegmentsForServiceAgreement(
  utilityId: string,
  saId: string,
): Promise<BillSegmentSummary[]> {
  const segments = await prisma.billSegment.findMany({
    where: { utilityId, serviceAgreementId: saId },
    orderBy: { periodStart: "desc" },
  });
  return segments.map((s) => ({
    id: s.id,
    utilityId: s.utilityId,
    serviceAgreementId: s.serviceAgreementId,
    periodStart: s.periodStart,
    periodEnd: s.periodEnd,
    subtotal: s.subtotal.toFixed(4),
    taxes: s.taxes.toFixed(4),
    credits: s.credits.toFixed(4),
    total: s.total.toFixed(4),
    minimumFloorApplied: s.minimumFloorApplied,
    segmentNumber: s.segmentNumber,
    createdAt: s.createdAt,
  }));
}

export async function getBillSegment(
  utilityId: string,
  id: string,
): Promise<BillSegmentWithLines> {
  return assembleSegmentWithLines(prisma as unknown as Prisma.TransactionClient, utilityId, id);
}
