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
 * Holiday sets (spec 26, TOU-CAL-4).
 *
 * The file this replaced tested an observance *resolver*: rules in,
 * dates out, three years at a time. The dates are now typed by whoever
 * knows them, so what is left to test is everything the rules were
 * hiding — that a set is versioned and published like a season set,
 * that a published one cannot be edited, that it is shared and the reach
 * is visible, and that it runs out.
 *
 * 4 July 2026 is a Saturday and this utility takes the Friday, so
 * **2026-07-03** is the date that appears throughout. That a rule could
 * have produced it is not the point; that somebody can read it is.
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
    // Calendars first: the key from a calendar to its set is RESTRICT.
    await prisma.$executeRawUnsafe("UPDATE rate_schedule SET tou_calendar_id = NULL");
    await prisma.$executeRawUnsafe("DELETE FROM tou_slot");
    await prisma.$executeRawUnsafe("DELETE FROM tou_day_override");
    await prisma.$executeRawUnsafe("DELETE FROM tou_day_type_weekday");
    await prisma.$executeRawUnsafe("DELETE FROM tou_day_type");
    await prisma.$executeRawUnsafe("DELETE FROM tou_period");
    await prisma.$executeRawUnsafe("DELETE FROM tou_calendar");
    await prisma.$executeRawUnsafe("DELETE FROM tou_holiday");
    await prisma.$executeRawUnsafe("DELETE FROM tou_holiday_set");
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

async function createSet(over: Record<string, unknown> = {}) {
  const res = await inject("POST", "/api/v1/tou-holiday-sets", {
    name: "Observed holidays",
    effectiveDate: "2026-01-01",
    ...over,
  });
  if (res.statusCode !== 201) throw new Error(`create failed: ${res.statusCode} ${res.body}`);
  return body(res);
}

const HOLIDAYS = [
  { date: "2026-01-01", name: "New Year's Day" },
  { date: "2026-07-03", name: "Independence Day (observed)" },
  { date: "2026-11-26", name: "Thanksgiving Day" },
];

async function withDates(over: Record<string, unknown> = {}) {
  const set = await createSet(over);
  const res = await inject("PUT", `/api/v1/tou-holiday-sets/${set.id}/holidays`, {
    holidays: HOLIDAYS,
  });
  if (res.statusCode !== 200) throw new Error(`put failed: ${res.statusCode} ${res.body}`);
  return set;
}

/** A calendar naming a set, written directly — the editor is its own suite. */
async function calendarNaming(setId: string | null, name = "Residential time-of-use") {
  return seedAsPlatform(async () => {
    const { prisma } = prismaImports;
    const seasons = await prisma.seasonSet.create({
      data: {
        utilityId: TENANT_A,
        name: `seasons for ${name}`,
        effectiveDate: new Date(Date.UTC(2026, 0, 1)),
        publishedAt: new Date(),
      },
    });
    const calendar = await prisma.touCalendar.create({
      data: {
        utilityId: TENANT_A,
        name,
        effectiveDate: new Date(Date.UTC(2026, 0, 1)),
        seasonSetId: seasons.id,
        touHolidaySetId: setId,
        timeZone: "America/Denver",
      },
    });
    return calendar.id;
  });
}

