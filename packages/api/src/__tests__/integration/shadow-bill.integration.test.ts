import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import type { FastifyInstance } from "fastify";
import {
  bootPostgres,
  resetDb,
  makeTenantFixture,
  TENANT_A,
  ACTOR,
  type TenantFixture,
  ensurePrincipal,
  seedAsPlatform,
  endAdminPool,
} from "./_effective-dating-fixtures.js";

/**
 * The staff shadow bill (spec 26, TOU-BIL-4), over HTTP:
 *
 *   GET /api/v1/bill-segments/:id/shadow/options
 *   GET /api/v1/bill-segments/:id/shadow?with=<schedule code>
 *
 * Staff pick the rate to compare with. A real bill is rated through the
 * segment route, then asked what the picked rate would have charged.
 * Pinned: the figure; the version in force for the period, published
 * only; that the picked rate replaces every non-rider schedule and riders
 * carry over; that nothing is written; TOU usage from a meter's registers
 * or classified intervals; and the refusals.
 *
 * Prices are chosen so the arithmetic is checkable by eye:
 *   TOU      $10 + peak × 0.30 + off-peak × 0.08
 *   STD v1   $10 + total × 0.12        (Jan–Aug)
 *   STD v2   $10 + total × 0.50        (from Sep)
 *   STD v3   unpublished, 9.99 — never used
 *   RIDER    $1 a bill, kept whatever the rate
 *
 * The calendar is one season all year on UTC: weekdays 17:00–20:00 peak,
 * everything else off-peak.
 */

let pgContainer: StartedPostgreSqlContainer;
let prismaImports: typeof import("../../lib/prisma.js");
let app: FastifyInstance;

let fix: TenantFixture;
let saId: string;
let touId: string;
let stdV1Id: string;
let riderId: string;
let calendarId: string;

const asPlatform = <T>(fn: () => Promise<T>): Promise<T> => seedAsPlatform(async () => await fn());

function makeToken() {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({ sub: ACTOR, utility_id: TENANT_A, email: "tester@example.com", name: "Tester", role: "admin" }),
  ).toString("base64url");
  return `${header}.${payload}.fake-signature`;
}
const headers = () => ({ authorization: `Bearer ${makeToken()}` });

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

type Comp = { kind: string; label: string; qs: object; rate: number };
const SERVICE: Comp = { kind: "service_charge", label: "Customer charge", qs: { base: "fixed" }, rate: 10 };
const energy = (rate: number): Comp => ({ kind: "consumption", label: "Energy", qs: { base: "metered" }, rate });
const touEnergy = (code: string, rate: number): Comp => ({
  kind: "consumption",
  label: `${code} energy`,
  qs: { base: "tou_period", peak_code: code },
  rate,
});

async function schedule(opts: {
  code: string;
  version: number;
  effective: string;
  published: boolean;
  tou?: boolean;
  components: Comp[];
}) {
  const { prisma } = prismaImports;
  const s = await prisma.rateSchedule.create({
    data: {
      utilityId: fix.utilityId,
      name: opts.code,
      code: opts.code,
      commodityId: fix.commodityId,
      effectiveDate: new Date(opts.effective),
      version: opts.version,
      publishedAt: opts.published ? new Date() : null,
      touCalendarId: opts.tou ? calendarId : null,
    },
  });
  for (const [i, c] of opts.components.entries()) {
    await prisma.rateComponent.create({
      data: {
        utilityId: fix.utilityId,
        rateScheduleId: s.id,
        kindCode: c.kind,
        label: c.label,
        sortOrder: (i + 1) * 10,
        effectiveDate: new Date(opts.effective),
        predicate: {},
        quantitySource: c.qs,
        pricing: { type: "flat", rate: c.rate },
      },
    });
  }
  return s.id;
}

