import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import {
  bootPostgres,
  resetDb,
  TENANT_A,
  TENANT_B,
  endAdminPool,
  seedAsPlatform,
} from "./_effective-dating-fixtures.js";
import { runAsTenant } from "../../lib/tenant-context.js";
import { loadTouCalendar } from "../../lib/rate-engine-loaders/load-tou-calendar.js";
import {
  SMUD_CALENDAR,
  SMUD_HOLIDAY_RULES,
  SMUD_SEASONS,
  SMUD_TIME_ZONE,
} from "../../lib/rate-engine/__tests__/tariff-golden/_smud-time-of-day-fixtures.js";

/**
 * The TOU calendar loader, against real rows (spec 26, slice 1).
 *
 * A **round trip**, deliberately: the real SMUD tariff is written into
 * the schema and read back, and the loaded definition must equal the
 * fixture the pure tests classify with. That proves two things one at a
 * time cannot — that the schema can hold a tariff nobody designed it
 * around, and that the loader does not quietly reshape it on the way
 * out. If they ever diverge, the golden tests are testing something the
 * database cannot store.
 *
 * Integration rather than unit, because the unit suites mock Prisma end
 * to end: they would stay green against a schema missing half these
 * columns, which is exactly how the scheduler-config columns went
 * missing for three commits.
 */

let pgContainer: StartedPostgreSqlContainer;
let prismaImports: typeof import("../../lib/prisma.js");

beforeAll(async () => {
  const booted = await bootPostgres({ utilities: [TENANT_A, TENANT_B] });
  pgContainer = booted.container;
  prismaImports = await import("../../lib/prisma.js");
}, 180_000);

afterAll(async () => {
  await prismaImports?.prisma.$disconnect().catch(() => {});
  await prismaImports?.pool.end().catch(() => {});
  await endAdminPool();
  await pgContainer?.stop().catch(() => {});
});

beforeEach(async () => {
  await resetDb();
});

const PERIOD = { startDate: new Date(Date.UTC(2026, 5, 1)), endDate: new Date(Date.UTC(2026, 5, 30)) };

/**
 * Write the SMUD tariff for a tenant, exactly as the fixture states it.
 *
 * Returns the calendar id. `publish: false` leaves it a draft, which is
 * how the "no version in force" case is arranged.
 */
