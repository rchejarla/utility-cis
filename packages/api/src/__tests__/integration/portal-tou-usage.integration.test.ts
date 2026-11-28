import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import type { FastifyInstance } from "fastify";
import {
  bootPostgres,
  resetDb,
  makeTenantFixture,
  TENANT_A,
  type TenantFixture,
  ensurePrincipal,
  truncateTables,
  seedAsPlatform,
  endAdminPool,
  serviceClassFor,
} from "./_effective-dating-fixtures.js";

/**
 * A customer's usage for one billed period, by TOU period and by hour
 * (spec 26, the portal half of TOU-BIL-3), over HTTP.
 *
 *   GET /portal/api/agreements/:id/billed-periods
 *   GET /portal/api/agreements/:id/billed-periods/:segmentId/usage
 *
 * Pinned here: the portal's rules (ownership in the query, 404 on a miss,
 * unposted bills withheld); the period table is the bill's own; the hourly
 * profile groups by **local** hour, including the fall-back day, when 1 am
 * happens twice; and a register meter, which records no time of use, says
 * so with `hourly: null`.
 */

let pgContainer: StartedPostgreSqlContainer;
let prismaImports: typeof import("../../lib/prisma.js");
let app: FastifyInstance;

let fix: TenantFixture;
let customerId: string;
let strangerAgreementId: string;
let agreementId: string;
let portalUserId: string;
let scheduleId: string;
const componentByCode: Record<string, string> = {};

const asPlatform = <T>(fn: () => Promise<T>): Promise<T> => seedAsPlatform(async () => await fn());

function makeToken(opts: { actorId: string; customerId: string }) {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      sub: opts.actorId,
      utility_id: TENANT_A,
      email: "customer@example.com",
      name: "Portal Customer",
      role: "portal",
      customer_id: opts.customerId,
    }),
  ).toString("base64url");
  return `${header}.${payload}.fake-signature`;
}

beforeAll(async () => {
  const booted = await bootPostgres({ utilities: [TENANT_A] });
  pgContainer = booted.container;
  prismaImports = await import("../../lib/prisma.js");
  app = await (await import("../../app.js")).buildApp();
  await app.ready();
}, 180_000);

afterAll(async () => {
  await app?.close().catch(() => {});
  await prismaImports?.prisma.$disconnect().catch(() => {});
  await prismaImports?.pool.end().catch(() => {});
  await endAdminPool();
  await pgContainer?.stop().catch(() => {});
});

