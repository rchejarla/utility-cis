import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import {
  bootPostgres,
  resetDb,
  makeTenantFixture,
  TENANT_A,
  type TenantFixture,
  seedAsPlatform,
  endAdminPool,
} from "./_effective-dating-fixtures.js";

/**
 * A service period is read to read.
 *
 * The code derived it from the cycle's `billDayOfMonth` alone, so a bill
 * said 2/1–2/28 over usage the meter recorded between 1/30 and 2/28.
 * With manual reading two accounts on one cycle are never read on the
 * same day, and a reader one day late left one calendar window with no
 * read — a zero-usage bill — and the next with two, billing both
 * intervals at once and pushing the customer up a tier they never
 * entered.
 *
 * These cases pin the rule that replaces it: the period ends on the
 * newest unbilled read and starts the day after the last billed one, so
 * consecutive periods abut exactly.
 */

let pgContainer: StartedPostgreSqlContainer;
let prismaImports: typeof import("../../lib/prisma.js");
let svc: typeof import("../../services/bill-segment.service.js");
let fix: TenantFixture;
let saId: string;

beforeAll(async () => {
  const booted = await bootPostgres({ utilities: [TENANT_A] });
  // RLS-OPT-OUT: this suite still connects as the migration owner.
  // It calls services directly rather than through a route, so there is
  // no middleware to enter a tenant scope and each test would need its
  // own `runAsTenant` — see `bill-list.integration.test.ts` for the
  // shape that conversion takes. Counted by
  // `src/__tests__/app/rls-suite-coverage.test.ts`, which only lets the
  // number go down.
  process.env.DATABASE_URL = booted.dbUrl;
  pgContainer = booted.container;
  process.env.DATABASE_URL = booted.dbUrl;
  prismaImports = await import("../../lib/prisma.js");
  svc = await import("../../services/bill-segment.service.js");
}, 180_000);

afterAll(async () => {
  // `$disconnect` does not dispose a pool the application owns — that
  // is the driver-adapter contract — so the pools are ended here.
  // Without it the container stops while connections are live and
  // Postgres reports 57P01 as an unhandled error after a green run.
  await prismaImports?.prisma.$disconnect().catch(() => {});
  await prismaImports?.pool.end().catch(() => {});
  await endAdminPool();
  await pgContainer?.stop().catch(() => {});
});

beforeEach(() =>
  seedAsPlatform(async () => {
  const { prisma } = prismaImports;
  await resetDb();
  fix = await makeTenantFixture(prisma, TENANT_A);
  const sa = await prisma.serviceAgreement.create({
    data: {
      utilityId: fix.utilityId,
      agreementNumber: "SA-PERIOD",
      accountId: fix.accountId,
      commodityId: fix.commodityId,
      startDate: new Date("2025-11-01T00:00:00.000Z"),
      status: "ACTIVE",
    },
  });
  saId = sa.id;
}),
);

/** A read on `date`, unbilled unless `billed` says otherwise. */
async function read(date: string, opts: { billed?: boolean; consumption?: number } = {}) {
  const { prisma } = prismaImports;
  const meter = await prisma.meter.findUniqueOrThrow({
    where: { id: fix.meterId },
    select: { uomId: true },
  });
  return prisma.meterRead.create({
    data: {
      utilityId: fix.utilityId,
      meterId: fix.meterId,
      serviceAgreementId: saId,
      uomId: meter.uomId,
      readDate: new Date(`${date}T00:00:00.000Z`),
      readDatetime: new Date(`${date}T12:00:00.000Z`),
      reading: 100,
      priorReading: 88,
      consumption: opts.consumption ?? 12,
      readType: "ACTUAL",
      readSource: "MANUAL",
      billedAt: opts.billed ? new Date(`${date}T23:00:00.000Z`) : null,
    },
  });
}

const ymd = (d: Date) => d.toISOString().slice(0, 10);

