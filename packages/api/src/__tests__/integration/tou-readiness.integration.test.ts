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
 * The TOU pre-run check against real rows (spec 26, TOU-BIL-1).
 *
 * Every problem it reports shares one property: **none of them shows up
 * on the bill.** A calendar mismatch bills correctly against the wrong
 * hours and every figure reconciles; unreconciled registers bill some
 * usage twice or not at all; an unrecorded meter calendar means nobody
 * can tell. The exception is a period the meter never reported, which
 * stops rating — and finding that here beats finding it halfway through
 * a run of thousands.
 */

let pgContainer: StartedPostgreSqlContainer;
let prismaImports: typeof import("../../lib/prisma.js");
/*
 * Imported dynamically, after `bootPostgres` has pointed `DATABASE_URL`
 * at the container. The service holds `prisma` at module scope, so a
 * static import would build its pool against whatever the environment
 * said at file load — which is nothing, and surfaces as
 * "SASL: client password must be a string" rather than as a missing URL.
 */
let svc: typeof import("../../services/tou-readiness.service.js");

const PERIOD = {
  startDate: new Date("2026-01-01"),
  endDate: new Date("2026-01-31"),
};

beforeAll(async () => {
  const booted = await bootPostgres({ utilities: [TENANT_A] });
  pgContainer = booted.container;
  prismaImports = await import("../../lib/prisma.js");
  svc = await import("../../services/tou-readiness.service.js");
}, 180_000);

afterAll(async () => {
  await prismaImports?.prisma.$disconnect().catch(() => {});
  await prismaImports?.pool.end().catch(() => {});
  await endAdminPool();
  await pgContainer?.stop().catch(() => {});
});

beforeEach(() => seedAsPlatform(async () => { await resetDb(); }));

interface Scene {
  fix: TenantFixture;
  saId: string;
  meterId: string;
}

/** A calendar with the periods named, published. */
async function makeCalendar(name: string, peakCodes: string[]): Promise<string> {
  const { prisma } = prismaImports;
  const seasonSet = await prisma.seasonSet.create({
    data: {
      utilityId: TENANT_A,
      name: `seasons ${name}`,
      effectiveDate: new Date(Date.UTC(2026, 0, 1)),
      publishedAt: new Date(),
    },
  });
  const calendar = await prisma.touCalendar.create({
    data: {
      utilityId: TENANT_A,
      name,
      effectiveDate: new Date(Date.UTC(2026, 0, 1)),
      publishedAt: new Date(),
      seasonSetId: seasonSet.id,
      timeZone: "America/Denver",
    },
  });
  for (const [i, peakCode] of peakCodes.entries()) {
    await prisma.touPeriod.create({
      data: {
        utilityId: TENANT_A,
        touCalendarId: calendar.id,
        peakCode,
        label: peakCode,
        sortOrder: i,
      },
    });
  }
  return calendar.id;
}

/**
 * An agreement on a TOU schedule, with one meter on a service point.
 *
 * `meterCalendarId` is what the *device* is recorded as programmed with;
 * `scheduleCalendarId` is what the tariff prices against. Passing
 * different ones is how the mismatch case is arranged.
 */
