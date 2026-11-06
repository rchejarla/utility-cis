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
import { MeterLoader } from "../../lib/rate-engine-loaders/loaders/meter-loader.js";

/**
 * The two ways a TOU bucket comes to exist (spec 26).
 *
 * Both are here in one file on purpose. A register meter and an
 * interval meter must end at the same place — `meter_read` rows
 * carrying a `peak_code` — because the rate engine prices one shape
 * and never learns which kind of meter produced it. Testing them apart
 * would let that divergence pass twice.
 *
 *   register meter   device splits it   mapping says what dial 2 means
 *   interval meter   we split it        calendar says what 17:30 means
 *
 * The calendar is the simplest one that still has a boundary: a single
 * season, 17:00–20:00 on-peak on weekdays, off-peak the rest of the
 * time and all weekend. Bozeman's zone, so the UTC instants carry a
 * -6 offset in July and the test would fail if anything classified
 * them as UTC.
 */

let pgContainer: StartedPostgreSqlContainer;
let prismaImports: typeof import("../../lib/prisma.js");
let rollupImports: typeof import("../../services/interval-rollup.service.js");
let intervalReadsImports: typeof import("../../services/billing-run/interval-reads.js");
let sweepImports: typeof import("../../services/interval-coverage-sweep.service.js");
let readImports: typeof import("../../services/meter-read.service.js");

const ACTOR = "00000000-0000-4000-8000-aaaa00000001";
const ZONE = "America/Denver";

/** 1–7 July 2026 local: Wed, Thu, Fri, Sat, Sun, Mon, Tue — five weekdays. */
const PERIOD = {
  startDate: new Date("2026-07-01T06:00:00.000Z"),
  endDate: new Date("2026-07-08T06:00:00.000Z"),
};
const HOURS_IN_PERIOD = 7 * 24;
const WEEKDAYS_IN_PERIOD = 5;
const PEAK_HOURS_PER_WEEKDAY = 3;

beforeAll(async () => {
  const booted = await bootPostgres({ utilities: [TENANT_A] });
  pgContainer = booted.container;
  prismaImports = await import("../../lib/prisma.js");
  rollupImports = await import("../../services/interval-rollup.service.js");
  intervalReadsImports = await import("../../services/billing-run/interval-reads.js");
  sweepImports = await import("../../services/interval-coverage-sweep.service.js");
  readImports = await import("../../services/meter-read.service.js");
}, 180_000);

afterAll(async () => {
  await prismaImports?.prisma.$disconnect().catch(() => {});
  await prismaImports?.pool.end().catch(() => {});
  await endAdminPool();
  await pgContainer?.stop().catch(() => {});
});

beforeEach(() => seedAsPlatform(async () => { await resetDb(); }));

/**
 * A read-back under the fixture authority, **awaited inside the scope**.
 *
 * `seedAsPlatform(() => prisma.x.findMany(…))` is a bug, not a style:
 * a `PrismaPromise` is lazy, so returning one out of the scope executes
 * it after the scope has exited — the tenant setting is then `''` and
 * Postgres answers 22P02 on a query that looks perfectly correct.
 */
const asPlatform = <T>(fn: () => Promise<T>): Promise<T> =>
  seedAsPlatform(async () => await fn());

interface Fixture {
  fix: TenantFixture;
  saId: string;
  calendarId: string;
}

/**
 * A published calendar with one boundary, and the rows a bucket needs.
 *
 * `peakStart` is minutes from local midnight, so a test can put the
 * boundary off the hour and make an hourly interval straddle it.
 */