describe("resolveServicePeriod", () => {
  it("ends on the newest unbilled read, whatever the calendar says", async () => {
    // The reader came on the 30th, not the month end.
    await read("2026-01-30");

    const p = await svc.resolveServicePeriod(fix.utilityId, saId, {
      asOf: new Date("2026-02-01T00:00:00.000Z"),
    });

    expect(ymd(p.periodEnd)).toBe("2026-01-30");
  });

  it("starts the day after the last billed read, so periods abut exactly", async () => {
    await read("2025-12-30", { billed: true });
    await read("2026-01-30");

    const p = await svc.resolveServicePeriod(fix.utilityId, saId, {
      asOf: new Date("2026-02-01T00:00:00.000Z"),
    });

    expect(ymd(p.periodStart)).toBe("2025-12-31");
    expect(ymd(p.periodEnd)).toBe("2026-01-30");
    // 31 days, not the 31 of a January calendar month — the interval the
    // meter measured.
    expect(p.readCount).toBe(1);
  });

  it("starts at the agreement, not at epoch, on a first bill", async () => {
    await read("2026-01-30");

    const p = await svc.resolveServicePeriod(fix.utilityId, saId, {
      asOf: new Date("2026-02-01T00:00:00.000Z"),
    });

    const sa = await prismaImports.prisma.serviceAgreement.findUniqueOrThrow({
      where: { id: saId },
      select: { startDate: true },
    });
    expect(ymd(p.periodStart)).toBe(ymd(sa.startDate));
  });

  /**
   * The reader slipped a day. Under the calendar rule, January's window
   * caught no read and February's caught two — a zero bill then a double
   * one. Read to read there is one interval, dated for what it covers.
   */
  it("gives a late read one interval rather than a zero bill and a double", async () => {
    await read("2025-12-30", { billed: true });
    // January's read, taken on 2/1.
    await read("2026-02-01");

    // Billing January finds nothing to bill, and says so.
    await expect(
      svc.resolveServicePeriod(fix.utilityId, saId, {
        asOf: new Date("2026-01-31T00:00:00.000Z"),
      }),
    ).rejects.toMatchObject({ code: "NO_READ_IN_WINDOW" });

    // Billing after it lands covers the whole 33 days, once.
    const p = await svc.resolveServicePeriod(fix.utilityId, saId, {
      asOf: new Date("2026-02-28T00:00:00.000Z"),
    });
    expect(ymd(p.periodStart)).toBe("2025-12-31");
    expect(ymd(p.periodEnd)).toBe("2026-02-01");
    expect(p.readCount).toBe(1);
  });

  it("leaves a read taken after the window for the next period", async () => {
    await read("2026-01-30");
    await read("2026-02-15");

    const p = await svc.resolveServicePeriod(fix.utilityId, saId, {
      asOf: new Date("2026-02-01T00:00:00.000Z"),
    });

    expect(ymd(p.periodEnd)).toBe("2026-01-30");
    expect(p.readCount).toBe(1);
  });

  it("includes every unbilled read inside the interval", async () => {
    await read("2025-12-30", { billed: true });
    await read("2026-01-15");
    await read("2026-01-30");

    const p = await svc.resolveServicePeriod(fix.utilityId, saId, {
      asOf: new Date("2026-02-01T00:00:00.000Z"),
    });

    expect(ymd(p.periodStart)).toBe("2025-12-31");
    expect(ymd(p.periodEnd)).toBe("2026-01-30");
    expect(p.readCount).toBe(2);
  });

  it("refuses when there is no read to bill, naming what to do", async () => {
    const err = await svc
      .resolveServicePeriod(fix.utilityId, saId, { asOf: new Date("2026-02-01T00:00:00.000Z") })
      .catch((e: unknown) => e);

    expect((err as { code: string }).code).toBe("NO_READ_IN_WINDOW");
    expect((err as { statusCode: number }).statusCode).toBe(400);
    expect((err as Error).message).toMatch(/estimate/i);
  });

  /**
   * A read dated before the last billed interval closed, arriving after
   * it. Billing it would overlap a period already billed, which is a
   * rebill and not a new segment.
   */
  it("refuses a backdated read rather than overlapping a billed period", async () => {
    await read("2026-01-30", { billed: true });
    await read("2026-01-10");

    await expect(
      svc.resolveServicePeriod(fix.utilityId, saId, {
        asOf: new Date("2026-02-01T00:00:00.000Z"),
      }),
    ).rejects.toMatchObject({ code: "READ_PREDATES_BILLED_PERIOD", statusCode: 409 });
  });

  it("does not see another tenant's reads", async () => {
    await read("2026-01-30");

    await expect(
      svc.resolveServicePeriod("00000000-0000-4000-8000-0000000000bb", saId, {
        asOf: new Date("2026-02-01T00:00:00.000Z"),
      }),
    ).rejects.toMatchObject({ code: "SA_NOT_FOUND" });
  });
});
