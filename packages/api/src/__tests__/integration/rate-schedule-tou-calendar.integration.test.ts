import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import type { FastifyInstance } from "fastify";
import {
  bootPostgres,
  TENANT_A,
  ensurePrincipal,
  seedAsPlatform,
} from "./_effective-dating-fixtures.js";

/**
 * Attaching a TOU calendar to a rate schedule (spec 26, TOU-UI-3).
 *
 * `rate_schedule.tou_calendar_id` and the four publish refusals have
 * existed since 2026-11-03, and nothing could set the column: the
 * create schema was `.strict()` without it and there is no PATCH. So
 * the gate was reachable and unsatisfiable — a tariff that priced TOU
 * periods could never be published, and one that did not never looked
 * at a calendar. These tests are the path from one end to the other.
 *
 * The companion half is the component: `quantitySource.base =
 * "tou_period"` was in the engine and not in the grammar the API
 * accepts, so the charges a TOU calendar exists to price could not be
 * saved either. Both halves are exercised here, because either alone
 * still cannot produce a TOU bill.
 */

let pgContainer: StartedPostgreSqlContainer;
let prismaImports: typeof import("../../lib/prisma.js");
let app: FastifyInstance;

let waterCommodityId: string;
/** A complete, published calendar: summer weekdays peak 5–8pm, the rest off-peak. */
let publishedCalendarId: string;
/** The same hours, never published — what TOU-CAL-5 refuses. */
let draftCalendarId: string;

const ACTOR_ID = "00000000-0000-4000-8000-aaaa00000001";

function makeToken(utilityId: string, actorId = ACTOR_ID) {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      sub: actorId,
      utility_id: utilityId,
      email: "tester@example.com",
      name: "Tester",
      role: "admin",
    }),
  ).toString("base64url");
  return `${header}.${payload}.fake-signature`;
}

const headers = () => ({ authorization: `Bearer ${makeToken(TENANT_A)}` });

function inject(method: "GET" | "POST" | "PUT", url: string, payload?: unknown) {
  return app.inject({ method, url, headers: headers(), ...(payload ? { payload } : {}) });
}

const body = (res: { body: string }) => JSON.parse(res.body);

/** The three the day-type editor keeps; `holiday` is the reserved code. */
const DAY_TYPES = {
  dayTypes: [
    { dayTypeCode: "weekday", label: "Weekday", weekdays: [1, 2, 3, 4, 5] },
    { dayTypeCode: "weekend", label: "Weekend", weekdays: [6, 7] },
    { dayTypeCode: "holiday", label: "Holiday", weekdays: [] },
  ],
};

/** Every (season, day type) covered, so the calendar can be published. */
async function fillSpans(id: string) {
  await inject("PUT", `/api/v1/tou-calendars/${id}/spans`, {
    seasonCode: "summer",
    dayTypeCode: "weekday",
    spans: [
      { startMinute: 0, endMinute: 1020, peakCode: "off_peak" },
      { startMinute: 1020, endMinute: 1200, peakCode: "peak" },
      { startMinute: 1200, endMinute: 1440, peakCode: "off_peak" },
    ],
  });
  for (const [seasonCode, dayTypeCode] of [
    ["summer", "weekend"],
    ["summer", "holiday"],
    ["non_summer", "weekday"],
    ["non_summer", "weekend"],
    ["non_summer", "holiday"],
  ] as const) {
    await inject("PUT", `/api/v1/tou-calendars/${id}/spans`, {
      seasonCode,
      dayTypeCode,
      spans: [{ startMinute: 0, endMinute: 1440, peakCode: "off_peak" }],
    });
  }
}