async function makeFixture(peakStart = 17 * 60): Promise<Fixture> {
  return seedAsPlatform(async () => {
    const { prisma } = prismaImports;
    const fix = await makeTenantFixture(prisma, TENANT_A);

    const sa = await prisma.serviceAgreement.create({
      data: {
        utilityId: fix.utilityId,
        agreementNumber: "SA-TOU-1",
        accountId: fix.accountId,
        commodityId: fix.commodityId,
        startDate: new Date("2026-01-01"),
        status: "ACTIVE",
      },
    });

    const seasonSet = await prisma.seasonSet.create({
      data: {
        utilityId: fix.utilityId,
        name: "All year",
        effectiveDate: new Date(Date.UTC(2026, 0, 1)),
        publishedAt: new Date(),
      },
    });
    /*
     * Two seasons, and the period is in summer. Winter exists so the
     * calendar uses a third code — `mid_peak` — that this period never
     * reaches, which is what the zero-bucket case needs: a tariff
     * pricing three periods has to be able to bill a month with two.
     */
    await prisma.season.createMany({
      data: [
        {
          utilityId: fix.utilityId,
          seasonSetId: seasonSet.id,
          seasonCode: "summer",
          label: "Summer",
          startMonth: 6,
          startDay: 1,
          endMonth: 9,
          endDay: 30,
          sortOrder: 0,
        },
        {
          utilityId: fix.utilityId,
          seasonSetId: seasonSet.id,
          seasonCode: "winter",
          label: "Winter",
          startMonth: 10,
          startDay: 1,
          endMonth: 5,
          endDay: 31,
          sortOrder: 1,
        },
      ],
    });

    const calendar = await prisma.touCalendar.create({
      data: {
        utilityId: fix.utilityId,
        name: "Residential time-of-use",
        effectiveDate: new Date(Date.UTC(2026, 0, 1)),
        publishedAt: new Date(),
        seasonSetId: seasonSet.id,
        timeZone: ZONE,
        clockBasis: "prevailing",
      },
    });

    const dayTypes: Record<string, string> = {};
    for (const [code, label, weekdays] of [
      ["weekday", "Weekday", [1, 2, 3, 4, 5]],
      ["weekend", "Weekend", [6, 7]],
    ] as const) {
      const dt = await prisma.touDayType.create({
        data: {
          utilityId: fix.utilityId,
          touCalendarId: calendar.id,
          dayTypeCode: code,
          label,
        },
      });
      dayTypes[code] = dt.id;
      await prisma.touDayTypeWeekday.createMany({
        data: weekdays.map((isoWeekday) => ({
          utilityId: fix.utilityId,
          touCalendarId: calendar.id,
          touDayTypeId: dt.id,
          isoWeekday,
        })),
      });
    }

    const peakEnd = peakStart + PEAK_HOURS_PER_WEEKDAY * 60;
    await prisma.touSlot.createMany({
      data: [
        { season: "summer", dayType: "weekday", peakCode: "off_peak", startMinute: 0, endMinute: peakStart },
        { season: "summer", dayType: "weekday", peakCode: "peak", startMinute: peakStart, endMinute: peakEnd },
        { season: "summer", dayType: "weekday", peakCode: "off_peak", startMinute: peakEnd, endMinute: 1440 },
        { season: "summer", dayType: "weekend", peakCode: "off_peak", startMinute: 0, endMinute: 1440 },
        // Winter is one flat mid-peak. Nothing in this period is in it;
        // the calendar still uses the code, so a bucket is still owed.
        { season: "winter", dayType: "weekday", peakCode: "mid_peak", startMinute: 0, endMinute: 1440 },
        { season: "winter", dayType: "weekend", peakCode: "mid_peak", startMinute: 0, endMinute: 1440 },
      ].map((s) => ({
        utilityId: fix.utilityId,
        touCalendarId: calendar.id,
        seasonCode: s.season,
        touDayTypeId: dayTypes[s.dayType]!,
        peakCode: s.peakCode,
        startMinute: s.startMinute,
        endMinute: s.endMinute,
      })),
    });

    return { fix, saId: sa.id, calendarId: calendar.id };
  });
}

/** One kWh an hour, every hour of the period. */
async function seedHourlyIntervals(
  f: Fixture,
  over: { at?: string; quality?: string } = {},
) {
  return seedAsPlatform(async () => {
    const { prisma } = prismaImports;
    const rows = [];
    for (let h = 0; h < HOURS_IN_PERIOD; h += 1) {
      const intervalStart = new Date(PERIOD.startDate.getTime() + h * 3_600_000);
      rows.push({
        utilityId: f.fix.utilityId,
        meterId: f.fix.meterId,
        uomId: f.fix.uomId,
        intervalStart,
        lengthMinutes: 60,
        quantity: "1.000000",
        quality:
          over.at && intervalStart.toISOString() === over.at
            ? (over.quality ?? "actual")
            : "actual",
      });
    }
    await prisma.meterReadInterval.createMany({ data: rows });
  });
}

const rollUp = (f: Fixture) =>
  runAsTenant(TENANT_A, () =>
    rollupImports.rollUpIntervals({
      utilityId: f.fix.utilityId,
      meterId: f.fix.meterId,
      serviceAgreementId: f.saId,
      touCalendarId: f.calendarId,
      period: PERIOD,
      uomId: f.fix.uomId,
    }),
  );

