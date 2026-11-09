import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import {
  bootPostgres,
  resetDb,
  makeTenantFixture,
  TENANT_A,
  TENANT_B,
  type TenantFixture,
  endAdminPool,
  seedAsPlatform,
} from "./_effective-dating-fixtures.js";

/**
 * Which rows a stop produces, against a real database. Every exclusion
 * test below seeds a row that WOULD be included and differs from it in
 * exactly the one clause under test, so deleting that clause from the
 * query turns the test red. A meter with no assignment asserted absent
 * would prove nothing about the AMI filter.
 */

let pgContainer: StartedPostgreSqlContainer;
let prismaImports: typeof import("../../lib/prisma.js");
let tenancy: typeof import("../../lib/tenant-context.js");
let rr: typeof import("../../services/read-route/readable-rows.js");

let fixA: TenantFixture;
let fixB: TenantFixture;

beforeAll(async () => {
  const booted = await bootPostgres({ utilities: [TENANT_A, TENANT_B] });
  pgContainer = booted.container;
  prismaImports = await import("../../lib/prisma.js");
  tenancy = await import("../../lib/tenant-context.js");
  rr = await import("../../services/read-route/readable-rows.js");
}, 180_000);

afterAll(async () => {
  await prismaImports?.prisma.$disconnect().catch(() => {});
  await prismaImports?.pool.end().catch(() => {});
  await endAdminPool();
  await pgContainer?.stop().catch(() => {});
});

beforeEach(() =>
  seedAsPlatform(async () => {
    await resetDb();
    fixA = await makeTenantFixture(prismaImports.prisma, TENANT_A);
    fixB = await makeTenantFixture(prismaImports.prisma, TENANT_B);
  }));

const ON = new Date("2026-06-15");

const rowsFor = (premiseIds: string[], onDate = ON, tenant = TENANT_A) =>
  tenancy.runAsTenant(tenant, () => rr.readableRowsForPremises(tenant, premiseIds, onDate));

let seq = 0;

/** A premise with its own agreement and service point, so every test starts from one clean included shape. */
async function makeStop(fix: TenantFixture = fixA, tenant = TENANT_A) {
  const n = ++seq;
  return seedAsPlatform(async () => {
    const { prisma } = prismaImports;
    const premise = await prisma.premise.create({
      data: {
        utilityId: tenant,
        addressLine1: `${n} Stop Street`,
        city: "Testville",
        state: "TS",
        zip: "00000",
        premiseType: "RESIDENTIAL",
        commodityIds: [fix.commodityId],
        status: "ACTIVE",
      },
    });
    const agreement = await prisma.serviceAgreement.create({
      data: {
        utilityId: tenant,
        agreementNumber: `SA-RR-${n}`,
        accountId: fix.accountId,
        commodityId: fix.commodityId,
        startDate: new Date("2024-01-01"),
        status: "ACTIVE",
      },
    });
    const sp = await prisma.servicePoint.create({
      data: {
        utilityId: tenant,
        serviceAgreementId: agreement.id,
        premiseId: premise.id,
        startDate: new Date("2024-01-01"),
      },
    });
    return { premiseId: premise.id, agreementId: agreement.id, servicePointId: sp.id, fix, tenant };
  });
}
type Stop = Awaited<ReturnType<typeof makeStop>>;