/** Put the agreement on these schedules, replacing whatever it had. */
function assign(...pairs: Array<[string, string]>) {
  return asPlatform(async () => {
    const { prisma } = prismaImports;
    await prisma.sAScheduleAssignment.deleteMany({ where: { serviceAgreementId: saId } });
    for (const [rateScheduleId, roleCode] of pairs) {
      await prisma.sAScheduleAssignment.create({
        data: { utilityId: fix.utilityId, serviceAgreementId: saId, rateScheduleId, roleCode, effectiveDate: new Date("2026-01-01") },
      });
    }
  });
}

/** A period's usage: the meter's total read, and its two TOU buckets. */
function month(endIso: string, total: number, peak: number, offPeak: number) {
  return asPlatform(async () => {
    const base = {
      utilityId: fix.utilityId,
      meterId: fix.meterId,
      serviceAgreementId: saId,
      uomId: fix.uomId,
      readDate: new Date(endIso),
      readDatetime: new Date(`${endIso}T23:00:00Z`),
      readType: "ACTUAL" as const,
      readSource: "AMI" as const,
    };
    await prismaImports.prisma.meterRead.createMany({
      data: [
        { ...base, reading: total, priorReading: 0, consumption: total },
        { ...base, reading: null, priorReading: null, consumption: peak, peakCode: "peak" },
        { ...base, reading: null, priorReading: null, consumption: offPeak, peakCode: "off_peak" },
      ],
    });
  });
}

/** One day's total read, as a standard meter reports it. */
const totalRead = (kwh: number) =>
  asPlatform(() =>
    prismaImports.prisma.meterRead.create({
      data: {
        utilityId: fix.utilityId,
        meterId: fix.meterId,
        serviceAgreementId: saId,
        uomId: fix.uomId,
        readDate: new Date("2026-07-01"),
        readDatetime: new Date("2026-07-01T23:00:00Z"),
        reading: kwh,
        priorReading: 0,
        consumption: kwh,
        readType: "ACTUAL",
        readSource: "AMI",
      },
    }),
  );

/** Hourly intervals at 1 kWh from one UTC instant to another, skipping any hour listed. */
const hourly = (from: string, to: string, skip: number[] = []) =>
  asPlatform(async () => {
    const rows = [];
    for (let t = Date.parse(from); t < Date.parse(to); t += 3_600_000) {
      if (skip.includes(new Date(t).getUTCHours())) continue;
      rows.push({
        utilityId: fix.utilityId,
        meterId: fix.meterId,
        uomId: fix.uomId,
        intervalStart: new Date(t),
        lengthMinutes: 60,
        quantity: "1.000000",
        quality: "actual",
      });
    }
    await prismaImports.prisma.meterReadInterval.createMany({ data: rows });
  });

