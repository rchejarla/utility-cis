import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import pg from "pg";
import { bootPostgres, TENANT_A, TENANT_B } from "./_effective-dating-fixtures.js";

/**
 * What authority a queue's work runs under.
 *
 * Task 7 of `docs/superpowers/plans/2026-10-24-rls-enforcement.md`.
 *
 * Six of the eight queues sweep every tenant in one pass. Under an
 * enforcing policy a sweep with no tenant set reads *nothing* and
 * reports success — it flips no rows, logs no error, and the next
 * morning nobody's SLA has breached. That is the failure this task
 * exists to prevent, and it is why the assertion below is on work
 * **done** rather than on the absence of an exception.
 *
 * Everything runs as `cis_app`, never the container's superuser, since a
 * superuser is exempt from RLS and would pass either way.
 */

const utilityId = TENANT_A;
const otherUtility = TENANT_B;

let pgContainer: StartedPostgreSqlContainer;
let prismaImports: typeof import("../../lib/prisma.js");

beforeAll(async () => {
  const booted = await bootPostgres({ utilities: [utilityId, otherUtility] });
  pgContainer = booted.container;

  const superuserPool = new pg.Pool({ connectionString: booted.dbUrl });
  try {
    await superuserPool.query(`ALTER ROLE cis_app LOGIN PASSWORD 'probe'`);
    await superuserPool.query(`ALTER ROLE cis_platform LOGIN PASSWORD 'probe'`);

    const { PrismaClient } = await import("@utility-cis/shared/src/generated/prisma");
    const { PrismaPg } = await import("@prisma/adapter-pg");
    const seeder = new PrismaClient({ adapter: new PrismaPg(superuserPool) });
    try {
      await seeder.serviceRequestTypeDef.createMany({
        data: [{ code: "LEAK_REPORT", label: "Leak Report" }],
        skipDuplicates: true,
      });
      // The sweep joins `utility_config` and requires
      // `sla_breach_sweep_enabled`, so a tenant with no config row is
      // skipped entirely — which is the tenant opt-out working, and was
      // why this first flipped nothing at all.
      for (const uid of [utilityId, otherUtility]) {
        await seeder.utilityConfig.create({
          data: { utilityId: uid, slaBreachSweepEnabled: true },
        });
      }

      // One overdue, unbreached request per tenant. A sweep that respects
      // only one tenant flips one; a sweep with no authority flips none.
      for (const [i, uid] of [utilityId, otherUtility].entries()) {
        await seeder.serviceRequest.create({
          data: {
            utilityId: uid,
            requestNumber: `SR-SWEEP-${i}`,
            requestType: "LEAK_REPORT",
            priority: "HIGH",
            status: "IN_PROGRESS",
            description: "overdue",
            slaDueAt: new Date("2020-01-01T00:00:00Z"),
            slaBreached: false,
          },
        });
      }
    } finally {
      await seeder.$disconnect().catch(() => {});
    }
  } finally {
    await superuserPool.end();
  }

  const asRoleUrl = (role: string) => booted.dbUrl.replace(/\/\/[^@]+@/, `//${role}:probe@`);
  process.env.DATABASE_URL = asRoleUrl("cis_app");
  process.env.DATABASE_URL_PLATFORM = asRoleUrl("cis_platform");

  prismaImports = await import("../../lib/prisma.js");
}, 240_000);

afterAll(async () => {
  await prismaImports?.prisma.$disconnect().catch(() => {});
  await pgContainer?.stop().catch(() => {});
});

describe("a queue's authority", () => {
  /*
   * The scope is derived from `QUEUE_TENANCY` rather than applied by
   * hand at each of the eight builders. That is the point: the plan
   * asked for the declaration and the wrapping to agree, and deriving
   * one from the other is the only way they cannot drift. A seventh
   * all-tenants queue gets platform authority by being declared one.
   */
  it("runs an all-tenants queue's work as the platform", async () => {
    const { scopedJob } = await import("../../lib/queue-scope.js");
    const { prisma } = prismaImports;
    const handler = scopedJob("sla-breach-sweep", async () => {
      const [{ u }] = await prisma.$queryRaw<{ u: string }[]>`SELECT current_user AS u`;
      return u;
    });
    expect(await handler({ data: {} } as never)).toBe("cis_platform");
  });

  it("runs a per-tenant queue's work as that tenant", async () => {
    const { scopedJob } = await import("../../lib/queue-scope.js");
    const { prisma } = prismaImports;
    const handler = scopedJob("billing-runs", async () => {
      const [{ u, t }] = await prisma.$queryRaw<{ u: string; t: string | null }[]>`
        SELECT current_user AS u, current_setting('app.current_utility_id', true) AS t`;
      return { u, t };
    });
    expect(await handler({ data: { utilityId } } as never)).toEqual({
      u: "cis_app",
      t: utilityId,
    });
  });

  /*
   * A per-tenant job with no tenant in its payload is a programming
   * error, and it must not quietly become platform authority — that
   * would be the one mistake able to turn a scoped sweep into a
   * cross-tenant one.
   */
  it("refuses a per-tenant job that names no tenant", async () => {
    const { scopedJob } = await import("../../lib/queue-scope.js");
    const handler = scopedJob("billing-runs", async () => "ran");
    await expect(handler({ data: {} } as never)).rejects.toThrow(/utilityId/i);
  });

  /*
   * And the thing it is all for: the sweep flips BOTH tenants' rows.
   * Asserted as a count, because zero is what a sweep without authority
   * returns and it returns it successfully.
   */
  it("sweeps every tenant, not none and not one", async () => {
    const { scopedJob } = await import("../../lib/queue-scope.js");
    const { sweepBreachedSRs } = await import("../../services/service-request.service.js");
    const handler = scopedJob("sla-breach-sweep", async () =>
      sweepBreachedSRs(new Date("2026-01-01T00:00:00Z")),
    );

    const result = (await handler({ data: {} } as never)) as { flipped: number };
    expect(result.flipped).toBe(2);

    const { prisma } = prismaImports;
    const { runAsPlatform } = await import("../../lib/tenant-context.js");
    const breached = await runAsPlatform(async () =>
      prisma.serviceRequest.findMany({
        where: { slaBreached: true },
        select: { utilityId: true },
      }),
    );
    expect(breached.map((r) => r.utilityId).sort()).toEqual([utilityId, otherUtility].sort());
  });
});