describe("an interval meter", () => {
  it("splits the month by the calendar, not by the meter", async () => {
    const f = await makeFixture();
    await seedHourlyIntervals(f);

    const result = await rollUp(f);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.intervalsRead).toBe(HOURS_IN_PERIOD);
    expect(result.buckets).toEqual([
      // Used by the calendar's winter, which July is not in.
      { peakCode: "mid_peak", quantity: "0.0000", intervals: 0 },
      {
        peakCode: "off_peak",
        quantity: (HOURS_IN_PERIOD - WEEKDAYS_IN_PERIOD * PEAK_HOURS_PER_WEEKDAY).toFixed(4),
        intervals: HOURS_IN_PERIOD - WEEKDAYS_IN_PERIOD * PEAK_HOURS_PER_WEEKDAY,
      },
      {
        peakCode: "peak",
        quantity: (WEEKDAYS_IN_PERIOD * PEAK_HOURS_PER_WEEKDAY).toFixed(4),
        intervals: WEEKDAYS_IN_PERIOD * PEAK_HOURS_PER_WEEKDAY,
      },
    ]);
  });

  it("reports a zero for a period the month never reaches", async () => {
    /*
     * A missing bucket is not a zero: the loader leaves the key unset
     * and the `tou_period` source raises, because on a register meter
     * an absent period means usage rolled into another dial. An
     * interval meter has no such ambiguity — so a winter month of a
     * calendar whose summer has a mid-peak must still bill, at zero.
     */
    const f = await makeFixture();
    await seedHourlyIntervals(f);

    const result = await rollUp(f);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const midPeak = result.buckets.find((b) => b.peakCode === "mid_peak");
    expect(midPeak).toEqual({ peakCode: "mid_peak", quantity: "0.0000", intervals: 0 });
  });

  it("writes buckets with no dial reading behind them", async () => {
    /*
     * A sum over classified intervals has no cumulative reading, and
     * inventing one would put a number on the bill that matches
     * nothing on the device. The paired CHECK in the `tou_registers`
     * migration is what makes "both or neither" true.
     */
    const f = await makeFixture();
    await seedHourlyIntervals(f);

    await rollUp(f);

    const rows = await asPlatform(() =>
      prismaImports.prisma.meterRead.findMany({
        where: { meterId: f.fix.meterId },
        select: { peakCode: true, reading: true, priorReading: true, consumption: true },
        orderBy: { peakCode: "asc" },
      }),
    );
    expect(rows).toHaveLength(3);
    for (const r of rows) {
      expect(r.reading).toBeNull();
      expect(r.priorReading).toBeNull();
    }
    expect(rows.some((r) => Number(r.consumption) > 0)).toBe(true);
  });

  /*
   * What kind of read a bucket is (spec 26, TOU-GAP-2 step 4).
   *
   * `readType` was hardcoded `AMI` — which is a *source*, and
   * `readSource` already said it. So the column that says whether a
   * figure is measured or estimated said neither, and "a bill
   * containing any estimate says so" had nothing to read.
   */
  it("stamps an interval-derived bucket ACTUAL, not with its source", async () => {
    const f = await makeFixture();
    await seedHourlyIntervals(f);

    await rollUp(f);

    const rows = await asPlatform(() =>
      prismaImports.prisma.meterRead.findMany({
        where: { meterId: f.fix.meterId },
        select: { readType: true, readSource: true },
      }),
    );
    expect(rows.map((r) => r.readType)).toEqual(["ACTUAL", "ACTUAL", "ACTUAL"]);
    // The source is still AMI, and is where that belongs.
    expect(rows.map((r) => r.readSource)).toEqual(["AMI", "AMI", "AMI"]);
  });

  it("says a bucket is an estimate when one of its intervals is", async () => {
    /*
     * Per bucket, not per read event: an estimated hour in the on-peak
     * window makes the on-peak figure an estimate and leaves the
     * off-peak one measured. Stamping the whole event would overstate
     * it, and a customer disputing an on-peak charge is owed the
     * narrower truth.
     */
    const f = await makeFixture();
    await seedHourlyIntervals(f, { at: "2026-07-01T23:00:00.000Z", quality: "estimated" });

    await rollUp(f);

    const rows = await asPlatform(() =>
      prismaImports.prisma.meterRead.findMany({
        where: { meterId: f.fix.meterId },
        select: { peakCode: true, readType: true },
        orderBy: { peakCode: "asc" },
      }),
    );
    expect(rows).toEqual([
      { peakCode: "mid_peak", readType: "ACTUAL" },
      { peakCode: "off_peak", readType: "ACTUAL" },
      { peakCode: "peak", readType: "ESTIMATED" },
    ]);
  });

  it("calls an edited interval measured, because somebody read the meter", async () => {
    /*
     * `edited` is a real value a person corrected, not a figure nobody
     * took — so it is ACTUAL. `CORRECTED` would be wrong: that means a
     * read row that supersedes another, with `correctsReadId` set, and
     * there is no such row here.
     */
    const f = await makeFixture();
    await seedHourlyIntervals(f, { at: "2026-07-01T23:00:00.000Z", quality: "edited" });

    await rollUp(f);

    const peak = await asPlatform(() =>
      prismaImports.prisma.meterRead.findFirstOrThrow({
        where: { meterId: f.fix.meterId, peakCode: "peak" },
        select: { readType: true },
      }),
    );
    expect(peak.readType).toBe("ACTUAL");
  });

  it("answers the rating keys a TOU charge reads", async () => {
    // The whole point: the engine asks `meter:tou:<meter>:<code>` and
    // does not care which kind of meter answered.
    const f = await makeFixture();
    await seedHourlyIntervals(f);
    await rollUp(f);

    const loaded = await runAsTenant(TENANT_A, () => {
      const loader = new MeterLoader(prismaImports.prisma, TENANT_A, PERIOD);
      return loader.load([
        `meter:tou:${f.fix.meterId}:peak`,
        `meter:tou:${f.fix.meterId}:off_peak`,
      ]);
    });

    expect(Number((loaded.get(`meter:tou:${f.fix.meterId}:peak`) as { quantity: unknown }).quantity))
      .toBe(WEEKDAYS_IN_PERIOD * PEAK_HOURS_PER_WEEKDAY);
  });

  it("can be re-run after a correction without doubling the month", async () => {
    const f = await makeFixture();
    await seedHourlyIntervals(f);

    await rollUp(f);
    const second = await rollUp(f);

    expect(second.ok).toBe(true);
    const rows = await asPlatform(() =>
      prismaImports.prisma.meterRead.count({ where: { meterId: f.fix.meterId } }),
    );
    expect(rows).toBe(3);
  });

  it("refuses an interval that straddles a period change, rather than guessing", async () => {
    /*
     * TOU-INT-4. An hourly interval against a 17:30 boundary has no
     * honest single answer, and classifying it by its start would
     * price half an hour of on-peak energy at the off-peak rate every
     * day, invisibly.
     */
    const f = await makeFixture(17 * 60 + 30);
    await seedHourlyIntervals(f);

    const result = await rollUp(f);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems.join(" ")).toMatch(/starts in "off_peak" and ends in "peak"/);
  });

  it("refuses a period with a missing interval instead of under-billing it", async () => {
    // TOU-GAP-1: missing energy is never silently priced as off-peak.
    // A sum missing an hour looks exactly like a quiet hour.
    const f = await makeFixture();
    await seedHourlyIntervals(f, { at: "2026-07-01T23:00:00.000Z", quality: "missing" });

    const result = await rollUp(f);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems.join(" ")).toMatch(/reported no value/);
  });

  it("refuses a draft calendar, whose hours can still change", async () => {
    const f = await makeFixture();
    await seedHourlyIntervals(f);
    await asPlatform(() =>
      prismaImports.prisma.touCalendar.update({
        where: { id: f.calendarId },
        data: { publishedAt: null },
      }),
    );

    const result = await rollUp(f);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems.join(" ")).toMatch(/still a draft/);
  });
});

