import { Prisma } from "@utility-cis/shared/src/generated/prisma";
import { prisma } from "../lib/prisma.js";
import { auditCreate } from "../lib/audit-wrap.js";
import { EVENT_TYPES } from "@utility-cis/shared";
import * as engine from "../lib/rate-engine/index.js";
import { loadBase } from "../lib/rate-engine-loaders/index.js";
import { buildRegistry } from "../lib/rate-engine-registry.js";
import type { Decimal as JsDecimal } from "../lib/rate-engine/decimal.js";

export interface CreateBillInput {
  periodStart: Date;
  periodEnd: Date;
}

export interface BillLineRow {
  id: string;
  label: string;
  kindCode: string;
  amount: string;       // serialized decimal
  quantity: string | null;
  sourceScheduleId: string;
  sourceComponentId: string;
  sortOrder: number;
}

export interface BillSummary {
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
  billNumber: string;
  createdAt: Date;
}

export interface BillWithLines extends BillSummary {
  lines: BillLineRow[];
}

function decToFixedRequired(d: JsDecimal): string {
  return d.toFixed(4);
}

function billNumberPrefix(d: Date): string {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  return `BILL-${yyyy}${mm}-`;
}

/**
 * Allocate a per-tenant sequential bill number. The unique index on
 * (utility_id, bill_number) makes a tight race produce a 23505 that the
 * route layer can map to a 409 — but the human-in-the-loop create flow
 * makes a race almost impossible.
 */
async function nextBillNumber(
  tx: Prisma.TransactionClient,
  utilityId: string,
  now: Date,
): Promise<string> {
  const prefix = billNumberPrefix(now);
  const count = await tx.bill.count({
    where: { utilityId, billNumber: { startsWith: prefix } },
  });
  return `${prefix}${count + 1}`;
}

export async function createBillForServiceAgreement(
  utilityId: string,
  actorId: string,
  actorName: string,
  saId: string,
  input: CreateBillInput,
): Promise<BillWithLines> {
  if (input.periodEnd < input.periodStart) {
    throw Object.assign(new Error("periodEnd must be on/after periodStart"), {
      statusCode: 400,
      code: "INVALID_PERIOD",
    });
  }

  return auditCreate(
    { utilityId, actorId, actorName, entityType: "Bill" },
    EVENT_TYPES.BILL_CREATED,
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

      // 7. allocate bill number + persist Bill row
      const now = new Date();
      const billNumber = await nextBillNumber(tx, utilityId, now);
      const bill = await tx.bill.create({
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
          billNumber,
        },
      });

      // 8. persist BillLine rows preserving engine order
      const lineRows = result.lines.map((line, idx) => ({
        utilityId,
        billId: bill.id,
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
        await tx.billLine.createMany({ data: lineRows });
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

      return assembleBillWithLines(tx, utilityId, bill.id);
    },
  );
}

async function assembleBillWithLines(
  tx: Prisma.TransactionClient,
  utilityId: string,
  id: string,
): Promise<BillWithLines> {
  const bill = await tx.bill.findUniqueOrThrow({
    where: { id, utilityId },
    include: { lines: { orderBy: { sortOrder: "asc" } } },
  });
  return {
    id: bill.id,
    utilityId: bill.utilityId,
    serviceAgreementId: bill.serviceAgreementId,
    periodStart: bill.periodStart,
    periodEnd: bill.periodEnd,
    subtotal: bill.subtotal.toFixed(4),
    taxes: bill.taxes.toFixed(4),
    credits: bill.credits.toFixed(4),
    total: bill.total.toFixed(4),
    minimumFloorApplied: bill.minimumFloorApplied,
    billNumber: bill.billNumber,
    createdAt: bill.createdAt,
    lines: bill.lines.map((l) => ({
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

export async function listBillsForServiceAgreement(
  utilityId: string,
  saId: string,
): Promise<BillSummary[]> {
  const bills = await prisma.bill.findMany({
    where: { utilityId, serviceAgreementId: saId },
    orderBy: { periodStart: "desc" },
  });
  return bills.map((b) => ({
    id: b.id,
    utilityId: b.utilityId,
    serviceAgreementId: b.serviceAgreementId,
    periodStart: b.periodStart,
    periodEnd: b.periodEnd,
    subtotal: b.subtotal.toFixed(4),
    taxes: b.taxes.toFixed(4),
    credits: b.credits.toFixed(4),
    total: b.total.toFixed(4),
    minimumFloorApplied: b.minimumFloorApplied,
    billNumber: b.billNumber,
    createdAt: b.createdAt,
  }));
}

export async function getBill(utilityId: string, id: string): Promise<BillWithLines> {
  return assembleBillWithLines(prisma as unknown as Prisma.TransactionClient, utilityId, id);
}
