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
 * The TOU calendar editor's server side (spec 26, §5).
 *
 * Driven through `app.inject` rather than the service directly, because
 * half of what is being checked is the refusals reaching an operator as
 * a status code and a sentence they can act on.
 *
 * The holiday case is the centre of the file. **4 July 2026 is a
 * Saturday**, so a `NEAREST_WEEKDAY` rule observes it on Friday 3 July —
 * a date whose weekday says "weekday day type" and whose holiday list
 * says otherwise. That is the interaction the spec calls the part people
 * get wrong (TOU-UI-1c), and a calendar that resolved it the other way
 * would price a peak afternoon at peak on a day the tariff calls
 * off-peak, with nothing raised.
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

const inject = (method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", url: string, payload?: unknown) =>
  app.inject({ method, url, headers: headers(), ...(payload ? { payload } : {}) });

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

let publishedSeasonSetId: string;
let draftSeasonSetId: string;
let holidayListId: string;

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

    // Two seasons, one of which wraps the year end — the shape that
    // breaks a naive month comparison.
    const published = await prisma.seasonSet.create({
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
          seasonSetId: published.id,
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
          seasonSetId: published.id,
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
    publishedSeasonSetId = published.id;

    const draft = await prisma.seasonSet.create({
      data: {
        utilityId: TENANT_A,
        name: "Draft seasons",
        effectiveDate: new Date(Date.UTC(2027, 0, 1)),
      },
    });
    await prisma.season.create({
      data: {
        utilityId: TENANT_A,
        seasonSetId: draft.id,
        seasonCode: "all",
        label: "All year",
        startMonth: 1,
        startDay: 1,
        endMonth: 12,
        endDay: 31,
      },
    });
    draftSeasonSetId = draft.id;

    const list = await prisma.touHolidayList.create({
      data: { utilityId: TENANT_A, name: "Utility holidays" },
    });
    await prisma.touHolidayRule.createMany({
      data: [
        {
          utilityId: TENANT_A,
          touHolidayListId: list.id,
          code: "independence_day",
          label: "Independence Day",
          kind: "FIXED",
          month: 7,
          day: 4,
          observance: "NEAREST_WEEKDAY",
        },
        {
          utilityId: TENANT_A,
          touHolidayListId: list.id,
          code: "thanksgiving",
          label: "Thanksgiving",
          kind: "NTH_WEEKDAY",
          month: 11,
          weekday: 4,
          nth: 4,
          observance: "NONE",
        },
      ],
    });
    holidayListId = list.id;
  }),
);

/** A draft calendar naming the published season set and the holidays. */
async function createCalendar(over: Record<string, unknown> = {}) {
  const res = await inject("POST", "/api/v1/tou-calendars", {
    name: "TOD 5-8pm",
    effectiveDate: "2026-06-01",
    seasonSetId: publishedSeasonSetId,
    touHolidayListId: holidayListId,
    timeZone: "America/Los_Angeles",
    ...over,
  });
  if (res.statusCode !== 201) throw new Error(`create failed: ${res.statusCode} ${res.body}`);
  return body(res);
}

const PERIODS = { periods: [
  { peakCode: "off_peak", label: "Off-peak" },
  { peakCode: "peak", label: "Peak" },
] };

const DAY_TYPES = { dayTypes: [
  { dayTypeCode: "weekday", label: "Weekday", isHoliday: false, weekdays: [1, 2, 3, 4, 5] },
  { dayTypeCode: "weekend", label: "Weekend", isHoliday: false, weekdays: [6, 7] },
  { dayTypeCode: "holiday", label: "Holiday", isHoliday: true, weekdays: [] },
] };