describe("an interval meter with holes in its data", () => {
  /*
   * The wiring for `findCoverageProblems`, whose arithmetic is unit
   * tested. What matters here is that a gap reaches the same refusal
   * as a `missing` reading and writes nothing — the migration always
   * said both should behave alike, and only the self-reported half was
   * built.
   */
  it("refuses a month with hours simply absent, and says how many minutes", async () => {
    const f = await makeFixture();
    await seedHourlyIntervals(f);
    await asPlatform(() =>
      prismaImports.prisma.meterReadInterval.deleteMany({
        where: {
          meterId: f.fix.meterId,
          intervalStart: {
            gte: new Date(PERIOD.startDate.getTime() + 10 * 3_600_000),
            lt: new Date(PERIOD.startDate.getTime() + 13 * 3_600_000),
          },
        },
      }),
    );

    const result = await rollUp(f);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems.join(" ")).toMatch(/180 minutes/);
    expect(result.problems.join(" ")).toMatch(/undercharge/i);
  });

  it("writes no buckets at all when the data has a hole", async () => {
    // Not "bill what arrived": that bill is short by the missing hours
    // and reads as an ordinary quiet month.
    const f = await makeFixture();
    await seedHourlyIntervals(f);
    await asPlatform(() =>
      prismaImports.prisma.meterReadInterval.deleteMany({
        where: {
          meterId: f.fix.meterId,
          intervalStart: { gte: new Date(PERIOD.startDate.getTime() + 10 * 3_600_000) },
        },
      }),
    );

    await rollUp(f);

    const written = await asPlatform(() =>
      prismaImports.prisma.meterRead.findMany({
        where: { meterId: f.fix.meterId, peakCode: { not: null } },
      }),
    );
    expect(written).toHaveLength(0);
  });
});

describe("a register meter", () => {
  it("stamps each read with the period its register counts", async () => {
    /*
     * The device already did the bucketing; the mapping says what each
     * dial means. Stamping at the read is what makes a re-rate exact —
     * the mapping is not versioned, so looking it up again later would
     * answer with today's assignment.
     */
    const f = await makeFixture();
    const registers = await seedAsPlatform(async () => {
      const { prisma } = prismaImports;
      const measureType = await prisma.measureTypeDef.findFirst({ select: { id: true } });
      return Promise.all(
        [
          { registerNumber: 1, peakCode: "peak" },
          { registerNumber: 2, peakCode: "off_peak" },
        ].map((r) =>
          prisma.meterRegister.create({
            data: {
              utilityId: f.fix.utilityId,
              meterId: f.fix.meterId,
              registerNumber: r.registerNumber,
              uomId: f.fix.uomId,
              measureTypeId: measureType!.id,
              peakCode: r.peakCode,
            },
          }),
        ),
      );
    });

    await runAsTenant(TENANT_A, () =>
      readImports.createMeterReadEvent(f.fix.utilityId, ACTOR, "Tester", {
        meterId: f.fix.meterId,
        serviceAgreementId: f.saId,
        readDate: "2026-07-07",
        readDatetime: "2026-07-07T18:00:00.000Z",
        readings: [
          { registerId: registers[0]!.id, reading: "15" },
          { registerId: registers[1]!.id, reading: "153" },
        ],
        skips: [],
      } as never),
    );

    const rows = await asPlatform(() =>
      prismaImports.prisma.meterRead.findMany({
        where: { meterId: f.fix.meterId },
        select: { peakCode: true, consumption: true },
        orderBy: { peakCode: "asc" },
      }),
    );
    expect(rows.map((r) => r.peakCode)).toEqual(["off_peak", "peak"]);
  });
});

