import { Prisma } from "@utility-cis/shared/src/generated/prisma";
import { prisma } from "../lib/prisma.js";
import type * as engine from "../lib/rate-engine/index.js";
import { Decimal } from "../lib/rate-engine/decimal.js";
import { loadTouCalendarById } from "../lib/rate-engine-loaders/load-tou-calendar.js";
import { getBillSegment, rateAgreementPeriod, type BillSegmentLineRow } from "./bill-segment.service.js";
import { classifyIntervals } from "./interval-rollup.service.js";

/**
 * A shadow bill (spec 26, TOU-BIL-4): what one billed period would have
 * cost on another rate, which **staff pick when they ask** — "you paid
 * $84.10 on time-of-use; the standard rate would have been $91.35".
 *
 * Picked, not configured. Until 2026-11-28 each schedule named its
 * comparison in a column; but a schedule is frozen once published, so the
 * column could only be set by revising, and bills priced on earlier
 * versions could never be compared. A comparison prices nothing, so it
 * has no business on an immutable tariff — staff choose the rate instead.
 *
 * **What is replaced.** The picked rates — one all-in tariff, or a delivery
 * and a supply schedule that together make a standard rate — stand in for
 * every assignment that is not a `rider`: a standard customer's delivery
 * and supply schedules are replaced by an all-in TOU tariff, or a TOU
 * customer's tariff by delivery plus supply. Riders (a public-benefits
 * charge levied whatever the rate) carry over and are never offered. The
 * result names what was replaced and what was kept, so the comparison says
 * what it compared.
 *
 * **Nothing is written.** Rated through `rateAgreementPeriod`, the code
 * that priced the bill; no segment, line, `billedAt`, audit row or bucket
 * read. A question, not a transaction.
 *
 * **TOU without TOU data.** A TOU rate prices usage by period. A meter that
 * already carries TOU bucket reads uses them; one that records intervals
 * has them classified in memory by `classifyIntervals` — the roll-up's own
 * rules — against the picked rate's calendar. Refusals as the roll-up's:
 * a gap, a missing or unclassifiable or straddling interval, or a meter
 * that records totals only.
 *
 * The actual side is the **stored** segment — what the customer was
 * charged. If reads were corrected since, the shadow rates the corrected
 * ones; settling that is a rebill's job.
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
  /** `shadow.total − actual.total`: positive means the picked rate would have cost more. */
  difference: string;
  /** The schedules the picked rate stood in for, and the riders kept beside it. */
  replaced: string[];
  kept: string[];
  /** Where TOU usage came from, when the picked rate prices any; null for a standard rate. */
  touUsageFrom: "registers" | "intervals" | null;
}

export interface ShadowOption {
  code: string;
  name: string;
  version: number;
  tou: boolean;
  /**
   * The role this tariff is usually assigned in (delivery, supply,
   * primary…), read off the tenant's assignments, so staff can see that a
   * standard rate is delivery **and** supply. Null when it is assigned to
   * nobody yet.
   */
  role: string | null;
}

const day = (d: Date) => d.toISOString().slice(0, 10);
const DAY_MS = 86_400_000;
const refuse = (statusCode: number, code: string, message: string) =>
  Object.assign(new Error(message), { statusCode, code });

/** Each tariff code's most common assignment role across the tenant. */
async function usualRoles(utilityId: string, codes: string[]): Promise<Map<string, string>> {
  const rows = await prisma.sAScheduleAssignment.findMany({
    where: { utilityId, rateSchedule: { code: { in: codes } } },
    select: { roleCode: true, rateSchedule: { select: { code: true } } },
  });
  const tally = new Map<string, Map<string, number>>();
  for (const r of rows) {
    const byRole = tally.get(r.rateSchedule.code) ?? new Map<string, number>();
    byRole.set(r.roleCode, (byRole.get(r.roleCode) ?? 0) + 1);
    tally.set(r.rateSchedule.code, byRole);
  }
  return new Map(
    [...tally].map(([code, byRole]) => [code, [...byRole].sort((a, b) => b[1] - a[1])[0]![0]]),
  );
}

/**
 * The rates a billed period can be compared with: published, in force by
 * its start, same commodity, not already on the bill — and **not riders**,
 * which are levied whatever the rate and are kept, not chosen.
 */