/** Every (season, day type) covered — a calendar that can be published. */
async function fillSpans(id: string) {
  // Summer weekdays carry the 5–8pm peak; everything else is off-peak
  // all day, which is what a two-period residential tariff looks like.
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

async function completeCalendar() {
  const calendar = await createCalendar();
  await inject("PUT", `/api/v1/tou-calendars/${calendar.id}/periods`, PERIODS);
  await inject("PUT", `/api/v1/tou-calendars/${calendar.id}/day-types`, DAY_TYPES);
  await fillSpans(calendar.id);
  return calendar.id;
}

describe("creating a calendar", () => {
  it("creates a draft", async () => {
    const calendar = await createCalendar();
    expect(calendar.publishedAt).toBeNull();
    expect(calendar.timeZone).toBe("America/Los_Angeles");
  });

  it("refuses a time zone the runtime does not know", async () => {
    /*
     * Without this the name falls back to the runtime's own zone rather
     * than raising, so every peak shifts by hours and nothing says so.
     */
    const res = await inject("POST", "/api/v1/tou-calendars", {
      name: "Typo",
      effectiveDate: "2026-06-01",
      seasonSetId: publishedSeasonSetId,
      timeZone: "America/Los_Angelos",
    });
    expect(res.statusCode).toBe(400);
    expect(body(res).error.code).toBe("UNKNOWN_TIME_ZONE");
    expect(body(res).error.message).toMatch(/IANA/);
  });

  it("lets a draft calendar name a draft season set, which publishing will not", async () => {
    // The two are usually built together; forcing an order would be an
    // invented rule.
    const calendar = await createCalendar({ seasonSetId: draftSeasonSetId });
    expect(calendar.id).toBeTruthy();
  });
});

describe("validation while the calendar is being built", () => {
  it("names the hours that no period covers", async () => {
    const calendar = await createCalendar();
    await inject("PUT", `/api/v1/tou-calendars/${calendar.id}/periods`, PERIODS);
    await inject("PUT", `/api/v1/tou-calendars/${calendar.id}/day-types`, DAY_TYPES);
    await inject("PUT", `/api/v1/tou-calendars/${calendar.id}/spans`, {
      seasonCode: "summer",
      dayTypeCode: "weekday",
      spans: [{ startMinute: 0, endMinute: 1020, peakCode: "off_peak" }],
    });

    const res = await inject("GET", `/api/v1/tou-calendars/${calendar.id}/validation`);
    expect(res.statusCode).toBe(200);
    const validation = body(res);
    expect(validation.ok).toBe(false);
    // Positional and in words (TOU-UI-1a): the hour, not "invalid".
    expect(validation.problems.join("\n")).toMatch(/17:00/);
    expect(validation.problems.join("\n")).toMatch(/summer/);
  });

  it("passes once every season and day type tiles the day", async () => {
    const id = await completeCalendar();
    const res = await inject("GET", `/api/v1/tou-calendars/${id}/validation`);
    expect(body(res).ok).toBe(true);
  });

  it("refuses two spans that overlap, naming both", async () => {
    const calendar = await createCalendar();
    await inject("PUT", `/api/v1/tou-calendars/${calendar.id}/periods`, PERIODS);
    await inject("PUT", `/api/v1/tou-calendars/${calendar.id}/day-types`, DAY_TYPES);

    const res = await inject("PUT", `/api/v1/tou-calendars/${calendar.id}/spans`, {
      seasonCode: "summer",
      dayTypeCode: "weekday",
      spans: [
        { startMinute: 0, endMinute: 1080, peakCode: "off_peak" },
        { startMinute: 1020, endMinute: 1200, peakCode: "peak" },
      ],
    });
    expect(res.statusCode).toBe(400);
    expect(body(res).error.code).toBe("TOU_SPANS_OVERLAP");
    expect(body(res).error.message).toMatch(/00:00–18:00/);
    expect(body(res).error.message).toMatch(/17:00–20:00/);
  });
});

describe("the collections that cannot be edited row by row", () => {
  it("refuses to drop a period that hours are still assigned to", async () => {
    const id = await completeCalendar();
    const res = await inject("PUT", `/api/v1/tou-calendars/${id}/periods`, {
      periods: [{ peakCode: "off_peak", label: "Off-peak" }],
    });
    expect(res.statusCode).toBe(409);
    expect(body(res).error.code).toBe("TOU_PERIOD_IN_USE");
    expect(body(res).error.message).toMatch(/Peak/);
  });

  it("refuses to drop a day type whose hours would be cascaded away", async () => {
    /*
     * `tou_slot_day_type_id_fkey` cascades, which is right for deleting
     * a calendar and wrong for a typo in a code — it would discard an
     * afternoon's work with no warning.
     */
    const id = await completeCalendar();
    const res = await inject("PUT", `/api/v1/tou-calendars/${id}/day-types`, {
      dayTypes: [
        { dayTypeCode: "weekday", label: "Weekday", isHoliday: false, weekdays: [1, 2, 3, 4, 5] },
        { dayTypeCode: "weekend", label: "Weekend", isHoliday: false, weekdays: [6, 7] },
      ],
    });
    expect(res.statusCode).toBe(409);
    expect(body(res).error.code).toBe("TOU_DAY_TYPE_HAS_SPANS");
    expect(body(res).error.message).toMatch(/Holiday/);
  });

  it("moves a weekday from one day type to another", async () => {
    /*
     * `tou_day_type_weekday_once_per_calendar` makes a weekday one day
     * type's property, so this is only legal with the old row already
     * gone — which is why the whole collection is rewritten in one
     * transaction rather than diffed.
     */
    const id = await completeCalendar();
    const res = await inject("PUT", `/api/v1/tou-calendars/${id}/day-types`, {
      dayTypes: [
        { dayTypeCode: "weekday", label: "Weekday", isHoliday: false, weekdays: [1, 2, 3, 4] },
        { dayTypeCode: "weekend", label: "Weekend", isHoliday: false, weekdays: [5, 6, 7] },
        { dayTypeCode: "holiday", label: "Holiday", isHoliday: true, weekdays: [] },
      ],
    });
    expect(res.statusCode).toBe(200);
    const weekend = body(res).dayTypes.find((d: { dayTypeCode: string }) => d.dayTypeCode === "weekend");
    expect(weekend.weekdays).toEqual([5, 6, 7]);
  });

  it("refuses a second holiday day type", async () => {
    const id = await completeCalendar();
    const res = await inject("PUT", `/api/v1/tou-calendars/${id}/day-types`, {
      dayTypes: [
        { dayTypeCode: "weekday", label: "Weekday", isHoliday: false, weekdays: [1, 2, 3, 4, 5] },
        { dayTypeCode: "weekend", label: "Weekend", isHoliday: true, weekdays: [6, 7] },
        { dayTypeCode: "holiday", label: "Holiday", isHoliday: true, weekdays: [] },
      ],
    });
    expect(res.statusCode).toBe(400);
    expect(body(res).error.code).toBe("MULTIPLE_HOLIDAY_DAY_TYPES");
  });
});

describe("the spot check (TOU-UI-1c)", () => {
  it("answers an ordinary summer weekday with the peak period", async () => {
    const id = await completeCalendar();
    // Thursday 2 July 2026, 17:15 — inside the 5–8pm peak.
    const res = await inject(
      "GET",
      `/api/v1/tou-calendars/${id}/spot-check?date=2026-07-02&time=17:15`,
    );
    expect(res.statusCode).toBe(200);
    const answer = body(res);
    expect(answer.ok).toBe(true);
    expect(answer.peakCode).toBe("peak");
    expect(answer.periodLabel).toBe("Peak");
    expect(answer.seasonCode).toBe("summer");
    expect(answer.dayTypeCode).toBe("weekday");
    expect(answer.why).toMatch(/Thursday/);
  });

  it("applies the holiday day type on the day a Saturday holiday is observed", async () => {
    /*
     * 4 July 2026 is a Saturday, so NEAREST_WEEKDAY observes it on
     * Friday 3 July. A Friday afternoon that would otherwise be peak is
     * off-peak, and the sentence has to say why — this is the
     * interaction the spec says people get wrong.
     */
    const id = await completeCalendar();
    const res = await inject(
      "GET",
      `/api/v1/tou-calendars/${id}/spot-check?date=2026-07-03&time=17:15`,
    );
    const answer = body(res);
    expect(answer.ok).toBe(true);
    expect(answer.dayTypeCode).toBe("holiday");
    expect(answer.peakCode).toBe("off_peak");
    expect(answer.why).toMatch(/Independence Day/);
    expect(answer.why).toMatch(/2026-07-04/);
  });

  it("reports the hour it cannot classify rather than guessing one", async () => {
    const calendar = await createCalendar();
    await inject("PUT", `/api/v1/tou-calendars/${calendar.id}/periods`, PERIODS);
    await inject("PUT", `/api/v1/tou-calendars/${calendar.id}/day-types`, DAY_TYPES);
    const res = await inject(
      "GET",
      `/api/v1/tou-calendars/${calendar.id}/spot-check?date=2026-07-02&time=17:15`,
    );
    expect(body(res).ok).toBe(false);
    expect(body(res).problem).toBeTruthy();
  });

  it("refuses a time it cannot read instead of assuming midnight", async () => {
    const id = await completeCalendar();
    const res = await inject("GET", `/api/v1/tou-calendars/${id}/spot-check?date=2026-07-02&time=5pm`);
    expect(res.statusCode).toBe(400);
  });
});

describe("the day preview (TOU-UI-1e)", () => {
  it("lays out the observed holiday's day", async () => {
    const id = await completeCalendar();
    const res = await inject("GET", `/api/v1/tou-calendars/${id}/day?date=2026-07-03`);
    const day = body(res);
    expect(day.ok).toBe(true);
    expect(day.dayTypeCode).toBe("holiday");
    expect(day.seasonCode).toBe("summer");
    expect(day.spans).toHaveLength(1);
    expect(day.spans[0]).toMatchObject({ startMinute: 0, endMinute: 1440, peakCode: "off_peak" });
  });

  it("lays out a summer weekday's three spans in order", async () => {
    const id = await completeCalendar();
    const res = await inject("GET", `/api/v1/tou-calendars/${id}/day?date=2026-07-02`);
    const day = body(res);
    expect(day.spans.map((s: { peakCode: string }) => s.peakCode)).toEqual([
      "off_peak",
      "peak",
      "off_peak",
    ]);
  });

  it("resolves the wrapping season on a January date", async () => {
    // non_summer runs Oct 1 – May 31, so January is inside it only if
    // the wrap is handled.
    const id = await completeCalendar();
    const res = await inject("GET", `/api/v1/tou-calendars/${id}/day?date=2026-01-15`);
    expect(body(res).seasonCode).toBe("non_summer");
  });
});

describe("day overrides", () => {
  it("takes precedence over the weekday and says so", async () => {
    const id = await completeCalendar();
    const put = await inject("PUT", `/api/v1/tou-calendars/${id}/overrides`, {
      overrides: [
        { date: "2026-07-02", dayTypeCode: "holiday", reason: "Plant shutdown" },
      ],
    });
    expect(put.statusCode).toBe(200);

    const res = await inject(
      "GET",
      `/api/v1/tou-calendars/${id}/spot-check?date=2026-07-02&time=17:15`,
    );
    const answer = body(res);
    expect(answer.dayTypeCode).toBe("holiday");
    expect(answer.peakCode).toBe("off_peak");
    expect(answer.why).toMatch(/Plant shutdown/);
  });

  it("refuses an override naming a day type the calendar has not got", async () => {
    const id = await completeCalendar();
    const res = await inject("PUT", `/api/v1/tou-calendars/${id}/overrides`, {
      overrides: [{ date: "2026-07-02", dayTypeCode: "bank_holiday" }],
    });
    expect(res.statusCode).toBe(400);
    expect(body(res).error.code).toBe("TOU_DAY_TYPE_MISSING");
  });
});

describe("publishing", () => {
  it("refuses a calendar that does not price every hour, and names the gap", async () => {
    const calendar = await createCalendar();
    await inject("PUT", `/api/v1/tou-calendars/${calendar.id}/periods`, PERIODS);
    await inject("PUT", `/api/v1/tou-calendars/${calendar.id}/day-types`, DAY_TYPES);

    const res = await inject("POST", `/api/v1/tou-calendars/${calendar.id}/publish`);
    expect(res.statusCode).toBe(409);
    expect(body(res).error.code).toBe("TOU_CALENDAR_INVALID");
    // The message states the consequence, not just the fault.
    expect(body(res).error.message).toMatch(/uncharged|charged twice/);
  });

  it("refuses a calendar whose season set is still a draft", async () => {
    /*
     * TOU-CAL-10: the spans are keyed on the set's codes, and a draft
     * set can still rename them — which would leave every span
     * referencing a code that no longer exists.
     */
    const calendar = await createCalendar({ seasonSetId: draftSeasonSetId });
    await inject("PUT", `/api/v1/tou-calendars/${calendar.id}/periods`, PERIODS);
    await inject("PUT", `/api/v1/tou-calendars/${calendar.id}/day-types`, DAY_TYPES);
    for (const dayTypeCode of ["weekday", "weekend", "holiday"]) {
      await inject("PUT", `/api/v1/tou-calendars/${calendar.id}/spans`, {
        seasonCode: "all",
        dayTypeCode,
        spans: [{ startMinute: 0, endMinute: 1440, peakCode: "off_peak" }],
      });
    }

    const res = await inject("POST", `/api/v1/tou-calendars/${calendar.id}/publish`);
    expect(res.statusCode).toBe(409);
    expect(body(res).error.code).toBe("SEASON_SET_NOT_PUBLISHED");
  });

  it("publishes a complete calendar", async () => {
    const id = await completeCalendar();
    const res = await inject("POST", `/api/v1/tou-calendars/${id}/publish`);
    expect(res.statusCode).toBe(200);
    expect(body(res).publishedAt).toBeTruthy();
  });

  it("refuses to publish twice", async () => {
    const id = await completeCalendar();
    await inject("POST", `/api/v1/tou-calendars/${id}/publish`);
    const res = await inject("POST", `/api/v1/tou-calendars/${id}/publish`);
    expect(res.statusCode).toBe(409);
    expect(body(res).error.code).toBe("ALREADY_PUBLISHED");
  });

  it("freezes the hours once published", async () => {
    const id = await completeCalendar();
    await inject("POST", `/api/v1/tou-calendars/${id}/publish`);

    const res = await inject("PUT", `/api/v1/tou-calendars/${id}/spans`, {
      seasonCode: "summer",
      dayTypeCode: "weekday",
      spans: [{ startMinute: 0, endMinute: 1440, peakCode: "peak" }],
    });
    expect(res.statusCode).toBe(409);
    expect(body(res).error.code).toBe("TOU_CALENDAR_PUBLISHED");
    // It says what to do instead, because the operator still has a job
    // to finish.
    expect(body(res).error.message).toMatch(/new version/);
  });

  it("refuses a header edit on a published calendar too", async () => {
    const id = await completeCalendar();
    await inject("POST", `/api/v1/tou-calendars/${id}/publish`);
    const res = await inject("PATCH", `/api/v1/tou-calendars/${id}`, { timeZone: "America/Denver" });
    expect(res.statusCode).toBe(409);
  });

  it("keeps a second version as its own row, by effective date", async () => {
    // There is no version column: a version IS a (name, effectiveDate).
    const first = await completeCalendar();
    await inject("POST", `/api/v1/tou-calendars/${first}/publish`);
    const second = await createCalendar({ effectiveDate: "2027-06-01" });

    const res = await inject("GET", "/api/v1/tou-calendars?name=TOD%205-8pm");
    expect(res.statusCode).toBe(200);
    expect(body(res).data).toHaveLength(2);
    expect(body(res).data.map((c: { id: string }) => c.id)).toContain(second.id);
  });
});

describe("the holiday list's resolved dates (TOU-UI-2)", () => {
  /*
   * A rule nobody can see the output of is a rule nobody will trust,
   * and the observance rules are where the surprises live: "4 July,
   * nearest weekday" does not tell anybody that 2026 lands on a
   * Saturday and moves the holiday to the Friday — which moves a peak
   * weekday to off-peak.
   */
  it("resolves three years and marks the dates an observance rule moved", async () => {
    const res = await inject(
      "GET",
      `/api/v1/tou-holiday-lists/${holidayListId}/resolved?fromYear=2026`,
    );
    expect(res.statusCode).toBe(200);
    const payload = body(res);
    expect(payload.fromYear).toBe(2026);
    expect(payload.toYear).toBe(2028);

    const independence = payload.resolved.filter(
      (r: { code: string }) => r.code === "independence_day",
    );
    expect(independence).toHaveLength(3);

    // 2026: 4 July is a Saturday, so it is observed on Friday the 3rd.
    const y2026 = independence.find((r: { year: number }) => r.year === 2026);
    expect(y2026).toMatchObject({ actual: "2026-07-04", observed: "2026-07-03", moved: true });

    // 2027: 4 July is a Sunday → the Monday after.
    const y2027 = independence.find((r: { year: number }) => r.year === 2027);
    expect(y2027).toMatchObject({ actual: "2027-07-04", observed: "2027-07-05", moved: true });

    // 2028: a Tuesday, so nothing moves and `moved` must say so.
    const y2028 = independence.find((r: { year: number }) => r.year === 2028);
    expect(y2028).toMatchObject({ actual: "2028-07-04", observed: "2028-07-04", moved: false });
  });

  it("resolves an nth-weekday rule to the right date", async () => {
    const res = await inject(
      "GET",
      `/api/v1/tou-holiday-lists/${holidayListId}/resolved?fromYear=2026`,
    );
    const thanksgiving = body(res).resolved.find(
      (r: { code: string; year: number }) => r.code === "thanksgiving" && r.year === 2026,
    );
    // The fourth Thursday of November 2026 is the 26th.
    expect(thanksgiving).toMatchObject({ observed: "2026-11-26", moved: false });
  });

  it("lists the rules beside their output", async () => {
    const res = await inject(
      "GET",
      `/api/v1/tou-holiday-lists/${holidayListId}/resolved?fromYear=2026`,
    );
    expect(body(res).rules.map((r: { code: string }) => r.code).sort()).toEqual([
      "independence_day",
      "thanksgiving",
    ]);
  });
});

describe("season sets, for the calendar form", () => {
  it("lists them with their seasons, so the form can say how many", async () => {
    const res = await inject("GET", "/api/v1/season-sets");
    expect(res.statusCode).toBe(200);
    const published = body(res).data.find(
      (s: { name: string }) => s.name === "Published seasons",
    );
    expect(published.seasons).toHaveLength(2);
    expect(published.publishedAt).toBeTruthy();
  });

  it("includes drafts, because a draft calendar may name one", async () => {
    const res = await inject("GET", "/api/v1/season-sets?status=draft");
    expect(body(res).data.map((s: { name: string }) => s.name)).toEqual(["Draft seasons"]);
  });
});

describe("what period a version applies for", () => {
  /*
   * A calendar has no end date column and should not have one.
   * `load-tou-calendar.ts` picks the newest published version whose
   * effective date is on or before the period start, so a version's
   * last day *is* the day before the next published version of the same
   * name. A `superseded_by_id` column would be a second answer to a
   * question the loader settles by date, and the two could disagree
   * about which version priced a bill.
   */
  it("is open-ended while nothing has replaced it", async () => {
    const id = await completeCalendar();
    await inject("POST", `/api/v1/tou-calendars/${id}/publish`);

    const res = await inject("GET", `/api/v1/tou-calendars/${id}`);
    expect(body(res).inForceUntil).toBeNull();
    expect(body(res).supersededBy).toBeNull();
  });

  it("ends the day before the next published version takes over", async () => {
    const first = await completeCalendar();
    await inject("POST", `/api/v1/tou-calendars/${first}/publish`);

    // Same name, later date — that pair *is* the version.
    const second = await createCalendar({ effectiveDate: "2027-06-01" });
    await inject("PUT", `/api/v1/tou-calendars/${second.id}/periods`, PERIODS);
    await inject("PUT", `/api/v1/tou-calendars/${second.id}/day-types`, DAY_TYPES);
    await fillSpans(second.id);
    await inject("POST", `/api/v1/tou-calendars/${second.id}/publish`);

    const res = await inject("GET", `/api/v1/tou-calendars/${first}`);
    expect(body(res).inForceUntil.slice(0, 10)).toBe("2027-05-31");
    expect(body(res).supersededBy.id).toBe(second.id);
  });

  it("is not ended by a draft successor", async () => {
    /*
     * A draft can still be edited, have its date moved or be deleted,
     * and rating will not reach it. Treating it as an end would retire
     * the version that is actually pricing bills.
     */
    const first = await completeCalendar();
    await inject("POST", `/api/v1/tou-calendars/${first}/publish`);
    await createCalendar({ effectiveDate: "2027-06-01" });

    const res = await inject("GET", `/api/v1/tou-calendars/${first}`);
    expect(body(res).inForceUntil).toBeNull();
    expect(body(res).supersededBy).toBeNull();
  });

  it("is not ended by a later version of a different calendar", async () => {
    const first = await completeCalendar();
    await inject("POST", `/api/v1/tou-calendars/${first}/publish`);

    const other = await createCalendar({ name: "Some other tariff", effectiveDate: "2027-06-01" });
    await inject("PUT", `/api/v1/tou-calendars/${other.id}/periods`, PERIODS);
    await inject("PUT", `/api/v1/tou-calendars/${other.id}/day-types`, DAY_TYPES);
    await fillSpans(other.id);
    await inject("POST", `/api/v1/tou-calendars/${other.id}/publish`);

    const res = await inject("GET", `/api/v1/tou-calendars/${first}`);
    expect(body(res).supersededBy).toBeNull();
  });

  it("marks the replaced version on the list too", async () => {
    // The row is where somebody picks which version to open, so a
    // retired one reading "published" with an open-ended start is the
    // state most likely to send them to the wrong hours.
    const first = await completeCalendar();
    await inject("POST", `/api/v1/tou-calendars/${first}/publish`);
    const second = await createCalendar({ effectiveDate: "2027-06-01" });
    await inject("PUT", `/api/v1/tou-calendars/${second.id}/periods`, PERIODS);
    await inject("PUT", `/api/v1/tou-calendars/${second.id}/day-types`, DAY_TYPES);
    await fillSpans(second.id);
    await inject("POST", `/api/v1/tou-calendars/${second.id}/publish`);

    const res = await inject("GET", "/api/v1/tou-calendars?name=TOD%205-8pm");
    const rows = body(res).data as Array<{ id: string; supersededById: string | null }>;
    expect(rows.find((r) => r.id === first)?.supersededById).toBe(second.id);
    expect(rows.find((r) => r.id === second.id)?.supersededById).toBeNull();
  });
});

describe("what a new calendar starts with", () => {
  /*
   * Starting from nothing made the first screen a blank form over a
   * vocabulary nobody has met: a "period code" and a "day type code"
   * with no indication of what either should say. These are real rows,
   * editable and deletable like any other — not placeholder text, which
   * is what made the empty rows look filled in.
   */
  it("has the three periods nearly every TOU tariff has", async () => {
    const created = await createCalendar();
    const res = await inject("GET", `/api/v1/tou-calendars/${created.id}`);
    expect(body(res).periods.map((p: { peakCode: string }) => p.peakCode)).toEqual([
      "off_peak",
      "mid_peak",
      "peak",
    ]);
  });

  it("has weekday and weekend, between them claiming all seven days", async () => {
    const created = await createCalendar();
    const res = await inject("GET", `/api/v1/tou-calendars/${created.id}`);
    const dayTypes = body(res).dayTypes as Array<{ dayTypeCode: string; weekdays: number[] }>;
    expect(dayTypes.map((d) => d.dayTypeCode)).toEqual(["weekday", "weekend"]);
    expect(dayTypes.flatMap((d) => d.weekdays).sort()).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it("names no holiday day type, which is a tariff shape and not an omission", async () => {
    // A calendar with a holiday list and no holiday day type classifies
    // holidays by their weekday. Real, and not ours to decide.
    const created = await createCalendar();
    const res = await inject("GET", `/api/v1/tou-calendars/${created.id}`);
    expect(body(res).dayTypes.some((d: { isHoliday: boolean }) => d.isHoliday)).toBe(false);
  });

  it("leaves the defaults editable like anything else", async () => {
    const created = await createCalendar();
    const res = await inject("PUT", `/api/v1/tou-calendars/${created.id}/periods`, {
      periods: [{ peakCode: "flat", label: "All hours" }],
    });
    expect(res.statusCode).toBe(200);
    expect(body(res).periods.map((p: { peakCode: string }) => p.peakCode)).toEqual(["flat"]);
  });

  it("starts with no hours, so nothing is priced by assumption", async () => {
    const created = await createCalendar();
    const res = await inject("GET", `/api/v1/tou-calendars/${created.id}`);
    expect(body(res).spanGroups.every((g: { spans: unknown[] }) => g.spans.length === 0)).toBe(true);
    expect(body(res).validation.ok).toBe(false);
  });
});

describe("changing the season set on a draft", () => {
  it("is allowed while no hours reference the old seasons", async () => {
    const created = await createCalendar();
    const res = await inject("PATCH", `/api/v1/tou-calendars/${created.id}`, {
      seasonSetId: draftSeasonSetId,
    });
    expect(res.statusCode).toBe(200);

    const after = await inject("GET", `/api/v1/tou-calendars/${created.id}`);
    expect(body(after).seasonSet.id).toBe(draftSeasonSetId);
  });

  it("is refused when hours are keyed on a season the new set does not define", async () => {
    /*
     * `tou_slot.season_code` is a string with no foreign key — it cannot
     * have one, since a season belongs to a set and a slot to a
     * calendar — so the hours would survive pointing at nothing and
     * `resolvePeak` would answer "no period covers 17:15" on every bill.
     */
    const id = await completeCalendar();
    const res = await inject("PATCH", `/api/v1/tou-calendars/${id}`, {
      seasonSetId: draftSeasonSetId,
    });
    expect(res.statusCode).toBe(409);
    expect(body(res).error.code).toBe("SEASON_CODE_IN_USE");
    expect(body(res).error.message).toMatch(/summer|non_summer/);
    expect(body(res).error.message).toMatch(/Draft seasons/);
  });

  it("does not delete the hours to make the change succeed", async () => {
    const id = await completeCalendar();
    await inject("PATCH", `/api/v1/tou-calendars/${id}`, { seasonSetId: draftSeasonSetId });

    const after = await inject("GET", `/api/v1/tou-calendars/${id}`);
    expect(after.statusCode).toBe(200);
    expect(body(after).seasonSet.name).toBe("Published seasons");
    expect(body(after).spanGroups.some((g: { spans: unknown[] }) => g.spans.length > 0)).toBe(true);
  });

  it("is refused once published", async () => {
    const id = await completeCalendar();
    await inject("POST", `/api/v1/tou-calendars/${id}/publish`);
    const res = await inject("PATCH", `/api/v1/tou-calendars/${id}`, {
      seasonSetId: draftSeasonSetId,
    });
    expect(res.statusCode).toBe(409);
    expect(body(res).error.code).toBe("TOU_CALENDAR_PUBLISHED");
  });
});

describe("deleting", () => {
  it("deletes a draft", async () => {
    const calendar = await createCalendar();
    const res = await inject("DELETE", `/api/v1/tou-calendars/${calendar.id}`);
    expect(res.statusCode).toBeLessThan(300);
    const after = await inject("GET", `/api/v1/tou-calendars/${calendar.id}`);
    expect(after.statusCode).toBe(404);
  });

  it("deletes a draft that has hours in it", async () => {
    /*
     * Deleting a calendar cascades to its periods, day types and slots
     * — but `tou_slot_period_id_fkey` is RESTRICT, so if Postgres
     * removed the periods before the slots that reference them the
     * delete would fail on a foreign key. The empty-draft case above
     * cannot show that; this one has three spans per group.
     */
    const id = await completeCalendar();
    const res = await inject("DELETE", `/api/v1/tou-calendars/${id}`);
    expect(res.statusCode).toBeLessThan(300);
    expect((await inject("GET", `/api/v1/tou-calendars/${id}`)).statusCode).toBe(404);
  });

  it("refuses to delete a published one", async () => {
    const id = await completeCalendar();
    await inject("POST", `/api/v1/tou-calendars/${id}/publish`);
    const res = await inject("DELETE", `/api/v1/tou-calendars/${id}`);
    expect(res.statusCode).toBe(409);
  });
});