/** A meter at the stop, assigned through its service point unless told otherwise. */
async function makeMeter(
  stop: Stop,
  over: {
    type?: "MANUAL" | "AMR" | "AMI";
    status?: "ACTIVE" | "DEFECTIVE" | "PENDING_INSTALL" | "REMOVED";
    assign?: { addedDate?: string; removedDate?: string | null } | false;
    registers?: { number: number; active?: boolean }[];
    meterPremiseId?: string;
  } = {},
) {
  const n = ++seq;
  return seedAsPlatform(async () => {
    const { prisma } = prismaImports;
    const meter = await prisma.meter.create({
      data: {
        utilityId: stop.tenant,
        premiseId: over.meterPremiseId ?? stop.premiseId,
        commodityId: stop.fix.commodityId,
        uomId: stop.fix.uomId,
        meterNumber: `RR-M-${n}`,
        meterType: over.type ?? "MANUAL",
        status: over.status ?? "ACTIVE",
        installDate: new Date("2024-01-01"),
      },
    });
    if (over.assign !== false) {
      await prisma.servicePointMeter.create({
        data: {
          utilityId: stop.tenant,
          servicePointId: stop.servicePointId,
          meterId: meter.id,
          addedDate: new Date(over.assign?.addedDate ?? "2024-01-01"),
          removedDate: over.assign?.removedDate ? new Date(over.assign.removedDate) : null,
        },
      });
    }
    if (over.registers?.length) {
      const measureType = await prisma.measureTypeDef.findFirstOrThrow({
        where: { OR: [{ utilityId: stop.tenant }, { utilityId: null }] },
      });
      for (const r of over.registers) {
        await prisma.meterRegister.create({
          data: {
            utilityId: stop.tenant,
            meterId: meter.id,
            registerNumber: r.number,
            uomId: stop.fix.uomId,
            measureTypeId: measureType.id,
            isActive: r.active ?? true,
          },
        });
      }
    }
    return meter;
  });
}