export async function shadowBillOptions(utilityId: string, segmentId: string): Promise<ShadowOption[]> {
  const segment = await prisma.billSegment.findFirstOrThrow({
    where: { id: segmentId, utilityId },
    select: {
      periodStart: true,
      serviceAgreement: { select: { commodityId: true } },
      lines: { select: { sourceSchedule: { select: { code: true } } } },
    },
  });
  const onBill = new Set(segment.lines.map((l) => l.sourceSchedule.code));
  const candidates = await prisma.rateSchedule.findMany({
    where: {
      utilityId,
      commodityId: segment.serviceAgreement.commodityId,
      publishedAt: { not: null },
      effectiveDate: { lte: segment.periodStart },
    },
    orderBy: [{ code: "asc" }, { version: "desc" }],
    select: { code: true, name: true, version: true, touCalendarId: true },
  });
  const seen = new Set<string>();
  const fresh = candidates.filter((c) => !onBill.has(c.code) && !seen.has(c.code) && seen.add(c.code));
  const roles = await usualRoles(utilityId, fresh.map((c) => c.code));
  return fresh
    .filter((c) => roles.get(c.code) !== "rider")
    .map((c) => ({
      code: c.code,
      name: c.name,
      version: c.version,
      tou: c.touCalendarId !== null,
      role: roles.get(c.code) ?? null,
    }));
}

/**
 * @param compareCodes the rate or rates picked — one all-in tariff, or a
 *   delivery and a supply schedule that together make a standard rate.
 */
