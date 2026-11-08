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
 * Looking at a meter's interval data (spec 26, TOU-INT-9).
 *
 * **Nothing could.** The importer landed on 2026-11-07 and until this
 * there was still no route that returned an interval row and no screen
 * that showed one: a month of AMI data existed only as the three
 * `meter_read` buckets the roll-up derived from it. So the two
 * questions this answers had no answer anywhere — *what did this meter
 * actually report*, which is what a customer disputing a TOU bill is
 * asking, and *where is the hole*, which is what the coverage queue
 * reports and nothing could show.
 *
 * The gaps come from `findCoverageProblems`, the same tiling the
 * roll-up and the sweep use. Deliberately not a second implementation:
 * a screen that drew holes a different way from the thing that refuses
 * to bill them would be worse than no screen.
 */

let pgContainer: StartedPostgreSqlContainer;
let prismaImports: typeof import("../../lib/prisma.js");
let svc: typeof import("../../services/meter-interval-series.service.js");
let fixA: TenantFixture;

const DAY = "2026-02-08";

beforeAll(async () => {
  const booted = await bootPostgres({ utilities: [TENANT_A] });
  pgContainer = booted.container;
  prismaImports = await import("../../lib/prisma.js");
  svc = await import("../../services/meter-interval-series.service.js");
}, 180_000);

afterAll(async () => {
  await prismaImports?.prisma.$disconnect().catch(() => {});
  await prismaImports?.pool.end().catch(() => {});
  await endAdminPool();
  await pgContainer?.stop().catch(() => {});
});

beforeEach(() =>
  seedAsPlatform(async () => {
    await resetDb();
    fixA = await makeTenantFixture(prismaImports.prisma, TENANT_A);
  }));

/** `count` hourly intervals from `startHour` on DAY. */
async function seedHours(
  count: number,
  opts: { startHour?: number; quality?: string; quantity?: string } = {},
) {
  const startHour = opts.startHour ?? 0;
  await seedAsPlatform(async () => {
    await prismaImports.prisma.meterReadInterval.createMany({
      data: Array.from({ length: count }, (_, i) => ({
        utilityId: TENANT_A,
        meterId: fixA.meterId,
        uomId: fixA.uomId,
        intervalStart: new Date(`${DAY}T${String(startHour + i).padStart(2, "0")}:00:00.000Z`),
        lengthMinutes: 60,
        quantity: opts.quantity ?? "1.5",
        quality: opts.quality ?? "actual",
      })),
    });
  });
}

const series = (over: Record<string, unknown> = {}) =>
  runAsTenant(TENANT_A, () =>
    svc.getMeterIntervalSeries(TENANT_A, fixA.meterId, {
      from: DAY,
      to: DAY,
      ...over,
    } as Parameters<typeof svc.getMeterIntervalSeries>[2]),
  );

describe("a meter's day of intervals", () => {
  it("returns every interval, in time order, with its quality", async () => {
    await seedHours(24);

    const s = await series();

    expect(s.intervals).toHaveLength(24);
    expect(s.intervals[0]!.intervalStart.toISOString()).toBe(`${DAY}T00:00:00.000Z`);
    expect(s.intervals[0]!.quality).toBe("actual");
    expect(s.meterNumber).toBeTruthy();
  });

  it("totals the quantity, which is what the bill is a sum of", async () => {
    await seedHours(24, { quantity: "0.5" });

    const s = await series();

    expect(Number(s.summary.total)).toBeCloseTo(12, 4);
  });

  it("counts the qualities apart, since an estimate is not a measurement", async () => {
    await seedHours(20);
    await seedHours(4, { startHour: 20, quality: "estimated" });

    const s = await series();

    expect(s.summary.byQuality).toMatchObject({ actual: 20, estimated: 4 });
  });

  it("does not reach another meter's data", async () => {
    await seedHours(24);
    await seedAsPlatform(async () => {
      await prismaImports.prisma.meterReadInterval.create({
        data: {
          utilityId: TENANT_A,
          meterId: fixA.meterId2,
          uomId: fixA.uomId,
          intervalStart: new Date(`${DAY}T00:00:00.000Z`),
          lengthMinutes: 60,
          quantity: "99",
          quality: "actual",
        },
      });
    });

    expect((await series()).intervals).toHaveLength(24);
  });
});

describe("where the holes are", () => {
  it("names a gap, by the same tiling the roll-up refuses on", async () => {
    // 09:00–12:00 missing: the shape the coverage queue reports.
    await seedHours(9);
    await seedHours(12, { startHour: 12 });

    const s = await series();

    expect(s.summary.gaps).toHaveLength(1);
    expect(s.summary.gaps[0]!.startsAt.toISOString()).toBe(`${DAY}T09:00:00.000Z`);
    expect(s.summary.gaps[0]!.minutes).toBe(180);
  });

  it("reports the minutes covered against the minutes asked for", async () => {
    await seedHours(18);

    const s = await series();

    expect(s.summary.minutesCovered).toBe(18 * 60);
    expect(s.summary.minutesInRange).toBe(24 * 60);
  });

  it("finds no gap in a day that tiles", async () => {
    await seedHours(24);

    expect((await series()).summary.gaps).toHaveLength(0);
  });
});

describe("choosing what to look at", () => {
  it("opens on the meter's most recent day when no date is given", async () => {
    await seedHours(24);
    await seedAsPlatform(async () => {
      await prismaImports.prisma.meterReadInterval.create({
        data: {
          utilityId: TENANT_A,
          meterId: fixA.meterId,
          uomId: fixA.uomId,
          intervalStart: new Date("2026-03-01T05:00:00.000Z"),
          lengthMinutes: 60,
          quantity: "2",
          quality: "actual",
        },
      });
    });

    // No range: the newest data is what somebody opening the tab wants,
    // and picking a date first is work before an answer.
    const s = await runAsTenant(TENANT_A, () =>
      svc.getMeterIntervalSeries(TENANT_A, fixA.meterId, {} as never),
    );

    expect(s.from.toISOString().slice(0, 10)).toBe("2026-03-01");
    expect(s.intervals).toHaveLength(1);
  });

  it("says so, rather than guessing, when the meter has never reported", async () => {
    const s = await runAsTenant(TENANT_A, () =>
      svc.getMeterIntervalSeries(TENANT_A, fixA.meterId, {} as never),
    );

    expect(s.intervals).toHaveLength(0);
    expect(s.reportsIntervals).toBe(false);
  });

  it("refuses a range longer than it will draw", async () => {
    /*
     * A month of 5-minute data is 8,928 rows, and a chart of them is
     * neither readable nor cheap. The limit is stated rather than
     * silently truncated: a view that quietly drops the end of a range
     * is how somebody concludes a meter stopped reporting.
     */
    await expect(series({ from: "2026-01-01", to: "2026-03-01" })).rejects.toMatchObject({
      code: "RANGE_TOO_LONG",
      statusCode: 400,
    });
  });
});
