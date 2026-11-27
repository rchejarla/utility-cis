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
 * The staff shadow bill (spec 26, TOU-BIL-4, slice 3a), over HTTP:
 *
 *   PUT /api/v1/rate-schedules/:id/comparison-schedule
 *   GET /api/v1/bill-segments/:id/shadow
 *
 * A real TOU bill is rated through the segment route, then asked what the
 * standard rate would have charged. Pinned: the figure; that the standard
 * version is the one **in force for the period**, published only; that
 * nothing is written; and the refusals — no comparison, and the
 * standard → TOU direction, which needs interval classification (3b).
 *
 * Prices are chosen so the arithmetic is checkable by eye:
 *   TOU      $10 + 200 kWh × 0.30 + 800 kWh × 0.08 = $134
 *   STD v1   $10 + 1000 kWh × 0.12                  = $130   (Jan–Aug)
 *   STD v2   $10 + 1000 kWh × 0.50                  = $510   (from Sep)
 *   STD v3   unpublished, 9.99 — never used
 */

let pgContainer: StartedPostgreSqlContainer;
let prismaImports: typeof import("../../lib/prisma.js");
let app: FastifyInstance;

let fix: TenantFixture;
let saId: string;
let touId: string;
let stdV1Id: string;
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
  comparison?: string;
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
      comparisonScheduleCode: opts.comparison ?? null,
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

/** A month of usage: the meter's total read, and its two TOU buckets. */
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

