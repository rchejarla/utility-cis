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
 * Holiday lists and their rules (spec 26, TOU-CAL-4 and TOU-UI-2).
 *
 * The centre of this file is that **a rule's output is the point**. "4
 * July, nearest weekday" does not tell anybody that 2026 lands on a
 * Saturday and moves the holiday to Friday the 3rd — a weekday whose
 * peak hours disappear. A list of dates could not express the rule and
 * a rule nobody can see the dates of will not be trusted, so the API
 * answers with both.
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
    await prisma.$executeRawUnsafe("UPDATE tou_calendar SET tou_holiday_list_id = NULL");
    await prisma.$executeRawUnsafe("DELETE FROM tou_calendar");
    await prisma.$executeRawUnsafe("DELETE FROM tou_holiday_rule");
    await prisma.$executeRawUnsafe("DELETE FROM tou_holiday_list");
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

async function createList(name = "Observed holidays") {
  const res = await inject("POST", "/api/v1/tou-holiday-lists", { name });
  if (res.statusCode !== 201) throw new Error(`create failed: ${res.statusCode} ${res.body}`);
  return body(res);
}

const INDEPENDENCE = {
  code: "independence_day",
  label: "Independence Day",
  kind: "FIXED" as const,
  month: 7,
  day: 4,
  observance: "NEAREST_WEEKDAY" as const,
};

const THANKSGIVING = {
  code: "thanksgiving",
  label: "Thanksgiving",
  kind: "NTH_WEEKDAY" as const,
  month: 11,
  weekday: 4,
  nth: 4,
  observance: "NONE" as const,
};

