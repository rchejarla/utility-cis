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
  serviceClassFor,
} from "./_effective-dating-fixtures.js";

/**
 * The three tables read routes stand on, and the rules the database
 * itself enforces on them.
 *
 * Apart from the first test, which reads the catalogue for RLS, every
 * assertion here provokes the constraint and reads its name out of the
 * error: a CHECK that exists but was written against the wrong column
 * would pass a catalogue read and fail this. The delete test does the
 * same for the three ON DELETE rules, by deleting.
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
    const rows = await seedAsPlatform(async () =>
      await prismaImports.prisma.$queryRaw<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }[]>`
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

  it("makes the sequence key deferrable and the premise key not", async () => {
    const rows = await seedAsPlatform(async () =>
      await prismaImports.prisma.$queryRaw<{ conname: string; condeferrable: boolean; condeferred: boolean }[]>`
        SELECT conname, condeferrable, condeferred FROM pg_constraint
        WHERE conname IN ('read_route_stop_sequence_key', 'read_route_stop_premise_key')
        ORDER BY conname`,
    );
    expect(rows).toEqual([
      { conname: "read_route_stop_premise_key", condeferrable: false, condeferred: false },
      { conname: "read_route_stop_sequence_key", condeferrable: true, condeferred: false },
    ]);
  });

  /**
   * Two stops, because one row can never collide with itself.
   *
   * What this key's DEFERRABLE buys comes in two strengths, and the
   * tests below separate them. INITIALLY IMMEDIATE alone moves the check
   * from each row to the end of the *statement*, which is all a single
   * bulk `sequence + 1` needs. A multi-statement resequence passes
   * through duplicates between statements and needs SET CONSTRAINTS
   * DEFERRED as well.
   */
  async function twoStopsOnARoute(): Promise<{ route: string; first: string; second: string }> {
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
    await insertStop(route, other, 2);
    return { route, first: fixA.premiseId, second: other };
  }

  const inTx = (fn: (tx: { $executeRawUnsafe: (q: string, ...v: unknown[]) => Promise<number> }) => Promise<void>) =>
    seedAsPlatform(async () => {
      await prismaImports.prisma.$transaction(async (tx) => fn(tx));
    });

  const bump = (route: string) => (tx: { $executeRawUnsafe: (q: string, ...v: unknown[]) => Promise<number> }) =>
    tx.$executeRawUnsafe(
      `UPDATE read_route_stop SET sequence = sequence + 1 WHERE read_route_id = $1::uuid AND sequence >= 1`,
      route,
    ).then(() => undefined);

  const sequences = (route: string) =>
    seedAsPlatform(async () =>
      (await prismaImports.prisma.readRouteStop.findMany({
        where: { readRouteId: route },
        orderBy: { sequence: "asc" },
        select: { sequence: true },
      })).map((r) => r.sequence),
    );

  it("lets one bulk UPDATE resequence a route without any SET CONSTRAINTS", async () => {
    const { route } = await twoStopsOnARoute();
    await inTx(bump(route));
    expect(await sequences(route)).toEqual([2, 3]);
  });

  it("is what makes that possible: the same UPDATE on a plain unique key raises", async () => {
    // A scratch table with an ordinary, non-deferrable unique, so the
    // contrast is the constraint's flag and nothing else.
    await expect(
      inTx(async (tx) => {
        await tx.$executeRawUnsafe(`CREATE TEMP TABLE scratch_stop (seq int, CONSTRAINT scratch_stop_seq_key UNIQUE (seq)) ON COMMIT DROP`);
        await tx.$executeRawUnsafe(`INSERT INTO scratch_stop VALUES (1), (2)`);
        await tx.$executeRawUnsafe(`UPDATE scratch_stop SET seq = seq + 1`);
      }),
    ).rejects.toThrow(/scratch_stop_seq_key/);
  });

  it("refuses a two-statement resequence unless the key is deferred", async () => {
    const { route, first, second } = await twoStopsOnARoute();
    const steps = (tx: { $executeRawUnsafe: (q: string, ...v: unknown[]) => Promise<number> }) =>
      tx.$executeRawUnsafe(`UPDATE read_route_stop SET sequence = 2 WHERE read_route_id = $1::uuid AND premise_id = $2::uuid`, route, first)
        .then(() => tx.$executeRawUnsafe(`UPDATE read_route_stop SET sequence = 3 WHERE read_route_id = $1::uuid AND premise_id = $2::uuid`, route, second))
        .then(() => undefined);

    await expect(inTx(steps)).rejects.toThrow(/read_route_stop_sequence_key/);
    expect(await sequences(route)).toEqual([1, 2]);

    await inTx(async (tx) => {
      await tx.$executeRawUnsafe(`SET CONSTRAINTS "read_route_stop_sequence_key" DEFERRED`);
      await steps(tx);
    });
    expect(await sequences(route)).toEqual([2, 3]);
  });

  it("deletes a route's stops, and only forgets the route on skips and reads", async () => {
    const { prisma } = prismaImports;
    const route = await insertRoute();
    await insertStop(route, fixA.premiseId, 1);

    const { skipId, readId, readDatetime } = await seedAsPlatform(async () => {
      const skip = await prisma.readSkip.create({
        data: {
          utilityId: TENANT_A,
          meterId: fixA.meterId,
          readRouteId: route,
          readDate: new Date("2026-02-01"),
          skipReason: "DOG",
        },
        select: { id: true },
      });
      const agreement = await prisma.serviceAgreement.create({
        data: {
          utilityId: TENANT_A,
          agreementNumber: "SA-DEL-1",
          accountId: fixA.accountId,
          commodityId: fixA.commodityId,
          rateServiceClassId: await serviceClassFor(prisma, TENANT_A, fixA.commodityId),
          startDate: new Date("2025-01-01"),
          status: "ACTIVE",
        },
        select: { id: true },
      });
      const readDatetime = new Date("2026-02-01T12:00:00Z");
      const read = await prisma.meterRead.create({
        data: {
          utilityId: TENANT_A,
          meterId: fixA.meterId,
          serviceAgreementId: agreement.id,
          uomId: fixA.uomId,
          readDate: new Date("2026-02-01"),
          readDatetime,
          reading: 100,
          priorReading: 50,
          consumption: 50,
          readType: "ACTUAL",
          readSource: "AMR",
          routeId: route,
        },
        select: { id: true },
      });
      return { skipId: skip.id, readId: read.id, readDatetime };
    });

    await seedAsPlatform(async () => {
      await prisma.$executeRawUnsafe(`DELETE FROM read_route WHERE id = $1::uuid`, route);
    });

    await seedAsPlatform(async () => {
      expect(await prisma.readRouteStop.findMany({ where: { readRouteId: route } })).toEqual([]);
      const skip = await prisma.readSkip.findFirst({ where: { id: skipId } });
      expect(skip).toMatchObject({ id: skipId, readRouteId: null, utilityId: TENANT_A });
      const read = await prisma.meterRead.findFirst({ where: { id: readId, readDatetime } });
      expect(read).toMatchObject({ id: readId, routeId: null, utilityId: TENANT_A });
    });
  });
});