async function makeCalendar(name: string, effectiveDate: string, seasonSetId: string) {
  const res = await inject("POST", "/api/v1/tou-calendars", {
    name,
    effectiveDate,
    seasonSetId,
    timeZone: "America/Los_Angeles",
  });
  if (res.statusCode !== 201) throw new Error(`calendar create failed: ${res.body}`);
  const id = body(res).id as string;
  await inject("PUT", `/api/v1/tou-calendars/${id}/day-types`, DAY_TYPES);
  await fillSpans(id);
  return id;
}

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

      const { prisma } = prismaImports;
      const water = await prisma.commodity.upsert({
        where: { utilityId_code: { utilityId: TENANT_A, code: "water" } },
        create: { utilityId: TENANT_A, code: "water", name: "Water" },
        update: {},
      });
      waterCommodityId = water.id;

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

      const seasons = await prisma.seasonSet.create({
        data: {
          utilityId: TENANT_A,
          name: "Published seasons",
          effectiveDate: new Date(Date.UTC(2026, 0, 1)),
          publishedAt: new Date(),
        },
      });
      await prisma.season.createMany({
        data: [
          {
            utilityId: TENANT_A,
            seasonSetId: seasons.id,
            seasonCode: "summer",
            label: "Summer",
            startMonth: 6,
            startDay: 1,
            endMonth: 9,
            endDay: 30,
            sortOrder: 0,
          },
          {
            utilityId: TENANT_A,
            seasonSetId: seasons.id,
            seasonCode: "non_summer",
            label: "Non-summer",
            startMonth: 10,
            startDay: 1,
            endMonth: 5,
            endDay: 31,
            sortOrder: 1,
          },
        ],
      });

      publishedCalendarId = await makeCalendar("TOD 5-8pm", "2026-06-01", seasons.id);
      const pub = await inject("POST", `/api/v1/tou-calendars/${publishedCalendarId}/publish`);
      if (pub.statusCode !== 200) throw new Error(`calendar publish failed: ${pub.body}`);

      draftCalendarId = await makeCalendar("TOD 5-8pm (next)", "2027-06-01", seasons.id);
    }),
  240_000,
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
    await prisma.$executeRawUnsafe("DELETE FROM rate_component");
    await prisma.$executeRawUnsafe(
      "UPDATE rate_schedule SET superseded_by_id = NULL, supersedes_id = NULL",
    );
    await prisma.$executeRawUnsafe("DELETE FROM rate_schedule");
    /*
     * The calendars are not reset: they are built once in `beforeAll`
     * and the published one is immutable by design, so every test here
     * sees the same hours. A test that wiped them would also have to
     * rebuild a season set, and `tou_slot` now keys on the tenant's
     * peak codes, which this would be deleting out from under.
     */
  }),
);

let scheduleCode = 0;

async function createDraft(payload: Record<string, unknown> = {}) {
  scheduleCode += 1;
  const res = await inject("POST", "/api/v1/rate-schedules", {
    name: "Residential Water TOU",
    code: `RES-TOU-${scheduleCode}`,
    commodityId: waterCommodityId,
    effectiveDate: "2026-07-01",
    ...payload,
  });
  if (res.statusCode !== 201) throw new Error(`schedule create failed: ${res.body}`);
  return body(res);
}

/** A consumption charge priced against one of the calendar's periods. */
function touComponent(peakCode: string, rate: number, sortOrder: number) {
  return {
    kindCode: "consumption",
    label: `${peakCode} energy`,
    predicate: {},
    quantitySource: { base: "tou_period", peak_code: peakCode, transforms: [] },
    pricing: { type: "flat", rate },
    sortOrder,
    effectiveDate: "2026-07-01",
  };
}