async function seedSmud(
  utilityId: string,
  opts: { name?: string; publish?: boolean; effectiveDate?: Date; withHolidays?: boolean } = {},
): Promise<string> {
  const { prisma } = prismaImports;
  const name = opts.name ?? "Time-of-Day 5-8pm";
  const publish = opts.publish ?? true;
  const withHolidays = opts.withHolidays ?? true;
  const effectiveDate = opts.effectiveDate ?? new Date(Date.UTC(2026, 0, 1));
  // Versions of one calendar share a name and differ by effective date,
  // so the satellite rows are keyed on the date, not the name.
  const suffix = `${name} ${effectiveDate.toISOString().slice(0, 10)}`;

  /*
   * Children are created flat, not nested. Every key here is
   * tenant-scoped and composite — `(utility_id, season_set_id)`,
   * `(utility_id, tou_calendar_id, tou_day_type_id)` — so Prisma counts
   * `utilityId` as part of the relation and refuses it as a field in a
   * nested create ("Unknown argument `utilityId`"). `createMany` takes
   * the scalars directly, which is what these rows are.
   */
  return seedAsPlatform(async () => {
    const seasonSet = await prisma.seasonSet.create({
      data: {
        utilityId,
        name: `SMUD seasons ${suffix}`,
        effectiveDate: new Date(Date.UTC(2026, 0, 1)),
        publishedAt: new Date(),
      },
    });
    await prisma.season.createMany({
      data: SMUD_SEASONS.map((s, i) => ({
        utilityId,
        seasonSetId: seasonSet.id,
        seasonCode: s.seasonCode,
        label: s.seasonCode,
        startMonth: s.startMonth,
        startDay: s.startDay,
        endMonth: s.endMonth,
        endDay: s.endDay,
        sortOrder: i,
      })),
    });

    let holidayListId: string | null = null;
    if (withHolidays) {
      const list = await prisma.touHolidayList.create({
        data: { utilityId, name: `SMUD holidays ${suffix}` },
      });
      await prisma.touHolidayRule.createMany({
        data: SMUD_HOLIDAY_RULES.map((r) => ({
          utilityId,
          touHolidayListId: list.id,
          code: r.code,
          label: r.label,
          kind: r.kind,
          month: r.month,
          day: r.day ?? null,
          weekday: r.weekday ?? null,
          nth: r.nth ?? null,
          observance: r.observance,
        })),
      });
      holidayListId = list.id;
    }

    const calendar = await prisma.touCalendar.create({
      data: {
        utilityId,
        name,
        effectiveDate,
        publishedAt: publish ? new Date() : null,
        seasonSetId: seasonSet.id,
        touHolidayListId: holidayListId,
        timeZone: SMUD_TIME_ZONE,
        clockBasis: "prevailing",
      },
    });

    const periodIds = new Map<string, string>();
    for (const [i, peakCode] of SMUD_CALENDAR.peakCodes.entries()) {
      const row = await prisma.touPeriod.create({
        data: { utilityId, touCalendarId: calendar.id, peakCode, label: peakCode, sortOrder: i },
      });
      periodIds.set(peakCode, row.id);
    }

    const dayTypeIds = new Map<string, string>();
    for (const [i, dt] of SMUD_CALENDAR.dayTypes.entries()) {
      const row = await prisma.touDayType.create({
        data: {
          utilityId,
          touCalendarId: calendar.id,
          dayTypeCode: dt.dayTypeCode,
          label: dt.dayTypeCode,
          isHoliday: dt.isHoliday,
          sortOrder: i,
        },
      });
      dayTypeIds.set(dt.dayTypeCode, row.id);
      if (dt.weekdays.length > 0) {
        await prisma.touDayTypeWeekday.createMany({
          data: dt.weekdays.map((w) => ({
            utilityId,
            touCalendarId: calendar.id,
            touDayTypeId: row.id,
            isoWeekday: w,
          })),
        });
      }
    }

    await prisma.touSlot.createMany({
      data: SMUD_CALENDAR.slots.map((slot) => ({
        utilityId,
        touCalendarId: calendar.id,
        seasonCode: slot.seasonCode,
        touDayTypeId: dayTypeIds.get(slot.dayTypeCode)!,
        touPeriodId: periodIds.get(slot.peakCode)!,
        startMinute: slot.startMinute,
        endMinute: slot.endMinute,
      })),
    });

    return calendar.id;
  });
}

/** Sort both sides, since neither the schema nor the fixture fixes an order. */
const sortSlots = <T extends { seasonCode: string; dayTypeCode: string; startMinute: number }>(
  slots: readonly T[],
): T[] =>
  [...slots].sort(
    (a, b) =>
      a.seasonCode.localeCompare(b.seasonCode) ||
      a.dayTypeCode.localeCompare(b.dayTypeCode) ||
      a.startMinute - b.startMinute,
  );

