import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { bootPostgres, ensurePrincipal } from "./_effective-dating-fixtures.js";

/**
 * Slice 5b.2 — POST /api/v1/accounts/:id/bills aggregates the Account's
 * unbilled BillSegments into a single per-Account Bill.
 *
 * The Bozeman SFR water Account has one SA + segment seeded by Slice
 * 5a; the golden case picks that up at $69.65. Edge cases cover
 * multi-SA aggregation, period auto-derivation, and the three error
 * paths (NO_SEGMENTS_TO_BILL, BILL_ALREADY_EXISTS_FOR_PERIOD,
 * partial-period account).
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SHARED_DIR = path.resolve(__dirname, "../../../../shared");
const REPO_ROOT = path.resolve(__dirname, "../../../../..");

let pgContainer: StartedPostgreSqlContainer;
let prismaImports: typeof import("../../lib/prisma.js");
let appImports: typeof import("../../app.js");
let app: FastifyInstance;

let utilityId: string;
let accountId: string;
let saId: string;
let saMeterId: string;

const ACTOR_ID = "00000000-0000-4000-8000-aaaa00000001";

function makeToken(uid: string) {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      sub: ACTOR_ID,
      utility_id: uid,
      email: "tester@example.com",
      name: "Tester",
      role: "admin",
    }),
  ).toString("base64url");
  return `${header}.${payload}.fake-signature`;
}
const headers = () => ({ authorization: `Bearer ${makeToken(utilityId)}` });

async function seedBozemanSegment(): Promise<{ subtotal: string; total: string }> {
  // Generate a segment for the Bozeman SFR water SA via the rate engine,
  // period aligned to the billDay=15 cycle so the auto-derived bill
  // period for asOfDate 2026-05-15 picks it up. The exact dollar amount
  // is what the engine produces for whatever reads exist on the meter
  // — the Bill tests assert that the Bill *aggregates* segments correctly,
  // not that the rate engine itself is correct (Slice 5a tests own that).
  const periodStart = "2026-04-16";
  const periodEnd = "2026-05-15";
  const res = await app.inject({
    method: "POST",
    url: `/api/v1/service-agreements/${saId}/bill-segments`,
    headers: headers(),
    payload: { periodStart, periodEnd },
  });
  if (res.statusCode !== 201) {
    throw new Error(`segment seed failed: ${res.statusCode} ${res.body}`);
  }
  const body = JSON.parse(res.body);
  return { subtotal: body.subtotal, total: body.total };
}

beforeAll(async () => {
  const booted = await bootPostgres();
  pgContainer = booted.container;

  const TSX_BIN =
    process.platform === "win32"
      ? path.join(REPO_ROOT, "node_modules", ".pnpm", "node_modules", ".bin", "tsx.cmd")
      : path.join(REPO_ROOT, "node_modules", ".pnpm", "node_modules", ".bin", "tsx");
  execSync(`"${TSX_BIN}" prisma/seed.ts`, {
    cwd: SHARED_DIR,
    env: { ...process.env, DATABASE_URL: booted.dbUrl },
    stdio: "pipe",
  });

  prismaImports = await import("../../lib/prisma.js");
  appImports = await import("../../app.js");
  app = await appImports.buildApp();
  await app.ready();

  // Pick the Bozeman SFR water SA + its account (same fixture as 5a).
  const { prisma } = prismaImports;
  const sched = await prisma.rateSchedule.findFirstOrThrow({ where: { code: "BZN-WATER" } });
  const assignment = await prisma.sAScheduleAssignment.findFirstOrThrow({
    where: {
      rateScheduleId: sched.id,
      roleCode: "primary",
      serviceAgreement: { rateServiceClass: { code: "single_family" } },
    },
    include: {
      serviceAgreement: {
        include: {
          servicePoints: {
            where: { endDate: null },
            include: { meters: { include: { meter: true } } },
            take: 1,
          },
        },
      },
    },
  });
  saId = assignment.serviceAgreementId;
  utilityId = assignment.serviceAgreement.utilityId;
  await ensurePrincipal(prismaImports.prisma, utilityId);
  accountId = assignment.serviceAgreement.accountId;
  saMeterId = assignment.serviceAgreement.servicePoints[0]!.meters[0]!.meterId;

  // Enable agreements + accounts modules so the bill routes' permission
  // gates pass. The seed enables agreements; accounts may need it too.
  for (const moduleKey of ["agreements", "accounts"]) {
    const existing = await prisma.utilityModule.findFirst({
      where: { utilityId, moduleKey },
    });
    if (!existing) {
      await prisma.utilityModule.create({ data: { utilityId, moduleKey } });
    }
  }
  const rbac = await import("../../services/rbac.service.js");
  await rbac.invalidateTenantModulesCache(utilityId);

  // Seed meter size + a single 12 HCF read for May 2026 (mirrors 5a).
  await prisma.meter.update({
    where: { id: saMeterId },
    data: { customFields: { size: '5/8"' } as object },
  });
  const meter = await prisma.meter.findUniqueOrThrow({
    where: { id: saMeterId },
    select: { uomId: true },
  });
  await prisma.meterRead.create({
    data: {
      utilityId,
      meterId: saMeterId,
      serviceAgreementId: saId,
      uomId: meter.uomId,
      readDate: new Date(2026, 4, 14),
      readDatetime: new Date(2026, 4, 14, 12, 0, 0),
      reading: 100,
      priorReading: 88,
      consumption: 12,
      readType: "ACTUAL",
      readSource: "MANUAL",
    },
  });

  // Force the account onto a cycle whose billDayOfMonth=15 so the
  // computed period for asOfDate=2026-05-15 lands at [2026-04-16, 2026-05-15].
  await prisma.billingCycle.updateMany({
    where: { utilityId, id: { in: await prisma.billingCycle.findMany({ where: { utilityId }, select: { id: true } }).then((cs) => cs.map((c) => c.id)) } },
    data: { readDayOfMonth: 1, billDayOfMonth: 15 },
  });

  // Push account.createdAt back so the period-clamp doesn't fire by
  // default. The partial-period test will explicitly bump it forward.
  await prisma.$executeRawUnsafe(
    "UPDATE account SET created_at = '2025-01-01T00:00:00Z'::timestamptz WHERE id = $1::uuid",
    accountId,
  );
}, 600_000);

afterAll(async () => {
  await app?.close().catch(() => {});
  // `$disconnect` does not dispose a pool the application owns — that
  // is the driver-adapter contract — so the pools are ended here.
  // Without it the container stops while connections are live and
  // Postgres reports 57P01 as an unhandled error after a green run.
  await prismaImports?.prisma.$disconnect().catch(() => {});
  await prismaImports?.pool.end().catch(() => {});
  await pgContainer?.stop().catch(() => {});
});

beforeEach(async () => {
  const { prisma } = prismaImports;
  // Wipe Bills + reattach segments (set bill_id back to null) so each
  // case starts from "segments exist, no Bill yet".
  await prisma.$executeRawUnsafe("UPDATE bill_segment SET bill_id = NULL");
  // Generation now auto-posts, so each Bill has a ledger_entry FK-ing to it.
  await prisma.$executeRawUnsafe("DELETE FROM ledger_entry");
  await prisma.$executeRawUnsafe("DELETE FROM bill");
  // Wipe segments + their lines so each test re-seeds the golden segment fresh.
  await prisma.$executeRawUnsafe("DELETE FROM bill_segment_line");
  await prisma.$executeRawUnsafe("DELETE FROM bill_segment");
  // Reset MeterRead.billed_at so re-running segment generation works.
  await prisma.$executeRawUnsafe(
    "UPDATE meter_read SET billed_at = NULL WHERE service_agreement_id = $1::uuid",
    saId,
  );
  // Reset account.createdAt to the pre-test default so the partial-period
  // test's mutation doesn't bleed into other cases.
  await prisma.$executeRawUnsafe(
    "UPDATE account SET created_at = '2025-01-01T00:00:00Z'::timestamptz WHERE id = $1::uuid",
    accountId,
  );
  // Drop any synthetic SAs the multi-SA test created so they don't
  // contribute extra unbilled segments to subsequent tests.
  await prisma.$executeRawUnsafe(
    "DELETE FROM service_agreement WHERE account_id = $1::uuid AND agreement_number LIKE 'TEST-%'",
    accountId,
  );
});

describe("POST /api/v1/accounts/:id/bills — Bozeman SFR golden", () => {
  it("creates a Bill that aggregates the SA's segment", async () => {
    const seg = await seedBozemanSegment();

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/accounts/${accountId}/bills`,
      headers: headers(),
      payload: { asOfDate: "2026-05-15" },
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.subtotal).toBe(seg.subtotal);
    expect(body.total).toBe(seg.total);
    expect(body.segments.length).toBe(1);
    expect(body.segments[0].total).toBe(seg.total);

    // DB row exists and segment is linked.
    const { prisma } = prismaImports;
    const dbBill = await prisma.bill.findUniqueOrThrow({
      where: { id: body.id, utilityId },
      include: { segments: true },
    });
    expect(dbBill.segments.length).toBe(1);
    expect(dbBill.segments[0].billId).toBe(dbBill.id);
  }, 600_000);

  /*
   * The unit travels with the quantity all the way out.
   *
   * There are three near-identical BillSegmentLine row types — this
   * endpoint's, the segment service's, and the statement's — each with
   * its own mapper. Adding `unit` to two of them left the bill dialog
   * showing a bare 6.6279 for a gallons meter on an HCF tariff, which
   * is the number the column exists to explain.
   */
  /*
   * Billing one account by hand creates a bill for review, exactly as a
   * run does.
   *
   * It used to post immediately, per the tenant's `autoPostBills`, so
   * the same act moved money or did not depending on which screen it
   * was started from — and the screen with less context around it was
   * the one that charged the customer straight away. The dialog now
   * says it will not post; this is what makes that true.
   */
  it("does not post the bill it makes, the way a run does not", async () => {
    await seedBozemanSegment();

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/accounts/${accountId}/bills`,
      headers: headers(),
      payload: { asOfDate: "2026-05-15" },
    });

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.postedAt).toBeNull();
    // And nothing has moved: no receivable, no balance.
    const { prisma } = prismaImports;
    expect(await prisma.ledgerEntry.count({ where: { billId: body.id } })).toBe(0);
  }, 600_000);

  it("returns the unit each line's quantity is counted in", async () => {
    await seedBozemanSegment();

    const created = await app.inject({
      method: "POST",
      url: `/api/v1/accounts/${accountId}/bills`,
      headers: headers(),
      payload: { asOfDate: "2026-05-15" },
    });
    const billId = JSON.parse(created.body).id;

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/bills/${billId}`,
      headers: headers(),
    });

    expect(res.statusCode).toBe(200);
    const lines = JSON.parse(res.body).segments[0].lines as Array<Record<string, unknown>>;
    expect(lines.length).toBeGreaterThan(0);
    // Every line names its unit or says plainly that it has none;
    // `undefined` would mean the field never left the service.
    for (const line of lines) {
      expect(line).toHaveProperty("unit");
    }
    expect(lines.some((l) => l.unit === "HCF")).toBe(true);
  }, 600_000);

  /*
   * One shape for a bill line, not one per endpoint.
   *
   * `BillSegmentLineRow` was declared twice — here and in the segment
   * service — with two hand-written mappers, and the bill endpoint's
   * copy omitted the provenance fields. That is how `unit` reached the
   * database and the segment endpoint but not the bill dialog: a field
   * added to one list of nine and not the other. Spec 09 says a line
   * can be traced to the exact schedule version and component that
   * produced it; this is that claim, asserted where it is served.
   */
  it("traces each line to the schedule and component that produced it", async () => {
    await seedBozemanSegment();

    const created = await app.inject({
      method: "POST",
      url: `/api/v1/accounts/${accountId}/bills`,
      headers: headers(),
      payload: { asOfDate: "2026-05-15" },
    });
    const billId = JSON.parse(created.body).id;

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/bills/${billId}`,
      headers: headers(),
    });

    const lines = JSON.parse(res.body).segments[0].lines as Array<Record<string, unknown>>;
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line.sourceScheduleId).toEqual(expect.any(String));
      expect(line.sourceComponentId).toEqual(expect.any(String));
    }

    // And they name rows that exist, not ids carried for show.
    const { prisma } = prismaImports;
    const component = await prisma.rateComponent.findUnique({
      where: { id: lines[0]!.sourceComponentId as string },
    });
    expect(component).not.toBeNull();
  }, 600_000);

  it("multi-SA aggregation: Bill totals = sum of attached segments", async () => {
    // First, the real water segment from the engine.
    const waterSeg = await seedBozemanSegment();
    const waterTotal = parseFloat(waterSeg.total);

    // Add a synthetic second SA on the same account + a hand-rolled
    // segment of $30 so we can assert the Bill totals to 99.65.
    const { prisma } = prismaImports;
    const sewer = await prisma.commodity.findFirstOrThrow({
      where: { utilityId, code: "SEWER" },
    });
    const sewerClass = await prisma.rateServiceClass.findFirstOrThrow({
      where: { utilityId, commodityId: sewer.id, code: "residential" },
    });
    const sewerSched = await prisma.rateSchedule.findFirstOrThrow({
      where: { utilityId, commodityId: sewer.id, publishedAt: { not: null } },
      include: { components: { take: 1 } },
    });
    const synthSa = await prisma.serviceAgreement.create({
      data: {
        utilityId,
        agreementNumber: `TEST-MULTI-${Date.now()}`,
        accountId,
        commodityId: sewer.id,
        rateServiceClassId: sewerClass.id,
        startDate: new Date(2026, 0, 1),
        status: "ACTIVE",
      },
    });
    await prisma.billSegment.create({
      data: {
        utilityId,
        serviceAgreementId: synthSa.id,
        periodStart: new Date(2026, 3, 16),
        periodEnd: new Date(2026, 4, 15),
        subtotal: "30.0000",
        taxes: "0.0000",
        credits: "0.0000",
        total: "30.0000",
        minimumFloorApplied: false,
        segmentNumber: `SEG-TEST-MULTI-${Date.now()}`,
        lines: {
          create: [{
            utilityId,
            label: "Sewer base",
            kindCode: "service_charge",
            amount: "30.0000",
            sourceScheduleId: sewerSched.id,
            sourceComponentId: sewerSched.components[0]!.id,
            sortOrder: 100,
          }],
        },
      },
    });

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/accounts/${accountId}/bills`,
      headers: headers(),
      payload: { asOfDate: "2026-05-15" },
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(parseFloat(body.total).toFixed(2)).toBe((waterTotal + 30).toFixed(2));
    expect(body.segments.length).toBe(2);
  }, 600_000);

  it("auto-derives period from BillCycle.billDayOfMonth + frequency", async () => {
    await seedBozemanSegment();

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/accounts/${accountId}/bills`,
      headers: headers(),
      payload: { asOfDate: "2026-05-15" },
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    // billDayOfMonth=15 (forced in beforeAll) → period [Apr 16, May 15].
    expect(body.periodStart.slice(0, 10)).toBe("2026-04-16");
    expect(body.periodEnd.slice(0, 10)).toBe("2026-05-15");
    // Due is bill_date + 30 days.
    expect(body.dueDate.slice(0, 10)).toBe("2026-06-14");
  }, 600_000);

  it("returns 400 NO_SEGMENTS_TO_BILL when no unbilled segments exist", async () => {
    // No segments seeded for this case.
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/accounts/${accountId}/bills`,
      headers: headers(),
      payload: { asOfDate: "2026-05-15" },
    });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error?.code).toBe("NO_SEGMENTS_TO_BILL");
  });

  it("returns 409 BILL_ALREADY_EXISTS_FOR_PERIOD on a second generate", async () => {
    await seedBozemanSegment();

    const first = await app.inject({
      method: "POST",
      url: `/api/v1/accounts/${accountId}/bills`,
      headers: headers(),
      payload: { asOfDate: "2026-05-15" },
    });
    expect(first.statusCode).toBe(201);

    const second = await app.inject({
      method: "POST",
      url: `/api/v1/accounts/${accountId}/bills`,
      headers: headers(),
      payload: { asOfDate: "2026-05-15" },
    });
    expect(second.statusCode).toBe(409);
    const body = JSON.parse(second.body);
    expect(body.error?.code).toBe("BILL_ALREADY_EXISTS_FOR_PERIOD");
  }, 600_000);

  /**
   * A bill says what its segments cover, not what the cycle's calendar
   * says — even for an account created mid-period.
   *
   * This case used to assert the opposite: `computeBillPeriod` clamped
   * `periodStart` to `account.createdAt`, so a bill whose only segment
   * covered 2026-04-16 to 05-15 was issued claiming 05-08 to 05-15. It
   * charged thirty days and said eight. The clamp made the dates look
   * careful while the money disagreed with them, and a service period is
   * the one thing on a bill a customer checks against their own reading.
   *
   * The clamp still exists and still does its real job: deciding which
   * segments a window picks up. It no longer decides what the bill says
   * it is for. Not billing service from before it began is now the
   * segment's own rule — `resolveServicePeriod` starts at the service
   * agreement's start date — which is a better question than the account
   * row's creation timestamp anyway.
   */
  it("a mid-period account is billed for what its segments cover, not a clamped window", async () => {
    await seedBozemanSegment();

    // Mid-period for a billDay=15 cycle, which used to move the dates.
    const { prisma } = prismaImports;
    await prisma.$executeRawUnsafe(
      "UPDATE account SET created_at = $1::timestamptz WHERE id = $2::uuid",
      new Date("2026-05-08T00:00:00Z").toISOString(),
      accountId,
    );

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/accounts/${accountId}/bills`,
      headers: headers(),
      payload: { asOfDate: "2026-05-15" },
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.periodStart.slice(0, 10)).toBe("2026-04-16");
    expect(body.periodEnd.slice(0, 10)).toBe("2026-05-15");

    // The invariant that replaces the clamp: the bill's period is the
    // span of its own segments, so the two cannot state different things.
    const segments = await prisma.billSegment.findMany({
      where: { billId: body.id },
      select: { periodStart: true, periodEnd: true },
    });
    expect(segments.length).toBeGreaterThan(0);
    const earliest = segments
      .map((s) => s.periodStart.toISOString().slice(0, 10))
      .sort()[0];
    const latest = segments
      .map((s) => s.periodEnd.toISOString().slice(0, 10))
      .sort()
      .at(-1);
    expect(body.periodStart.slice(0, 10)).toBe(earliest);
    expect(body.periodEnd.slice(0, 10)).toBe(latest);
  }, 600_000);
});
