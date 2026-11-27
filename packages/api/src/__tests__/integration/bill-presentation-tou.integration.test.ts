import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import {
  bootPostgres,
  resetDb,
  makeTenantFixture,
  TENANT_A,
  type TenantFixture,
  endAdminPool,
  seedAsPlatform,
} from "./_effective-dating-fixtures.js";
import { runAsTenant } from "../../lib/tenant-context.js";

/**
 * Usage by time of day on a bill (spec 26, TOU-BIL-2 and the bill half of
 * TOU-BIL-3), built from the rows a real bill is made of.
 *
 * Three things only a database can show:
 *   1. a period with no charge line — the engine suppresses zero-amount
 *      lines — still gets its row, from the stored zero bucket;
 *   2. the amounts come from the stored lines through their components;
 *   3. a reading written after the segment was rated does not change what
 *      the bill says, so a reprint cannot move.
 *
 * July in Bozeman's zone: summer, 17:00–20:00 on-peak on weekdays, a
 * holiday day type that carries no on-peak hours.
 */

let pgContainer: StartedPostgreSqlContainer;
let prismaImports: typeof import("../../lib/prisma.js");
let touImports: typeof import("../../services/bill-presentation/tou.js");

beforeAll(async () => {
  const booted = await bootPostgres({ utilities: [TENANT_A] });
  pgContainer = booted.container;
  prismaImports = await import("../../lib/prisma.js");
  touImports = await import("../../services/bill-presentation/tou.js");
}, 180_000);

afterAll(async () => {
  await prismaImports?.prisma.$disconnect().catch(() => {});
  await prismaImports?.pool.end().catch(() => {});
  await endAdminPool();
  await pgContainer?.stop().catch(() => {});
});

beforeEach(() => seedAsPlatform(async () => { await resetDb(); }));

const asPlatform = <T>(fn: () => Promise<T>): Promise<T> => seedAsPlatform(async () => await fn());

const PERIOD_START = new Date("2026-07-01");
const PERIOD_END = new Date("2026-07-07");

interface Fixture {
  fix: TenantFixture;
  saId: string;
  scheduleId: string;
  componentByCode: Record<string, string>;
}

