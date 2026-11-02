import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import {
  bootPostgres,
  resetDb,
  makeTenantFixture,
  TENANT_A,
  type TenantFixture,
  truncateTables,
  seedAsPlatform,
  endAdminPool,
} from "./_effective-dating-fixtures.js";
import { runAsTenant } from "../../lib/tenant-context.js";

/**
 * Tenant-configured seasons, against a real database (spec 26,
 * TOU-SEA-1 – 3).
 *
 * The unit tests prove the arithmetic — wrapping, tiling, 29 February.
 * What only a database can answer is the part that decides whether this
 * migration was safe: that `loadBase` finds the set the migration
 * seeded, that an unpublished set is invisible to rating exactly as an
 * unpublished rate schedule is, and that a tenant with no set resolves
 * to no season rather than to a guess.
 */

let pgContainer: StartedPostgreSqlContainer;
let prismaImports: typeof import("../../lib/prisma.js");
let loadBaseFn: typeof import("../../lib/rate-engine-loaders/load-base.js")["loadBase"];
let fixA: TenantFixture;
let saId: string;

const PERIOD = {
  startDate: new Date(Date.UTC(2026, 5, 1)), // 1 June — summer, as seeded
  endDate: new Date(Date.UTC(2026, 5, 30)),
};

beforeAll(async () => {
  const booted = await bootPostgres({ utilities: [TENANT_A] });
  pgContainer = booted.container;
  prismaImports = await import("../../lib/prisma.js");
  ({ loadBase: loadBaseFn } = await import(
    "../../lib/rate-engine-loaders/load-base.js"
  ));
}, 180_000);

afterAll(async () => {
  await prismaImports?.prisma.$disconnect().catch(() => {});
  await prismaImports?.pool.end().catch(() => {});
  await endAdminPool();
  await pgContainer?.stop().catch(() => {});
});

beforeEach(() =>
  seedAsPlatform(async () => {
    const { prisma } = prismaImports;
    await resetDb();
    await truncateTables("season, season_set");
    fixA = await makeTenantFixture(prisma, TENANT_A);

    const sa = await prisma.serviceAgreement.create({
      data: {
        utilityId: TENANT_A,
        agreementNumber: "SA-SEASON",
        accountId: fixA.accountId,
        commodityId: fixA.commodityId,
        startDate: new Date("2025-01-01"),
        status: "ACTIVE",
      },
    });
    await prisma.servicePoint.create({
      data: {
        utilityId: TENANT_A,
        serviceAgreementId: sa.id,
        premiseId: fixA.premiseId,
        type: "METERED",
        status: "ACTIVE",
        startDate: new Date("2025-01-01"),
      },
    });
    saId = sa.id;
  }),
);

/** The set the `season_sets` migration seeds for every tenant. */
async function seedDefaultSet(opts: { published?: boolean } = {}) {
  const { prisma } = prismaImports;
  return prisma.seasonSet.create({
    data: {
      utilityId: TENANT_A,
      name: "Default",
      effectiveDate: new Date("2000-01-01"),
      publishedAt: opts.published === false ? null : new Date(),
      seasons: {
        create: [
          {
            seasonCode: "summer",
            label: "Summer",
            startMonth: 5,
            startDay: 1,
            endMonth: 10,
            endDay: 31,
            sortOrder: 1,
          },
          {
            seasonCode: "winter",
            label: "Winter",
            startMonth: 11,
            startDay: 1,
            endMonth: 4,
            endDay: 30,
            sortOrder: 2,
          },
        ],
      },
    },
  });
}

const load = () =>
  runAsTenant(TENANT_A, async () =>
    loadBaseFn(prismaImports.prisma, saId, PERIOD, TENANT_A),
  );