export async function shadowBill(utilityId: string, segmentId: string, compareCodes: string[]): Promise<ShadowBill> {
  const segment = await getBillSegment(utilityId, segmentId);
  const period = { startDate: segment.periodStart, endDate: segment.periodEnd };
  const db = prisma as unknown as Prisma.TransactionClient;

  const codes = [...new Set(compareCodes)];
  const picked: Prisma.RateScheduleGetPayload<{ include: { components: true } }>[] = [];
  for (const code of codes) {
    const s = await prisma.rateSchedule.findFirst({
      where: { utilityId, code, publishedAt: { not: null }, effectiveDate: { lte: period.startDate } },
      orderBy: { version: "desc" },
      include: { components: { orderBy: { sortOrder: "asc" } } },
    });
    if (!s) {
      throw refuse(
        400,
        "COMPARISON_SCHEDULE_INVALID",
        `No published version of ${code} was in effect on ${day(period.startDate)}.`,
      );
    }
    picked.push(s);
  }
  const roles = await usualRoles(utilityId, codes);
  const touPicks = picked.filter((s) => s.touCalendarId !== null);
  if (touPicks.length > 1) {
    throw refuse(400, "COMPARISON_SCHEDULE_INVALID", "Pick one time-of-use rate at a time.");
  }
  const touCalendarId = touPicks[0]?.touCalendarId ?? null;

  const replaced: string[] = [];
  const kept: string[] = [];
  let touUsageFrom: ShadowBill["touUsageFrom"] = null;

  const { base, result } = await rateAgreementPeriod(db, utilityId, segment.serviceAgreementId, period, {
    substitute: async (loaded) => {
      for (const s of picked) {
        if (loaded.sa.commodityId !== s.commodityId) {
          throw refuse(400, "COMPARISON_SCHEDULE_INVALID", `${s.code} prices a different commodity.`);
        }
        if (loaded.assignments.some((a) => a.schedule.code === s.code)) {
          throw refuse(400, "COMPARISON_SCHEDULE_INVALID", `${s.code} is already on this bill.`);
        }
      }
      const riders = loaded.assignments.filter((a) => a.roleCode === "rider");
      const swapped = loaded.assignments.filter((a) => a.roleCode !== "rider");
      if (swapped.length === 0) {
        throw refuse(409, "NOTHING_TO_REPLACE", "This period was billed on riders only, so there is no rate to replace.");
      }
      replaced.push(...new Set(swapped.map((a) => a.schedule.code)));
      kept.push(...new Set(riders.map((a) => a.schedule.code)));

      const template = swapped[0]!;
      const stand = picked.map<engine.ResolvedAssignment>((s) => ({
        ...template,
        // Its usual role, so a component selecting by role still finds it.
        roleCode: roles.get(s.code) ?? "primary",
        rateScheduleId: s.id,
        schedule: {
          id: s.id,
          name: s.name,
          code: s.code,
          version: s.version,
          components: s.components.map((c) => ({
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
      }));
      return { ...loaded, assignments: [...stand, ...riders] };
    },

    /*
     * A TOU rate's buckets for a meter that has none of its own. A meter's
     * bucket reads are left alone — they are what a TOU bill would use too.
     */
    fill: async ({ touKeys, vars }) => {
      if (touKeys.length === 0 || !touCalendarId) return;
      touUsageFrom = "registers";
      const missing = touKeys.filter((k) => !vars.has(k));
      if (missing.length === 0) return;
      touUsageFrom = "intervals";

      // The billed days, as a half-open window of whole UTC days — the
      // span the meter loader reads a period's reads over.
      const window = { startDate: period.startDate, endDate: new Date(period.endDate.getTime() + DAY_MS) };
      const load = await loadTouCalendarById(prisma, { utilityId, id: touCalendarId, period: window });
      if (!load.ok) throw refuse(409, "SHADOW_TOU_CALENDAR", load.problem);

      const meterIds = [...new Set(missing.map((k) => k.split(":")[2]!))];
      const meters = await prisma.meter.findMany({
        where: { utilityId, id: { in: meterIds } },
        select: { id: true, meterNumber: true, uom: { select: { code: true } } },
      });
      for (const meter of meters) {
        const intervals = await prisma.meterReadInterval.findMany({
          where: { utilityId, meterId: meter.id, intervalStart: { gte: window.startDate, lt: window.endDate } },
          orderBy: { intervalStart: "asc" },
          select: { intervalStart: true, lengthMinutes: true, quantity: true, quality: true },
        });
        if (intervals.length === 0) {
          throw refuse(
            409,
            "SHADOW_NEEDS_INTERVALS",
            `Meter ${meter.meterNumber} records how much was used, not when, so what a time-of-use rate ` +
              "would have cost cannot be worked out for it.",
          );
        }
        const classified = classifyIntervals(load.calendar, intervals, window);
        if (!classified.ok) {
          throw refuse(
            409,
            "SHADOW_INTERVALS_INCOMPLETE",
            `Meter ${meter.meterNumber}'s interval data for this period cannot be split by time of day: ` +
              classified.problems.join(" "),
          );
        }
        for (const b of classified.buckets) {
          const key = `meter:tou:${meter.id}:${b.peakCode}`;
          if (!vars.has(key)) vars.set(key, { quantity: new Decimal(b.quantity), unit: meter.uom?.code ?? "KWH" });
        }
      }
    },
  });

  /*
   * A picked rate whose charges all fell away. Its components' conditions
   * (a service class, a premise type) did not match this agreement, so it
   * priced nothing — and a $0 comparison would read as "the other rate is
   * cheaper by the whole bill". Found in the 2026-11-28 walkthrough: a TOU
   * agreement with no service class, compared with a residential-only
   * standard rate, showed $0.00 and "$91.57 less than billed".
   */
  const pricedBy = new Set(result.lines.map((l) => l.sourceScheduleId));
  const inert = picked.filter((s) => !pricedBy.has(s.id)).map((s) => s.code);
  if (inert.length > 0) {
    throw refuse(
      409,
      "COMPARISON_NOT_APPLICABLE",
      `None of ${inert.join(" and ")}'s charges apply to this agreement — their conditions, such as the ` +
        "service class, don't match it — so the comparison would mean nothing.",
    );
  }

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
      lines: segment.lines.map(({ label, kindCode, amount, quantity, unit }) => ({ label, kindCode, amount, quantity, unit })),
    },
    shadow: {
      schedules: base.assignments
        .map((a) => ({ code: a.schedule.code, name: a.schedule.name, version: a.schedule.version }))
        .filter((s, i, all) => all.findIndex((t) => t.code === s.code && t.version === s.version) === i),
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
    replaced,
    kept,
    touUsageFrom,
  };
}