/**
 * The billing run derives an interval meter's buckets itself.
 *
 * Until it did, the only thing that classified intervals was an
 * operator running `scripts/roll-up-intervals.ts`, and the failure was
 * quiet in the worst way: `resolveServicePeriod` needs an unbilled
 * `meter_read` to find a period, so an interval meter with a month of
 * data and no roll-up was **skipped** — and the run reported the
 * account as having no read.
 */
describe("deriving an interval meter's reads for a run", () => {
  /**
   * The meter has to reach the agreement the way it does in production:
   * service agreement → service point → meter. `rollUpIntervals` takes
   * a meter id and never needed the link, so the fixture above has
   * none; `deriveIntervalReads` finds the meters for an agreement, and
   * must, because that is what a run knows.
   */
  async function attachMeterToAgreement(f: Fixture) {
    return asPlatform(async () => {
      const { prisma } = prismaImports;
      const sp = await prisma.servicePoint.create({
        data: {
          utilityId: f.fix.utilityId,
          serviceAgreementId: f.saId,
          premiseId: f.fix.premiseId,
          startDate: new Date("2026-01-01"),
        },
      });
      await prisma.servicePointMeter.create({
        data: {
          utilityId: f.fix.utilityId,
          servicePointId: sp.id,
          meterId: f.fix.meterId,
          addedDate: new Date("2026-01-01"),
        },
      });
    });
  }

  /** A published TOU tariff over the fixture's calendar, assigned. */
  async function assignTouSchedule(f: Fixture, over: { touCalendarId?: string | null } = {}) {
    return asPlatform(async () => {
      const { prisma } = prismaImports;
      const schedule = await prisma.rateSchedule.create({
        data: {
          utilityId: f.fix.utilityId,
          name: "Residential TOU",
          code: `RES-TOU-${Math.random().toString(36).slice(2, 8)}`,
          commodityId: f.fix.commodityId,
          effectiveDate: new Date("2026-01-01"),
          version: 1,
          publishedAt: new Date(),
          touCalendarId:
            over.touCalendarId === undefined ? f.calendarId : over.touCalendarId,
        },
      });
      await prisma.sAScheduleAssignment.create({
        data: {
          utilityId: f.fix.utilityId,
          serviceAgreementId: f.saId,
          rateScheduleId: schedule.id,
          roleCode: "primary",
          effectiveDate: new Date("2026-01-01"),
        },
      });
      return schedule.id;
    });
  }

  const derive = (f: Fixture) =>
    runAsTenant(TENANT_A, () =>
      intervalReadsImports.deriveIntervalReads({
        utilityId: f.fix.utilityId,
        serviceAgreementIds: [f.saId],
        window: PERIOD,
      }),
    );

  const bucketsOf = (f: Fixture) =>
    asPlatform(() =>
      prismaImports.prisma.meterRead.findMany({
        where: { meterId: f.fix.meterId, peakCode: { not: null } },
        select: { peakCode: true, consumption: true, billedAt: true },
        orderBy: { peakCode: "asc" },
      }),
    );

  it("produces the buckets a bill is priced from", async () => {
    const f = await makeFixture();
    await attachMeterToAgreement(f);
    await assignTouSchedule(f);
    await seedHourlyIntervals(f);

    const derived = await derive(f);

    expect(derived).toHaveLength(1);
    expect(derived[0]!.intervalsRead).toBe(HOURS_IN_PERIOD);
    const buckets = await bucketsOf(f);
    // Every period the calendar uses, zero included — the contract the
    // `tou_period` source relies on to raise instead of billing zero.
    expect(buckets.map((b) => b.peakCode)).toEqual(["mid_peak", "off_peak", "peak"]);
    const peak = buckets.find((b) => b.peakCode === "peak")!;
    expect(Number(peak.consumption)).toBe(WEEKDAYS_IN_PERIOD * PEAK_HOURS_PER_WEEKDAY);
  });

  it("does nothing for an agreement whose tariff prices no TOU period", async () => {
    const f = await makeFixture();
    await attachMeterToAgreement(f);
    await assignTouSchedule(f, { touCalendarId: null });
    await seedHourlyIntervals(f);

    expect(await derive(f)).toEqual([]);
    expect(await bucketsOf(f)).toHaveLength(0);
  });

  it("does nothing for a meter that reports no intervals", async () => {
    // The ordinary register meter: its buckets are stamped at import,
    // and asking it for intervals it was never going to have is not a
    // fault.
    const f = await makeFixture();
    await attachMeterToAgreement(f);
    await assignTouSchedule(f);

    expect(await derive(f)).toEqual([]);
  });

  it("refuses to bill the account when the intervals cannot be split", async () => {
    const f = await makeFixture();
    await attachMeterToAgreement(f);
    await assignTouSchedule(f);
    await seedHourlyIntervals(f, {
      at: PERIOD.startDate.toISOString(),
      quality: "missing",
    });

    // Not "bill what classified and drop the rest": a missing hour is
    // usage nobody can price, and the bill would silently be short.
    await expect(derive(f)).rejects.toThrow(/could not be split/i);
    expect(await bucketsOf(f)).toHaveLength(0);
  });

  it("names the meter in the refusal", async () => {
    const f = await makeFixture();
    await attachMeterToAgreement(f);
    await assignTouSchedule(f);
    await seedHourlyIntervals(f, {
      at: PERIOD.startDate.toISOString(),
      quality: "missing",
    });

    const meter = await asPlatform(() =>
      prismaImports.prisma.meter.findUniqueOrThrow({
        where: { id: f.fix.meterId },
        select: { meterNumber: true },
      }),
    );
    await expect(derive(f)).rejects.toThrow(new RegExp(meter.meterNumber));
  });

  it("leaves a window that has already been billed alone", async () => {
    /*
     * The roll-up clears and rewrites unbilled interval-derived rows, so
     * a re-run picks up late-arriving intervals. A window already billed
     * is closed: rewriting it would move a figure a customer has been
     * told.
     */
    const f = await makeFixture();
    await attachMeterToAgreement(f);
    await assignTouSchedule(f);
    await seedHourlyIntervals(f);
    await derive(f);
    await asPlatform(() =>
      prismaImports.prisma.meterRead.updateMany({
        where: { meterId: f.fix.meterId, peakCode: { not: null } },
        data: { billedAt: new Date(), consumption: "1.0000" },
      }),
    );

    expect(await derive(f)).toEqual([]);
    const after = await bucketsOf(f);
    expect(after.every((b) => Number(b.consumption) === 1)).toBe(true);
  });
});

