import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import type { FastifyInstance } from "fastify";
import {
  bootPostgres,
  TENANT_A,
  ACTOR,
  ensurePrincipal,
  seedAsPlatform,
} from "./_effective-dating-fixtures.js";

/**
 * The season set editor's server side (spec 26, §1).
 *
 * Two things here are worth more than the CRUD. The first is the **leap
 * day**: a set that ends one season on 28 February and starts the next
 * on 1 March tiles 365 days exactly and loses a day every fourth year,
 * so `validateSeasons` enumerates a leap year on purpose. The second is
 * the **divergence warning** — a published TOU calendar keeps the season
 * set it names for ever, while non-TOU charges follow whichever set is
 * in force, so publishing a new set silently gives one customer two
 * definitions of summer. Nothing else in the system would ever say so.
 */

let pgContainer: StartedPostgreSqlContainer;
let prismaImports: typeof import("../../lib/prisma.js");
let app: FastifyInstance;

function makeToken(utilityId: string) {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      sub: ACTOR,
      utility_id: utilityId,
      email: "tester@example.com",
      name: "Tester",
      role: "admin",
    }),
  ).toString("base64url");
  return `${header}.${payload}.fake-signature`;
}

const headers = () => ({ authorization: `Bearer ${makeToken(TENANT_A)}` });

const inject = (
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  url: string,
  payload?: unknown,
) => app.inject({ method, url, headers: headers(), ...(payload ? { payload } : {}) });

const body = (res: { body: string }) => JSON.parse(res.body);

beforeAll(
  () =>
    seedAsPlatform(async () => {
      const booted = await bootPostgres({ utilities: [TENANT_A] });
      pgContainer = booted.container;
      prismaImports = await import("../../lib/prisma.js");
      await ensurePrincipal(prismaImports.prisma, TENANT_A);
      const appImports = await import("../../app.js");
      app = await appImports.buildApp();
      await app.ready();
    }),
  180_000,
);

afterAll(async () => {
  await app?.close().catch(() => {});
  await prismaImports?.prisma.$disconnect().catch(() => {});
  await prismaImports?.pool.end().catch(() => {});
  await pgContainer?.stop().catch(() => {});
});

beforeEach(() =>
  seedAsPlatform(async () => {
    const { prisma } = prismaImports;
    await prisma.$executeRawUnsafe("DELETE FROM tou_slot");
    await prisma.$executeRawUnsafe("DELETE FROM tou_day_override");
    await prisma.$executeRawUnsafe("DELETE FROM tou_day_type_weekday");
    await prisma.$executeRawUnsafe("DELETE FROM tou_day_type");
    await prisma.$executeRawUnsafe("DELETE FROM tou_period");
    await prisma.$executeRawUnsafe("UPDATE rate_schedule SET tou_calendar_id = NULL");
    await prisma.$executeRawUnsafe("DELETE FROM tou_calendar");
    await prisma.$executeRawUnsafe("DELETE FROM season");
    await prisma.$executeRawUnsafe("DELETE FROM season_set");

    const existing = await prisma.utilityModule.findFirst({
      where: { utilityId: TENANT_A, moduleKey: "rate_schedules" },
    });
    if (!existing) {
      await prisma.utilityModule.create({
        data: { utilityId: TENANT_A, moduleKey: "rate_schedules" },
      });
    }
    const rbac = await import("../../services/rbac.service.js");
    await rbac.invalidateTenantModulesCache(TENANT_A);
  }),
);

async function createSet(name = "Summer and winter", effectiveDate = "2026-01-01") {
  const res = await inject("POST", "/api/v1/season-sets", { name, effectiveDate });
  if (res.statusCode !== 201) throw new Error(`create failed: ${res.statusCode} ${res.body}`);
  return body(res);
}

const TWO_SEASONS = {
  seasons: [
    {
      seasonCode: "summer",
      label: "Summer",
      startMonth: 6,
      startDay: 1,
      endMonth: 9,
      endDay: 30,
    },
    {
      seasonCode: "non_summer",
      label: "Non-summer",
      startMonth: 10,
      startDay: 1,
      endMonth: 5,
      endDay: 31,
    },
  ],
};

