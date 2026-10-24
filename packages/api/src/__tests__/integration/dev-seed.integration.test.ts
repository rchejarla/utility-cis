import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { bootPostgres } from "./_effective-dating-fixtures.js";

/**
 * `seed.js` — the database every developer actually works against.
 *
 * It had no test. Nothing ran it, nothing looked at what it produced,
 * and the consequences took an evening to find by hand: no meter
 * carried a size, so Bozeman's water service charge — `lookup` pricing
 * by `meter:size:<id>` — failed every water account outright; the
 * supply index was published for one quarter only; the demo bills
 * claimed periods whose reads they never stamped, so the first real run
 * swept twenty-one months into one segment and billed $530,257.75 for a
 * single house; and the cleanup could not delete a `bill_document` or a
 * `billing_run`, so a reseed crashed on any database where a bill had
 * been rendered or a run started.
 *
 * Every one of those is a property of the seed's output, and none of
 * them was visible from reading it. The other seed —
 * `packages/shared/prisma/seed.ts`, which the rest of these suites run
 * — did set meter sizes, and that is precisely why no existing test
 * could see the gap: the fixture had what the dev database lacked.
 *
 * So this asserts the one thing a seeded database is for: that a
 * billing run over it produces a bill, with figures of the right
 * magnitude. It is deliberately end-to-end rather than a list of column
 * checks, because every fault above presented as "the run skipped
 * everything" and not as a missing field.
 */

vi.mock("../../lib/queues.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/queues.js")>()),
  enqueueSafely: vi.fn(async () => "test-job-id"),
}));

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../../../..");

const UTILITY_ID = "00000000-0000-4000-8000-000000000001";
const ACTOR_ID = "00000000-0000-4000-8000-000000000091";

let pgContainer: StartedPostgreSqlContainer;
let prismaImports: typeof import("../../lib/prisma.js");
let svc: typeof import("../../services/billing-run.service.js");

beforeAll(async () => {
  const booted = await bootPostgres();
  // RLS-OPT-OUT: this suite still connects as the migration owner.
  // It calls services directly rather than through a route, so there is
  // no middleware to enter a tenant scope and each test would need its
  // own `runAsTenant` — see `bill-list.integration.test.ts` for the
  // shape that conversion takes. Counted by
  // `src/__tests__/app/rls-suite-coverage.test.ts`, which only lets the
  // number go down.
  process.env.DATABASE_URL = booted.dbUrl;
  pgContainer = booted.container;

  // The real thing, run the way a developer runs it. It shells out to
  // `provision-tenant.ts` for the tenant itself, which is part of what
  // is under test: a seed that cannot provision produces a utility with
  // no modules and no roles.
  execSync("node seed.js", {
    cwd: REPO_ROOT,
    env: { ...process.env, DATABASE_URL: booted.dbUrl },
    stdio: "pipe",
  });

  prismaImports = await import("../../lib/prisma.js");
  svc = await import("../../services/billing-run.service.js");
}, 600_000);

afterAll(async () => {
  // `$disconnect` does not dispose a pool the application owns — that
  // is the driver-adapter contract — so the pools are ended here.
  // Without it the container stops while connections are live and
  // Postgres reports 57P01 as an unhandled error after a green run.
  await prismaImports?.prisma.$disconnect().catch(() => {});
  await prismaImports?.pool.end().catch(() => {});
  await pgContainer?.stop().catch(() => {});
});

describe("the dev seed produces a database that can bill", () => {
  it("rates a run end to end, at residential magnitudes", async () => {
    const { prisma } = prismaImports;
    const cycle = await prisma.billingCycle.findFirstOrThrow({
      where: { utilityId: UTILITY_ID, cycleCode: "R01" },
    });

    const run = await svc.createBillingRun(UTILITY_ID, ACTOR_ID, "Seed test", {
      billingCycleId: cycle.id,
    });
    const done = await svc.processBillingRun({
      runId: run.id,
      utilityId: UTILITY_ID,
      actorId: ACTOR_ID,
      actorName: "Seed test",
    });

    // Nothing may fail. A skip is ordinary — the seed gives most meters
    // no reads — but a failure means the seed produced data the engine
    // cannot rate, which is the whole class of fault this file exists
    // for.
    expect(done.failedCount).toBe(0);
    expect(done.billedCount).toBeGreaterThan(0);

    const billed = await prisma.billingRunItem.findMany({
      where: { billingRunId: run.id, status: "BILLED" },
    });
    for (const item of billed) {
      // Tens of dollars. $530,257.75 and $33,467.69 both cleared a
      // "greater than zero" assertion earlier today.
      expect(Number(item.total)).toBeGreaterThan(1);
      expect(Number(item.total)).toBeLessThan(500);
      // One month, not a catch-up from the agreement's start date.
      const days =
        (item.servicePeriodEnd!.getTime() - item.servicePeriodStart!.getTime()) / 86_400_000;
      expect(days).toBeLessThan(45);
    }
  }, 600_000);

  it("leaves later reads for the next period", async () => {
    // A seed that stamps every read leaves a run nothing to do, and one
    // that stamps none makes the first run a catch-up over the whole
    // meter history. Both were true of this file today.
    const { prisma } = prismaImports;
    const unbilled = await prisma.meterRead.count({
      where: { utilityId: UTILITY_ID, billedAt: null },
    });
    expect(unbilled).toBeGreaterThan(0);
  }, 120_000);

  it("gives every water meter a size its tariff can price", async () => {
    /*
     * Not a restatement of the seed: the sizes have to be keys of the
     * tariff's own lookup table. A meter recorded as 0.625 instead of
     * `5/8"` passes any "is it set" check and still fails to bill.
     */
    const { prisma } = prismaImports;
    const component = await prisma.rateComponent.findFirstOrThrow({
      where: { utilityId: UTILITY_ID, kindCode: "service_charge", label: "Water Service Charge" },
    });
    const table = (component.pricing as { table: Record<string, number> }).table;

    const water = await prisma.meter.findMany({
      where: { utilityId: UTILITY_ID, meterNumber: { startsWith: "WM-" } },
      select: { meterNumber: true, customFields: true },
    });
    expect(water.length).toBeGreaterThan(0);
    for (const meter of water) {
      const size = (meter.customFields as Record<string, unknown>).size;
      expect(Object.keys(table)).toContain(size);
    }
  }, 120_000);

  it("can be re-run over a database that has billed", async () => {
    // `bill_document` and `billing_run` are RESTRICT parents the cleanup
    // never deleted. No seeded database had a row in either until a bill
    // was rendered and a run was started by hand, after which the seed
    // could not run at all. The run above has just created both.
    const rerun = () =>
      execSync("node seed.js", {
        cwd: REPO_ROOT,
        env: { ...process.env, DATABASE_URL: pgContainer.getConnectionUri() },
        stdio: "pipe",
      });
    expect(rerun).not.toThrow();
  }, 600_000);
});
