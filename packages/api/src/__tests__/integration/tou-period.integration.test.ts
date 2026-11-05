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
 * A tenant's TOU periods — its price tiers (spec 26, TOU-CAL-1).
 *
 * Defined once per tenant since 2026-11-04. The two rules worth a suite
 * are the ones a caller cannot infer:
 *
 * - **The code is immutable.** It has been copied into every calendar's
 *   hours, into rate components and onto meter registers, none of which
 *   know this row exists.
 * - **A code in use cannot go.** `tou_slot_peak_code_fkey` is RESTRICT,
 *   and the refusal has to name the calendars rather than a constraint.
 *
 * The per-calendar version of the second rule lived in
 * `tou-calendar-editor.integration.test.ts` as "refuses to drop a
 * period that hours are still assigned to". It is here now, because
 * dropping one is no longer something you do to a calendar.
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
    await prisma.$executeRawUnsafe("DELETE FROM tou_day_type_weekday");
    await prisma.$executeRawUnsafe("DELETE FROM tou_day_type");
    await prisma.$executeRawUnsafe("DELETE FROM tou_calendar");
    await prisma.$executeRawUnsafe("DELETE FROM season");
    await prisma.$executeRawUnsafe("DELETE FROM season_set");

    /*
     * Back to the three a tenant is provisioned with, since these tests
     * add and remove them. Not a truncate: a tenant with no periods
     * could not be given an hour of a tariff.
     */
    await prisma.$executeRawUnsafe(
      "DELETE FROM tou_period WHERE peak_code NOT IN ('off_peak','mid_peak','peak')",
    );

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

/** A published calendar charging `peak` for an hour, so the code is in use. */
async function calendarUsing(peakCode: string, name = "Residential time-of-use") {
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
    await prisma.season.create({
      data: {
        utilityId: TENANT_A,
        seasonSetId: seasons.id,
        seasonCode: "all",
        label: "All year",
        startMonth: 1,
        startDay: 1,
        endMonth: 12,
        endDay: 31,
      },
    });
    const calendar = await prisma.touCalendar.create({
      data: {
        utilityId: TENANT_A,
        name,
        effectiveDate: new Date(Date.UTC(2026, 0, 1)),
        publishedAt: new Date(),
        seasonSetId: seasons.id,
        timeZone: "America/Denver",
      },
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
        seasonCode: "all",
        touDayTypeId: dayType.id,
        peakCode,
        startMinute: 0,
        endMinute: 1440,
      },
    });
    return calendar.id;
  });
}

describe("the list a tenant starts with", () => {
  it("is the three nearly every TOU tariff has, in display order", async () => {
    const res = await inject("GET", "/api/v1/tou-periods");
    expect(res.statusCode).toBe(200);
    expect(body(res).data.map((p: { peakCode: string }) => p.peakCode)).toEqual([
      "off_peak",
      "mid_peak",
      "peak",
    ]);
  });

  it("reports a real total", async () => {
    const res = await inject("GET", "/api/v1/tou-periods");
    expect(body(res).meta).toMatchObject({ total: 3, page: 1, pages: 1 });
  });

  it("says what is charged at each, which is what makes one removable", async () => {
    await calendarUsing("peak");
    const res = await inject("GET", "/api/v1/tou-periods");
    const rows = body(res).data as Array<{
      peakCode: string;
      spanCount: number;
      calendarCount: number;
    }>;
    expect(rows.find((r) => r.peakCode === "peak")).toMatchObject({
      spanCount: 1,
      calendarCount: 1,
    });
    expect(rows.find((r) => r.peakCode === "mid_peak")).toMatchObject({
      spanCount: 0,
      calendarCount: 0,
    });
  });
});