describe("loadBase and the tenant's seasons", () => {
  it("carries the published set's seasons into the rating context", () =>
    seedAsPlatform(async () => {
      await seedDefaultSet();
      const base = await load();

      expect(base.seasons.map((s) => s.seasonCode)).toEqual(["summer", "winter"]);
      expect(base.seasons[0]).toMatchObject({
        startMonth: 5,
        startDay: 1,
        endMonth: 10,
        endDay: 31,
      });
      expect(base.seasonSpanRule).toBe("START_DATE");
    }), 120_000);

  it("keeps an unpublished set out of rating, as a draft tariff is", () =>
    seedAsPlatform(async () => {
      /*
       * The same rule `bill-segment.service` applies to rate schedules:
       * a draft must never price a bill. A season set decides what a
       * seasonal tariff charges, so it earns the same treatment.
       */
      await seedDefaultSet({ published: false });
      const base = await load();
      expect(base.seasons).toEqual([]);
    }), 120_000);

  it("ignores a set that is not yet in force for the period", () =>
    seedAsPlatform(async () => {
      const { prisma } = prismaImports;
      await seedDefaultSet();
      // A later set, published, but effective after this period starts.
      await prisma.seasonSet.create({
        data: {
          utilityId: TENANT_A,
          name: "Revised 2027",
          effectiveDate: new Date("2027-01-01"),
          publishedAt: new Date(),
          seasons: {
            create: [
              {
                seasonCode: "all_year",
                label: "All year",
                startMonth: 1,
                startDay: 1,
                endMonth: 12,
                endDay: 31,
              },
            ],
          },
        },
      });

      const base = await load();
      expect(base.seasons.map((s) => s.seasonCode)).toEqual(["summer", "winter"]);
    }), 120_000);

  it("takes the most recent set in force when several are", () =>
    seedAsPlatform(async () => {
      const { prisma } = prismaImports;
      await seedDefaultSet();
      await prisma.seasonSet.create({
        data: {
          utilityId: TENANT_A,
          name: "Revised 2025",
          effectiveDate: new Date("2025-01-01"),
          publishedAt: new Date(),
          seasons: {
            create: [
              {
                seasonCode: "all_year",
                label: "All year",
                startMonth: 1,
                startDay: 1,
                endMonth: 12,
                endDay: 31,
              },
            ],
          },
        },
      });

      const base = await load();
      expect(base.seasons.map((s) => s.seasonCode)).toEqual(["all_year"]);
    }), 120_000);

  it("resolves to no season for a tenant with no set at all", () =>
    seedAsPlatform(async () => {
      // Rather than to a guess: a seasonal tariff then simply does not
      // match, instead of pricing against a season nobody chose.
      const base = await load();
      expect(base.seasons).toEqual([]);
      expect(base.seasonSpanRule).toBe("START_DATE");
    }), 120_000);
});

describe("the database's own guards", () => {
  it("refuses two seasons with the same code in one set", () =>
    seedAsPlatform(async () => {
      const { prisma } = prismaImports;
      const set = await seedDefaultSet();
      await expect(
        prisma.season.create({
          data: {
            utilityId: TENANT_A,
            seasonSetId: set.id,
            seasonCode: "summer",
            label: "Summer again",
            startMonth: 1,
            startDay: 1,
            endMonth: 2,
            endDay: 1,
          },
        }),
      ).rejects.toBeTruthy();
    }), 120_000);

  it("refuses a month that is not a month", () =>
    seedAsPlatform(async () => {
      const { prisma } = prismaImports;
      const set = await seedDefaultSet();
      await expect(
        prisma.season.create({
          data: {
            utilityId: TENANT_A,
            seasonSetId: set.id,
            seasonCode: "nope",
            label: "Nope",
            startMonth: 13,
            startDay: 1,
            endMonth: 12,
            endDay: 31,
          },
        }),
      ).rejects.toBeTruthy();
    }), 120_000);

  it("refuses a span rule it has no behaviour for", () =>
    seedAsPlatform(async () => {
      const { prisma } = prismaImports;
      await expect(
        prisma.seasonSet.create({
          data: {
            utilityId: TENANT_A,
            name: "Bad rule",
            effectiveDate: new Date("2026-01-01"),
            spanRule: "WHATEVER",
          },
        }),
      ).rejects.toBeTruthy();
    }), 120_000);
});
