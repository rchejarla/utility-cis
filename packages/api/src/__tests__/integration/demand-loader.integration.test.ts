import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import {
  bootPostgres,
  resetDb,
  makeTenantFixture,
  TENANT_A,
  type TenantFixture,
  endAdminPool,
  seedAsPlatform,
  serviceClassFor,
} from "./_effective-dating-fixtures.js";
import { DemandLoader, type DemandPeak, type DemandHistoryEntry } from "../../lib/rate-engine-loaders/loaders/demand-loader.js";
import { runAsTenant } from "../../lib/tenant-context.js";

/**
 * DemandLoader against real rows (spec 31, slice 2).
 *
 * The engine's demand rules are tested in `rate-engine/__tests__/demand.test.ts`
 * with the loader's output handed in. What only a database can show is
 * whether the loader *produces* that output: the maximum of a period's
 * demand reads rather than their sum, a gap for a demand register with no
 * read, energy reads left out, and history confined to one agreement.
 */

let pgContainer: StartedPostgreSqlContainer;
let prismaImports: typeof import("../../lib/prisma.js");

const PERIOD = { startDate: new Date("2026-10-11"), endDate: new Date("2026-11-10") };

beforeAll(async () => {
  const booted = await bootPostgres({ utilities: [TENANT_A] });
  pgContainer = booted.container;
  prismaImports = await import("../../lib/prisma.js");
}, 180_000);

afterAll(async () => {
  await prismaImports?.prisma.$disconnect().catch(() => {});
  await prismaImports?.pool.end().catch(() => {});
  await endAdminPool();
  await pgContainer?.stop().catch(() => {});
});

beforeEach(() => seedAsPlatform(() => resetDb()));

interface Fixture {
  fix: TenantFixture;
  saId: string;
  otherSaId: string;
  kwUomId: string;
  /** The demand register on meter 1. */
  demandRegisterId: string;
}

/**
 * A tenant, two agreements (the second stands for the next occupant), a
 * KW unit, and a demand register on meter 1. Meter 2 measures no demand.
 */
async function makeFixture(): Promise<Fixture> {
  return seedAsPlatform(async () => {
    const { prisma } = prismaImports;
    const fix = await makeTenantFixture(prisma, TENANT_A);
    // `resetDb` truncates the reference catalog, so the DEMAND type is made here.
    const demand = await prisma.measureTypeDef.create({
      data: { utilityId: fix.utilityId, code: "DEMAND", label: "Demand" },
    });
    const kw = await prisma.unitOfMeasure.create({
      data: {
        utilityId: fix.utilityId, code: "KW", name: "Kilowatts", commodityId: fix.commodityId,
        measureTypeId: demand.id, conversionFactor: 1, isBaseUnit: true, isActive: true,
      },
    });
    const register = await prisma.meterRegister.create({
      data: { utilityId: fix.utilityId, meterId: fix.meterId, registerNumber: 2, uomId: kw.id, measureTypeId: demand.id },
    });
    const sa = (n: string) =>
      serviceClassFor(prisma, fix.utilityId, fix.commodityId).then((rateServiceClassId) =>
        prisma.serviceAgreement.create({
          data: {
            utilityId: fix.utilityId, agreementNumber: n, accountId: fix.accountId, commodityId: fix.commodityId,
            rateServiceClassId, startDate: new Date("2025-01-01"), status: "ACTIVE",
          },
        }),
      );
    const a = await sa("SA-DEMAND-1");
    const b = await sa("SA-DEMAND-2");
    return { fix, saId: a.id, otherSaId: b.id, kwUomId: kw.id, demandRegisterId: register.id };
  });
}

