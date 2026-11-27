import { Decimal } from "decimal.js";
import { prisma } from "../../lib/prisma.js";
import { loadTouCalendarById } from "../../lib/rate-engine-loaders/load-tou-calendar.js";
import { resolveSeason } from "../../lib/rate-engine/seasons.js";
import { describeTouHours } from "../../lib/rate-engine/tou-calendar-text.js";
import type { BillPresentationTouSection } from "./document.js";
import { money } from "./format.js";

/**
 * Usage by time of day, for each TOU segment on a bill (spec 26,
 * TOU-BIL-2 and the bill half of TOU-BIL-3).
 *
 * **Why not just regroup the stored lines.** The engine suppresses a
 * zero-amount line, so a period the customer did not use — or one priced at
 * zero — has no line at all, and a table built from lines silently drops it.
 * Every period the tariff prices gets a row here; the usage comes from the
 * stored TOU buckets, which exist even at zero (the interval roll-up seeds
 * every period, and register imports must write a row per register).
 *
 * **Nothing here can change after the bill is issued:**
 * - which periods: the schedule's `tou_period` components, and a published
 *   schedule's components refuse edits (`rate-component.service.ts`);
 * - the amounts: the stored lines, joined to those components by
 *   `sourceComponentId`;
 * - the usage: buckets **created no later than the segment**, so a read
 *   corrected afterwards cannot move a reprint;
 * - the hours: the exact calendar version the schedule names
 *   (`rate_schedule.tou_calendar_id`, as the billing run classifies by),
 *   in the season the bill was priced in.
 * The one exception is the tenant's period *label*, which is editable and
 * unversioned — a renamed period reprints under its new name.
 */

export interface TouSegmentInput {
  periodStart: Date;
  periodEnd: Date;
  createdAt: Date;
  serviceAgreementId: string;
  serviceAgreement: { commodity: { code: string; name: string | null } | null } | null;
  lines: Array<{ sourceScheduleId: string; sourceComponentId: string; amount: Decimal | { toString(): string } }>;
}

export async function loadTouSections(
  utilityId: string,
  segments: TouSegmentInput[],
): Promise<BillPresentationTouSection[]> {
  const scheduleIds = [...new Set(segments.flatMap((s) => s.lines.map((l) => l.sourceScheduleId)))];
  if (scheduleIds.length === 0) return [];

  const touSchedules = await prisma.rateSchedule.findMany({
    where: { utilityId, id: { in: scheduleIds }, touCalendarId: { not: null } },
    select: {
      id: true,
      touCalendarId: true,
      components: { select: { id: true, quantitySource: true } },
    },
  });
  if (touSchedules.length === 0) return [];
  const scheduleById = new Map(touSchedules.map((s) => [s.id, s]));

  const sections: BillPresentationTouSection[] = [];
  for (const segment of segments) {
    const schedule = segment.lines.map((l) => scheduleById.get(l.sourceScheduleId)).find(Boolean);
    if (!schedule?.touCalendarId) continue;

    // Peak code per component, for the components that price a TOU period.
    const peakOf = new Map<string, string>();
    for (const c of schedule.components) {
      const qs = c.quantitySource as { base?: string; peak_code?: string } | null;
      if (qs?.base === "tou_period" && qs.peak_code) peakOf.set(c.id, qs.peak_code);
    }
    const codes = [...new Set(peakOf.values())];
    if (codes.length === 0) continue;

    const amountByCode = new Map<string, Decimal>(codes.map((c) => [c, new Decimal(0)]));
    for (const line of segment.lines) {
      const code = peakOf.get(line.sourceComponentId);
      if (code) amountByCode.set(code, amountByCode.get(code)!.plus(new Decimal(line.amount.toString())));
    }

    const usage = await bucketUsage(utilityId, segment, codes);
    const periods = await prisma.touPeriod.findMany({
      where: { utilityId, peakCode: { in: codes } },
      select: { peakCode: true, label: true, sortOrder: true },
    });
    const order = [...codes].sort((a, b) => {
      const pa = periods.find((p) => p.peakCode === a);
      const pb = periods.find((p) => p.peakCode === b);
      return (pa?.sortOrder ?? 999) - (pb?.sortOrder ?? 999) || a.localeCompare(b);
    });
    const labels = new Map(periods.map((p) => [p.peakCode, p.label]));

    const total = order.reduce((sum, c) => sum.plus(usage.byCode.get(c) ?? 0), new Decimal(0));
    const rows = order.map((code) => {
      const q = usage.byCode.get(code) ?? new Decimal(0);
      return {
        label: labels.get(code) ?? code,
        usage: usage.unit ? `${money(q)} ${usage.unit}` : money(q),
        share: shareText(q, total),
        amount: money(amountByCode.get(code) ?? 0),
      };
    });

    sections.push({
      heading: `${segment.serviceAgreement?.commodity?.name ?? segment.serviceAgreement?.commodity?.code ?? "Service"} — usage by time of day`,
      rows,
      footnote: await footnoteFor(utilityId, schedule.touCalendarId, segment, labels, order),
    });
  }
  return sections;
}