/** A published TOU calendar and tariff, an agreement with the fixture meter on it. */
async function makeFixture(): Promise<Fixture> {
  return asPlatform(async () => {
    const { prisma } = prismaImports;
    const fix = await makeTenantFixture(prisma, TENANT_A);

    const sa = await prisma.serviceAgreement.create({
      data: {
        utilityId: fix.utilityId,
        agreementNumber: "SA-TOU-BILL",
        accountId: fix.accountId,
        commodityId: fix.commodityId,
        startDate: new Date("2026-01-01"),
        status: "ACTIVE",
      },
    });
    const sp = await prisma.servicePoint.create({
      data: { utilityId: fix.utilityId, serviceAgreementId: sa.id, premiseId: fix.premiseId, startDate: new Date("2026-01-01") },
    });
    await prisma.servicePointMeter.create({
      data: { utilityId: fix.utilityId, servicePointId: sp.id, meterId: fix.meterId, addedDate: new Date("2026-01-01") },
    });

    const seasonSet = await prisma.seasonSet.create({
      data: { utilityId: fix.utilityId, name: "Two seasons", effectiveDate: new Date(Date.UTC(2026, 0, 1)), publishedAt: new Date() },
    });
    await prisma.season.createMany({
      data: [
        { seasonCode: "summer", label: "Summer", startMonth: 6, startDay: 1, endMonth: 9, endDay: 30, sortOrder: 0 },
        { seasonCode: "winter", label: "Winter", startMonth: 10, startDay: 1, endMonth: 5, endDay: 31, sortOrder: 1 },
      ].map((s) => ({ ...s, utilityId: fix.utilityId, seasonSetId: seasonSet.id })),
    });

    const calendar = await prisma.touCalendar.create({
      data: {
        utilityId: fix.utilityId,
        name: "Residential time-of-use",
        effectiveDate: new Date(Date.UTC(2026, 0, 1)),
        publishedAt: new Date(),
        seasonSetId: seasonSet.id,
        timeZone: "America/Denver",
        clockBasis: "prevailing",
      },
    });
    const dayTypes: Record<string, string> = {};
    for (const [code, weekdays] of [
      ["weekday", [1, 2, 3, 4, 5]],
      ["weekend", [6, 7]],
      ["holiday", []],
    ] as const) {
      const dt = await prisma.touDayType.create({
        data: { utilityId: fix.utilityId, touCalendarId: calendar.id, dayTypeCode: code, label: code },
      });
      dayTypes[code] = dt.id;
      if (weekdays.length) {
        await prisma.touDayTypeWeekday.createMany({
          data: weekdays.map((isoWeekday) => ({
            utilityId: fix.utilityId,
            touCalendarId: calendar.id,
            touDayTypeId: dt.id,
            isoWeekday,
          })),
        });
      }
    }
    await prisma.touSlot.createMany({
      data: [
        { season: "summer", dayType: "weekday", peakCode: "off_peak", start: 0, end: 1020 },
        { season: "summer", dayType: "weekday", peakCode: "peak", start: 1020, end: 1200 },
        { season: "summer", dayType: "weekday", peakCode: "off_peak", start: 1200, end: 1440 },
        { season: "summer", dayType: "weekend", peakCode: "off_peak", start: 0, end: 1440 },
        { season: "summer", dayType: "holiday", peakCode: "off_peak", start: 0, end: 1440 },
        // Winter prices a third period this July bill never reaches.
        { season: "winter", dayType: "weekday", peakCode: "mid_peak", start: 0, end: 1440 },
        { season: "winter", dayType: "weekend", peakCode: "mid_peak", start: 0, end: 1440 },
        { season: "winter", dayType: "holiday", peakCode: "mid_peak", start: 0, end: 1440 },
      ].map((s) => ({
        utilityId: fix.utilityId,
        touCalendarId: calendar.id,
        seasonCode: s.season,
        touDayTypeId: dayTypes[s.dayType]!,
        peakCode: s.peakCode,
        startMinute: s.start,
        endMinute: s.end,
      })),
    });

    const schedule = await prisma.rateSchedule.create({
      data: {
        utilityId: fix.utilityId,
        name: "Residential TOU",
        code: "RES-TOU",
        commodityId: fix.commodityId,
        effectiveDate: new Date("2026-01-01"),
        version: 1,
        publishedAt: new Date(),
        touCalendarId: calendar.id,
      },
    });
    const componentByCode: Record<string, string> = {};
    for (const [i, [code, rate]] of ([["peak", 0.24], ["mid_peak", 0.14], ["off_peak", 0.0645]] as const).entries()) {
      const c = await prisma.rateComponent.create({
        data: {
          utilityId: fix.utilityId,
          rateScheduleId: schedule.id,
          kindCode: "consumption",
          label: `${code} energy`,
          sortOrder: (i + 1) * 10,
          effectiveDate: new Date("2026-01-01"),
          predicate: {},
          quantitySource: { base: "tou_period", peak_code: code },
          pricing: { type: "flat", rate, unit: "kWh" },
        },
      });
      componentByCode[code] = c.id;
    }
    return { fix, saId: sa.id, scheduleId: schedule.id, componentByCode };
  });
}

/** A TOU bucket on the fixture meter, as the roll-up or a register import writes one. */
function bucket(f: Fixture, peakCode: string, kwh: number, at = "2026-07-07T23:59:59Z") {
  return asPlatform(() =>
    prismaImports.prisma.meterRead.create({
      data: {
        utilityId: f.fix.utilityId,
        meterId: f.fix.meterId,
        serviceAgreementId: f.saId,
        uomId: f.fix.uomId,
        readDate: PERIOD_END,
        readDatetime: new Date(at),
        reading: null,
        priorReading: null,
        consumption: kwh,
        peakCode,
        readType: "ACTUAL",
        readSource: "AMI",
      },
    }),
  );
}