describe("which rows a stop produces", () => {
  // The zero-register path is the common one in real data, so the base case is it.
  it("includes a MANUAL meter with an open assignment, as one row with null register", async () => {
    const stop = await makeStop();
    const meter = await makeMeter(stop);
    const rows = await rowsFor([stop.premiseId]);
    expect(rows).toEqual([
      {
        premiseId: stop.premiseId,
        meterId: meter.id,
        meterNumber: meter.meterNumber,
        registerId: null,
        registerNumber: null,
        serviceAgreementId: stop.agreementId,
        accountNumber: expect.any(String),
        uomId: fixA.uomId,
      },
    ]);
  });

  it("includes an AMR meter", async () => {
    const stop = await makeStop();
    await makeMeter(stop, { type: "AMR" });
    expect(await rowsFor([stop.premiseId])).toHaveLength(1);
  });

  it("excludes an AMI meter, which nobody visits", async () => {
    // Pinned against a MANUAL twin at the same stop: only the type differs.
    const stop = await makeStop();
    const manual = await makeMeter(stop, { type: "MANUAL" });
    await makeMeter(stop, { type: "AMI" });
    const rows = await rowsFor([stop.premiseId]);
    expect(rows.map((r) => r.meterId)).toEqual([manual.id]);
  });

  it.each(["DEFECTIVE", "PENDING_INSTALL", "REMOVED"] as const)(
    "excludes a %s meter, which is not a stop",
    async (status) => {
      const stop = await makeStop();
      const active = await makeMeter(stop);
      await makeMeter(stop, { status });
      const rows = await rowsFor([stop.premiseId]);
      expect(rows.map((r) => r.meterId)).toEqual([active.id]);
    },
  );

  it("excludes a meter whose assignment was removed before the date", async () => {
    const stop = await makeStop();
    const open = await makeMeter(stop);
    await makeMeter(stop, { assign: { removedDate: "2026-06-14" } });
    expect((await rowsFor([stop.premiseId])).map((r) => r.meterId)).toEqual([open.id]);
  });

  it("includes an assignment removed on the date itself (open through its last day)", async () => {
    const stop = await makeStop();
    const m = await makeMeter(stop, { assign: { removedDate: "2026-06-15" } });
    expect((await rowsFor([stop.premiseId])).map((r) => r.meterId)).toEqual([m.id]);
  });

  it("excludes an assignment that begins after the date", async () => {
    const stop = await makeStop();
    const open = await makeMeter(stop);
    await makeMeter(stop, { assign: { addedDate: "2026-06-16" } });
    expect((await rowsFor([stop.premiseId])).map((r) => r.meterId)).toEqual([open.id]);
  });

  it("is date-scoped: a past date sees an assignment that has since been removed", async () => {
    const stop = await makeStop();
    const m = await makeMeter(stop, { assign: { removedDate: "2026-03-01" } });
    expect(await rowsFor([stop.premiseId], new Date("2026-02-01"))).toHaveLength(1);
    expect(await rowsFor([stop.premiseId], ON)).toHaveLength(0);
    expect(m.id).toBeTruthy();
  });

  it("reaches the meter through the service point, so an agreement always resolves", async () => {
    // Both meters are Meter.premise_id = this premise and otherwise identical;
    // only the one with a ServicePointMeter may print.
    const stop = await makeStop();
    const assigned = await makeMeter(stop);
    await makeMeter(stop, { assign: false });
    expect((await rowsFor([stop.premiseId])).map((r) => r.meterId)).toEqual([assigned.id]);
  });

  it("goes by the service point's premise, not Meter.premise_id", async () => {
    // The meter's own column points at the other stop; its service point is at `here`.
    const here = await makeStop();
    const elsewhere = await makeStop();
    const m = await makeMeter(here, { meterPremiseId: elsewhere.premiseId });
    expect((await rowsFor([here.premiseId])).map((r) => r.meterId)).toEqual([m.id]);
    expect(await rowsFor([elsewhere.premiseId])).toEqual([]);
  });

  it("returns one row per active register on a multi-register meter", async () => {
    const stop = await makeStop();
    const m = await makeMeter(stop, { registers: [{ number: 1 }, { number: 2 }] });
    const rows = await rowsFor([stop.premiseId]);
    expect(rows.map((r) => r.registerNumber)).toEqual(["1", "2"]);
    expect(new Set(rows.map((r) => r.registerId)).size).toBe(2);
    expect(rows.every((r) => r.meterId === m.id && r.registerId !== null)).toBe(true);
  });

  it("ignores an inactive register, and falls to one null row when none are active", async () => {
    const stop = await makeStop();
    const some = await makeMeter(stop, { registers: [{ number: 1 }, { number: 2, active: false }] });
    const none = await makeMeter(stop, { registers: [{ number: 1, active: false }] });
    const rows = await rowsFor([stop.premiseId]);
    const forSome = rows.filter((r) => r.meterId === some.id);
    expect(forSome.map((r) => r.registerNumber)).toEqual(["1"]);
    const forNone = rows.filter((r) => r.meterId === none.id);
    expect(forNone).toHaveLength(1);
    expect(forNone[0].registerId).toBeNull();
    expect(forNone[0].registerNumber).toBeNull();
  });

  it("answers many premises in one call and returns nothing for none", async () => {
    const a = await makeStop();
    const b = await makeStop();
    await makeMeter(a);
    await makeMeter(b);
    const rows = await rowsFor([a.premiseId, b.premiseId]);
    expect(new Set(rows.map((r) => r.premiseId))).toEqual(new Set([a.premiseId, b.premiseId]));
    expect(await rowsFor([])).toEqual([]);
  });

  it("returns a meter once when it moved between service points on the date", async () => {
    // Old assignment ends the day the new one begins; both are open on that day.
    const a = await makeStop();
    const m = await makeMeter(a, { assign: { removedDate: "2026-06-15" } });
    await seedAsPlatform(async () => {
      await prismaImports.prisma.servicePointMeter.create({
        data: {
          utilityId: TENANT_A,
          servicePointId: a.servicePointId,
          meterId: m.id,
          addedDate: new Date("2026-06-15"),
        },
      });
    });
    expect(await rowsFor([a.premiseId])).toHaveLength(1);
  });

  it("does not see another tenant's rows", async () => {
    const stopB = await makeStop(fixB, TENANT_B);
    await makeMeter(stopB);
    expect(await rowsFor([stopB.premiseId], ON, TENANT_A)).toEqual([]);
    expect(await rowsFor([stopB.premiseId], ON, TENANT_B)).toHaveLength(1);
  });
});
