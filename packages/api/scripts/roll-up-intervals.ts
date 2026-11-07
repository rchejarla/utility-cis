/**
 * Classify a meter's intervals into TOU buckets (spec 26, TOU-INT-4).
 *
 * The interval half of a TOU bill has to be driven by something, and
 * the billing run does not call it yet. This is that something: an
 * operator command, and the way `seed.js` fills its interval sample —
 * the seed is plain CommonJS and cannot import the service, but it can
 * shell out to `tsx`, exactly as it already does for
 * `scripts/provision-tenant.ts`.
 *
 * It deliberately re-uses `rollUpIntervals` rather than reimplementing
 * the classification. A second classifier is how a seed ends up
 * demonstrating a split the engine would not produce.
 *
 *   npx tsx scripts/roll-up-intervals.ts \
 *     --utility-id <uuid> --meter <meter number> --from 2026-10-01 --to 2026-11-01
 *
 * `--from`/`--to` are **local** dates for the calendar's zone, half
 * open: the period is [from 00:00, to 00:00). The calendar comes from
 * the rate schedule the meter's service agreement is assigned, which
 * is the only thing entitled to decide how usage is split for pricing
 * (TOU-CAL-11).
 */
import { prisma } from "../src/lib/prisma.js";
import { runAsTenant } from "../src/lib/tenant-context.js";
import { rollUpIntervals } from "../src/services/interval-rollup.service.js";
import { zoneOffsetMinutes } from "../src/lib/rate-engine/tou-clock.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

function required(name: string): string {
  const v = arg(name);
  if (!v) {
    console.error(`Missing --${name}`);
    process.exit(1);
  }
  return v;
}

/**
 * Local midnight on `date`, in `zone`, as a UTC instant.
 *
 * Two steps, because the offset depends on the instant it is being
 * asked about: guess with the offset at UTC midnight, then re-ask at
 * the guess. One iteration settles every zone except the hour that
 * daylight saving skips, which has no local midnight to find.
 */
function localMidnight(date: string, zone: string): Date {
  const utcMidnight = new Date(`${date}T00:00:00.000Z`);
  const guess = new Date(utcMidnight.getTime() - zoneOffsetMinutes(utcMidnight, zone) * 60_000);
  return new Date(utcMidnight.getTime() - zoneOffsetMinutes(guess, zone) * 60_000);
}

async function main() {
  const utilityId = required("utility-id");
  const meterNumber = required("meter");
  const from = required("from");
  const to = required("to");

  await runAsTenant(utilityId, async () => {
    const meter = await prisma.meter.findFirst({
      where: { utilityId, meterNumber },
      select: { id: true, uomId: true },
    });
    if (!meter) throw new Error(`No meter numbered ${meterNumber} in this utility.`);

    /*
     * The agreement the intervals belong to, and through it the tariff
     * whose calendar classifies them. `SAScheduleAssignment` is how a
     * schedule reaches an agreement; the primary one is taken, since a
     * TOU split is a property of the tariff being billed.
     */
    const link = await prisma.servicePointMeter.findFirst({
      where: { utilityId, meterId: meter.id, removedDate: null },
      select: { servicePoint: { select: { serviceAgreementId: true } } },
    });
    const serviceAgreementId = link?.servicePoint?.serviceAgreementId;
    if (!serviceAgreementId) {
      throw new Error(`Meter ${meterNumber} is not attached to a service agreement.`);
    }

    const assignment = await prisma.sAScheduleAssignment.findFirst({
      where: { utilityId, serviceAgreementId },
      orderBy: { effectiveDate: "desc" },
      select: { rateScheduleId: true },
    });
    if (!assignment) throw new Error(`No rate schedule is assigned to that agreement.`);

    const schedule = await prisma.rateSchedule.findFirst({
      where: { utilityId, id: assignment.rateScheduleId },
      select: { name: true, touCalendarId: true },
    });
    if (!schedule?.touCalendarId) {
      throw new Error(`Rate schedule "${schedule?.name}" names no TOU calendar.`);
    }

    const calendar = await prisma.touCalendar.findFirst({
      where: { utilityId, id: schedule.touCalendarId },
      select: { name: true, timeZone: true },
    });
    const zone = calendar!.timeZone;

    const period = {
      startDate: localMidnight(from, zone),
      endDate: localMidnight(to, zone),
    };

    const result = await rollUpIntervals({
      utilityId,
      meterId: meter.id,
      serviceAgreementId,
      touCalendarId: schedule.touCalendarId,
      period,
      uomId: meter.uomId,
    });

    if (!result.ok) {
      console.error(`Meter ${meterNumber}: cannot roll up ${from}..${to}`);
      for (const p of result.problems) console.error(`  - ${p}`);
      process.exit(1);
    }

    console.log(
      `Meter ${meterNumber}: ${result.intervalsRead} intervals, ${from}..${to} ` +
        `(${calendar!.name}, ${zone})`,
    );
    for (const b of result.buckets) {
      console.log(`  ${b.peakCode.padEnd(14)} ${b.quantity.padStart(12)}  (${b.intervals} intervals)`);
    }
  });
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