/** A rated segment with the lines the engine kept — none for a zero-amount period. */
function ratedSegment(f: Fixture, lines: Array<[string, string, number]>) {
  return asPlatform(async () => {
    const { prisma } = prismaImports;
    const total = lines.reduce((s, [, amount]) => s + Number(amount), 0).toFixed(4);
    const segment = await prisma.billSegment.create({
      data: {
        utilityId: f.fix.utilityId,
        serviceAgreementId: f.saId,
        periodStart: PERIOD_START,
        periodEnd: PERIOD_END,
        subtotal: total,
        taxes: "0",
        credits: "0",
        total,
        minimumFloorApplied: false,
        segmentNumber: "SEG-TOU-1",
      },
    });
    await prisma.billSegmentLine.createMany({
      data: lines.map(([code, amount, kwh], i) => ({
        utilityId: f.fix.utilityId,
        billSegmentId: segment.id,
        label: `${code} energy`,
        kindCode: "consumption",
        amount,
        quantity: kwh,
        unit: "kWh",
        sourceScheduleId: f.scheduleId,
        sourceComponentId: f.componentByCode[code]!,
        sortOrder: (i + 1) * 100,
      })),
    });
    return segment.id;
  });
}

const sectionsFor = (f: Fixture, segmentId: string) =>
  runAsTenant(f.fix.utilityId, async () => {
    const segment = await prismaImports.prisma.billSegment.findFirstOrThrow({
      where: { id: segmentId },
      include: { serviceAgreement: { include: { commodity: true } }, lines: { orderBy: { sortOrder: "asc" } } },
    });
    return touImports.loadTouSections(f.fix.utilityId, [segment]);
  });

const labels = (f: Fixture) =>
  asPlatform(async () => {
    const rows = await prismaImports.prisma.touPeriod.findMany({ where: { utilityId: f.fix.utilityId } });
    return Object.fromEntries(rows.map((r) => [r.peakCode, r.label]));
  });

describe("usage by time of day on a bill", () => {
  it("prints every priced period — a zero one too — with its share, amount and hours", async () => {
    const f = await makeFixture();
    await bucket(f, "peak", 15);
    await bucket(f, "mid_peak", 0);
    await bucket(f, "off_peak", 153);
    // The engine kept no line for mid_peak: zero amounts are suppressed.
    const segmentId = await ratedSegment(f, [
      ["peak", "3.6000", 15],
      ["off_peak", "9.8685", 153],
    ]);
    const l = await labels(f);

    const [section, ...rest] = await sectionsFor(f, segmentId);

    expect(rest).toEqual([]);
    expect(section!.heading).toMatch(/usage by time of day$/);
    const byLabel = Object.fromEntries(section!.rows.map((r) => [r.label, r]));
    expect(section!.rows).toHaveLength(3);
    expect(byLabel[l.peak!]).toMatchObject({ share: "9%", amount: "3.60" });
    expect(byLabel[l.peak!]!.usage).toMatch(/^15\.00 /);
    // No line, still a row.
    expect(byLabel[l.mid_peak!]).toMatchObject({ share: "0%", amount: "0.00" });
    expect(byLabel[l.mid_peak!]!.usage).toMatch(/^0\.00 /);
    expect(byLabel[l.off_peak!]).toMatchObject({ share: "91%", amount: "9.87" });

    expect(section!.footnote).toEqual([
      "Time-of-day periods, summer season (1 Jun – 30 Sep):",
      `${l.peak}: 5–8 pm weekdays, excluding holidays.`,
      `${l.off_peak}: all other hours.`,
    ]);
  });

  it("does not move when a reading is written after the segment was rated", async () => {
    const f = await makeFixture();
    await bucket(f, "peak", 15);
    await bucket(f, "mid_peak", 0);
    await bucket(f, "off_peak", 153);
    const segmentId = await ratedSegment(f, [
      ["peak", "3.6000", 15],
      ["off_peak", "9.8685", 153],
    ]);
    const before = await sectionsFor(f, segmentId);

    // A late reading in the same period, after the bill was rated.
    await new Promise((r) => setTimeout(r, 20));
    await bucket(f, "off_peak", 50, "2026-07-06T12:00:00Z");

    expect(await sectionsFor(f, segmentId)).toEqual(before);
  });

  it("prints nothing for a segment whose tariff is not TOU", async () => {
    const f = await makeFixture();
    // The same tariff with its calendar taken away is an ordinary schedule.
    await asPlatform(() =>
      prismaImports.prisma.rateSchedule.update({ where: { id: f.scheduleId }, data: { touCalendarId: null } }),
    );
    const segmentId = await ratedSegment(f, [["off_peak", "9.8685", 153]]);

    expect(await sectionsFor(f, segmentId)).toEqual([]);
  });
});
