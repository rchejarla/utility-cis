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
 * The three tables read routes stand on, and the rules the database
 * itself enforces on them.
 *
 * Every assertion here provokes the constraint and reads its name out of
 * the error, rather than inspecting the catalogue: a CHECK that exists
 * but was written against the wrong column would pass a catalogue read
 * and fail this.
 */

let pgContainer: StartedPostgreSqlContainer;
let prismaImports: typeof import("../../lib/prisma.js");

let fixA: TenantFixture;
let fixB: TenantFixture;

beforeAll(async () => {
  const booted = await bootPostgres({ utilities: [TENANT_A, TENANT_B] });
  pgContainer = booted.container;
  prismaImports = await import("../../lib/prisma.js");
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

/** Raw inserts: the point is what Postgres does, not what Prisma would validate first. */
async function insertRoute(over: {
  utilityId?: string;
  code?: string;
  billingCycleId?: string;
  origin?: string;
} = {}): Promise<string> {
  return seedAsPlatform(async () => {
    const rows = await prismaImports.prisma.$queryRawUnsafe<{ id: string }[]>(
      `INSERT INTO read_route (utility_id, code, name, billing_cycle_id, origin)
       VALUES ($1::uuid, $2, 'Route', $3::uuid, $4) RETURNING id`,
      over.utilityId ?? TENANT_A,
      over.code ?? "R-1",
      over.billingCycleId ?? fixA.billingCycleId,
      over.origin ?? "LOCAL",
    );
    return rows[0]!.id;
  });
}

async function insertStop(routeId: string, premiseId: string, sequence: number): Promise<void> {
  await seedAsPlatform(async () => {
    await prismaImports.prisma.$executeRawUnsafe(
      `INSERT INTO read_route_stop (utility_id, read_route_id, premise_id, sequence)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4)`,
      TENANT_A,
      routeId,
      premiseId,
      sequence,
    );
  });
}

async function insertSkip(over: {
  skipReason?: string;
  readDate?: string;
  resolvedAt?: string | null;
} = {}): Promise<void> {
  await seedAsPlatform(async () => {
    await prismaImports.prisma.$executeRawUnsafe(
      `INSERT INTO read_skip (utility_id, meter_id, read_date, skip_reason, resolved_at)
       VALUES ($1::uuid, $2::uuid, $3::date, $4, $5::timestamptz)`,
      TENANT_A,
      fixA.meterId,
      over.readDate ?? "2026-02-01",
      over.skipReason ?? "LOCKED_GATE",
      over.resolvedAt ?? null,
    );
  });
}

describe("read route schema", () => {
  it("forces RLS on all three tables", async () => {
    const rows = await seedAsPlatform(() =>
      prismaImports.prisma.$queryRaw<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }[]>`
        SELECT relname, relrowsecurity, relforcerowsecurity
        FROM pg_class
        WHERE relname IN ('read_route', 'read_route_stop', 'read_skip')
        ORDER BY relname`,
    );
    expect(rows).toEqual([
      { relname: "read_route", relrowsecurity: true, relforcerowsecurity: true },
      { relname: "read_route_stop", relrowsecurity: true, relforcerowsecurity: true },
      { relname: "read_skip", relrowsecurity: true, relforcerowsecurity: true },
    ]);
  });

  it("refuses an origin outside LOCAL and EXTERNAL", async () => {
    await expect(insertRoute({ origin: "SOMETHING" })).rejects.toThrow(/read_route_origin_known/);
    await expect(insertRoute({ origin: "EXTERNAL", code: "R-2" })).resolves.toBeTruthy();
  });

  it("refuses a skip_reason outside the seven", async () => {
    await expect(insertSkip({ skipReason: "RAINING" })).rejects.toThrow(/read_skip_reason_known/);
    for (const [i, reason] of [
      "LOCKED_GATE",
      "DOG",
      "BURIED",
      "UNREADABLE",
      "OBSTRUCTED",
      "APPEARS_VACANT",
      "NO_METER_FOUND",
    ].entries()) {
      await insertSkip({ skipReason: reason, readDate: `2026-03-0${i + 1}` });
    }
  });

  it("refuses a second route with the same code in one tenant", async () => {
    await insertRoute({ code: "R-1" });
    await expect(insertRoute({ code: "R-1" })).rejects.toThrow(/read_route_utility_id_code_key/);
  });

  it("refuses a second stop at the same sequence on one route", async () => {
    const route = await insertRoute();
    await insertStop(route, fixA.premiseId, 1);
    const other = await seedAsPlatform(() =>
      prismaImports.prisma.premise.create({
        data: {
          utilityId: TENANT_A,
          addressLine1: "2 Test Lane",
          city: "Testville",
          state: "TS",
          zip: "00000",
          premiseType: "RESIDENTIAL",
          commodityIds: [fixA.commodityId],
          status: "ACTIVE",
        },
        select: { id: true },
      }).then((p) => p.id),
    );
    await expect(insertStop(route, other, 1)).rejects.toThrow(/read_route_stop_sequence_key/);
  });

  it("refuses the same premise twice on one route", async () => {
    const route = await insertRoute();
    await insertStop(route, fixA.premiseId, 1);
    await expect(insertStop(route, fixA.premiseId, 2)).rejects.toThrow(/read_route_stop_premise_key/);
  });

  it("refuses a route whose billing cycle belongs to another tenant", async () => {
    await expect(insertRoute({ billingCycleId: fixB.billingCycleId })).rejects.toThrow(
      /read_route_billing_cycle_id_fkey/,
    );
  });

  it("refuses a second open skip for one meter on one date, but not once the first is resolved", async () => {
    await insertSkip();
    await expect(insertSkip()).rejects.toThrow(/read_skip_one_open_per_meter_day/);
    await insertSkip({ readDate: "2026-02-02" });
  });

  it("keeps a resolved skip as history beside a new open one", async () => {
    await insertSkip({ resolvedAt: "2026-02-02T00:00:00Z" });
    await insertSkip();
    await insertSkip({ resolvedAt: "2026-02-03T00:00:00Z" });
  });
});