beforeEach(() =>
  asPlatform(async () => {
    const { prisma } = prismaImports;
    await resetDb();
    fix = await makeTenantFixture(prisma, TENANT_A);
    await ensurePrincipal(prisma, TENANT_A);
    for (const moduleKey of ["agreements", "rate_schedules"]) {
      await prisma.utilityModule.create({ data: { utilityId: fix.utilityId, moduleKey } });
    }
    await (await import("../../services/rbac.service.js")).invalidateTenantModulesCache(fix.utilityId);

    const seasonSet = await prisma.seasonSet.create({
      data: { utilityId: fix.utilityId, name: "Seasons", effectiveDate: new Date("2026-01-01"), publishedAt: new Date() },
    });
    await prisma.season.create({
      data: {
        utilityId: fix.utilityId,
        seasonSetId: seasonSet.id,
        seasonCode: "all",
        label: "All year",
        startMonth: 1,
        startDay: 1,
        endMonth: 12,
        endDay: 31,
        sortOrder: 0,
      },
    });
    calendarId = (
      await prisma.touCalendar.create({
        data: {
          utilityId: fix.utilityId,
          name: "Residential TOU",
          effectiveDate: new Date("2026-01-01"),
          publishedAt: new Date(),
          seasonSetId: seasonSet.id,
          timeZone: "UTC",
          clockBasis: "prevailing",
        },
      })
    ).id;
    const dayTypes: Record<string, string> = {};
    for (const [code, weekdays] of [["weekday", [1, 2, 3, 4, 5]], ["weekend", [6, 7]]] as const) {
      const dt = await prisma.touDayType.create({
        data: { utilityId: fix.utilityId, touCalendarId: calendarId, dayTypeCode: code, label: code },
      });
      dayTypes[code] = dt.id;
      await prisma.touDayTypeWeekday.createMany({
        data: weekdays.map((isoWeekday) => ({ utilityId: fix.utilityId, touCalendarId: calendarId, touDayTypeId: dt.id, isoWeekday })),
      });
    }
    await prisma.touSlot.createMany({
      data: [
        { dayType: "weekday", peakCode: "off_peak", start: 0, end: 1020 },
        { dayType: "weekday", peakCode: "peak", start: 1020, end: 1200 },
        { dayType: "weekday", peakCode: "off_peak", start: 1200, end: 1440 },
        { dayType: "weekend", peakCode: "off_peak", start: 0, end: 1440 },
      ].map((s) => ({
        utilityId: fix.utilityId,
        touCalendarId: calendarId,
        seasonCode: "all",
        touDayTypeId: dayTypes[s.dayType]!,
        peakCode: s.peakCode,
        startMinute: s.start,
        endMinute: s.end,
      })),
    });

    touId = await schedule({
      code: "RES-TOU",
      version: 1,
      effective: "2026-01-01",
      published: true,
      tou: true,
      components: [SERVICE, touEnergy("peak", 0.3), touEnergy("off_peak", 0.08)],
    });
    stdV1Id = await schedule({ code: "RES-STD", version: 1, effective: "2026-01-01", published: true, components: [SERVICE, energy(0.12)] });
    await schedule({ code: "RES-STD", version: 2, effective: "2026-09-01", published: true, components: [SERVICE, energy(0.5)] });
    await schedule({ code: "RES-STD", version: 3, effective: "2026-06-01", published: false, components: [SERVICE, energy(9.99)] });
    await schedule({
      code: "SUPPLY",
      version: 1,
      effective: "2026-01-01",
      published: true,
      components: [{ kind: "service_charge", label: "Supply charge", qs: { base: "fixed" }, rate: 5 }],
    });
    riderId = await schedule({
      code: "RIDER",
      version: 1,
      effective: "2026-01-01",
      published: true,
      components: [{ kind: "service_charge", label: "Public benefits", qs: { base: "fixed" }, rate: 1 }],
    });

    const sa = await prisma.serviceAgreement.create({
      data: {
        utilityId: fix.utilityId,
        agreementNumber: "SA-SHADOW",
        accountId: fix.accountId,
        commodityId: fix.commodityId,
        startDate: new Date("2026-01-01"),
        status: "ACTIVE",
      },
    });
    saId = sa.id;
    const sp = await prisma.servicePoint.create({
      data: { utilityId: fix.utilityId, serviceAgreementId: saId, premiseId: fix.premiseId, startDate: new Date("2026-01-01") },
    });
    await prisma.servicePointMeter.create({
      data: { utilityId: fix.utilityId, servicePointId: sp.id, meterId: fix.meterId, addedDate: new Date("2026-01-01") },
    });
  }),
);