beforeEach(() =>
  asPlatform(async () => {
    const { prisma } = prismaImports;
    await resetDb();
    fix = await makeTenantFixture(prisma, TENANT_A);
    await ensurePrincipal(prisma, TENANT_A);
    for (const moduleKey of ["agreements", "rate_schedules", "billing"]) {
      await prisma.utilityModule.create({ data: { utilityId: fix.utilityId, moduleKey } });
    }
    await (await import("../../services/rbac.service.js")).invalidateTenantModulesCache(fix.utilityId);

    /*
     * One season all year, on UTC so the arithmetic needs no offsets:
     * weekdays 17:00–20:00 peak, everything else off-peak. The 3a tests
     * price from bucket reads and never consult the hours; 3b classifies
     * intervals against them.
     */
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
      comparison: "RES-STD",
      components: [SERVICE, touEnergy("peak", 0.3), touEnergy("off_peak", 0.08)],
    });
    stdV1Id = await schedule({ code: "RES-STD", version: 1, effective: "2026-01-01", published: true, components: [SERVICE, energy(0.12)] });
    await schedule({ code: "RES-STD", version: 2, effective: "2026-09-01", published: true, components: [SERVICE, energy(0.5)] });
    await schedule({ code: "RES-STD", version: 3, effective: "2026-06-01", published: false, components: [SERVICE, energy(9.99)] });

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
    await prisma.sAScheduleAssignment.create({
      data: {
        utilityId: fix.utilityId,
        serviceAgreementId: saId,
        rateScheduleId: touId,
        roleCode: "primary",
        effectiveDate: new Date("2026-01-01"),
      },
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
const shadow = (segmentId: string) =>
  app.inject({ method: "GET", url: `/api/v1/bill-segments/${segmentId}/shadow`, headers: headers() });

const counts = () =>
  asPlatform(async () => {
    const { prisma } = prismaImports;
    return {
      segments: await prisma.billSegment.count(),
      lines: await prisma.billSegmentLine.count(),
      audit: await prisma.auditLog.count(),
    };
  });

describe("GET /api/v1/bill-segments/:id/shadow", () => {
  it("says what the standard rate would have charged for a TOU bill, and writes nothing", async () => {
    await month("2026-07-31", 1000, 200, 800);
    const seg = await bill("2026-07-01", "2026-07-31");
    expect(Number(seg.total)).toBe(134);
    const before = await counts();

    const res = await shadow(seg.id);

    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    expect(Number(body.actual.total)).toBe(134);
    expect(Number(body.shadow.total)).toBe(130);
    expect(body.difference).toBe("-4.0000");
    expect(body.actual.schedules).toEqual([{ code: "RES-TOU", name: "RES-TOU", version: 1 }]);
    expect(body.shadow.schedules).toEqual([{ code: "RES-STD", name: "RES-STD", version: 1 }]);
    expect(body.shadow.lines.map((l: { label: string }) => l.label)).toEqual(["Customer charge", "Energy"]);
    expect(await counts()).toEqual(before);
  });

  it("rates on the standard version in force for the period, never an unpublished one", async () => {
    await month("2026-09-30", 1000, 200, 800);
    const seg = await bill("2026-09-01", "2026-09-30");

    const body = (await shadow(seg.id)).json();

    expect(body.shadow.schedules).toEqual([{ code: "RES-STD", name: "RES-STD", version: 2 }]);
    expect(Number(body.shadow.total)).toBe(510);
  });

  it("tells the bill dialog which segments can be compared", async () => {
    await month("2026-07-31", 1000, 200, 800);
    const seg = await bill("2026-07-01", "2026-07-31");
    const billId = await asPlatform(async () => {
      const { prisma } = prismaImports;
      const b = await prisma.bill.create({
        data: {
          utilityId: fix.utilityId,
          accountId: fix.accountId,
          billingCycleId: fix.billingCycleId,
          periodStart: new Date("2026-07-01"),
          periodEnd: new Date("2026-07-31"),
          billDate: new Date("2026-07-31"),
          dueDate: new Date("2026-08-20"),
          subtotal: seg.total,
          taxes: "0",
          credits: "0",
          total: seg.total,
          billNumber: "B-SHADOW-1",
        },
      });
      await prisma.billSegment.update({ where: { id: seg.id }, data: { billId: b.id } });
      return b.id;
    });

    const res = await app.inject({ method: "GET", url: `/api/v1/bills/${billId}`, headers: headers() });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().segments[0].comparesWith).toBe("RES-STD");

    await asPlatform(() =>
      prismaImports.prisma.rateSchedule.update({ where: { id: touId }, data: { comparisonScheduleCode: null } }),
    );
    const after = await app.inject({ method: "GET", url: `/api/v1/bills/${billId}`, headers: headers() });
    expect(after.json().segments[0].comparesWith).toBeNull();
  });

  it("refuses when the tariff names no comparison schedule", async () => {
    await month("2026-07-31", 1000, 200, 800);
    const seg = await bill("2026-07-01", "2026-07-31");
    await asPlatform(() =>
      prismaImports.prisma.rateSchedule.update({ where: { id: touId }, data: { comparisonScheduleCode: null } }),
    );

    const res = await shadow(seg.id);

    expect(res.statusCode).toBe(409);
    expect(res.json().error?.code ?? res.json().code).toBe("NO_COMPARISON_SCHEDULE");
  });

});

/*
 * Standard → TOU, "considering TOU" (slice 3b). The customer is on the
 * standard rate; what would the TOU tariff have charged?
 *
 * One weekday, Wednesday 1 July 2026, hourly at 1 kWh an hour:
 *   STD v1   $10 + 24 kWh × 0.12                        = $12.88
 *   TOU      $10 + 3 kWh peak × 0.30 + 21 off × 0.08    = $12.58
 */
describe("standard → TOU", () => {
  beforeEach(() =>
    asPlatform(async () => {
      const { prisma } = prismaImports;
      await prisma.rateSchedule.update({ where: { id: touId }, data: { comparisonScheduleCode: null } });
      await prisma.rateSchedule.update({ where: { id: stdV1Id }, data: { comparisonScheduleCode: "RES-TOU" } });
      await prisma.sAScheduleAssignment.updateMany({ where: { serviceAgreementId: saId }, data: { rateScheduleId: stdV1Id } });
    }),
  );

  /** The day's total read, as a standard meter reports it. */
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

  /** Hourly intervals at 1 kWh, from one UTC instant to another, skipping any hour listed. */
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

  it("prices an interval meter on the TOU tariff from its own intervals, and writes nothing", async () => {
    await totalRead(24);
    await hourly("2026-07-01T00:00:00Z", "2026-07-02T00:00:00Z");
    const seg = await bill("2026-07-01", "2026-07-01");
    expect(Number(seg.total)).toBe(12.88);
    const before = await counts();
    const readsBefore = await asPlatform(() => prismaImports.prisma.meterRead.count());

    const res = await shadow(seg.id);

    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    expect(body.shadow.schedules).toEqual([{ code: "RES-TOU", name: "RES-TOU", version: 1 }]);
    expect(Number(body.shadow.total)).toBe(12.58);
    expect(body.difference).toBe("-0.3000");
    expect(body.touUsageFrom).toBe("intervals");
    const peak = body.shadow.lines.find((l: { label: string }) => l.label === "peak energy");
    expect(Number(peak.quantity)).toBe(3);
    // No segment, line or audit row — and no bucket reads left behind.
    expect(await counts()).toEqual(before);
    expect(await asPlatform(() => prismaImports.prisma.meterRead.count())).toBe(readsBefore);
  });

  it("uses a meter's own TOU registers where it has them", async () => {
    await month("2026-07-31", 1000, 200, 800);
    const seg = await bill("2026-07-01", "2026-07-31");

    const body = (await shadow(seg.id)).json();

    expect(body.touUsageFrom).toBe("registers");
    expect(Number(body.shadow.total)).toBe(134); // The 3a figure, from the same buckets.
  });

  it("refuses a meter that records totals only", async () => {
    await totalRead(24);
    const seg = await bill("2026-07-01", "2026-07-01");

    const res = await shadow(seg.id);

    expect(res.statusCode).toBe(409);
    expect(res.json().error?.code ?? res.json().code).toBe("SHADOW_NEEDS_INTERVALS");
  });

  it("refuses intervals with a gap rather than pricing a short day", async () => {
    await totalRead(24);
    await hourly("2026-07-01T00:00:00Z", "2026-07-02T00:00:00Z", [18]);
    const seg = await bill("2026-07-01", "2026-07-01");

    const res = await shadow(seg.id);

    expect(res.statusCode).toBe(409);
    expect(res.json().error?.code ?? res.json().code).toBe("SHADOW_INTERVALS_INCOMPLETE");
  });
});

describe("PUT /api/v1/rate-schedules/:id/comparison-schedule", () => {
  const put = (id: string, comparisonScheduleCode: string | null) =>
    app.inject({
      method: "PUT",
      url: `/api/v1/rate-schedules/${id}/comparison-schedule`,
      headers: headers(),
      payload: { comparisonScheduleCode },
    });
  const codeOf = (res: { json: () => { code?: string; error?: { code?: string } } }) =>
    res.json().error?.code ?? res.json().code;

  it("sets it on a draft, and only to a published-or-not schedule of the opposite kind", async () => {
    const draft = await asPlatform(() =>
      schedule({ code: "RES-TOU", version: 2, effective: "2026-10-01", published: false, tou: true, components: [] }),
    );
    await asPlatform(() =>
      schedule({ code: "COM-TOU", version: 1, effective: "2026-01-01", published: true, tou: true, components: [] }),
    );

    const ok = await put(draft, "RES-STD");
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().comparisonScheduleCode).toBe("RES-STD");

    const sameKind = await put(draft, "COM-TOU");
    expect(sameKind.statusCode).toBe(400);
    expect(codeOf(sameKind)).toBe("COMPARISON_SCHEDULE_INVALID");
    expect(codeOf(await put(draft, "NOPE"))).toBe("COMPARISON_SCHEDULE_INVALID");
    expect(codeOf(await put(draft, "RES-TOU"))).toBe("COMPARISON_SCHEDULE_INVALID");

    expect((await put(draft, null)).json().comparisonScheduleCode).toBeNull();
  });

  it("will not change a published schedule", async () => {
    const res = await put(touId, null);

    expect(res.statusCode).toBe(409);
    expect(codeOf(res)).toBe("SCHEDULE_NOT_EDITABLE");
  });

  it("is carried forward by a revision", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/rate-schedules/${touId}/revise`,
      headers: headers(),
      payload: { effectiveDate: "2026-10-01" },
    });

    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().comparisonScheduleCode).toBe("RES-STD");
  });
});