describe("building a set", () => {
  it("creates a draft with no seasons, which is not yet publishable", async () => {
    const set = await createSet();
    expect(set.publishedAt).toBeNull();

    const res = await inject("GET", `/api/v1/season-sets/${set.id}`);
    expect(body(res).validation.ok).toBe(false);
    expect(body(res).validation.problems[0]).toMatch(/at least one season/);
  });

  it("accepts a season that wraps the year end as one season", async () => {
    // 1 October to 31 May is one season, not two. This is the case a
    // naive month comparison gets wrong.
    const set = await createSet();
    const res = await inject("PUT", `/api/v1/season-sets/${set.id}/seasons`, TWO_SEASONS);
    expect(res.statusCode).toBe(200);
    expect(body(res).validation.ok).toBe(true);
  });

  it("returns a day-by-day coverage of a leap year", async () => {
    const set = await createSet();
    const res = await inject("PUT", `/api/v1/season-sets/${set.id}/seasons`, TWO_SEASONS);
    const coverage = body(res).coverage;
    expect(coverage).toHaveLength(366);
    // 29 February exists in the coverage and belongs to non_summer.
    const leapDay = coverage.find(
      (d: { month: number; day: number }) => d.month === 2 && d.day === 29,
    );
    expect(leapDay.claimedBy).toEqual(["non_summer"]);
  });

  it("names the days no season covers", async () => {
    const set = await createSet();
    const res = await inject("PUT", `/api/v1/season-sets/${set.id}/seasons`, {
      seasons: [TWO_SEASONS.seasons[0]],
    });
    const validation = body(res).validation;
    expect(validation.ok).toBe(false);
    expect(validation.problems.join("\n")).toMatch(/October/);
  });

  it("names the days two seasons both cover", async () => {
    const set = await createSet();
    const res = await inject("PUT", `/api/v1/season-sets/${set.id}/seasons`, {
      seasons: [
        { seasonCode: "a", label: "A", startMonth: 1, startDay: 1, endMonth: 7, endDay: 31 },
        { seasonCode: "b", label: "B", startMonth: 7, startDay: 1, endMonth: 12, endDay: 31 },
      ],
    });
    const validation = body(res).validation;
    expect(validation.ok).toBe(false);
    expect(validation.problems.join("\n")).toMatch(/July/);
  });

  it("refuses a boundary that is not a date", async () => {
    const set = await createSet();
    const res = await inject("PUT", `/api/v1/season-sets/${set.id}/seasons`, {
      seasons: [
        { seasonCode: "a", label: "A", startMonth: 1, startDay: 1, endMonth: 2, endDay: 30 },
        { seasonCode: "b", label: "B", startMonth: 3, startDay: 1, endMonth: 12, endDay: 31 },
      ],
    });
    const validation = body(res).validation;
    expect(validation.ok).toBe(false);
    expect(validation.problems.join("\n")).toMatch(/30 February, which is not a date/);
  });

  it("refuses two seasons with one code", async () => {
    const set = await createSet();
    const res = await inject("PUT", `/api/v1/season-sets/${set.id}/seasons`, {
      seasons: [
        { seasonCode: "summer", label: "A", startMonth: 1, startDay: 1, endMonth: 6, endDay: 30 },
        { seasonCode: "summer", label: "B", startMonth: 7, startDay: 1, endMonth: 12, endDay: 31 },
      ],
    });
    expect(res.statusCode).toBe(400);
    expect(body(res).error.code).toBe("DUPLICATE_SEASON_CODE");
  });
});

describe("the leap day", () => {
  it("is a gap when February ends on the 28th", async () => {
    /*
     * The fault that ships and then waits: 365 days tile exactly, and
     * every fourth year a bill falls on a day in no season. The
     * validator enumerates a leap year so this is caught on the screen
     * rather than in 2028.
     */
    const set = await createSet();
    const res = await inject("PUT", `/api/v1/season-sets/${set.id}/seasons`, {
      seasons: [
        { seasonCode: "winter", label: "Winter", startMonth: 1, startDay: 1, endMonth: 2, endDay: 28 },
        { seasonCode: "rest", label: "Rest", startMonth: 3, startDay: 1, endMonth: 12, endDay: 31 },
      ],
    });
    const validation = body(res).validation;
    expect(validation.ok).toBe(false);
    expect(validation.problems.join("\n")).toMatch(/29 February/);
  });

  it("is covered when February ends on the 29th", async () => {
    const set = await createSet();
    const res = await inject("PUT", `/api/v1/season-sets/${set.id}/seasons`, {
      seasons: [
        { seasonCode: "winter", label: "Winter", startMonth: 1, startDay: 1, endMonth: 2, endDay: 29 },
        { seasonCode: "rest", label: "Rest", startMonth: 3, startDay: 1, endMonth: 12, endDay: 31 },
      ],
    });
    expect(body(res).validation.ok).toBe(true);
  });
});