async function makeScene(opts: {
  pricedCodes: string[];
  scheduleCalendarId: string;
  meterCalendarId: string | null;
  /*
   * A fixture to build on, so two scenes can share one tenant.
   * `makeTenantFixture` creates the tenant's `utility_config` row and is
   * not idempotent, so calling it twice in one test collides on
   * `utility_config_utility_id_key` — which is how the batched test
   * first failed.
   */
  fix?: TenantFixture;
  /** Which of the fixture's two meters this scene uses. */
  meterId?: string;
}): Promise<Scene> {
  return seedAsPlatform(async () => {
    const { prisma } = prismaImports;
    const fix = opts.fix ?? (await makeTenantFixture(prisma, TENANT_A));
    const meterId = opts.meterId ?? fix.meterId;

    await prisma.meter.update({
      where: { id: meterId },
      data: { touCalendarId: opts.meterCalendarId },
    });

    const schedule = await prisma.rateSchedule.create({
      data: {
        utilityId: TENANT_A,
        name: "TOU Residential",
        code: `TOU-${Math.random().toString(36).slice(2, 8)}`,
        commodityId: fix.commodityId,
        effectiveDate: new Date(Date.UTC(2026, 0, 1)),
        publishedAt: new Date(),
        touCalendarId: opts.scheduleCalendarId,
      },
    });
    for (const [i, peakCode] of opts.pricedCodes.entries()) {
      await prisma.rateComponent.create({
        data: {
          utilityId: TENANT_A,
          rateScheduleId: schedule.id,
          kindCode: "consumption",
          label: `${peakCode} energy`,
          sortOrder: (i + 1) * 10,
          effectiveDate: new Date(Date.UTC(2026, 0, 1)),
          predicate: {},
          quantitySource: { base: "tou_period", peak_code: peakCode },
          pricing: { type: "flat", rate: 0.1, unit: "kWh" },
        },
      });
    }

    const sa = await prisma.serviceAgreement.create({
      data: {
        utilityId: TENANT_A,
        agreementNumber: `SA-TOU-${Math.random().toString(36).slice(2, 8)}`,
        accountId: fix.accountId,
        commodityId: fix.commodityId,
        startDate: new Date("2026-01-01"),
        status: "ACTIVE",
      },
    });
    await prisma.sAScheduleAssignment.create({
      data: {
        utilityId: TENANT_A,
        serviceAgreementId: sa.id,
        rateScheduleId: schedule.id,
        roleCode: "delivery",
        effectiveDate: new Date(Date.UTC(2026, 0, 1)),
      },
    });

    const sp = await prisma.servicePoint.create({
      data: {
        utilityId: TENANT_A,
        serviceAgreementId: sa.id,
        premiseId: fix.premiseId,
        type: "METERED",
        startDate: new Date("2026-01-01"),
      },
    });
    await prisma.servicePointMeter.create({
      data: {
        utilityId: TENANT_A,
        servicePointId: sp.id,
        meterId,
        addedDate: new Date("2026-01-01"),
      },
    });

    return { fix, saId: sa.id, meterId };
  });
}

async function seedRead(
  scene: Scene,
  consumption: string,
  peakCode: string | null,
): Promise<void> {
  await seedAsPlatform(async () => {
    await prismaImports.prisma.meterRead.create({
      data: {
        utilityId: TENANT_A,
        meterId: scene.meterId,
        serviceAgreementId: scene.saId,
        uomId: scene.fix.uomId,
        readDate: new Date("2026-01-20"),
        readDatetime: new Date("2026-01-20"),
        consumption,
        peakCode,
        readType: "ACTUAL",
        readSource: "MANUAL",
      },
    });
  });
}

const check = (scene: Scene) =>
  runAsTenant(TENANT_A, () => svc.checkTouReadiness(TENANT_A, scene.saId, PERIOD));

describe("a TOU service with nothing wrong", () => {
  it("reports no problems", async () => {
    const cal = await seedAsPlatform(() => makeCalendar("TOD 5-8pm", ["peak", "off_peak"]));
    const scene = await makeScene({
      pricedCodes: ["peak", "off_peak"],
      scheduleCalendarId: cal,
      meterCalendarId: cal,
    });
    await seedRead(scene, "600", null);
    await seedRead(scene, "100", "peak");
    await seedRead(scene, "500", "off_peak");

    expect(await check(scene)).toEqual([]);
  });

  it("accepts a meter programmed with a different version of the same calendar", async () => {
    /*
     * TOU-REG-2 compares calendar **names**, not versions. Republishing
     * a calendar must not flag every TOU meter in the territory — the
     * hours a meter was programmed with are the hours the tariff's
     * version names, and the version is recorded for the audit trail
     * rather than for this comparison.
     */
    const v1 = await seedAsPlatform(() => makeCalendar("TOD 5-8pm", ["peak", "off_peak"]));
    const v2 = await seedAsPlatform(async () => {
      const { prisma } = prismaImports;
      const seasonSet = await prisma.seasonSet.create({
        data: {
          utilityId: TENANT_A,
          name: "seasons v2",
          effectiveDate: new Date(Date.UTC(2027, 0, 1)),
          publishedAt: new Date(),
        },
      });
      const cal = await prisma.touCalendar.create({
        data: {
          utilityId: TENANT_A,
          name: "TOD 5-8pm", // same name, later effective date
          effectiveDate: new Date(Date.UTC(2027, 0, 1)),
          publishedAt: new Date(),
          seasonSetId: seasonSet.id,
          timeZone: "America/Denver",
        },
      });
      return cal.id;
    });

    const scene = await makeScene({
      pricedCodes: ["peak", "off_peak"],
      scheduleCalendarId: v1,
      meterCalendarId: v2,
    });
    await seedRead(scene, "100", "peak");
    await seedRead(scene, "500", "off_peak");

    expect(await check(scene)).toEqual([]);
  });
});