describe("defining the dates", () => {
  it("creates an empty draft", async () => {
    const set = await createSet();
    expect(set.publishedAt).toBeNull();

    const res = await inject("GET", `/api/v1/tou-holiday-sets/${set.id}`);
    expect(body(res).holidays).toEqual([]);
    expect(body(res).calendars).toEqual([]);
  });

  it("saves the dates and reads them back in order", async () => {
    // Order matters on a screen somebody is checking against a tariff
    // document, and the dates are typed in whatever order they come to
    // mind.
    const set = await withDates();
    const res = await inject("GET", `/api/v1/tou-holiday-sets/${set.id}`);
    expect(
      body(res).holidays.map((h: { holidayDate: string }) => h.holidayDate.slice(0, 10)),
    ).toEqual(["2026-01-01", "2026-07-03", "2026-11-26"]);
  });

  it("keeps the observed date, not the nominal one", async () => {
    /*
     * The whole argument for dates over rules. 4 July 2026 is a
     * Saturday; the Friday is what the utility takes and the Friday is
     * what is stored. Nothing here computes it, so nothing can compute
     * it differently later.
     */
    const set = await withDates();
    const res = await inject("GET", `/api/v1/tou-holiday-sets/${set.id}`);
    const independence = body(res).holidays.find((h: { name: string }) =>
      h.name.startsWith("Independence"),
    );
    expect(independence.holidayDate.slice(0, 10)).toBe("2026-07-03");
  });

  it("replaces the list whole, so removing a date removes it", async () => {
    const set = await withDates();
    const res = await inject("PUT", `/api/v1/tou-holiday-sets/${set.id}/holidays`, {
      holidays: [HOLIDAYS[0]],
    });
    expect(res.statusCode).toBe(200);
    expect(body(res).holidays).toHaveLength(1);
  });

  it("empties the list when asked, rather than refusing a legitimate clear", async () => {
    const set = await withDates();
    const res = await inject("PUT", `/api/v1/tou-holiday-sets/${set.id}/holidays`, {
      holidays: [],
    });
    expect(res.statusCode).toBe(200);
    expect(body(res).holidays).toEqual([]);
  });

  it("refuses the same date twice, naming it", async () => {
    // Two names for one day would make "is this a holiday" ambiguous in
    // the set that exists to answer it.
    const set = await createSet();
    const res = await inject("PUT", `/api/v1/tou-holiday-sets/${set.id}/holidays`, {
      holidays: [
        { date: "2026-07-03", name: "Independence Day (observed)" },
        { date: "2026-07-03", name: "Company picnic" },
      ],
    });
    expect(res.statusCode).toBe(400);
    expect(body(res).error.code).toBe("DUPLICATE_HOLIDAY_DATE");
    expect(body(res).error.message).toMatch(/2026-07-03/);
  });

  it("refuses a date that is not a date", async () => {
    const set = await createSet();
    const res = await inject("PUT", `/api/v1/tou-holiday-sets/${set.id}/holidays`, {
      holidays: [{ date: "2026-02-30", name: "Nonsense" }],
    });
    expect(res.statusCode).toBe(400);
  });

  it("allows 29 February, which exists", async () => {
    const set = await createSet();
    const res = await inject("PUT", `/api/v1/tou-holiday-sets/${set.id}/holidays`, {
      holidays: [{ date: "2028-02-29", name: "Leap day closure" }],
    });
    expect(res.statusCode).toBe(200);
  });
});

