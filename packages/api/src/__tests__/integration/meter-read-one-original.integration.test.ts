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
} from "./_effective-dating-fixtures.js";

/**
 * `meter_read_one_original_per_instant` — the database's own refusal of a
 * read posted twice (migration 20261127100000).
 *
 * Against a real database because the rule **is** a database object, and
 * one Prisma cannot describe: a partial, NULLS NOT DISTINCT unique index
 * on a TimescaleDB hypertable. What each case pins:
 *   1. The same original read twice is refused — on an ordinary meter,
 *      where register and peak code are NULL. Without NULLS NOT DISTINCT
 *      this passes silently, which is the case that matters most.
 *   2. A correction carrying the original's instant is allowed.
 *   3. The same instant on two agreements is allowed — a transfer's FINAL
 *      read on the source and opening read on the new agreement.
 *   4. The same instant with two peak codes is allowed — the interval
 *      rollup's buckets.
 */

let pgContainer: StartedPostgreSqlContainer;
let prismaImports: typeof import("../../lib/prisma.js");
let fixA: TenantFixture;

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

beforeEach(async () => {
  await resetDb();
  fixA = await makeTenantFixture(prismaImports.prisma, TENANT_A);
});

const AT = new Date("2026-05-03T12:00:00.000Z");

async function agreement(number: string) {
  const { prisma } = prismaImports;
  return seedAsPlatform(async () =>
    prisma.serviceAgreement.create({
      data: {
        utilityId: fixA.utilityId,
        agreementNumber: number,
        accountId: fixA.accountId,
        commodityId: fixA.commodityId,
        startDate: new Date("2024-01-01"),
        status: "ACTIVE",
      },
    }),
  );
}

function read(opts: {
  agreementId: string;
  peakCode?: string;
  correctsReadId?: string;
  reading?: number | null;
}) {
  const { prisma } = prismaImports;
  const dial = opts.reading === undefined ? 1100 : opts.reading;
  return seedAsPlatform(async () =>
    prisma.meterRead.create({
      data: {
        utilityId: fixA.utilityId,
        meterId: fixA.meterId,
        serviceAgreementId: opts.agreementId,
        uomId: fixA.uomId,
        readDate: new Date("2026-05-03"),
        readDatetime: AT,
        reading: dial,
        priorReading: dial === null ? null : 1000,
        consumption: 100,
        readType: opts.correctsReadId ? "CORRECTED" : "ACTUAL",
        readSource: "MANUAL",
        peakCode: opts.peakCode ?? null,
        correctsReadId: opts.correctsReadId ?? null,
      },
    }),
  );
}

describe("one original meter read per instant (real DB)", () => {
  it("refuses the same read posted twice on a meter with no register", async () => {
    const sa = await agreement("SA-DUP");
    await read({ agreementId: sa.id });

    await expect(read({ agreementId: sa.id })).rejects.toMatchObject({ code: "P2002" });
  });

  it("allows a correction at the original's instant", async () => {
    const sa = await agreement("SA-CORR");
    const original = await read({ agreementId: sa.id });

    await expect(read({ agreementId: sa.id, correctsReadId: original.id, reading: 1110 })).resolves.toBeTruthy();
    // And a second correction of the same read: a chain stays possible.
    await expect(read({ agreementId: sa.id, correctsReadId: original.id, reading: 1111 })).resolves.toBeTruthy();
  });

  it("allows one instant on two agreements, as a transfer writes", async () => {
    const source = await agreement("SA-FROM");
    const target = await agreement("SA-TO");
    await read({ agreementId: source.id });

    await expect(read({ agreementId: target.id })).resolves.toBeTruthy();
  });

  it("allows one instant with two peak codes, as the interval rollup writes", async () => {
    const sa = await agreement("SA-TOU");
    await read({ agreementId: sa.id, peakCode: "peak", reading: null });

    await expect(read({ agreementId: sa.id, peakCode: "off_peak", reading: null })).resolves.toBeTruthy();
    await expect(read({ agreementId: sa.id, peakCode: "peak", reading: null })).rejects.toMatchObject({
      code: "P2002",
    });
  });
});