describe("the schema holds the real tariff and gives it back unchanged", () => {
  it("round-trips every span, day type and period", async () => {
    await seedSmud(TENANT_A);

    const loaded = await runAsTenant(TENANT_A, async () =>
      loadTouCalendar(prismaImports.prisma, {
        utilityId: TENANT_A,
        name: "Time-of-Day 5-8pm",
        period: PERIOD,
      }),
    );

    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;

    expect(sortSlots(loaded.calendar.definition.slots)).toEqual(sortSlots(SMUD_CALENDAR.slots));
    expect(loaded.calendar.definition.dayTypes).toEqual(SMUD_CALENDAR.dayTypes);
    expect([...loaded.calendar.definition.peakCodes].sort()).toEqual(
      [...SMUD_CALENDAR.peakCodes].sort(),
    );
    expect(loaded.calendar.seasons).toEqual(SMUD_SEASONS);
    expect(loaded.calendar.timeZone).toBe(SMUD_TIME_ZONE);
    expect(loaded.calendar.clockBasis).toBe("prevailing");
  });

  it("validates as a calendar after the round trip, not just before it", async () => {
    // The fixture is known valid; this proves nothing was lost in
    // storage. A span dropped on the way out would leave a gap, and a
    // gap is what prices an hour at nothing.
    await seedSmud(TENANT_A);
    const { validateCalendar } = await import("../../lib/rate-engine/tou-calendar.js");

    const loaded = await runAsTenant(TENANT_A, async () =>
      loadTouCalendar(prismaImports.prisma, {
        utilityId: TENANT_A,
        name: "Time-of-Day 5-8pm",
        period: PERIOD,
      }),
    );
    if (!loaded.ok) throw new Error(loaded.problem);

    expect(validateCalendar(loaded.calendar.definition, loaded.calendar.seasons)).toEqual({
      ok: true,
    });
  });

  it("resolves the holiday rules to observed dates for the period's years", async () => {
    await seedSmud(TENANT_A);

    const loaded = await runAsTenant(TENANT_A, async () =>
      loadTouCalendar(prismaImports.prisma, {
        utilityId: TENANT_A,
        name: "Time-of-Day 5-8pm",
        period: PERIOD,
      }),
    );
    if (!loaded.ok) throw new Error(loaded.problem);

    // Eleven holidays, and the two the golden tests lean on.
    expect(loaded.calendar.observedHolidays.size).toBe(11);
    expect(loaded.calendar.observedHolidays.has("2026-11-26")).toBe(true); // Thanksgiving
    expect(loaded.calendar.observedHolidays.has("2026-07-04")).toBe(true);
    // SMUD does not shift a weekend holiday to the Friday before.
    expect(loaded.calendar.observedHolidays.has("2026-07-03")).toBe(false);
  });

  it("covers both years when the period crosses the year end", async () => {
    // A December-to-January billing period needs both years' holidays,
    // or New Year's Day prices as an ordinary weekday.
    await seedSmud(TENANT_A);

    const loaded = await runAsTenant(TENANT_A, async () =>
      loadTouCalendar(prismaImports.prisma, {
        utilityId: TENANT_A,
        name: "Time-of-Day 5-8pm",
        period: {
          startDate: new Date(Date.UTC(2026, 11, 15)),
          endDate: new Date(Date.UTC(2027, 0, 15)),
        },
      }),
    );
    if (!loaded.ok) throw new Error(loaded.problem);

    expect(loaded.calendar.observedHolidays.has("2026-12-25")).toBe(true);
    expect(loaded.calendar.observedHolidays.has("2027-01-01")).toBe(true);
    expect(loaded.calendar.observedHolidays.size).toBe(22);
  });

  it("gives an empty holiday set when a calendar names no list", async () => {
    // A tenant whose tariff does not distinguish holidays. Not an
    // error, and the weekday coverage then answers for every date.
    await seedSmud(TENANT_A, { withHolidays: false });

    const loaded = await runAsTenant(TENANT_A, async () =>
      loadTouCalendar(prismaImports.prisma, {
        utilityId: TENANT_A,
        name: "Time-of-Day 5-8pm",
        period: PERIOD,
      }),
    );
    if (!loaded.ok) throw new Error(loaded.problem);
    expect(loaded.calendar.observedHolidays.size).toBe(0);
  });
});