async function read(f: Fixture, opts: { saId?: string; meterId?: string; day: string; kw: string; registerId?: string | null; uomId?: string }) {
  // Awaited inside the scope: a PrismaPromise is lazy, and returned out of
  // the callback it would run after the scope had exited (CLAUDE.md).
  await seedAsPlatform(async () => {
    await prismaImports.prisma.meterRead.create({
      data: {
        utilityId: f.fix.utilityId,
        meterId: opts.meterId ?? f.fix.meterId,
        serviceAgreementId: opts.saId ?? f.saId,
        registerId: opts.registerId === undefined ? f.demandRegisterId : opts.registerId,
        uomId: opts.uomId ?? f.kwUomId,
        readDate: new Date(opts.day),
        readDatetime: new Date(`${opts.day}T12:00:00Z`),
        reading: opts.kw,
        priorReading: "0",
        consumption: opts.kw,
        readType: "ACTUAL",
        readSource: "MANUAL",
      },
    });
  });
}

const load = (f: Fixture, keys: string[]) =>
  runAsTenant(TENANT_A, () => new DemandLoader(prismaImports.prisma, TENANT_A, f.saId, PERIOD).load(keys));

describe("DemandLoader — the period's peak", () => {
  it("takes the highest of a meter's demand reads in the period, never their sum (DEM-ENG-1a)", async () => {
    const f = await makeFixture();
    await read(f, { day: "2026-10-20", kw: "64.5" }); // an off-cycle read
    await read(f, { day: "2026-11-08", kw: "58" });
    await read(f, { day: "2026-10-05", kw: "300" }); // before the period

    const out = await load(f, [`demand:peak:${f.fix.meterId}`]);
    const p = out.get(`demand:peak:${f.fix.meterId}`) as DemandPeak;
    expect(p.quantity!.toString()).toBe("64.5");
    expect(p.unit).toBe("KW");
    expect(p.readDate).toBe("2026-10-20");
  });

  it("ignores energy reads on the same meter", async () => {
    const f = await makeFixture();
    await read(f, { day: "2026-11-08", kw: "58" });
    await read(f, { day: "2026-11-08", kw: "9000", registerId: null, uomId: f.fix.uomId });

    const out = await load(f, [`demand:peak:${f.fix.meterId}`]);
    expect((out.get(`demand:peak:${f.fix.meterId}`) as DemandPeak).quantity!.toString()).toBe("58");
  });

  it("marks a gap for a demand register with no read, and nothing for a meter without one", async () => {
    const f = await makeFixture();

    const out = await load(f, [`demand:peak:${f.fix.meterId}`, `demand:peak:${f.fix.meterId2}`]);
    expect(out.get(`demand:peak:${f.fix.meterId}`)).toMatchObject({ quantity: null, unit: "KW" });
    expect(out.has(`demand:peak:${f.fix.meterId2}`)).toBe(false);
  });
});

describe("DemandLoader — the agreement's history", () => {
  it("is the agreement's own peaks by month, before the period, each month's highest read", async () => {
    const f = await makeFixture();
    await read(f, { day: "2026-07-08", kw: "120" });
    await read(f, { day: "2026-07-21", kw: "130" }); // a second July read: July is 130, not 250
    await read(f, { day: "2026-09-08", kw: "70" });
    await read(f, { day: "2026-11-08", kw: "58" }); // in the period: not history

    const out = await load(f, [`demand:history:${f.saId}`]);
    const h = (out.get(`demand:history:${f.saId}`) as DemandHistoryEntry[]).map((e) => [e.month, e.quantity.toString(), e.readDate]);
    expect(h).toEqual([
      ["2026-07", "130", "2026-07-21"],
      ["2026-09", "70", "2026-09-08"],
    ]);
  });

  it("leaves out a previous occupant's peaks at the same meter (D1)", async () => {
    const f = await makeFixture();
    await read(f, { saId: f.otherSaId, day: "2026-07-08", kw: "400" });
    await read(f, { day: "2026-09-08", kw: "70" });

    const out = await load(f, [`demand:history:${f.saId}`]);
    const h = out.get(`demand:history:${f.saId}`) as DemandHistoryEntry[];
    expect(h.map((e) => e.quantity.toString())).toEqual(["70"]);
  });
});
