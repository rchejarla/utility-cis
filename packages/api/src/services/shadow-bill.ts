import { Prisma } from "@utility-cis/shared/src/generated/prisma";
import { prisma } from "../lib/prisma.js";
import type * as engine from "../lib/rate-engine/index.js";
import { getBillSegment, rateAgreementPeriod, type BillSegmentLineRow } from "./bill-segment.service.js";

/**
 * A shadow bill: what one billed period would have cost on the schedule
 * its tariff names as its comparison (spec 26, TOU-BIL-4) — "you paid
 * $84.10 on time-of-use; the standard rate would have been $91.35".
 *
 * **Nothing is written.** It is rated through `rateAgreementPeriod`, the
 * same code that priced the bill, with the tariff's assignment swapped for
 * the comparison schedule's, and the result is returned and forgotten:
 * no segment, no lines, no `billedAt`, no audit row. That is the property
 * that lets it be offered freely — it is a question, not a transaction.
 *
 * Built in this direction first (slice 3a): a **TOU** schedule compared
 * with its standard rate, which every TOU customer can be answered for,
 * since the standard rate prices total usage and total usage is always
 * there. The other direction — what TOU would have cost a standard
 * customer — needs usage split by period, which a standard customer's
 * meter has only if it records intervals; slice 3b classifies those.
 * Until then that direction is refused by name, not attempted.
 *
 * The actual side is the **stored** segment, not a re-rate: it is what
 * the customer was charged. If reads were corrected after billing, the
 * shadow rates the corrected reads; that difference is the correction's,
 * and a rebill is where it is settled.
 */

export interface ShadowSide {
  schedules: Array<{ code: string; name: string; version: number }>;
  subtotal: string;
  taxes: string;
  credits: string;
  total: string;
  lines: Array<Pick<BillSegmentLineRow, "label" | "kindCode" | "amount" | "quantity" | "unit">>;
}

export interface ShadowBill {
  segmentId: string;
  periodStart: string;
  periodEnd: string;
  actual: ShadowSide;
  shadow: ShadowSide;
  /** `shadow.total − actual.total`: positive means the comparison would have cost more. */
  difference: string;
}

const day = (d: Date) => d.toISOString().slice(0, 10);
const refuse = (statusCode: number, code: string, message: string) =>
  Object.assign(new Error(message), { statusCode, code });

export async function shadowBill(utilityId: string, segmentId: string): Promise<ShadowBill> {
  const segment = await getBillSegment(utilityId, segmentId);
  const period = { startDate: segment.periodStart, endDate: segment.periodEnd };
  const db = prisma as unknown as Prisma.TransactionClient;

  const swapped: Array<{ code: string; name: string; version: number }> = [];

  const { base, result } = await rateAgreementPeriod(db, utilityId, segment.serviceAgreementId, period, {
    substitute: async (loaded) => {
      const rows = await prisma.rateSchedule.findMany({
        where: { utilityId, id: { in: loaded.assignments.map((a) => a.rateScheduleId) } },
        select: { id: true, code: true, touCalendarId: true, comparisonScheduleCode: true },
      });
      const byId = new Map(rows.map((r) => [r.id, r]));
      const comparing = loaded.assignments.filter((a) => byId.get(a.rateScheduleId)?.comparisonScheduleCode);

      if (comparing.length === 0) {
        throw refuse(
          409,
          "NO_COMPARISON_SCHEDULE",
          "None of this period's rate schedules names a comparison schedule, so there is nothing to compare it with. " +
            "Set one on the schedule (a draft, or by revising it).",
        );
      }

      const assignments: engine.ResolvedAssignment[] = [];
      for (const a of loaded.assignments) {
        const own = byId.get(a.rateScheduleId);
        if (!own?.comparisonScheduleCode) {
          assignments.push(a); // Riders, taxes and anything else carry over unchanged.
          continue;
        }
        if (own.touCalendarId === null) {
          throw refuse(
            409,
            "SHADOW_TOU_NOT_AVAILABLE",
            `${own.code} is a standard rate. What a time-of-use rate would have cost needs this customer's ` +
              "usage split by time of day, which is not available yet.",
          );
        }
        const other = await prisma.rateSchedule.findFirst({
          where: {
            utilityId,
            code: own.comparisonScheduleCode,
            publishedAt: { not: null },
            effectiveDate: { lte: period.startDate },
          },
          orderBy: { version: "desc" },
          include: { components: { orderBy: { sortOrder: "asc" } } },
        });
        if (!other) {
          throw refuse(
            409,
            "COMPARISON_SCHEDULE_NOT_IN_FORCE",
            `No published version of ${own.comparisonScheduleCode} was in effect on ${day(period.startDate)}.`,
          );
        }
        if (other.touCalendarId !== null) {
          throw refuse(
            409,
            "SHADOW_TOU_NOT_AVAILABLE",
            `The version of ${other.code} in effect then is a time-of-use rate, so it cannot be compared yet.`,
          );
        }
        swapped.push({ code: other.code, name: other.name, version: other.version });
        assignments.push({
          ...a,
          rateScheduleId: other.id,
          schedule: {
            id: other.id,
            name: other.name,
            code: other.code,
            version: other.version,
            components: other.components.map((c) => ({
              id: c.id,
              rateScheduleId: c.rateScheduleId,
              kindCode: c.kindCode,
              label: c.label,
              predicate: c.predicate,
              quantitySource: c.quantitySource,
              pricing: c.pricing,
              sortOrder: c.sortOrder,
              effectiveDate: c.effectiveDate,
              expirationDate: c.expirationDate,
            })),
          },
        });
      }
      return { ...loaded, assignments };
    },
  });

  // The schedules that priced the actual bill, read off its lines.
  const actualIds = [...new Set(segment.lines.map((l) => l.sourceScheduleId))];
  const actualSchedules = await prisma.rateSchedule.findMany({
    where: { utilityId, id: { in: actualIds } },
    select: { code: true, name: true, version: true },
    orderBy: { code: "asc" },
  });

  const shadowTotal = new Prisma.Decimal(result.totals.total.toFixed(4));
  const actualTotal = new Prisma.Decimal(segment.total);

  return {
    segmentId: segment.id,
    periodStart: day(segment.periodStart),
    periodEnd: day(segment.periodEnd),
    actual: {
      schedules: actualSchedules,
      subtotal: segment.subtotal,
      taxes: segment.taxes,
      credits: segment.credits,
      total: segment.total,
      lines: segment.lines.map(({ label, kindCode, amount, quantity, unit }) => ({
        label,
        kindCode,
        amount,
        quantity,
        unit,
      })),
    },
    shadow: {
      schedules: [
        ...swapped,
        ...base.assignments
          .filter((a) => !swapped.some((s) => s.code === a.schedule.code))
          .map((a) => ({ code: a.schedule.code, name: a.schedule.name, version: a.schedule.version })),
      ].filter((s, i, all) => all.findIndex((t) => t.code === s.code && t.version === s.version) === i),
      subtotal: result.totals.subtotal.toFixed(4),
      taxes: result.totals.taxes.toFixed(4),
      credits: result.totals.credits.toFixed(4),
      total: result.totals.total.toFixed(4),
      lines: result.lines.map((l) => ({
        label: l.label,
        kindCode: l.kindCode,
        amount: l.amount.toFixed(4),
        quantity: l.quantity != null ? l.quantity.toFixed(4) : null,
        unit: l.unit ?? null,
      })),
    },
    difference: shadowTotal.minus(actualTotal).toFixed(4),
  };
}