describe("a non-TOU service", () => {
  it("reports nothing, whatever its reads look like", async () => {
    // The pre-run check runs over every account in a cycle, so the
    // ordinary tariff has to fall straight through.
    const cal = await seedAsPlatform(() => makeCalendar("TOD 5-8pm", ["peak", "off_peak"]));
    const scene = await makeScene({
      pricedCodes: [],
      scheduleCalendarId: cal,
      meterCalendarId: null,
    });
    await seedAsPlatform(async () => {
      await prismaImports.prisma.rateSchedule.updateMany({
        where: { utilityId: TENANT_A },
        data: { touCalendarId: null },
      });
    });
    await seedRead(scene, "600", null);

    expect(await check(scene)).toEqual([]);
  });
});

describe("what it catches", () => {
  it("names a calendar mismatch, with both calendars", async () => {
    const scheduleCal = await seedAsPlatform(() =>
      makeCalendar("TOD 5-8pm", ["peak", "off_peak"]),
    );
    const meterCal = await seedAsPlatform(() => makeCalendar("Legacy 4-9pm", ["peak", "off_peak"]));
    const scene = await makeScene({
      pricedCodes: ["peak", "off_peak"],
      scheduleCalendarId: scheduleCal,
      meterCalendarId: meterCal,
    });
    await seedRead(scene, "100", "peak");
    await seedRead(scene, "500", "off_peak");

    const problems = await check(scene);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({
      kind: "CALENDAR_MISMATCH",
      meterCalendar: "Legacy 4-9pm",
      scheduleCalendar: "TOD 5-8pm",
    });
  });

  it("reports a meter whose programming was never recorded", async () => {
    const cal = await seedAsPlatform(() => makeCalendar("TOD 5-8pm", ["peak", "off_peak"]));
    const scene = await makeScene({
      pricedCodes: ["peak", "off_peak"],
      scheduleCalendarId: cal,
      meterCalendarId: null,
    });
    await seedRead(scene, "100", "peak");
    await seedRead(scene, "500", "off_peak");

    const problems = await check(scene);
    expect(problems).toHaveLength(1);
    expect(problems[0].kind).toBe("CALENDAR_UNKNOWN");
  });

  it("reports registers that do not sum to the total", async () => {
    const cal = await seedAsPlatform(() => makeCalendar("TOD 5-8pm", ["peak", "off_peak"]));
    const scene = await makeScene({
      pricedCodes: ["peak", "off_peak"],
      scheduleCalendarId: cal,
      meterCalendarId: cal,
    });
    await seedRead(scene, "600", null);
    await seedRead(scene, "100", "peak");
    await seedRead(scene, "450", "off_peak"); // 50 missing

    const problems = await check(scene);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({
      kind: "REGISTERS_UNRECONCILED",
      total: "600",
      bucketSum: "550",
      difference: "50",
      allowed: "3",
    });
  });

  it("reports a period the schedule prices and the meter never reported", async () => {
    // The one that stops rating rather than mispricing — better found
    // here than halfway through a run.
    const cal = await seedAsPlatform(() =>
      makeCalendar("TOD 5-8pm", ["peak", "mid_peak", "off_peak"]),
    );
    const scene = await makeScene({
      pricedCodes: ["peak", "mid_peak", "off_peak"],
      scheduleCalendarId: cal,
      meterCalendarId: cal,
    });
    await seedRead(scene, "100", "peak");
    await seedRead(scene, "500", "off_peak");

    const problems = await check(scene);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({ kind: "PERIOD_NOT_REPORTED", peakCode: "mid_peak" });
  });

  it("reports a TOU service with no TOU reads at all", async () => {
    const cal = await seedAsPlatform(() => makeCalendar("TOD 5-8pm", ["peak", "off_peak"]));
    const scene = await makeScene({
      pricedCodes: ["peak", "off_peak"],
      scheduleCalendarId: cal,
      meterCalendarId: cal,
    });
    await seedRead(scene, "600", null); // a total read and nothing else

    const problems = await check(scene);
    expect(problems).toHaveLength(1);
    expect(problems[0].kind).toBe("NO_TOU_READS");
    // And not a reconciliation problem on top: there is nothing to
    // reconcile, and two findings for one cause reads as two faults.
    expect(problems.some((p) => p.kind === "REGISTERS_UNRECONCILED")).toBe(false);
  });

  it("reports every problem a meter has, not the first", async () => {
    // An operator fixing one at a time turns one run into four.
    const scheduleCal = await seedAsPlatform(() =>
      makeCalendar("TOD 5-8pm", ["peak", "mid_peak", "off_peak"]),
    );
    const meterCal = await seedAsPlatform(() => makeCalendar("Legacy", ["peak", "off_peak"]));
    const scene = await makeScene({
      pricedCodes: ["peak", "mid_peak", "off_peak"],
      scheduleCalendarId: scheduleCal,
      meterCalendarId: meterCal,
    });
    await seedRead(scene, "600", null);
    await seedRead(scene, "100", "peak");
    await seedRead(scene, "450", "off_peak");

    const kinds = (await check(scene)).map((p) => p.kind).sort();
    expect(kinds).toEqual(["CALENDAR_MISMATCH", "PERIOD_NOT_REPORTED", "REGISTERS_UNRECONCILED"]);
  });
});