beforeEach(() =>
  asPlatform(async () => {
    const { prisma } = prismaImports;
    await resetDb();
    await truncateTables("user_role, contact, cis_user, role");
    fix = await makeTenantFixture(prisma, TENANT_A);
    await ensurePrincipal(prisma, TENANT_A);
    for (const moduleKey of ["portal_usage", "accounts"]) {
      await prisma.utilityModule.create({ data: { utilityId: fix.utilityId, moduleKey } });
    }
    await (await import("../../services/rbac.service.js")).invalidateTenantModulesCache(fix.utilityId);

    const mkCustomerAgreement = async (name: string, n: string, premiseId: string) => {
      const c = await prisma.customer.create({
        data: { utilityId: fix.utilityId, customerType: "INDIVIDUAL", firstName: name, lastName: "Test" },
      });
      const a = await prisma.account.create({
        data: {
          utilityId: fix.utilityId,
          accountNumber: `PT-${n}`,
          accountType: "RESIDENTIAL",
          status: "ACTIVE",
          billingCycleId: fix.billingCycleId,
          customerId: c.id,
        },
      });
      const sa = await prisma.serviceAgreement.create({
        data: {
          utilityId: fix.utilityId,
          agreementNumber: `SA-PT-${n}`,
          accountId: a.id,
          commodityId: fix.commodityId,
          rateServiceClassId: await serviceClassFor(prisma, fix.utilityId, fix.commodityId),
          startDate: new Date("2026-01-01"),
          status: "ACTIVE",
        },
      });
      const sp = await prisma.servicePoint.create({
        data: { utilityId: fix.utilityId, serviceAgreementId: sa.id, premiseId, startDate: new Date("2026-01-01") },
      });
      return { customerId: c.id, agreementId: sa.id, servicePointId: sp.id, accountId: a.id };
    };
    const mine = await mkCustomerAgreement("Ada", "MINE", fix.premiseId);
    customerId = mine.customerId;
    agreementId = mine.agreementId;
    await prisma.servicePointMeter.create({
      data: { utilityId: fix.utilityId, servicePointId: mine.servicePointId, meterId: fix.meterId, addedDate: new Date("2026-01-01") },
    });
    const otherPremise = await prisma.premise.create({
      data: {
        utilityId: fix.utilityId,
        addressLine1: "9 Other Road",
        city: "Testville",
        state: "TS",
        zip: "00000",
        premiseType: "RESIDENTIAL",
        commodityIds: [fix.commodityId],
        status: "ACTIVE",
      },
    });
    strangerAgreementId = (await mkCustomerAgreement("Grace", "OTHER", otherPremise.id)).agreementId;

    const role = await prisma.role.create({
      data: { utilityId: fix.utilityId, name: "Portal Customer", permissions: { portal_usage: ["VIEW"] } },
    });
    const user = await prisma.cisUser.create({
      data: { utilityId: fix.utilityId, email: "ada@example.com", name: "Ada", isActive: true, customerId },
    });
    portalUserId = user.id;
    await prisma.userRole.create({ data: { utilityId: fix.utilityId, userId: user.id, roleId: role.id } });

    // Summer: on-peak 17:00–20:00 on weekdays. Winter: one flat mid-peak.
    const seasonSet = await prisma.seasonSet.create({
      data: { utilityId: fix.utilityId, name: "Two seasons", effectiveDate: new Date(Date.UTC(2026, 0, 1)), publishedAt: new Date() },
    });
    await prisma.season.createMany({
      data: [
        { seasonCode: "summer", label: "Summer", startMonth: 6, startDay: 1, endMonth: 9, endDay: 30, sortOrder: 0 },
        { seasonCode: "winter", label: "Winter", startMonth: 10, startDay: 1, endMonth: 5, endDay: 31, sortOrder: 1 },
      ].map((s) => ({ ...s, utilityId: fix.utilityId, seasonSetId: seasonSet.id })),
    });
    const calendar = await prisma.touCalendar.create({
      data: {
        utilityId: fix.utilityId,
        name: "Residential time-of-use",
        effectiveDate: new Date(Date.UTC(2026, 0, 1)),
        publishedAt: new Date(),
        seasonSetId: seasonSet.id,
        timeZone: "America/Denver",
        clockBasis: "prevailing",
      },
    });
    const dayTypes: Record<string, string> = {};
    for (const [code, weekdays] of [["weekday", [1, 2, 3, 4, 5]], ["weekend", [6, 7]]] as const) {
      const dt = await prisma.touDayType.create({
        data: { utilityId: fix.utilityId, touCalendarId: calendar.id, dayTypeCode: code, label: code },
      });
      dayTypes[code] = dt.id;
      await prisma.touDayTypeWeekday.createMany({
        data: weekdays.map((isoWeekday) => ({ utilityId: fix.utilityId, touCalendarId: calendar.id, touDayTypeId: dt.id, isoWeekday })),
      });
    }
    await prisma.touSlot.createMany({
      data: [
        { season: "summer", dayType: "weekday", peakCode: "off_peak", start: 0, end: 1020 },
        { season: "summer", dayType: "weekday", peakCode: "peak", start: 1020, end: 1200 },
        { season: "summer", dayType: "weekday", peakCode: "off_peak", start: 1200, end: 1440 },
        { season: "summer", dayType: "weekend", peakCode: "off_peak", start: 0, end: 1440 },
        { season: "winter", dayType: "weekday", peakCode: "mid_peak", start: 0, end: 1440 },
        { season: "winter", dayType: "weekend", peakCode: "mid_peak", start: 0, end: 1440 },
      ].map((s) => ({
        utilityId: fix.utilityId,
        touCalendarId: calendar.id,
        seasonCode: s.season,
        touDayTypeId: dayTypes[s.dayType]!,
        peakCode: s.peakCode,
        startMinute: s.start,
        endMinute: s.end,
      })),
    });
    const schedule = await prisma.rateSchedule.create({
      data: {
        utilityId: fix.utilityId,
        name: "Residential TOU",
        code: "RES-TOU",
        commodityId: fix.commodityId,
        effectiveDate: new Date("2026-01-01"),
        version: 1,
        publishedAt: new Date(),
        touCalendarId: calendar.id,
      },
    });
    scheduleId = schedule.id;
    for (const [i, code] of ["peak", "mid_peak", "off_peak"].entries()) {
      const c = await prisma.rateComponent.create({
        data: {
          utilityId: fix.utilityId,
          rateScheduleId: schedule.id,
          kindCode: "consumption",
          label: `${code} energy`,
          sortOrder: (i + 1) * 10,
          effectiveDate: new Date("2026-01-01"),
          predicate: {},
          quantitySource: { base: "tou_period", peak_code: code },
          pricing: { type: "flat", rate: 0.1, unit: "kWh" },
        },
      });
      componentByCode[code] = c.id;
    }
  }),
);