/**
 * The daily coverage sweep (spec 26, TOU-INT-4c).
 *
 * Coverage used to be checked only inside the roll-up, reached only
 * from a billing run — the one moment a gap is useless to know about,
 * because by bill day the choices are to hold the account or estimate
 * it. The point of sweeping is to find it while the meter can still be
 * re-polled and the real data recovered.
 *
 * `now` is passed in rather than mocked, because the whole gate is a
 * comparison between a tenant's local hour and its configured run
 * hour, and a test that could not move the clock could not exercise
 * it.
 */
describe("the interval coverage sweep", () => {
  const ZONE = "America/Denver";
  /** 04:00 local in Denver on 11 July 2026 (MDT, UTC-6). */
  const NOW = new Date("2026-07-11T10:00:00.000Z");
  const RUN_HOUR = 4;

  async function configureTenant(over: { enabled?: boolean; settings?: unknown } = {}) {
    return asPlatform(async () => {
      const { prisma } = prismaImports;
      await prisma.utilityConfig.upsert({
        where: { utilityId: TENANT_A },
        create: { utilityId: TENANT_A, timezone: ZONE },
        update: { timezone: ZONE },
      });
      await prisma.schedulerConfig.upsert({
        where: {
          utilityId_schedulerKey: { utilityId: TENANT_A, schedulerKey: "intervalCoverage" },
        },
        create: {
          utilityId: TENANT_A,
          schedulerKey: "intervalCoverage",
          enabled: over.enabled ?? true,
          runHourLocal: RUN_HOUR,
          settings: (over.settings ?? { graceHours: 48, lookbackDays: 7 }) as never,
        },
        update: {
          enabled: over.enabled ?? true,
          runHourLocal: RUN_HOUR,
          settings: (over.settings ?? { graceHours: 48, lookbackDays: 7 }) as never,
        },
      });
    });
  }

  const sweep = (now = NOW) =>
    asPlatform(() => sweepImports.sweepIntervalCoverage(now));

  /** Remove `hours` hourly intervals starting `offsetHours` into the period. */
  async function punchHole(f: Fixture, offsetHours: number, hours: number) {
    return asPlatform(() =>
      prismaImports.prisma.meterReadInterval.deleteMany({
        where: {
          meterId: f.fix.meterId,
          intervalStart: {
            gte: new Date(PERIOD.startDate.getTime() + offsetHours * 3_600_000),
            lt: new Date(PERIOD.startDate.getTime() + (offsetHours + hours) * 3_600_000),
          },
        },
      }),
    );
  }

  it("reports nothing for a meter whose days are fully covered", async () => {
    const f = await makeFixture();
    await seedHourlyIntervals(f);
    await configureTenant();

    const result = await sweep();

    expect(result.tenantsSwept).toBe(1);
    expect(result.metersChecked).toBe(1);
    expect(result.findings).toEqual([]);
  });

  it("names the meter and the day when hours are missing", async () => {
    const f = await makeFixture();
    await seedHourlyIntervals(f);
    // 48 hours into 1 July local is 3 July; three hours from 06:00 local.
    await punchHole(f, 54, 3);
    await configureTenant();

    const result = await sweep();

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]!.day).toBe("2026-07-03");
    expect(result.findings[0]!.minutesAffected).toBe(180);
    expect(result.findings[0]!.problems.map((p) => p.message).join(" ")).toMatch(/undercharge/i);
    expect(result.findings[0]!.problems[0]!.kind).toBe("gap");
  });

  it("does not sweep a tenant with the scheduler off", async () => {
    // Which is every tenant until somebody turns it on: the catalogue
    // default is disabled, so shipping this starts no work anywhere.
    const f = await makeFixture();
    await seedHourlyIntervals(f);
    await punchHole(f, 54, 3);
    await configureTenant({ enabled: false });

    const result = await sweep();

    expect(result.tenantsSwept).toBe(0);
    expect(result.findings).toEqual([]);
  });

  it("does not sweep at an hour that is not the tenant's", async () => {
    const f = await makeFixture();
    await seedHourlyIntervals(f);
    await punchHole(f, 54, 3);
    await configureTenant();

    // 09:00 local, five hours off the configured run hour.
    const result = await sweep(new Date("2026-07-11T15:00:00.000Z"));

    expect(result.tenantsSwept).toBe(0);
  });

  it("leaves a hole inside the grace period alone", async () => {
    /*
     * The point of the grace window: a head-end backfills for hours or
     * days, so judging the recent tail would report every meter whose
     * data is still arriving. With 7 July's hole and a grace of 120
     * hours from 11 July, the 7th is no longer judgeable.
     */
    const f = await makeFixture();
    await seedHourlyIntervals(f);
    await punchHole(f, 150, 3); // 7 July local
    await configureTenant({ settings: { graceHours: 120, lookbackDays: 7 } });

    expect((await sweep()).findings).toEqual([]);
  });

  it("stops asking about a day older than the lookback", async () => {
    const f = await makeFixture();
    await seedHourlyIntervals(f);
    await punchHole(f, 54, 3); // 3 July
    await configureTenant({ settings: { graceHours: 48, lookbackDays: 2 } });

    // A two-day lookback from the 9th reaches the 7th and 8th only.
    expect((await sweep()).findings).toEqual([]);
  });

  it("records that it ran, so the console can show it", async () => {
    const f = await makeFixture();
    await seedHourlyIntervals(f);
    await configureTenant();

    await sweep();

    const row = await asPlatform(() =>
      prismaImports.prisma.schedulerConfig.findUniqueOrThrow({
        where: {
          utilityId_schedulerKey: { utilityId: TENANT_A, schedulerKey: "intervalCoverage" },
        },
        select: { lastRunAt: true },
      }),
    );
    expect(row.lastRunAt?.toISOString()).toBe(NOW.toISOString());
  });
});