describe("the tenant's tolerance", () => {
  it("is honoured over the default", async () => {
    const cal = await seedAsPlatform(() => makeCalendar("TOD 5-8pm", ["peak", "off_peak"]));
    const scene = await makeScene({
      pricedCodes: ["peak", "off_peak"],
      scheduleCalendarId: cal,
      meterCalendarId: cal,
    });
    await seedRead(scene, "600", null);
    await seedRead(scene, "100", "peak");
    await seedRead(scene, "450", "off_peak"); // 50 off, which the default flags

    await seedAsPlatform(async () => {
      const { prisma } = prismaImports;
      const config = await prisma.utilityConfig.findFirst({ where: { utilityId: TENANT_A } });
      const settings = { ...(config?.settings as object), tou: { registerTolerancePercent: 20 } };
      if (config) {
        await prisma.utilityConfig.update({ where: { id: config.id }, data: { settings } });
      } else {
        await prisma.utilityConfig.create({ data: { utilityId: TENANT_A, settings } });
      }
    });

    // 20% of 600 is 120, so 50 is inside it now.
    expect(await check(scene)).toEqual([]);
  });
});

describe("checking many agreements at once", () => {
  /**
   * The form the run's preview uses. Batched because the preview runs
   * over every account in a cycle: per agreement it would be six
   * queries times tens of thousands, and here it is five in total.
   *
   * The map carries only agreements with a problem, so an empty map
   * means nothing to report rather than nothing checked.
   */
  it("keeps each agreement's problems to itself", async () => {
    const good = await seedAsPlatform(() => makeCalendar("TOD 5-8pm", ["peak", "off_peak"]));
    const legacy = await seedAsPlatform(() => makeCalendar("Legacy 4-9pm", ["peak", "off_peak"]));

    // One tenant fixture, two agreements on its two meters.
    const fix = await seedAsPlatform(() => makeTenantFixture(prismaImports.prisma, TENANT_A));

    const clean = await makeScene({
      pricedCodes: ["peak", "off_peak"],
      scheduleCalendarId: good,
      meterCalendarId: good,
      fix,
      meterId: fix.meterId,
    });
    await seedRead(clean, "100", "peak");
    await seedRead(clean, "500", "off_peak");

    const broken = await makeScene({
      pricedCodes: ["peak", "off_peak"],
      scheduleCalendarId: good,
      meterCalendarId: legacy,
      fix,
      meterId: fix.meterId2,
    });
    await seedRead(broken, "100", "peak");
    await seedRead(broken, "500", "off_peak");

    const byAgreement = await runAsTenant(TENANT_A, () =>
      svc.checkTouReadinessForAgreements(TENANT_A, [clean.saId, broken.saId], PERIOD),
    );

    // Only the broken one is listed at all.
    expect([...byAgreement.keys()]).toEqual([broken.saId]);
    expect(byAgreement.get(broken.saId)?.[0]).toMatchObject({ kind: "CALENDAR_MISMATCH" });
  });

  it("returns an empty map when none of them is a TOU service", async () => {
    // The common cycle, and the one that must stay cheap: the first
    // query answers it and the rest are never issued.
    const cal = await seedAsPlatform(() => makeCalendar("TOD 5-8pm", ["peak", "off_peak"]));
    const scene = await makeScene({
      pricedCodes: [],
      scheduleCalendarId: cal,
      meterCalendarId: null,
    });
    await seedAsPlatform(async () => {
      await prismaImports.prisma.rateSchedule.updateMany({
        where: { utilityId: TENANT_A },
        data: { touCalendarId: null },
      });
    });

    const byAgreement = await runAsTenant(TENANT_A, () =>
      svc.checkTouReadinessForAgreements(TENANT_A, [scene.saId], PERIOD),
    );
    expect(byAgreement.size).toBe(0);
  });

  it("asks nothing of the database for an empty list", async () => {
    const byAgreement = await runAsTenant(TENANT_A, () =>
      svc.checkTouReadinessForAgreements(TENANT_A, [], PERIOD),
    );
    expect(byAgreement.size).toBe(0);
  });
});