describe("publishing", () => {
  it("refuses a set that does not cover the year, saying what that costs", async () => {
    const set = await createSet();
    await inject("PUT", `/api/v1/season-sets/${set.id}/seasons`, {
      seasons: [TWO_SEASONS.seasons[0]],
    });

    const res = await inject("POST", `/api/v1/season-sets/${set.id}/publish`);
    expect(res.statusCode).toBe(409);
    expect(body(res).error.code).toBe("SEASON_SET_INVALID");
    expect(body(res).error.message).toMatch(/no season or in two/);
  });

  it("publishes a complete set", async () => {
    const set = await createSet();
    await inject("PUT", `/api/v1/season-sets/${set.id}/seasons`, TWO_SEASONS);
    const res = await inject("POST", `/api/v1/season-sets/${set.id}/publish`);
    expect(res.statusCode).toBe(200);
    expect(body(res).publishedAt).toBeTruthy();
  });

  it("freezes the seasons once published", async () => {
    const set = await createSet();
    await inject("PUT", `/api/v1/season-sets/${set.id}/seasons`, TWO_SEASONS);
    await inject("POST", `/api/v1/season-sets/${set.id}/publish`);

    const res = await inject("PUT", `/api/v1/season-sets/${set.id}/seasons`, TWO_SEASONS);
    expect(res.statusCode).toBe(409);
    expect(body(res).error.code).toBe("SEASON_SET_PUBLISHED");
    // It says why, in terms of what depends on these codes.
    expect(body(res).error.message).toMatch(/TOU calendars and rate components are keyed on/);
  });

  it("refuses to publish twice", async () => {
    const set = await createSet();
    await inject("PUT", `/api/v1/season-sets/${set.id}/seasons`, TWO_SEASONS);
    await inject("POST", `/api/v1/season-sets/${set.id}/publish`);
    const res = await inject("POST", `/api/v1/season-sets/${set.id}/publish`);
    expect(res.statusCode).toBe(409);
    expect(body(res).error.code).toBe("ALREADY_PUBLISHED");
  });
});

describe("the divergence a tenant cannot see", () => {
  /**
   * Publish a set, build a published TOU calendar on it, then start a
   * second set. The second set is what the tenant is about to put in
   * force, and the calendar will not follow it.
   */
  async function setWithPublishedCalendar() {
    const first = await createSet("Old seasons", "2026-01-01");
    await inject("PUT", `/api/v1/season-sets/${first.id}/seasons`, TWO_SEASONS);
    await inject("POST", `/api/v1/season-sets/${first.id}/publish`);

    const calendarId = await seedAsPlatform(async () => {
      const { prisma } = prismaImports;
      const calendar = await prisma.touCalendar.create({
        data: {
          utilityId: TENANT_A,
          name: "TOD 5-8pm",
          effectiveDate: new Date(Date.UTC(2026, 0, 1)),
          publishedAt: new Date(),
          seasonSetId: first.id,
          timeZone: "America/Denver",
        },
      });
      return calendar.id;
    });

    const second = await createSet("New seasons", "2027-01-01");
    await inject("PUT", `/api/v1/season-sets/${second.id}/seasons`, TWO_SEASONS);
    return { first, second, calendarId };
  }

  it("warns before publishing, not after", async () => {
    const { second, calendarId } = await setWithPublishedCalendar();

    const res = await inject("GET", `/api/v1/season-sets/${second.id}`);
    const diverging = body(res).calendarsOnOtherSets;
    expect(diverging).toHaveLength(1);
    expect(diverging[0]).toMatchObject({
      id: calendarId,
      name: "TOD 5-8pm",
      seasonSetName: "Old seasons",
    });
  });

  it("names them on the publish response too", async () => {
    const { second } = await setWithPublishedCalendar();
    const res = await inject("POST", `/api/v1/season-sets/${second.id}/publish`);
    expect(res.statusCode).toBe(200);
    expect(body(res).calendarsOnOtherSets.map((c: { name: string }) => c.name)).toEqual([
      "TOD 5-8pm",
    ]);
  });

  it("does not warn about a calendar keyed on this very set", async () => {
    // The whole point is divergence. A calendar on this set agrees with
    // it, and reporting it would train people to ignore the warning.
    const set = await createSet();
    await inject("PUT", `/api/v1/season-sets/${set.id}/seasons`, TWO_SEASONS);
    await seedAsPlatform(async () => {
      await prismaImports.prisma.touCalendar.create({
        data: {
          utilityId: TENANT_A,
          name: "Same set",
          effectiveDate: new Date(Date.UTC(2026, 0, 1)),
          publishedAt: new Date(),
          seasonSetId: set.id,
          timeZone: "America/Denver",
        },
      });
    });

    const res = await inject("GET", `/api/v1/season-sets/${set.id}`);
    expect(body(res).calendarsOnOtherSets).toEqual([]);
  });

  it("ignores draft calendars, which have not priced anything", async () => {
    const set = await createSet("Other", "2026-01-01");
    await seedAsPlatform(async () => {
      const { prisma } = prismaImports;
      const other = await prisma.seasonSet.create({
        data: {
          utilityId: TENANT_A,
          name: "Some other set",
          effectiveDate: new Date(Date.UTC(2025, 0, 1)),
          publishedAt: new Date(),
        },
      });
      await prisma.touCalendar.create({
        data: {
          utilityId: TENANT_A,
          name: "Still a draft",
          effectiveDate: new Date(Date.UTC(2026, 0, 1)),
          publishedAt: null,
          seasonSetId: other.id,
          timeZone: "America/Denver",
        },
      });
    });

    const res = await inject("GET", `/api/v1/season-sets/${set.id}`);
    expect(body(res).calendarsOnOtherSets).toEqual([]);
  });
});

