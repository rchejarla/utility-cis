import { Prisma } from "@utility-cis/shared/src/generated/prisma";
import { prisma } from "../lib/prisma.js";
import type * as engine from "../lib/rate-engine/index.js";
import { Decimal } from "../lib/rate-engine/decimal.js";
import { loadTouCalendarById } from "../lib/rate-engine-loaders/load-tou-calendar.js";
import { getBillSegment, rateAgreementPeriod, type BillSegmentLineRow } from "./bill-segment.service.js";
import { classifyIntervals } from "./interval-rollup.service.js";

/**
 * A shadow bill: what one billed period would have cost on the schedule
 * its tariff names as its comparison (spec 26, TOU-BIL-4) — "you paid
 * $84.10 on time-of-use; the standard rate would have been $91.35".
 *
 * **Nothing is written.** It is rated through `rateAgreementPeriod`, the
 * same code that priced the bill, with the tariff's assignment swapped for
 * the comparison schedule's, and the result is returned and forgotten:
 * no segment, no lines, no `billedAt`, no audit row, no bucket reads. That
 * is the property that lets it be offered freely — it is a question, not
 * a transaction.
 *
 * Both directions (slices 3a and 3b):
 *
 * - **TOU → standard.** The standard rate prices total usage, which every
 *   TOU customer has.
 * - **Standard → TOU** — "considering TOU". A TOU tariff prices usage by
 *   period, which a standard customer has only if the meter can say when
 *   it was used. A meter that already carries TOU bucket reads uses them;
 *   one that records **intervals** has them classified here, in memory,
 *   by `classifyIntervals` — the roll-up's own rules against the TOU
 *   tariff's calendar, so the answer is the bill that customer would
 *   actually get, refusals included: a gap, a missing interval or a
 *   straddling one stops the comparison rather than pricing a short
 *   month. A meter with neither is refused by name.
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
  /**
   * Where the comparison's time-of-use usage came from, when it prices
   * any: the meter's own TOU registers, or its intervals classified for
   * this comparison. `null` when the comparison is a standard rate.
   */
  touUsageFrom: "registers" | "intervals" | null;
}

const day = (d: Date) => d.toISOString().slice(0, 10);
const DAY_MS = 86_400_000;
const refuse = (statusCode: number, code: string, message: string) =>
  Object.assign(new Error(message), { statusCode, code });

export async function shadowBill(utilityId: string, segmentId: string): Promise<ShadowBill> {
  const segment = await getBillSegment(utilityId, segmentId);
  const period = { startDate: segment.periodStart, endDate: segment.periodEnd };
  const db = prisma as unknown as Prisma.TransactionClient;

  const swapped: Array<{ code: string; name: string; version: number }> = [];
  /** The calendar of the TOU comparison, when there is one. */
  let comparisonCalendarId: string | null = null;
  let touUsageFrom: ShadowBill["touUsageFrom"] = null;

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
        /*
         * The kinds were checked when the code was set, against the then
         * latest version — but the version in force for this period is
         * what is rated, and a tariff can change kind across versions.
         */
        if ((other.touCalendarId === null) === (own.touCalendarId === null)) {
          throw refuse(
            409,
            "COMPARISON_SCHEDULE_SAME_KIND",
            `The version of ${other.code} in effect on ${day(period.startDate)} is the same kind of tariff as ${own.code}, ` +
              "so comparing them answers nothing.",
          );
        }
        if (other.touCalendarId) comparisonCalendarId ??= other.touCalendarId;

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

    /*
     * Standard → TOU: the buckets a TOU tariff prices, for a meter that
     * has none. A meter's own bucket reads are left alone — they are what
     * a TOU bill for it would use too.
     */
    fill: async ({ touKeys, vars }) => {
      if (touKeys.length === 0 || !comparisonCalendarId) return;
      touUsageFrom = "registers";
      const missing = touKeys.filter((k) => !vars.has(k));
      if (missing.length === 0) return;
      touUsageFrom = "intervals";

      // The billed days, as a half-open window of whole UTC days — the
      // span the meter loader reads a period's reads over.
      const window = {
        startDate: period.startDate,
        endDate: new Date(period.endDate.getTime() + DAY_MS),
      };
      const load = await loadTouCalendarById(prisma, { utilityId, id: comparisonCalendarId, period: window });
      if (!load.ok) throw refuse(409, "SHADOW_TOU_CALENDAR", load.problem);

      const meterIds = [...new Set(missing.map((k) => k.split(":")[2]!))];
      const meters = await prisma.meter.findMany({
        where: { utilityId, id: { in: meterIds } },
        select: { id: true, meterNumber: true, uom: { select: { code: true } } },
      });
      for (const meter of meters) {
        const intervals = await prisma.meterReadInterval.findMany({
          where: {
            utilityId,
            meterId: meter.id,
            intervalStart: { gte: window.startDate, lt: window.endDate },
          },
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
          if (!vars.has(key)) {
            vars.set(key, { quantity: new Decimal(b.quantity), unit: meter.uom?.code ?? "KWH" });
          }
        }
      }
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
    touUsageFrom,
  };
}