describe("versioning and publishing", () => {
  it("publishes a set that has dates in it", async () => {
    const set = await withDates();
    const res = await inject("POST", `/api/v1/tou-holiday-sets/${set.id}/publish`);
    expect(res.statusCode).toBe(200);
    expect(body(res).publishedAt).toBeTruthy();
  });

  it("refuses to publish an empty one, naming the consequence", async () => {
    /*
     * A calendar naming an empty set would appear to observe holidays
     * and price every day by its weekday — the quiet failure this
     * subsystem refuses everywhere else.
     */
    const set = await createSet();
    const res = await inject("POST", `/api/v1/tou-holiday-sets/${set.id}/publish`);
    expect(res.statusCode).toBe(409);
    expect(body(res).error.code).toBe("HOLIDAY_SET_EMPTY");
    expect(body(res).error.message).toMatch(/appearing to observe holidays/);
  });

  it("refuses to publish twice", async () => {
    const set = await withDates();
    await inject("POST", `/api/v1/tou-holiday-sets/${set.id}/publish`);
    const res = await inject("POST", `/api/v1/tou-holiday-sets/${set.id}/publish`);
    expect(res.statusCode).toBe(409);
    expect(body(res).error.code).toBe("ALREADY_PUBLISHED");
  });

  it("freezes the dates once published", async () => {
    const set = await withDates();
    await inject("POST", `/api/v1/tou-holiday-sets/${set.id}/publish`);

    const res = await inject("PUT", `/api/v1/tou-holiday-sets/${set.id}/holidays`, {
      holidays: [{ date: "2026-12-25", name: "Christmas Day" }],
    });
    expect(res.statusCode).toBe(409);
    expect(body(res).error.code).toBe("HOLIDAY_SET_PUBLISHED");
    // It says what to do instead: the operator still has a job to do.
    expect(body(res).error.message).toMatch(/new set with a later effective date/);
  });

  it("refuses a header edit on a published set too", async () => {
    const set = await withDates();
    await inject("POST", `/api/v1/tou-holiday-sets/${set.id}/publish`);
    const res = await inject("PATCH", `/api/v1/tou-holiday-sets/${set.id}`, { name: "Renamed" });
    expect(res.statusCode).toBe(409);
  });

  it("refuses to delete a published set, because it priced bills", async () => {
    const set = await withDates();
    await inject("POST", `/api/v1/tou-holiday-sets/${set.id}/publish`);
    const res = await inject("DELETE", `/api/v1/tou-holiday-sets/${set.id}`);
    expect(res.statusCode).toBe(409);
  });

  it("keeps a second version as its own row, by effective date", async () => {
    // There is no version column here either: a version IS a (name,
    // effectiveDate), which is what the unique index constrains.
    const first = await withDates();
    await inject("POST", `/api/v1/tou-holiday-sets/${first.id}/publish`);
    const second = await createSet({ effectiveDate: "2027-01-01" });

    const res = await inject("GET", "/api/v1/tou-holiday-sets");
    expect(body(res).data).toHaveLength(2);
    expect(body(res).data.map((s: { id: string }) => s.id)).toContain(second.id);
  });

  it("refuses two versions with the same name and date", async () => {
    await createSet();
    const res = await inject("POST", "/api/v1/tou-holiday-sets", {
      name: "Observed holidays",
      effectiveDate: "2026-01-01",
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
  });

  it("renames a draft without disturbing its dates", async () => {
    const set = await withDates();
    await inject("PATCH", `/api/v1/tou-holiday-sets/${set.id}`, { name: "Public holidays" });

    const res = await inject("GET", `/api/v1/tou-holiday-sets/${set.id}`);
    expect(body(res).name).toBe("Public holidays");
    expect(body(res).holidays).toHaveLength(3);
  });
});

describe("a set is shared, which is the point and the risk", () => {
  it("names the calendars it reaches", async () => {
    const set = await withDates();
    await calendarNaming(set.id, "Residential time-of-use");
    await calendarNaming(set.id, "Commercial time-of-use");

    const res = await inject("GET", `/api/v1/tou-holiday-sets/${set.id}`);
    expect(body(res).calendars.map((c: { name: string }) => c.name).sort()).toEqual([
      "Commercial time-of-use",
      "Residential time-of-use",
    ]);
  });

  it("counts them on the list, so the reach is visible before opening one", async () => {
    const set = await withDates();
    await calendarNaming(set.id);

    const res = await inject("GET", "/api/v1/tou-holiday-sets");
    const row = body(res).data.find((s: { id: string }) => s.id === set.id);
    expect(row.calendarCount).toBe(1);
  });

  it("shows the span of dates on the list, which is where a set runs out", async () => {
    /*
     * The horizon is the cost of explicit dates, and the row is where
     * somebody will see it coming. Without these two fields the page
     * can only say how many dates there are, which does not answer
     * "until when".
     */
    const set = await withDates();
    const res = await inject("GET", "/api/v1/tou-holiday-sets");
    const row = body(res).data.find((s: { id: string }) => s.id === set.id);
    expect(row.firstDate.slice(0, 10)).toBe("2026-01-01");
    expect(row.lastDate.slice(0, 10)).toBe("2026-11-26");
    expect(row._count.holidays).toBe(3);
  });

  it("reports a real total, not zero above a visible row", async () => {
    // The season-set list shipped with a hand-rolled `pagination` key
    // and read "0 total season sets" above two rows.
    await createSet({ name: "One" });
    await createSet({ name: "Two" });
    const res = await inject("GET", "/api/v1/tou-holiday-sets");
    expect(body(res).meta.total).toBe(2);
    expect(body(res).data).toHaveLength(2);
  });

  it("refuses to delete a set a calendar names, naming the calendar", async () => {
    const set = await createSet();
    await calendarNaming(set.id, "Residential time-of-use");

    const res = await inject("DELETE", `/api/v1/tou-holiday-sets/${set.id}`);
    expect(res.statusCode).toBe(409);
    expect(body(res).error.code).toBe("HOLIDAY_SET_IN_USE");
    expect(body(res).error.message).toMatch(/Residential time-of-use/);
  });

  it("deletes a draft nothing names", async () => {
    const set = await withDates();
    const res = await inject("DELETE", `/api/v1/tou-holiday-sets/${set.id}`);
    expect(res.statusCode).toBeLessThan(300);
    expect((await inject("GET", `/api/v1/tou-holiday-sets/${set.id}`)).statusCode).toBe(404);
  });

  it("filters by status, because the drafts are the ones still being typed", async () => {
    const published = await withDates();
    await inject("POST", `/api/v1/tou-holiday-sets/${published.id}/publish`);
    await createSet({ name: "Next year", effectiveDate: "2027-01-01" });

    const drafts = await inject("GET", "/api/v1/tou-holiday-sets?status=draft");
    expect(body(drafts).data.map((s: { name: string }) => s.name)).toEqual(["Next year"]);
  });
});

describe("asking for one that is not there", () => {
  it("answers 404 rather than an empty set", async () => {
    const res = await inject("GET", "/api/v1/tou-holiday-sets/00000000-0000-4000-8000-0000000000ff");
    expect(res.statusCode).toBe(404);
    expect(body(res).error.code).toBe("HOLIDAY_SET_NOT_FOUND");
  });
});