const headers = () => ({ authorization: `Bearer ${makeToken({ actorId: portalUserId, customerId })}` });
const get = (url: string) => app.inject({ method: "GET", url, headers: headers() });

/** A billed segment on the customer's agreement, with one line per given period. */
function billedSegment(opts: { start: string; end: string; posted?: boolean; agreement?: string; codes?: string[] }) {
  return asPlatform(async () => {
    const { prisma } = prismaImports;
    const sa = await prisma.serviceAgreement.findUniqueOrThrow({
      where: { id: opts.agreement ?? agreementId },
      select: { accountId: true },
    });
    const bill = await prisma.bill.create({
      data: {
        utilityId: fix.utilityId,
        accountId: sa.accountId,
        billingCycleId: fix.billingCycleId,
        periodStart: new Date(opts.start),
        periodEnd: new Date(opts.end),
        billDate: new Date(opts.end),
        dueDate: new Date(opts.end),
        subtotal: "1",
        taxes: "0",
        credits: "0",
        total: "1",
        billNumber: `B-${Math.random().toString(36).slice(2, 8)}`,
        postedAt: opts.posted === false ? null : new Date(),
      },
    });
    const segment = await prisma.billSegment.create({
      data: {
        utilityId: fix.utilityId,
        serviceAgreementId: opts.agreement ?? agreementId,
        billId: bill.id,
        periodStart: new Date(opts.start),
        periodEnd: new Date(opts.end),
        subtotal: "1",
        taxes: "0",
        credits: "0",
        total: "1",
        minimumFloorApplied: false,
        segmentNumber: `SEG-${Math.random().toString(36).slice(2, 8)}`,
      },
    });
    await prisma.billSegmentLine.createMany({
      data: (opts.codes ?? ["off_peak"]).map((code, i) => ({
        utilityId: fix.utilityId,
        billSegmentId: segment.id,
        label: `${code} energy`,
        kindCode: "consumption",
        amount: "1",
        quantity: 10,
        unit: "kWh",
        sourceScheduleId: scheduleId,
        sourceComponentId: componentByCode[code]!,
        sortOrder: (i + 1) * 100,
      })),
    });
    return segment.id;
  });
}

/** 15-minute intervals at `kwhPerHour` from one UTC instant to another. */
function intervals(fromIso: string, toIso: string, kwhPerHour = 1) {
  return asPlatform(async () => {
    const rows = [];
    for (let t = Date.parse(fromIso); t < Date.parse(toIso); t += 15 * 60_000) {
      rows.push({
        utilityId: fix.utilityId,
        meterId: fix.meterId,
        uomId: fix.uomId,
        intervalStart: new Date(t),
        lengthMinutes: 15,
        quantity: (kwhPerHour / 4).toFixed(6),
        quality: "actual",
      });
    }
    await prismaImports.prisma.meterReadInterval.createMany({ data: rows });
  });
}

