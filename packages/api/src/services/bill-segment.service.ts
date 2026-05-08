import { Prisma } from "@utility-cis/shared/src/generated/prisma";
import { prisma } from "../lib/prisma.js";
import { auditCreate } from "../lib/audit-wrap.js";
import { EVENT_TYPES } from "@utility-cis/shared";
import * as engine from "../lib/rate-engine/index.js";
import { loadBase } from "../lib/rate-engine-loaders/index.js";
import { buildRegistry } from "../lib/rate-engine-registry.js";
import type { Decimal as JsDecimal } from "../lib/rate-engine/decimal.js";

export interface CreateBillSegmentInput {
  periodStart: Date;
  periodEnd: Date;
}

export interface BillSegmentLineRow {
  id: string;
  label: string;
  kindCode: string;
  amount: string;       // serialized decimal
  quantity: string | null;
  sourceScheduleId: string;
  sourceComponentId: string;
  sortOrder: number;
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
  actorId: string,
  actorName: string,
  saId: string,
  input: CreateBillSegmentInput,
): Promise<BillSegmentWithLines> {
  if (input.periodEnd < input.periodStart) {
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
      const period = { startDate: input.periodStart, endDate: input.periodEnd };
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
          periodStart: input.periodStart,
          periodEnd: input.periodEnd,
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
            readDate: { gte: input.periodStart, lte: input.periodEnd },
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
    lines: segment.lines.map((l) => ({
      id: l.id,
      label: l.label,
      kindCode: l.kindCode,
      amount: l.amount.toFixed(4),
      quantity: l.quantity ? l.quantity.toFixed(4) : null,
      sourceScheduleId: l.sourceScheduleId,
      sourceComponentId: l.sourceComponentId,
      sortOrder: l.sortOrder,
    })),
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