describe("which version is in force", () => {
  it("takes the newest published version on or before the period start", async () => {
    // Versions of one calendar share a name and differ by effective
    // date, so both of these are "Time-of-Day 5-8pm". Picking the older
    // one would price June 2026 on peak hours that were superseded in
    // January.
    const older = await seedSmud(TENANT_A, { effectiveDate: new Date(Date.UTC(2025, 0, 1)) });
    const newer = await seedSmud(TENANT_A, { effectiveDate: new Date(Date.UTC(2026, 0, 1)) });

    const loaded = await runAsTenant(TENANT_A, async () =>
      loadTouCalendar(prismaImports.prisma, {
        utilityId: TENANT_A,
        name: "Time-of-Day 5-8pm",
        period: PERIOD,
      }),
    );
    if (!loaded.ok) throw new Error(loaded.problem);
    expect(loaded.calendar.id).toBe(newer);
    expect(loaded.calendar.id).not.toBe(older);
    expect(loaded.calendar.effectiveDate.toISOString().slice(0, 10)).toBe("2026-01-01");
  });

  it("re-rates an older period on the version that was in force then", async () => {
    // The property that makes a re-rate reproducible: the version is
    // chosen by the period's own dates, not by today's.
    const older = await seedSmud(TENANT_A, { effectiveDate: new Date(Date.UTC(2025, 0, 1)) });
    await seedSmud(TENANT_A, { effectiveDate: new Date(Date.UTC(2026, 0, 1)) });

    const loaded = await runAsTenant(TENANT_A, async () =>
      loadTouCalendar(prismaImports.prisma, {
        utilityId: TENANT_A,
        name: "Time-of-Day 5-8pm",
        period: {
          startDate: new Date(Date.UTC(2025, 5, 1)),
          endDate: new Date(Date.UTC(2025, 5, 30)),
        },
      }),
    );
    if (!loaded.ok) throw new Error(loaded.problem);
    expect(loaded.calendar.id).toBe(older);
  });

  it("ignores a version effective after the period starts", async () => {
    // Rating April 2026 must not use a calendar that takes effect in
    // July, however current it is.
    await seedSmud(TENANT_A, { effectiveDate: new Date(Date.UTC(2026, 6, 1)) });

    const loaded = await runAsTenant(TENANT_A, async () =>
      loadTouCalendar(prismaImports.prisma, {
        utilityId: TENANT_A,
        name: "Time-of-Day 5-8pm",
        period: {
          startDate: new Date(Date.UTC(2026, 3, 1)),
          endDate: new Date(Date.UTC(2026, 3, 30)),
        },
      }),
    );
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) expect(loaded.problem).toMatch(/no published version/i);
  });

  it("distinguishes an unpublished calendar from one that does not exist", async () => {
    /*
     * Two different operator mistakes — "you never published it" and
     * "the component names a calendar you do not have" — and one
     * message for both sends somebody to the wrong screen.
     */
    await seedSmud(TENANT_A, { publish: false });

    const unpublished = await runAsTenant(TENANT_A, async () =>
      loadTouCalendar(prismaImports.prisma, {
        utilityId: TENANT_A,
        name: "Time-of-Day 5-8pm",
        period: PERIOD,
      }),
    );
    expect(unpublished.ok).toBe(false);
    if (!unpublished.ok) expect(unpublished.problem).toMatch(/no published version/i);

    const missing = await runAsTenant(TENANT_A, async () =>
      loadTouCalendar(prismaImports.prisma, {
        utilityId: TENANT_A,
        name: "Nothing by this name",
        period: PERIOD,
      }),
    );
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.problem).toMatch(/no TOU calendar named/i);
  });
});

describe("tenant isolation", () => {
  it("does not find another tenant's calendar of the same name", async () => {
    /*
     * The failure this closes is not a leak so much as a wrong bill: if
     * tenant A's rating could reach tenant B's calendar of the same
     * name, A's customers would be priced on B's peak hours, and
     * nothing about the result would look wrong.
     */
    await seedSmud(TENANT_B);

    const loaded = await runAsTenant(TENANT_A, async () =>
      loadTouCalendar(prismaImports.prisma, {
        utilityId: TENANT_A,
        name: "Time-of-Day 5-8pm",
        period: PERIOD,
      }),
    );
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) expect(loaded.problem).toMatch(/no TOU calendar named/i);
  });

  it("loads each tenant's own calendar when both have one", async () => {
    await seedSmud(TENANT_A);
    await seedSmud(TENANT_B);

    const a = await runAsTenant(TENANT_A, async () =>
      loadTouCalendar(prismaImports.prisma, {
        utilityId: TENANT_A,
        name: "Time-of-Day 5-8pm",
        period: PERIOD,
      }),
    );
    const b = await runAsTenant(TENANT_B, async () =>
      loadTouCalendar(prismaImports.prisma, {
        utilityId: TENANT_B,
        name: "Time-of-Day 5-8pm",
        period: PERIOD,
      }),
    );

    if (!a.ok || !b.ok) throw new Error("both tenants should load their own");
    expect(a.calendar.id).not.toBe(b.calendar.id);
    // Same tariff, so the definitions match — the ids are what differ.
    expect(sortSlots(a.calendar.definition.slots)).toEqual(sortSlots(b.calendar.definition.slots));
  });
});