describe("billed periods", () => {
  it("lists the agreement's posted periods and withholds an unposted one", async () => {
    await billedSegment({ start: "2026-07-01", end: "2026-07-02" });
    await billedSegment({ start: "2026-08-01", end: "2026-08-02", posted: false });

    const res = await get(`/portal/api/agreements/${agreementId}/billed-periods`);

    expect(res.statusCode).toBe(200);
    const periods = res.json().data;
    expect(periods).toHaveLength(1);
    expect(periods[0]).toMatchObject({ periodStart: "2026-07-01", periodEnd: "2026-07-02", tou: true });
  });

  it("does not serve another customer's agreement, or a period that is not theirs", async () => {
    const theirs = await billedSegment({ start: "2026-07-01", end: "2026-07-02", agreement: strangerAgreementId });

    expect((await get(`/portal/api/agreements/${strangerAgreementId}/billed-periods`)).statusCode).toBe(404);
    // Their segment named under the caller's own agreement is not found either.
    expect(
      (await get(`/portal/api/agreements/${agreementId}/billed-periods/${theirs}/usage`)).statusCode,
    ).toBe(404);
  });

  it("will not show the usage of a period whose bill is unposted", async () => {
    const draft = await billedSegment({ start: "2026-08-01", end: "2026-08-02", posted: false });

    expect((await get(`/portal/api/agreements/${agreementId}/billed-periods/${draft}/usage`)).statusCode).toBe(404);
  });
});

describe("a billed period's usage", () => {
  it("profiles an interval meter by local hour, the peak hours in their own colour", async () => {
    // Wed 1 and Thu 2 July 2026, local Denver days (UTC−6 in summer).
    const segmentId = await billedSegment({ start: "2026-07-01", end: "2026-07-02", codes: ["peak", "off_peak"] });
    await intervals("2026-07-01T06:00:00Z", "2026-07-03T06:00:00Z");

    const res = await get(`/portal/api/agreements/${agreementId}/billed-periods/${segmentId}/usage`);

    expect(res.statusCode).toBe(200);
    const { hourly, byPeriod } = res.json();
    expect(hourly.hours).toHaveLength(24);
    // Two weekdays: 5, 6 and 7 pm are peak, 2 kWh each; every other hour off-peak.
    for (const h of [17, 18, 19]) expect(hourly.hours[h].byPeriod).toEqual({ peak: 2 });
    for (const h of [0, 8, 16, 20, 23]) expect(hourly.hours[h].byPeriod).toEqual({ off_peak: 2 });
    expect(hourly.periods.map((p: { code: string }) => p.code)).toEqual(
      expect.arrayContaining(["peak", "off_peak"]),
    );
    // The period table is the bill's own.
    expect(byPeriod.heading).toMatch(/usage by time of day$/);
  });

  it("counts the fall-back hour twice, because 1 am happens twice that night", async () => {
    // Sunday 1 November 2026 in Denver: 25 local hours, 1–2 am repeated.
    const segmentId = await billedSegment({ start: "2026-11-01", end: "2026-11-01", codes: ["mid_peak"] });
    // Local midnight is 06:00Z (MDT); the next local midnight is 07:00Z (MST).
    await intervals("2026-11-01T06:00:00Z", "2026-11-02T07:00:00Z");

    const { hourly } = (await get(`/portal/api/agreements/${agreementId}/billed-periods/${segmentId}/usage`)).json();

    expect(hourly.hours[1].byPeriod).toEqual({ mid_peak: 2 });
    expect(hourly.hours[0].byPeriod).toEqual({ mid_peak: 1 });
    expect(hourly.hours[2].byPeriod).toEqual({ mid_peak: 1 });
    const total = hourly.hours.reduce(
      (s: number, h: { byPeriod: Record<string, number> }) => s + Object.values(h.byPeriod).reduce((a, b) => a + b, 0),
      0,
    );
    expect(total).toBe(25);
  });

  it("says a register meter has no hourly data rather than inventing it", async () => {
    // No intervals at all: the meter reports totals per period, not when they were used.
    const segmentId = await billedSegment({ start: "2026-07-01", end: "2026-07-02", codes: ["peak", "off_peak"] });

    const body = (await get(`/portal/api/agreements/${agreementId}/billed-periods/${segmentId}/usage`)).json();

    expect(body.hourly).toBeNull();
    expect(body.byPeriod).not.toBeNull();
  });
});