/**
 * The period's TOU buckets on the agreement's meters, summed per peak code.
 * By meter, as the rating engine's meter loader reads them, and bounded by
 * the segment's creation so a later correction cannot change a reprint.
 */
async function bucketUsage(
  utilityId: string,
  segment: TouSegmentInput,
  codes: string[],
): Promise<{ byCode: Map<string, Decimal>; unit: string | null }> {
  const installs = await prisma.servicePointMeter.findMany({
    where: { utilityId, servicePoint: { serviceAgreementId: segment.serviceAgreementId } },
    select: { meterId: true },
  });
  const meterIds = [...new Set(installs.map((i) => i.meterId))];
  const byCode = new Map<string, Decimal>();
  if (meterIds.length === 0) return { byCode, unit: null };

  const reads = await prisma.meterRead.findMany({
    where: {
      utilityId,
      meterId: { in: meterIds },
      peakCode: { in: codes },
      readDate: { gte: segment.periodStart, lte: segment.periodEnd },
      createdAt: { lte: segment.createdAt },
    },
    select: { peakCode: true, consumption: true, uom: { select: { code: true } } },
  });
  let unit: string | null = null;
  for (const r of reads) {
    const code = r.peakCode!;
    byCode.set(code, (byCode.get(code) ?? new Decimal(0)).plus(new Decimal(r.consumption.toString())));
    unit ??= r.uom?.code ?? null;
  }
  return { byCode, unit };
}

/** "18%", "<1%" for a sliver, "0%" for none. */
function shareText(part: Decimal, total: Decimal): string {
  if (total.isZero() || part.isZero()) return "0%";
  const pct = part.div(total).times(100);
  if (pct.lessThan(0.5)) return "<1%";
  return `${pct.toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toString()}%`;
}

async function footnoteFor(
  utilityId: string,
  touCalendarId: string,
  segment: TouSegmentInput,
  labels: Map<string, string>,
  order: string[],
): Promise<string[]> {
  const load = await loadTouCalendarById(prisma, {
    utilityId,
    id: touCalendarId,
    period: { startDate: segment.periodStart, endDate: segment.periodEnd },
  });
  // A schedule is published against a published calendar, so this does not
  // fail in practice; if it ever does, the table still prints and the
  // footnote is left off rather than guessed.
  if (!load.ok) return [];
  const { calendar } = load;
  // The season pricing used: the one in force on the period's start date.
  const seasonCode = resolveSeason(segment.periodStart, calendar.seasons);
  if (!seasonCode) return [];
  return describeTouHours({
    definition: calendar.definition,
    seasons: calendar.seasons,
    seasonCode,
    periodLabels: labels,
    periodOrder: order,
    clockBasis: calendar.clockBasis,
  });
}