async function bill(start: string, end: string) {
  const res = await app.inject({
    method: "POST",
    url: `/api/v1/service-agreements/${saId}/bill-segments`,
    headers: headers(),
    payload: { periodStart: start, periodEnd: end },
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as { id: string; total: string };
}
const shadow = (segmentId: string, code: string) =>
  app.inject({ method: "GET", url: `/api/v1/bill-segments/${segmentId}/shadow?with=${code}`, headers: headers() });
const codeOf = (res: { json: () => { code?: string; error?: { code?: string } } }) =>
  res.json().error?.code ?? res.json().code;

const counts = () =>
  asPlatform(async () => {
    const { prisma } = prismaImports;
    return {
      segments: await prisma.billSegment.count(),
      lines: await prisma.billSegmentLine.count(),
      audit: await prisma.auditLog.count(),
      reads: await prisma.meterRead.count(),
    };
  });

describe("a TOU customer, compared with the standard rate", () => {
  beforeEach(() => assign([touId, "primary"]));

  it("offers the rates not on the bill, and prices the period on the one picked, writing nothing", async () => {
    await month("2026-07-31", 1000, 200, 800);
    const seg = await bill("2026-07-01", "2026-07-31");
    expect(Number(seg.total)).toBe(134);

    // RIDER is someone else's rider, so the tenant knows it is levied, not chosen.
    await asPlatform(async () => {
      const { prisma } = prismaImports;
      const other = await prisma.serviceAgreement.create({
        data: {
          utilityId: fix.utilityId,
          agreementNumber: "SA-OTHER",
          accountId: fix.accountId,
          commodityId: fix.commodityId,
          startDate: new Date("2026-01-01"),
          status: "ACTIVE",
        },
      });
      await prisma.sAScheduleAssignment.create({
        data: { utilityId: fix.utilityId, serviceAgreementId: other.id, rateScheduleId: riderId, roleCode: "rider", effectiveDate: new Date("2026-01-01") },
      });
    });

    const options = await app.inject({ method: "GET", url: `/api/v1/bill-segments/${seg.id}/shadow/options`, headers: headers() });
    expect(options.statusCode, options.body).toBe(200);
    expect(options.json().data.map((o: { code: string }) => o.code)).toEqual(["RES-STD", "SUPPLY"]);

    const before = await counts();
    const res = await shadow(seg.id, "RES-STD");

    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    expect(Number(body.actual.total)).toBe(134);
    expect(Number(body.shadow.total)).toBe(130);
    expect(body.difference).toBe("-4.0000");
    expect(body.replaced).toEqual(["RES-TOU"]);
    expect(body.kept).toEqual([]);
    expect(body.shadow.schedules).toEqual([{ code: "RES-STD", name: "RES-STD", version: 1 }]);
    expect(body.touUsageFrom).toBeNull();
    expect(await counts()).toEqual(before);
  });

  it("compares with delivery and supply together, the way a standard bill is made", async () => {
    await month("2026-07-31", 1000, 200, 800);
    const seg = await bill("2026-07-01", "2026-07-31");

    const res = await shadow(seg.id, "RES-STD,SUPPLY");

    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    expect(Number(body.shadow.total)).toBe(135); // $130 + $5 supply
    expect(body.shadow.schedules.map((s: { code: string }) => s.code)).toEqual(["RES-STD", "SUPPLY"]);
    expect(body.replaced).toEqual(["RES-TOU"]);
  });

  it("rates on the version in force for the period, never an unpublished one", async () => {
    await month("2026-09-30", 1000, 200, 800);
    const seg = await bill("2026-09-01", "2026-09-30");

    const body = (await shadow(seg.id, "RES-STD")).json();

    expect(body.shadow.schedules).toEqual([{ code: "RES-STD", name: "RES-STD", version: 2 }]);
    expect(Number(body.shadow.total)).toBe(510);
  });

  it("refuses a rate none of whose charges apply to the agreement, rather than calling $0 cheaper", async () => {
    // A rate for another service class: its one charge's condition never matches.
    await asPlatform(async () => {
      const id = await schedule({ code: "COM-STD", version: 1, effective: "2026-01-01", published: true, components: [] });
      await prismaImports.prisma.rateComponent.create({
        data: {
          utilityId: fix.utilityId,
          rateScheduleId: id,
          kindCode: "service_charge",
          label: "Commercial charge",
          sortOrder: 10,
          effectiveDate: new Date("2026-01-01"),
          predicate: { class: "commercial" },
          quantitySource: { base: "fixed" },
          pricing: { type: "flat", rate: 50 },
        },
      });
    });
    await month("2026-07-31", 1000, 200, 800);
    const seg = await bill("2026-07-01", "2026-07-31");

    const res = await shadow(seg.id, "COM-STD");

    expect(res.statusCode).toBe(409);
    expect(codeOf(res)).toBe("COMPARISON_NOT_APPLICABLE");
    expect(res.json().error?.message ?? res.json().message).toMatch(/COM-STD/);
  });

  it("refuses a rate that does not exist, and one already on the bill", async () => {
    await month("2026-07-31", 1000, 200, 800);
    const seg = await bill("2026-07-01", "2026-07-31");

    const unknown = await shadow(seg.id, "NOPE");
    expect(unknown.statusCode).toBe(400);
    expect(codeOf(unknown)).toBe("COMPARISON_SCHEDULE_INVALID");
    expect(codeOf(await shadow(seg.id, "RES-TOU"))).toBe("COMPARISON_SCHEDULE_INVALID");
  });
});

/*
 * A standard customer considering TOU, with a rider on the bill. The TOU
 * rate replaces the standard delivery schedule; the rider carries over.
 *
 * One weekday, Wednesday 1 July 2026, hourly at 1 kWh an hour:
 *   actual   STD $10 + 24 × 0.12 = $12.88, + RIDER $1     = $13.88
 *   shadow   TOU $10 + 3 × 0.30 + 21 × 0.08 = $12.58, + $1 = $13.58
 */
describe("a standard customer, compared with TOU", () => {
  beforeEach(() => assign([stdV1Id, "delivery"], [riderId, "rider"]));

  it("works TOU usage out from the meter's intervals, keeps the rider, and writes nothing", async () => {
    await totalRead(24);
    await hourly("2026-07-01T00:00:00Z", "2026-07-02T00:00:00Z");
    const seg = await bill("2026-07-01", "2026-07-01");
    expect(Number(seg.total)).toBe(13.88);
    const before = await counts();

    const res = await shadow(seg.id, "RES-TOU");

    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    expect(Number(body.shadow.total)).toBe(13.58);
    expect(body.difference).toBe("-0.3000");
    expect(body.replaced).toEqual(["RES-STD"]);
    expect(body.kept).toEqual(["RIDER"]);
    expect(body.touUsageFrom).toBe("intervals");
    const peak = body.shadow.lines.find((l: { label: string }) => l.label === "peak energy");
    expect(Number(peak.quantity)).toBe(3);
    expect(body.shadow.lines.map((l: { label: string }) => l.label)).toContain("Public benefits");
    // No segment, line, audit row — and no bucket reads left behind.
    expect(await counts()).toEqual(before);
  });

  it("uses the meter's own TOU registers where it has them", async () => {
    await month("2026-07-31", 1000, 200, 800);
    const seg = await bill("2026-07-01", "2026-07-31");

    const body = (await shadow(seg.id, "RES-TOU")).json();

    expect(body.touUsageFrom).toBe("registers");
    expect(Number(body.actual.total)).toBe(131);
    expect(Number(body.shadow.total)).toBe(135);
  });

  it("refuses a meter that records totals only", async () => {
    await totalRead(24);
    const seg = await bill("2026-07-01", "2026-07-01");

    const res = await shadow(seg.id, "RES-TOU");

    expect(res.statusCode).toBe(409);
    expect(codeOf(res)).toBe("SHADOW_NEEDS_INTERVALS");
  });

  it("refuses intervals with a gap rather than pricing a short day", async () => {
    await totalRead(24);
    await hourly("2026-07-01T00:00:00Z", "2026-07-02T00:00:00Z", [18]);
    const seg = await bill("2026-07-01", "2026-07-01");

    const res = await shadow(seg.id, "RES-TOU");

    expect(res.statusCode).toBe(409);
    expect(codeOf(res)).toBe("SHADOW_INTERVALS_INCOMPLETE");
  });
});