describe("defining holidays", () => {
  it("creates an empty list", async () => {
    const list = await createList();
    expect(list.name).toBe("Observed holidays");

    const res = await inject("GET", `/api/v1/tou-holiday-lists/${list.id}`);
    expect(body(res).rules).toEqual([]);
    expect(body(res).resolved).toEqual([]);
  });

  it("saves a fixed date and an nth-weekday rule together", async () => {
    const list = await createList();
    const res = await inject("PUT", `/api/v1/tou-holiday-lists/${list.id}/rules`, {
      rules: [INDEPENDENCE, THANKSGIVING],
    });
    expect(res.statusCode).toBe(200);
    expect(body(res).rules.map((r: { code: string }) => r.code).sort()).toEqual([
      "independence_day",
      "thanksgiving",
    ]);
  });

  it("answers with the dates the rules produce, three years of them", async () => {
    const list = await createList();
    const res = await inject("PUT", `/api/v1/tou-holiday-lists/${list.id}/rules`, {
      rules: [INDEPENDENCE],
    });
    const resolved = body(res).resolved as Array<{ year: number }>;
    expect(resolved).toHaveLength(3);
    expect(body(res).toYear - body(res).fromYear).toBe(2);
  });

  it("flags the year an observance rule moves the day", async () => {
    /*
     * The fact that changes a bill. 4 July 2026 is a Saturday, so
     * NEAREST_WEEKDAY observes it on Friday the 3rd — a weekday whose
     * peak hours disappear. Nothing about "4 July, nearest weekday"
     * says so.
     */
    const list = await createList();
    await inject("PUT", `/api/v1/tou-holiday-lists/${list.id}/rules`, { rules: [INDEPENDENCE] });
    const res = await inject("GET", `/api/v1/tou-holiday-lists/${list.id}/resolved?fromYear=2026`);
    const resolved = body(res).resolved as Array<{
      year: number;
      actual: string;
      observed: string;
      moved: boolean;
    }>;
    /*
     * Pinned, not guarded. This used to read `if (y2026) { ... }`,
     * which would have stopped asserting anything the moment the
     * default window moved past 2026 — a test that quietly retires
     * itself.
     */
    const y2026 = resolved.find((r) => r.year === 2026);
    expect(y2026).toMatchObject({ actual: "2026-07-04", observed: "2026-07-03", moved: true });
  });

  it("replaces the rules whole, so removing one removes it", async () => {
    const list = await createList();
    await inject("PUT", `/api/v1/tou-holiday-lists/${list.id}/rules`, {
      rules: [INDEPENDENCE, THANKSGIVING],
    });
    const res = await inject("PUT", `/api/v1/tou-holiday-lists/${list.id}/rules`, {
      rules: [THANKSGIVING],
    });
    expect(body(res).rules.map((r: { code: string }) => r.code)).toEqual(["thanksgiving"]);
  });

  it("refuses two rules with one code", async () => {
    const list = await createList();
    const res = await inject("PUT", `/api/v1/tou-holiday-lists/${list.id}/rules`, {
      rules: [INDEPENDENCE, { ...THANKSGIVING, code: "independence_day" }],
    });
    expect(res.statusCode).toBe(400);
    expect(body(res).error.code).toBe("DUPLICATE_HOLIDAY_CODE");
  });

  it("refuses a date that does not exist, rather than saving a rule that resolves to nothing", async () => {
    const list = await createList();
    const res = await inject("PUT", `/api/v1/tou-holiday-lists/${list.id}/rules`, {
      rules: [{ ...INDEPENDENCE, code: "nonsense", label: "Nonsense", month: 2, day: 30 }],
    });
    expect(res.statusCode).toBe(400);
    expect(body(res).error.code).toBe("HOLIDAY_RULE_UNREAL");
    expect(body(res).error.message).toMatch(/Nonsense/);
  });

  it("allows 29 February, which exists", async () => {
    const list = await createList();
    const res = await inject("PUT", `/api/v1/tou-holiday-lists/${list.id}/rules`, {
      rules: [{ ...INDEPENDENCE, code: "leap", label: "Leap day", month: 2, day: 29 }],
    });
    expect(res.statusCode).toBe(200);
  });

  it("refuses a fixed rule carrying an nth, which would resolve elsewhere", async () => {
    // The two kinds carry their own fields and not the other's; the
    // database CHECK says the same. A stray `nth` reads as meaning
    // something it does not, and the resolver ignores the wrong one.
    const list = await createList();
    const res = await inject("PUT", `/api/v1/tou-holiday-lists/${list.id}/rules`, {
      rules: [{ ...INDEPENDENCE, nth: 2 }],
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("a list is shared, which is the point and the risk", () => {
  async function calendarNaming(listId: string | null, name = "Residential TOU") {
    return seedAsPlatform(async () => {
      const { prisma } = prismaImports;
      const set = await prisma.seasonSet.create({
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
          seasonSetId: set.id,
          touHolidayListId: listId,
          timeZone: "America/Denver",
        },
      });
      return calendar.id;
    });
  }

  it("names the calendars a change would reach", async () => {
    const list = await createList();
    await calendarNaming(list.id, "Residential TOU");
    await calendarNaming(list.id, "Commercial TOU");

    const res = await inject("GET", `/api/v1/tou-holiday-lists/${list.id}`);
    expect(body(res).calendars.map((c: { name: string }) => c.name).sort()).toEqual([
      "Commercial TOU",
      "Residential TOU",
    ]);
  });

  it("counts them on the list, so the reach is visible before opening one", async () => {
    const list = await createList();
    await calendarNaming(list.id);

    const res = await inject("GET", "/api/v1/tou-holiday-lists");
    const row = body(res).data.find((l: { id: string }) => l.id === list.id);
    expect(row.calendarCount).toBe(1);
  });

  it("reports a real total, not zero above a visible row", async () => {
    await createList("One");
    await createList("Two");
    const res = await inject("GET", "/api/v1/tou-holiday-lists");
    expect(body(res).meta.total).toBe(2);
    expect(body(res).data).toHaveLength(2);
  });

  it("refuses to delete a list a calendar names", async () => {
    const list = await createList();
    await calendarNaming(list.id, "Residential TOU");

    const res = await inject("DELETE", `/api/v1/tou-holiday-lists/${list.id}`);
    expect(res.statusCode).toBe(409);
    expect(body(res).error.code).toBe("HOLIDAY_LIST_IN_USE");
    expect(body(res).error.message).toMatch(/Residential TOU/);
  });

  it("deletes one that nothing names", async () => {
    const list = await createList();
    const res = await inject("DELETE", `/api/v1/tou-holiday-lists/${list.id}`);
    expect(res.statusCode).toBeLessThan(300);
    expect((await inject("GET", `/api/v1/tou-holiday-lists/${list.id}`)).statusCode).toBe(404);
  });

  it("renames without disturbing the rules", async () => {
    const list = await createList();
    await inject("PUT", `/api/v1/tou-holiday-lists/${list.id}/rules`, { rules: [THANKSGIVING] });
    await inject("PATCH", `/api/v1/tou-holiday-lists/${list.id}`, { name: "Public holidays" });

    const res = await inject("GET", `/api/v1/tou-holiday-lists/${list.id}`);
    expect(body(res).name).toBe("Public holidays");
    expect(body(res).rules).toHaveLength(1);
  });
});
