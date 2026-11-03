import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Decimal } from "decimal.js";
import {
  bootPostgres,
  resetDb,
  makeTenantFixture,
  TENANT_A,
  type TenantFixture,
  endAdminPool,
  seedAsPlatform,
} from "./_effective-dating-fixtures.js";
import { MeterLoader } from "../../lib/rate-engine-loaders/loaders/meter-loader.js";
import { UnsupportedInSlice4Error } from "../../lib/rate-engine-loaders/types.js";

import { runAsTenant } from "../../lib/tenant-context.js";
/**
 * Slice 4 task 3 — MeterLoader integration tests.
 *
 * Boots a Postgres container, applies migrations, and exercises the
 * loader's four declared patterns against real rows. `meter:size` and
 * `meter:role` are read out of `customFields`; `meter:reads` is
 * aggregated from real MeterRead rows; `meter:peak_demand` should
 * cleanly throw UnsupportedInSlice4Error.
 */

let pgContainer: StartedPostgreSqlContainer;
let prismaImports: typeof import("../../lib/prisma.js");

const PERIOD = {
  startDate: new Date("2026-01-01"),
  endDate: new Date("2026-01-31"),
};

beforeAll(async () => {
  const booted = await bootPostgres({ utilities: [TENANT_A] });
  pgContainer = booted.container;
  prismaImports = await import("../../lib/prisma.js");
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

/**
 * The loader run the way a route runs it: inside the tenant's scope.
 *
 * A loader takes the client and the tenant in its constructor, so the
 * scope cannot ride in on an argument to `load()` — it has to be around
 * the call. `runAsTenant` here overrides the surrounding
 * `seedAsPlatform`, so the fixtures stay free to arrange rows while the
 * read under test is confined to one tenant.
 */
const scoped = <T>(tenant: string, fn: () => Promise<T>): Promise<T> =>
  runAsTenant(tenant, fn);

beforeEach(() =>
  seedAsPlatform(async () => {    /* Fixture rows and read-backs under the fixture authority; the
     * scoped wrappers re-enter their own tenant scope. */
    /*
     * `resetDb` alone. The bare `DELETE FROM meter_read` that used to run
     * here was redundant *and* unprotected: redundant because
     * `resetDb`'s `TRUNCATE … CASCADE` reaches `meter_read` through its
     * foreign key to `meter`, and unprotected because a statement issued
     * straight at the client carries no `lock_timeout` — PostgreSQL has
     * no default, so a collision with one of Timescale's background
     * workers over a chunk lock waits forever. That is how this suite
     * spent 357 seconds in a 120-second hook during the 2026-10-25
     * full-suite run. `resetDb` bounds the same work and retries it.
     */
    await resetDb();

  }));

interface MeterReadFixture {
  fix: TenantFixture;
  saId: string;
}

/**
 * Build a tenant fixture and an SA the meter reads can hang off of.
 * Optionally seeds customFields on the meter so size/role tests have
 * something to read.
 */
async function makeMeterFixture(opts: {
  meter1CustomFields?: Record<string, unknown>;
  meter2CustomFields?: Record<string, unknown>;
}): Promise<MeterReadFixture> {
  /*
   * Arranging rows, so the authority the fixtures use. Calls under
   * test re-enter their own tenant scope.
   */
  return seedAsPlatform(async () => {
    const { prisma } = prismaImports;
    const fix = await makeTenantFixture(prisma, TENANT_A);

    if (opts.meter1CustomFields) {
      await prisma.meter.update({
        where: { id: fix.meterId },
        data: { customFields: opts.meter1CustomFields as object },
      });
    }
    if (opts.meter2CustomFields) {
      await prisma.meter.update({
        where: { id: fix.meterId2 },
        data: { customFields: opts.meter2CustomFields as object },
      });
    }

    const sa = await prisma.serviceAgreement.create({
      data: {
        utilityId: fix.utilityId,
        agreementNumber: "SA-METER-LOADER-1",
        accountId: fix.accountId,
        commodityId: fix.commodityId,
        startDate: new Date("2026-01-01"),
        status: "ACTIVE",
      },
    });

    return { fix, saId: sa.id };

  });
}

interface SeedReadOpts {
  meterId: string;
  saId: string;
  uomId: string;
  utilityId: string;
  readDate: Date;
  /* Optional since the `tou_registers` migration: an interval-derived
   * TOU bucket is a sum over classified intervals and has no dial
   * reading. A CHECK keeps the pair together. */
  reading?: string;
  priorReading?: string;
  consumption: string;
  /** Set to make this row a TOU bucket rather than a total read. */
  peakCode?: string;
}

async function seedRead(opts: SeedReadOpts): Promise<void> {

  /*

   * Arranging rows, so the authority the fixtures use. Calls under

   * test re-enter their own tenant scope.

   */

  return seedAsPlatform(async () => {
    const { prisma } = prismaImports;
    await prisma.meterRead.create({
      data: {
        utilityId: opts.utilityId,
        meterId: opts.meterId,
        serviceAgreementId: opts.saId,
        uomId: opts.uomId,
        readDate: opts.readDate,
        readDatetime: opts.readDate,
        reading: opts.reading ?? null,
        priorReading: opts.priorReading ?? null,
        consumption: opts.consumption,
        peakCode: opts.peakCode ?? null,
        readType: "ACTUAL",
        readSource: "MANUAL",
      },
    });


  });

}

describe("MeterLoader", () => {
  it("meter:size:<id> returns the size from customFields", async () => {
    const { fix } = await makeMeterFixture({
      meter1CustomFields: { size: '5/8"', role: "primary" },
    });

    const loader = new MeterLoader(prismaImports.prisma, TENANT_A, PERIOD);
    const out = await scoped(TENANT_A, () => loader.load([`meter:size:${fix.meterId}`]));
    expect(out.get(`meter:size:${fix.meterId}`)).toBe('5/8"');
  });

  it("meter:role:<id> returns the role, or null when not set", async () => {
    const { fix } = await makeMeterFixture({
      meter1CustomFields: { size: '1"', role: "irrigation" },
      // meter2 left with default {} — role should be null
    });

    const loader = new MeterLoader(prismaImports.prisma, TENANT_A, PERIOD);
    const out = await scoped(TENANT_A, () => loader.load([
      `meter:role:${fix.meterId}`,
      `meter:role:${fix.meterId2}`,
    ]));
    expect(out.get(`meter:role:${fix.meterId}`)).toBe("irrigation");
    expect(out.get(`meter:role:${fix.meterId2}`)).toBeNull();
  });

  it("meter:reads:<id> aggregates consumption across multiple reads in period", async () => {
    const { fix, saId } = await makeMeterFixture({});
    const seedFor = (readDate: Date, consumption: string, reading: string) =>
      seedRead({
        meterId: fix.meterId,
        saId,
        uomId: fix.uomId,
        utilityId: fix.utilityId,
        readDate,
        reading,
        priorReading: "0",
        consumption,
      });

    await seedFor(new Date("2026-01-05"), "10.5000", "10.5000");
    await seedFor(new Date("2026-01-15"), "20.2500", "30.7500");
    await seedFor(new Date("2026-01-25"), "5.1234", "35.8734");

    const loader = new MeterLoader(prismaImports.prisma, TENANT_A, PERIOD);
    const out = await scoped(TENANT_A, () => loader.load([`meter:reads:${fix.meterId}`]));
    const summary = out.get(`meter:reads:${fix.meterId}`) as {
      quantity: Decimal;
      unit: string;
    };
    expect(summary.unit).toBe("GAL"); // matches the fixture's UoM code
    expect(summary.quantity.toString()).toBe(new Decimal("35.8734").toString());
  });

  it("meter:reads:<id> ignores reads outside the period", async () => {
    const { fix, saId } = await makeMeterFixture({});
    // In-period
    await seedRead({
      meterId: fix.meterId,
      saId,
      uomId: fix.uomId,
      utilityId: fix.utilityId,
      readDate: new Date("2026-01-15"),
      reading: "100.0000",
      priorReading: "0",
      consumption: "12.0000",
    });
    // Before the period start
    await seedRead({
      meterId: fix.meterId,
      saId,
      uomId: fix.uomId,
      utilityId: fix.utilityId,
      readDate: new Date("2025-12-15"),
      reading: "50.0000",
      priorReading: "0",
      consumption: "999.0000",
    });
    // After the period end
    await seedRead({
      meterId: fix.meterId,
      saId,
      uomId: fix.uomId,
      utilityId: fix.utilityId,
      readDate: new Date("2026-02-05"),
      reading: "200.0000",
      priorReading: "0",
      consumption: "888.0000",
    });

    const loader = new MeterLoader(prismaImports.prisma, TENANT_A, PERIOD);
    const out = await scoped(TENANT_A, () => loader.load([`meter:reads:${fix.meterId}`]));
    const summary = out.get(`meter:reads:${fix.meterId}`) as {
      quantity: Decimal;
      unit: string;
    };
    expect(summary.quantity.toString()).toBe(new Decimal("12.0000").toString());
  });

  it("meter:reads:<id> returns 0 quantity when no reads exist (default unit HCF)", async () => {
    const { fix } = await makeMeterFixture({});

    const loader = new MeterLoader(prismaImports.prisma, TENANT_A, PERIOD);
    const out = await scoped(TENANT_A, () => loader.load([`meter:reads:${fix.meterId}`]));
    const summary = out.get(`meter:reads:${fix.meterId}`) as {
      quantity: Decimal;
      unit: string;
    };
    expect(summary.quantity.toString()).toBe("0");
    expect(summary.unit).toBe("HCF");
  });

  it("batches multiple meters into one Meter query for size+role", async () => {
    const { fix } = await makeMeterFixture({
      meter1CustomFields: { size: '5/8"', role: "primary" },
      meter2CustomFields: { size: '1"', role: "irrigation" },
    });

    const original = prismaImports.prisma.meter.findMany.bind(prismaImports.prisma.meter);
    const spy = vi
      .spyOn(prismaImports.prisma.meter, "findMany")
      .mockImplementation((args) => original(args) as ReturnType<typeof original>);
    try {
      const loader = new MeterLoader(prismaImports.prisma, TENANT_A, PERIOD);
      const out = await scoped(TENANT_A, () => loader.load([
        `meter:size:${fix.meterId}`,
        `meter:size:${fix.meterId2}`,
        `meter:role:${fix.meterId}`,
        `meter:role:${fix.meterId2}`,
      ]));

      expect(spy).toHaveBeenCalledTimes(1);
      expect(out.get(`meter:size:${fix.meterId}`)).toBe('5/8"');
      expect(out.get(`meter:size:${fix.meterId2}`)).toBe('1"');
      expect(out.get(`meter:role:${fix.meterId}`)).toBe("primary");
      expect(out.get(`meter:role:${fix.meterId2}`)).toBe("irrigation");
    } finally {
      spy.mockRestore();
    }
  });

  it("meter:peak_demand:* throws UnsupportedInSlice4Error", async () => {
    const { fix } = await makeMeterFixture({});
    const loader = new MeterLoader(prismaImports.prisma, TENANT_A, PERIOD);

    await expect(
      scoped(TENANT_A, () => loader.load([`meter:peak_demand:${fix.meterId}:15min`])),
    ).rejects.toBeInstanceOf(UnsupportedInSlice4Error);
  });
});

describe("MeterLoader - TOU buckets (spec 26, TOU-REG-1/2)", () => {
  /**
   * `meter:tou:<meter_id>:<peak_code>` - one TOU period's consumption.
   *
   * **The registers carrying a peak code are the declaration of which
   * periods this meter can report.** That is what makes the loader's
   * contract safe: it answers for a mapped register, zero included, and
   * a calendar period no register covers gets no bucket at all - so the
   * component pricing it raises rather than billing zero for usage the
   * meter never counted. A two-register meter on a three-period tariff
   * has to fail loudly, not cheaply.
   */

  /** Map a meter's registers to TOU periods. */
  async function mapRegisters(
    fix: TenantFixture,
    meterId: string,
    peakCodes: string[],
  ): Promise<void> {
    await seedAsPlatform(async () => {
      const { prisma } = prismaImports;
      const measureType = await prisma.measureTypeDef.findFirstOrThrow({
        where: { OR: [{ utilityId: fix.utilityId }, { utilityId: null }] },
      });
      for (const [i, peakCode] of peakCodes.entries()) {
        await prisma.meterRegister.create({
          data: {
            utilityId: fix.utilityId,
            meterId,
            registerNumber: i + 2, // 1 is conventionally the total
            uomId: fix.uomId,
            measureTypeId: measureType.id,
            peakCode,
          },
        });
      }
    });
  }

  const qty = (out: Map<string, unknown>, key: string): string =>
    (out.get(key) as { quantity: Decimal }).quantity.toString();

  it("sums one period's consumption, and keeps the periods apart", async () => {
    const { fix, saId } = await makeMeterFixture({});
    await mapRegisters(fix, fix.meterId, ["peak", "off_peak"]);

    const common = { meterId: fix.meterId, saId, uomId: fix.uomId, utilityId: fix.utilityId };
    await seedRead({ ...common, readDate: new Date("2026-01-10"), consumption: "40", peakCode: "peak" });
    await seedRead({ ...common, readDate: new Date("2026-01-20"), consumption: "60", peakCode: "peak" });
    await seedRead({ ...common, readDate: new Date("2026-01-20"), consumption: "500", peakCode: "off_peak" });

    const loader = new MeterLoader(prismaImports.prisma, TENANT_A, PERIOD);
    const out = await scoped(TENANT_A, () =>
      loader.load([`meter:tou:${fix.meterId}:peak`, `meter:tou:${fix.meterId}:off_peak`]),
    );

    expect(qty(out, `meter:tou:${fix.meterId}:peak`)).toBe("100");
    expect(qty(out, `meter:tou:${fix.meterId}:off_peak`)).toBe("500");
  });

  it("reports zero for a period the meter read as zero", async () => {
    /*
     * The customer who used nothing on-peak. A register meter is read
     * once and the event captures every register, so the on-peak dial
     * produced a row too - reading the same as its prior reading, so
     * consumption zero. The row is what makes zero the answer rather
     * than "absent".
     */
    const { fix, saId } = await makeMeterFixture({});
    await mapRegisters(fix, fix.meterId, ["peak", "off_peak"]);
    const common = { meterId: fix.meterId, saId, uomId: fix.uomId, utilityId: fix.utilityId };
    await seedRead({ ...common, readDate: new Date("2026-01-20"), reading: "40", priorReading: "40", consumption: "0", peakCode: "peak" });
    await seedRead({ ...common, readDate: new Date("2026-01-20"), consumption: "500", peakCode: "off_peak" });

    const loader = new MeterLoader(prismaImports.prisma, TENANT_A, PERIOD);
    const out = await scoped(TENANT_A, () => loader.load([`meter:tou:${fix.meterId}:peak`]));
    expect(qty(out, `meter:tou:${fix.meterId}:peak`)).toBe("0");
  });

  it("gives nothing for a period the meter never reported", async () => {
    /*
     * The failure this closes. A two-register meter cannot report
     * mid-peak, so a three-period tariff must not receive a zero for it
     * - that would bill nothing for mid-peak usage the meter rolled
     * into one of its two registers. No row means no bucket, and the
     * component pricing it raises.
     */
    const { fix, saId } = await makeMeterFixture({});
    const common = { meterId: fix.meterId, saId, uomId: fix.uomId, utilityId: fix.utilityId };
    await seedRead({ ...common, readDate: new Date("2026-01-20"), consumption: "100", peakCode: "peak" });
    await seedRead({ ...common, readDate: new Date("2026-01-20"), consumption: "500", peakCode: "off_peak" });

    const loader = new MeterLoader(prismaImports.prisma, TENANT_A, PERIOD);
    const out = await scoped(TENANT_A, () => loader.load([`meter:tou:${fix.meterId}:mid_peak`]));
    expect(out.has(`meter:tou:${fix.meterId}:mid_peak`)).toBe(false);
  });

  it("answers from the reads after a register is remapped", async () => {
    /*
     * **Why the gate is the reads and not the register mapping** (Rao,
     * 2026-11-03): a peak code on a register is the utility's
     * assignment of meaning to a dial, not something the device
     * reports, and it is neither versioned nor effective-dated.
     *
     * Here register 2 counted on-peak when the month was read, and has
     * since been remapped to mid-peak. Re-rating that month must still
     * find its on-peak usage - the reads were stamped at import and do
     * not change. Gating on the mapping instead answered about today's
     * periods and so failed to reproduce the bill.
     */
    const { fix, saId } = await makeMeterFixture({});
    await mapRegisters(fix, fix.meterId, ["peak"]);
    await seedRead({
      meterId: fix.meterId, saId, uomId: fix.uomId, utilityId: fix.utilityId,
      readDate: new Date("2026-01-20"), consumption: "100", peakCode: "peak",
    });

    // The remap, after the fact.
    await seedAsPlatform(async () => {
      await prismaImports.prisma.meterRegister.updateMany({
        where: { meterId: fix.meterId, peakCode: "peak" },
        data: { peakCode: "mid_peak" },
      });
    });

    const loader = new MeterLoader(prismaImports.prisma, TENANT_A, PERIOD);
    const out = await scoped(TENANT_A, () => loader.load([`meter:tou:${fix.meterId}:peak`]));
    expect(qty(out, `meter:tou:${fix.meterId}:peak`)).toBe("100");
  });

  it("still answers for a period whose register has been retired", async () => {
    /*
     * The same reasoning as the remap case, from the other side.
     * Retiring a register says nothing about the month it was read in,
     * and a bill for that month must still be reproducible.
     */
    const { fix, saId } = await makeMeterFixture({});
    await mapRegisters(fix, fix.meterId, ["peak"]);
    await seedRead({
      meterId: fix.meterId, saId, uomId: fix.uomId, utilityId: fix.utilityId,
      readDate: new Date("2026-01-20"), consumption: "100", peakCode: "peak",
    });
    await seedAsPlatform(async () => {
      await prismaImports.prisma.meterRegister.updateMany({
        where: { meterId: fix.meterId, peakCode: "peak" },
        data: { isActive: false },
      });
    });

    const loader = new MeterLoader(prismaImports.prisma, TENANT_A, PERIOD);
    const out = await scoped(TENANT_A, () => loader.load([`meter:tou:${fix.meterId}:peak`]));
    expect(qty(out, `meter:tou:${fix.meterId}:peak`)).toBe("100");
  });

  it("keeps two meters' buckets apart", async () => {
    const { fix, saId } = await makeMeterFixture({});
    await mapRegisters(fix, fix.meterId, ["peak"]);
    await mapRegisters(fix, fix.meterId2, ["peak"]);

    const common = { saId, uomId: fix.uomId, utilityId: fix.utilityId };
    await seedRead({ ...common, meterId: fix.meterId, readDate: new Date("2026-01-10"), consumption: "40", peakCode: "peak" });
    await seedRead({ ...common, meterId: fix.meterId2, readDate: new Date("2026-01-10"), consumption: "7", peakCode: "peak" });

    const loader = new MeterLoader(prismaImports.prisma, TENANT_A, PERIOD);
    const out = await scoped(TENANT_A, () =>
      loader.load([`meter:tou:${fix.meterId}:peak`, `meter:tou:${fix.meterId2}:peak`]),
    );
    expect(qty(out, `meter:tou:${fix.meterId}:peak`)).toBe("40");
    expect(qty(out, `meter:tou:${fix.meterId2}:peak`)).toBe("7");
  });
});

describe("MeterLoader - meter:reads against a TOU meter", () => {
  /**
   * The defect the TOU columns would otherwise have introduced.
   *
   * `meter:reads` sums `MeterRead.consumption` for the period. Once a
   * meter can carry *both* a total read and per-period bucket rows, a
   * naive sum counts the month twice - and the symptom is not an error
   * but a tiered charge at double the usage, on a bill that looks
   * entirely ordinary.
   */

  const qty = (out: Map<string, unknown>, key: string): string =>
    (out.get(key) as { quantity: Decimal }).quantity.toString();

  it("counts the total read only, not the buckets beside it", async () => {
    const { fix, saId } = await makeMeterFixture({});
    const common = { meterId: fix.meterId, saId, uomId: fix.uomId, utilityId: fix.utilityId };

    // A total register plus two TOU registers, reconciling as
    // TOU-REG-1 requires: 100 + 500 = 600.
    await seedRead({ ...common, readDate: new Date("2026-01-20"), reading: "1600", priorReading: "1000", consumption: "600" });
    await seedRead({ ...common, readDate: new Date("2026-01-20"), consumption: "100", peakCode: "peak" });
    await seedRead({ ...common, readDate: new Date("2026-01-20"), consumption: "500", peakCode: "off_peak" });

    const loader = new MeterLoader(prismaImports.prisma, TENANT_A, PERIOD);
    const out = await scoped(TENANT_A, () => loader.load([`meter:reads:${fix.meterId}`]));
    expect(qty(out, `meter:reads:${fix.meterId}`)).toBe("600");
  });

  it("falls back to summing the buckets when there is no total read", async () => {
    /*
     * A TOU meter with no total register still has a month's total - it
     * is the sum of its periods. Without this, a flat or tiered
     * component on the same schedule would bill zero for a customer who
     * used 600 units.
     */
    const { fix, saId } = await makeMeterFixture({});
    const common = { meterId: fix.meterId, saId, uomId: fix.uomId, utilityId: fix.utilityId };
    await seedRead({ ...common, readDate: new Date("2026-01-20"), consumption: "100", peakCode: "peak" });
    await seedRead({ ...common, readDate: new Date("2026-01-20"), consumption: "500", peakCode: "off_peak" });

    const loader = new MeterLoader(prismaImports.prisma, TENANT_A, PERIOD);
    const out = await scoped(TENANT_A, () => loader.load([`meter:reads:${fix.meterId}`]));
    expect(qty(out, `meter:reads:${fix.meterId}`)).toBe("600");
  });

  it("is unchanged for an ordinary meter", async () => {
    const { fix, saId } = await makeMeterFixture({});
    await seedRead({
      meterId: fix.meterId, saId, uomId: fix.uomId, utilityId: fix.utilityId,
      readDate: new Date("2026-01-20"), reading: "1600", priorReading: "1000", consumption: "600",
    });

    const loader = new MeterLoader(prismaImports.prisma, TENANT_A, PERIOD);
    const out = await scoped(TENANT_A, () => loader.load([`meter:reads:${fix.meterId}`]));
    expect(qty(out, `meter:reads:${fix.meterId}`)).toBe("600");
  });
});
