import { prisma } from "../lib/prisma.js";
import { shadowBill } from "./shadow-bill.js";

/**
 * The shadow bill in the customer portal (spec 26, TOU-BIL-4, slice 4):
 * what one of the customer's posted bills would have cost on its tariff's
 * comparison schedule — "on the standard rate this bill would have been
 * $91.35, so time-of-use saved you $7.25".
 *
 * Three gates, every one of which answers "nothing here" (a 404 at the
 * route) rather than a reason, because a portal caller learns nothing
 * about what it may not see:
 *
 * - the tenant has turned it on (`settings.portal.showRateComparison`,
 *   off by default — whether to tell customers a cheaper rate existed is
 *   the utility's call);
 * - the bill is the customer's, through its account, and posted — the
 *   portal's ownership rule and its unposted-bill rule;
 * - one of its segments' tariffs names a comparison.
 *
 * Each segment is compared by `shadowBill`, the staff code unchanged, and
 * writes nothing. A segment the comparison cannot answer (a meter that
 * records totals only, a month of interval data with a gap) comes back
 * with the reason instead of a figure, so one awkward agreement does not
 * hide the others.
 */

export interface PortalComparison {
  segmentId: string;
  periodStart: string;
  periodEnd: string;
  /** What the customer was charged for this part of the bill. */
  actualTotal: string;
  /** The tariff it was billed on and the one it is compared with, by name. */
  actualRate: string;
  comparisonRate: string | null;
  comparisonTotal: string | null;
  /** comparison − actual: positive means the customer's own rate was the cheaper. */
  difference: string | null;
  touUsageFrom: "registers" | "intervals" | null;
  /** Why this segment could not be compared, in the customer's words. */
  unavailable: string | null;
}

export async function portalRateComparisonEnabled(utilityId: string): Promise<boolean> {
  const config = await prisma.utilityConfig.findUnique({
    where: { utilityId },
    select: { settings: true },
  });
  const portal = (config?.settings as { portal?: { showRateComparison?: unknown } } | null)?.portal;
  return portal?.showRateComparison === true;
}

/** Of these bills, the ids with a segment whose tariff names a comparison. */
export async function comparableBillIds(utilityId: string, billIds: string[]): Promise<Set<string>> {
  if (billIds.length === 0) return new Set();
  const lines = await prisma.billSegmentLine.findMany({
    where: {
      utilityId,
      billSegment: { billId: { in: billIds } },
      sourceSchedule: { comparisonScheduleCode: { not: null } },
    },
    select: { billSegment: { select: { billId: true } } },
    distinct: ["billSegmentId"],
  });
  return new Set(lines.map((l) => l.billSegment.billId).filter((id): id is string => id !== null));
}

export async function portalRateComparison(
  utilityId: string,
  customerId: string,
  billId: string,
): Promise<{ billId: string; billNumber: string; comparisons: PortalComparison[] } | null> {
  if (!(await portalRateComparisonEnabled(utilityId))) return null;

  const bill = await prisma.bill.findFirst({
    where: { id: billId, utilityId, account: { customerId }, postedAt: { not: null } },
    select: { id: true, billNumber: true, segments: { select: { id: true }, orderBy: { periodStart: "asc" } } },
  });
  if (!bill) return null;

  const comparable = await prisma.billSegment.findMany({
    where: {
      utilityId,
      billId: bill.id,
      lines: { some: { sourceSchedule: { comparisonScheduleCode: { not: null } } } },
    },
    select: { id: true },
    orderBy: { periodStart: "asc" },
  });
  if (comparable.length === 0) return null;

  const comparisons: PortalComparison[] = [];
  for (const { id } of comparable) {
    try {
      const s = await shadowBill(utilityId, id);
      comparisons.push({
        segmentId: id,
        periodStart: s.periodStart,
        periodEnd: s.periodEnd,
        actualTotal: s.actual.total,
        actualRate: s.actual.schedules.map((x) => x.name).join(", "),
        comparisonRate: s.shadow.schedules.map((x) => x.name).join(", "),
        comparisonTotal: s.shadow.total,
        difference: s.difference,
        touUsageFrom: s.touUsageFrom,
        unavailable: null,
      });
    } catch (err) {
      const e = err as { statusCode?: number; message?: string };
      // A refusal is the comparison's answer; anything else is a fault.
      if (e.statusCode !== 409) throw err;
      const segment = await prisma.billSegment.findUniqueOrThrow({
        where: { id, utilityId },
        select: { periodStart: true, periodEnd: true, total: true },
      });
      comparisons.push({
        segmentId: id,
        periodStart: segment.periodStart.toISOString().slice(0, 10),
        periodEnd: segment.periodEnd.toISOString().slice(0, 10),
        actualTotal: segment.total.toFixed(4),
        actualRate: "",
        comparisonRate: null,
        comparisonTotal: null,
        difference: null,
        touUsageFrom: null,
        unavailable: "A comparison isn't available for this bill — the meter's readings don't give the detail it needs.",
      });
    }
  }
  return { billId: bill.id, billNumber: bill.billNumber, comparisons };
}