describe("naming the calendar", () => {
  it("takes one at create", async () => {
    const draft = await createDraft({ touCalendarId: publishedCalendarId });
    expect(draft.touCalendarId).toBe(publishedCalendarId);
  });

  it("takes one afterwards, which is the order the publish gate assumes", async () => {
    /*
     * `assertTouPricingComplete` says in so many words that a draft may
     * be half-written — the author adds the calendar and the charges in
     * whichever order they like. That was not true of the calendar
     * until this route existed.
     */
    const draft = await createDraft();
    expect(draft.touCalendarId).toBeNull();

    const res = await inject("PUT", `/api/v1/rate-schedules/${draft.id}/tou-calendar`, {
      touCalendarId: publishedCalendarId,
    });

    expect(res.statusCode).toBe(200);
    expect(body(res).touCalendarId).toBe(publishedCalendarId);
  });

  it("names it on the detail payload, since there is no Prisma relation to include", async () => {
    const draft = await createDraft({ touCalendarId: publishedCalendarId });

    const res = await inject("GET", `/api/v1/rate-schedules/${draft.id}`);

    expect(res.statusCode).toBe(200);
    expect(body(res).touCalendar).toMatchObject({
      id: publishedCalendarId,
      name: "TOD 5-8pm",
    });
  });

  it("clears it", async () => {
    const draft = await createDraft({ touCalendarId: publishedCalendarId });

    const res = await inject("PUT", `/api/v1/rate-schedules/${draft.id}/tou-calendar`, {
      touCalendarId: null,
    });

    expect(res.statusCode).toBe(200);
    expect(body(res).touCalendarId).toBeNull();
  });

  it("refuses a calendar this utility has not got", async () => {
    /*
     * The composite key refuses another tenant's id anyway, as a P2003
     * that reaches the author as a 500 naming a constraint.
     */
    const draft = await createDraft();

    const res = await inject("PUT", `/api/v1/rate-schedules/${draft.id}/tou-calendar`, {
      touCalendarId: "00000000-0000-4000-8000-00000000dead",
    });

    expect(res.statusCode).toBe(400);
    expect(body(res).error?.code).toBe("TOU_CALENDAR_UNKNOWN");
  });

  it("refuses to move a published schedule's calendar", async () => {
    // Which hours a tariff was priced against is part of what was
    // approved. Changing it is a revision, not an edit.
    const draft = await createDraft({ touCalendarId: publishedCalendarId });
    await inject("POST", `/api/v1/rate-schedules/${draft.id}/components`, touComponent("off_peak", 0.08, 100));
    await inject("POST", `/api/v1/rate-schedules/${draft.id}/components`, touComponent("peak", 0.21, 200));
    const published = await inject("POST", `/api/v1/rate-schedules/${draft.id}/publish`);
    expect(published.statusCode).toBe(200);

    const res = await inject("PUT", `/api/v1/rate-schedules/${draft.id}/tou-calendar`, {
      touCalendarId: draftCalendarId,
    });

    expect(res.statusCode).toBe(409);
    expect(body(res).error?.code).toBe("SCHEDULE_NOT_EDITABLE");
  });
});

describe("revising", () => {
  it("keeps the calendar when the revision only reprices", async () => {
    const draft = await createDraft({ touCalendarId: publishedCalendarId });

    const res = await inject("POST", `/api/v1/rate-schedules/${draft.id}/revise`, {
      effectiveDate: "2027-07-01",
    });

    expect(res.statusCode).toBe(201);
    expect(body(res).touCalendarId).toBe(publishedCalendarId);
  });

  it("re-points it when the revision follows new hours", async () => {
    // The usual reason a TOU tariff is revised at all: a published
    // schedule cannot follow a calendar republished with new hours, so
    // new hours mean a new version against the new calendar version.
    const draft = await createDraft({ touCalendarId: publishedCalendarId });

    const res = await inject("POST", `/api/v1/rate-schedules/${draft.id}/revise`, {
      effectiveDate: "2027-07-01",
      touCalendarId: draftCalendarId,
    });

    expect(res.statusCode).toBe(201);
    expect(body(res).touCalendarId).toBe(draftCalendarId);
  });
});