describe("adding one", () => {
  it("creates it at the end of the order", async () => {
    const res = await inject("POST", "/api/v1/tou-periods", {
      peakCode: "super_off_peak",
      label: "Super off-peak",
    });
    expect(res.statusCode).toBe(201);
    expect(body(res).sortOrder).toBe(3);
  });

  it("refuses a code the tenant already has, naming what it is called", async () => {
    const res = await inject("POST", "/api/v1/tou-periods", {
      peakCode: "peak",
      label: "Peak hours",
    });
    expect(res.statusCode).toBe(409);
    expect(body(res).error.code).toBe("DUPLICATE_PEAK_CODE");
    expect(body(res).error.message).toMatch(/already a period of this utility/);
    expect(body(res).error.message).toMatch(/On-peak/);
  });

  it("refuses a code that is not an identifier", async () => {
    /*
     * The code travels into a rate component's `quantitySource` and
     * onto meter registers, where it is matched as a literal — so
     * "On Peak!" would be a value nobody could type the same way
     * twice.
     */
    const res = await inject("POST", "/api/v1/tou-periods", {
      peakCode: "On Peak!",
      label: "On peak",
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("the code is immutable", () => {
  it("is not a field an update will accept", async () => {
    const created = await inject("POST", "/api/v1/tou-periods", {
      peakCode: "super_off_peak",
      label: "Super off-peak",
    });
    const res = await inject("PATCH", `/api/v1/tou-periods/${body(created).id}`, {
      peakCode: "renamed",
    });
    // `.strict()`, so the field is refused rather than ignored: a
    // silent no-op would read as a rename that worked.
    expect(res.statusCode).toBe(400);
  });

  it("lets the label and the order change, which carry no meaning elsewhere", async () => {
    const list = await inject("GET", "/api/v1/tou-periods");
    const peak = body(list).data.find((p: { peakCode: string }) => p.peakCode === "peak");

    const res = await inject("PATCH", `/api/v1/tou-periods/${peak.id}`, {
      label: "Peak hours",
      sortOrder: 9,
    });
    expect(res.statusCode).toBe(200);
    expect(body(res)).toMatchObject({ peakCode: "peak", label: "Peak hours", sortOrder: 9 });
  });
});

describe("removing one", () => {
  it("removes a period nothing is charged at", async () => {
    const list = await inject("GET", "/api/v1/tou-periods");
    const mid = body(list).data.find((p: { peakCode: string }) => p.peakCode === "mid_peak");

    const res = await inject("DELETE", `/api/v1/tou-periods/${mid.id}`);
    expect(res.statusCode).toBeLessThan(300);
    expect((await inject("GET", `/api/v1/tou-periods/${mid.id}`)).statusCode).toBe(404);
  });

  it("refuses one a calendar's hours are charged at, naming the calendar", async () => {
    await calendarUsing("peak", "Residential time-of-use");
    const list = await inject("GET", "/api/v1/tou-periods");
    const peak = body(list).data.find((p: { peakCode: string }) => p.peakCode === "peak");

    const res = await inject("DELETE", `/api/v1/tou-periods/${peak.id}`);
    expect(res.statusCode).toBe(409);
    expect(body(res).error.code).toBe("TOU_PERIOD_IN_USE");
    expect(body(res).error.message).toMatch(/Residential time-of-use/);
  });

  it("says a published calendar cannot be changed, so the code is permanent", async () => {
    /*
     * "Reassign those hours first" is not advice somebody can take on a
     * published calendar — its hours are frozen. The message has to say
     * so, or they will go looking for an edit that is not there.
     */
    await calendarUsing("peak");
    const list = await inject("GET", "/api/v1/tou-periods");
    const peak = body(list).data.find((p: { peakCode: string }) => p.peakCode === "peak");

    const res = await inject("DELETE", `/api/v1/tou-periods/${peak.id}`);
    expect(body(res).error.message).toMatch(/published calendar cannot be changed/);
  });

  it("names every calendar using it, not just the first", async () => {
    await calendarUsing("peak", "Residential time-of-use");
    await calendarUsing("peak", "Commercial time-of-use");
    const list = await inject("GET", "/api/v1/tou-periods");
    const peak = body(list).data.find((p: { peakCode: string }) => p.peakCode === "peak");

    const res = await inject("DELETE", `/api/v1/tou-periods/${peak.id}`);
    expect(body(res).error.message).toMatch(/Residential time-of-use/);
    expect(body(res).error.message).toMatch(/Commercial time-of-use/);
  });
});

describe("asking for one that is not there", () => {
  it("answers 404 rather than an empty row", async () => {
    const res = await inject("GET", "/api/v1/tou-periods/00000000-0000-4000-8000-0000000000ff");
    expect(res.statusCode).toBe(404);
    expect(body(res).error.code).toBe("TOU_PERIOD_NOT_FOUND");
  });
});