/**
 * The flag action (spec 26, TOU-GAP-1 step 2).
 *
 * Detection without somewhere to put it is a log line nobody reads. An
 * exception is a row somebody can work: one per (meter, day, kind), so
 * tonight's sighting of yesterday's hole finds its own row rather than
 * opening a second one, and a hole that has since been backfilled
 * closes itself.
 *
 * **It closes itself rather than being closed by a person**, because
 * the condition is a fact about the data and not a judgement: the
 * intervals are either there or they are not. The three statuses that
 * *are* judgements — accepted, estimated — are nobody's but a person's,
 * which is why the sweep writes only `open` and `resolved`.
 */
describe("the coverage sweep's exceptions", () => {
  const ZONE = "America/Denver";
  const NOW = new Date("2026-07-11T10:00:00.000Z");

  async function configureTenant(settings: unknown = { graceHours: 48, lookbackDays: 7 }) {
    return asPlatform(async () => {
      const { prisma } = prismaImports;
      await prisma.utilityConfig.upsert({
        where: { utilityId: TENANT_A },
        create: { utilityId: TENANT_A, timezone: ZONE },
        update: { timezone: ZONE },
      });
      await prisma.schedulerConfig.upsert({
        where: {
          utilityId_schedulerKey: { utilityId: TENANT_A, schedulerKey: "intervalCoverage" },
        },
        create: {
          utilityId: TENANT_A,
          schedulerKey: "intervalCoverage",
          enabled: true,
          runHourLocal: 4,
          settings: settings as never,
        },
        update: { enabled: true, runHourLocal: 4, settings: settings as never },
      });
    });
  }

  const sweep = () => asPlatform(() => sweepImports.sweepIntervalCoverage(NOW));

  async function punchHole(f: Fixture, offsetHours: number, hours: number) {
    return asPlatform(() =>
      prismaImports.prisma.meterReadInterval.deleteMany({
        where: {
          meterId: f.fix.meterId,
          intervalStart: {
            gte: new Date(PERIOD.startDate.getTime() + offsetHours * 3_600_000),
            lt: new Date(PERIOD.startDate.getTime() + (offsetHours + hours) * 3_600_000),
          },
        },
      }),
    );
  }

  /** The data arrives late: put the hole's intervals back. */
  async function fillHole(f: Fixture, offsetHours: number, hours: number) {
    return asPlatform(() =>
      prismaImports.prisma.meterReadInterval.createMany({
        data: Array.from({ length: hours }, (_, i) => ({
          utilityId: f.fix.utilityId,
          meterId: f.fix.meterId,
          uomId: f.fix.uomId,
          intervalStart: new Date(PERIOD.startDate.getTime() + (offsetHours + i) * 3_600_000),
          lengthMinutes: 60,
          quantity: "1.000000",
          quality: "actual",
        })),
      }),
    );
  }

  const exceptions = () =>
    asPlatform(() =>
      prismaImports.prisma.meterDataException.findMany({
        orderBy: [{ windowStart: "asc" }, { kind: "asc" }],
      }),
    );

  it("opens an exception naming the meter, the day and the minutes", async () => {
    const f = await makeFixture();
    await seedHourlyIntervals(f);
    await punchHole(f, 54, 3); // three hours of 3 July local
    await configureTenant();

    await sweep();

    const rows = await exceptions();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      utilityId: TENANT_A,
      meterId: f.fix.meterId,
      kind: "gap",
      status: "open",
      minutesAffected: 180,
    });
    expect(rows[0]!.windowStart.toISOString()).toBe("2026-07-03T06:00:00.000Z");
    expect(rows[0]!.windowEnd.toISOString()).toBe("2026-07-04T06:00:00.000Z");
    expect(rows[0]!.detail).toMatch(/undercharge/i);
    expect(rows[0]!.resolvedAt).toBeNull();
  });

  it("does not open a second exception when tonight finds the same hole", async () => {
    const f = await makeFixture();
    await seedHourlyIntervals(f);
    await punchHole(f, 54, 3);
    await configureTenant();

    await sweep();
    await sweep();

    expect(await exceptions()).toHaveLength(1);
  });

  it("resolves the exception once the missing intervals arrive", async () => {
    const f = await makeFixture();
    await seedHourlyIntervals(f);
    await punchHole(f, 54, 3);
    await configureTenant();
    await sweep();

    await fillHole(f, 54, 3);
    const second = await sweep();

    const rows = await exceptions();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("resolved");
    expect(rows[0]!.resolvedAt).not.toBeNull();
    // The counts the worker logs and the jobs page shows. A resolution
    // on a night that found nothing new is the outcome the sweep exists
    // for, and a count that silently stayed 0 would hide it.
    expect(second.exceptionsResolved).toBe(1);
    expect(second.exceptionsOpened).toBe(0);
    expect(second.findings).toEqual([]);
  });

  it("leaves an exception open for a day it no longer sweeps", async () => {
    /*
     * The dangerous case. A tenant narrowing the lookback must not have
     * its older exceptions closed by a sweep that never examined those
     * days — a resolved exception reads as one somebody fixed.
     */
    const f = await makeFixture();
    await seedHourlyIntervals(f);
    await punchHole(f, 54, 3); // 3 July
    await configureTenant();
    await sweep();

    await configureTenant({ graceHours: 48, lookbackDays: 2 });
    await sweep();

    const rows = await exceptions();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("open");
  });

  it("leaves a problem somebody accepted alone instead of re-opening it nightly", async () => {
    /*
     * The hole is still there, so every sweep finds it. Once somebody
     * has decided to bill the month as it stands, finding it again is
     * not news — and the partial unique index would not prevent a
     * second row, because it forbids only a second *open* one.
     */
    const f = await makeFixture();
    await seedHourlyIntervals(f);
    await punchHole(f, 54, 3);
    await configureTenant();
    await sweep();

    await asPlatform(() =>
      prismaImports.prisma.meterDataException.updateMany({
        where: { meterId: f.fix.meterId },
        data: { status: "accepted", resolvedAt: NOW },
      }),
    );

    const second = await sweep();

    const rows = await exceptions();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("accepted");
    expect(second.exceptionsOpened).toBe(0);
    expect(second.exceptionsUpdated).toBe(0);
  });

  it("opens a missing_reading exception for a value the meter never took", async () => {
    /*
     * The other half of TOU-GAP-1, and the half tiling cannot see: the
     * row is there and covers its minutes, and says the meter had no
     * value for it. A different problem with a different answer — a
     * hole means chase the data, this means somebody has to decide
     * whether to estimate.
     */
    const f = await makeFixture();
    await seedHourlyIntervals(f, { at: "2026-07-03T12:00:00.000Z", quality: "missing" });
    await configureTenant();

    await sweep();

    const rows = await exceptions();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: "missing_reading",
      status: "open",
      minutesAffected: 60,
    });
    expect(rows[0]!.windowStart.toISOString()).toBe("2026-07-03T06:00:00.000Z");
  });

  it("tells a gap and an overrun on the same day apart", async () => {
    const f = await makeFixture();
    await seedHourlyIntervals(f);
    await punchHole(f, 54, 3);
    /*
     * The last hour of 3 July, delivered half an hour late and still an
     * hour long — so it runs 30 minutes into the 4th. An interval
     * cannot simply be stretched: `meter_read_interval_length_known`
     * allows 5, 15, 30 and 60 minutes and nothing else, which is the
     * only shape an overrun really arrives in.
     */
    const lastHour = new Date(PERIOD.startDate.getTime() + 71 * 3_600_000);
    await asPlatform(async () => {
      const { prisma } = prismaImports;
      await prisma.meterReadInterval.deleteMany({
        where: { meterId: f.fix.meterId, intervalStart: lastHour },
      });
      await prisma.meterReadInterval.create({
        data: {
          utilityId: f.fix.utilityId,
          meterId: f.fix.meterId,
          uomId: f.fix.uomId,
          intervalStart: new Date(lastHour.getTime() + 1_800_000),
          lengthMinutes: 60,
          quantity: "1.000000",
          quality: "actual",
        },
      });
    });
    await configureTenant();

    await sweep();

    const rows = await exceptions();
    expect(rows.map((r) => r.kind)).toEqual(["gap", "overrun"]);
  });
});