describe("publishing a TOU tariff", () => {
  it("goes through when every period the calendar uses is priced", async () => {
    const draft = await createDraft({ touCalendarId: publishedCalendarId });
    const offPeak = await inject(
      "POST",
      `/api/v1/rate-schedules/${draft.id}/components`,
      touComponent("off_peak", 0.08, 100),
    );
    expect(offPeak.statusCode).toBe(201);
    await inject("POST", `/api/v1/rate-schedules/${draft.id}/components`, touComponent("peak", 0.21, 200));

    const res = await inject("POST", `/api/v1/rate-schedules/${draft.id}/publish`);

    expect(res.statusCode).toBe(200);
    expect(body(res).publishedAt).not.toBeNull();
  });

  it("refuses when a period the calendar uses is priced by nothing", async () => {
    /*
     * The expensive direction, and the quiet one: off-peak energy the
     * customer uses is never charged for, and nothing raises — the
     * bucket is simply never asked about and the bill looks complete.
     */
    const draft = await createDraft({ touCalendarId: publishedCalendarId });
    await inject("POST", `/api/v1/rate-schedules/${draft.id}/components`, touComponent("peak", 0.21, 100));

    const res = await inject("POST", `/api/v1/rate-schedules/${draft.id}/publish`);

    expect(res.statusCode).toBe(409);
    expect(body(res).error?.code).toBe("TOU_PRICING_INCOMPLETE");
    expect(res.body).toMatch(/off_peak/);
  });

  it("refuses when the charges price periods and no calendar says which hours those are", async () => {
    const draft = await createDraft();
    await inject("POST", `/api/v1/rate-schedules/${draft.id}/components`, touComponent("peak", 0.21, 100));

    const res = await inject("POST", `/api/v1/rate-schedules/${draft.id}/publish`);

    expect(res.statusCode).toBe(409);
    expect(body(res).error?.code).toBe("TOU_CALENDAR_REQUIRED");
  });

  it("refuses a draft calendar, whose hours can still change", async () => {
    const draft = await createDraft({ touCalendarId: draftCalendarId });
    await inject("POST", `/api/v1/rate-schedules/${draft.id}/components`, touComponent("off_peak", 0.08, 100));
    await inject("POST", `/api/v1/rate-schedules/${draft.id}/components`, touComponent("peak", 0.21, 200));

    const res = await inject("POST", `/api/v1/rate-schedules/${draft.id}/publish`);

    expect(res.statusCode).toBe(409);
    expect(body(res).error?.code).toBe("TOU_CALENDAR_NOT_PUBLISHED");
  });
});

describe("the charge that prices a period", () => {
  it("saves, which is what the grammar refused until now", async () => {
    const draft = await createDraft({ touCalendarId: publishedCalendarId });

    const res = await inject(
      "POST",
      `/api/v1/rate-schedules/${draft.id}/components`,
      touComponent("peak", 0.21, 100),
    );

    expect(res.statusCode).toBe(201);
    expect(body(res).quantitySource).toMatchObject({ base: "tou_period", peak_code: "peak" });
  });

  it("is refused without the period it prices", async () => {
    const draft = await createDraft({ touCalendarId: publishedCalendarId });

    const res = await inject("POST", `/api/v1/rate-schedules/${draft.id}/components`, {
      ...touComponent("peak", 0.21, 100),
      quantitySource: { base: "tou_period", transforms: [] },
    });

    expect(res.statusCode).toBe(400);
  });

  it("is refused when a period is named on a charge that prices the whole meter", async () => {
    /*
     * `metered` with a `peak_code` reads as a TOU charge and is not
     * one: the engine ignores the key, and the publish gate counts only
     * `tou_period` components — so the schedule would look complete
     * while every kWh billed at the on-peak price.
     */
    const draft = await createDraft({ touCalendarId: publishedCalendarId });

    const res = await inject("POST", `/api/v1/rate-schedules/${draft.id}/components`, {
      ...touComponent("peak", 0.21, 100),
      quantitySource: { base: "metered", peak_code: "peak", transforms: [] },
    });

    expect(res.statusCode).toBe(400);
  });
});