describe("what depends on a season code", () => {
  it("refuses to remove a code that a calendar's hours are keyed on", async () => {
    /*
     * A span names its season as a string with no foreign key to catch
     * it, so a rename would leave those hours pricing nothing and
     * `resolvePeak` answering "no period covers 17:15" on every bill.
     */
    const set = await createSet();
    await inject("PUT", `/api/v1/season-sets/${set.id}/seasons`, TWO_SEASONS);

    await seedAsPlatform(async () => {
      const { prisma } = prismaImports;
      const calendar = await prisma.touCalendar.create({
        data: {
          utilityId: TENANT_A,
          name: "Draft calendar",
          effectiveDate: new Date(Date.UTC(2026, 0, 1)),
          seasonSetId: set.id,
          timeZone: "America/Denver",
        },
      });
      const period = await prisma.touPeriod.create({
        data: { utilityId: TENANT_A, touCalendarId: calendar.id, peakCode: "peak", label: "Peak" },
      });
      const dayType = await prisma.touDayType.create({
        data: {
          utilityId: TENANT_A,
          touCalendarId: calendar.id,
          dayTypeCode: "weekday",
          label: "Weekday",
        },
      });
      await prisma.touSlot.create({
        data: {
          utilityId: TENANT_A,
          touCalendarId: calendar.id,
          seasonCode: "summer",
          touDayTypeId: dayType.id,
          touPeriodId: period.id,
          startMinute: 0,
          endMinute: 1440,
        },
      });
    });

    const res = await inject("PUT", `/api/v1/season-sets/${set.id}/seasons`, {
      seasons: [
        {
          seasonCode: "all",
          label: "All year",
          startMonth: 1,
          startDay: 1,
          endMonth: 12,
          endDay: 31,
        },
      ],
    });
    expect(res.statusCode).toBe(409);
    expect(body(res).error.code).toBe("SEASON_CODE_IN_USE");
    expect(body(res).error.message).toMatch(/Draft calendar/);
    expect(body(res).error.message).toMatch(/summer/);
  });

  it("refuses to delete a set a calendar names", async () => {
    const set = await createSet();
    await seedAsPlatform(async () => {
      await prismaImports.prisma.touCalendar.create({
        data: {
          utilityId: TENANT_A,
          name: "Needs these seasons",
          effectiveDate: new Date(Date.UTC(2026, 0, 1)),
          seasonSetId: set.id,
          timeZone: "America/Denver",
        },
      });
    });

    const res = await inject("DELETE", `/api/v1/season-sets/${set.id}`);
    expect(res.statusCode).toBe(409);
    expect(body(res).error.code).toBe("SEASON_SET_IN_USE");
    expect(body(res).error.message).toMatch(/Needs these seasons/);
  });

  it("deletes a draft nothing names", async () => {
    const set = await createSet();
    const res = await inject("DELETE", `/api/v1/season-sets/${set.id}`);
    expect(res.statusCode).toBeLessThan(300);
    expect((await inject("GET", `/api/v1/season-sets/${set.id}`)).statusCode).toBe(404);
  });
});
