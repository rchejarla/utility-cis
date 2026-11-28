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
  adminQuery,
  serviceClassFor,
} from "./_effective-dating-fixtures.js";

/**
 * `before_one_live_service_per_premise` — two live agreements may not
 * both serve one premise for one commodity over the same days.
 *
 * Against a real database because the rule **is** a database object: a
 * plpgsql trigger that joins `service_point` to `service_agreement` for
 * the commodity and the status. There is nothing in TypeScript to unit
 * test, and that is the point of putting it there — it holds for the four
 * paths that open a service point and for anything added later.
 *
 * The migration's own comment carries why this is a trigger rather than
 * the `no_overlapping_active_sa` exclusion constraint that spec 05
 * claimed existed and the database did not have.
 *
 * **This is the rewrite that file was parked for.**
 * `effective-dating-constraints.integration.test.ts.pending-rewrite`
 * covered that constraint, and its first line reads "Rewrite scheduled
 * for Slice 3 — invariant moves to service_point". So moving the rule
 * onto the service point was the plan all along; what happened instead
 * is that the only test of the constraint was disabled, the 2026-10-18
 * squash dropped the constraint, and nothing was left to notice. A
 * parked test is the one place a vanished guarantee cannot be seen from.
 *
 * That file still covers `spm_no_double_install` (which does exist, under
 * that name) and the lifecycle trigger (which `cascade-close` also
 * covers), so it stays where it is rather than being deleted here.
 *
 * What each case pins:
 *   1. A second live point at the same premise and commodity is refused.
 *   2. A different commodity at the same premise is fine — a premise has
 *      water and sewer and electricity at once.
 *   3. A different premise is fine.
 *   4. A successor starting the day the predecessor ends is fine: `[)`,
 *      so a clean hand-over is not an overlap.
 *   5. A successor that starts *before* the predecessor ends is refused.
 *   6. A terminal agreement does not take part, on either side.
 *   7. Reopening a closed point by clearing its end date is judged too —
 *      the trigger fires on UPDATE, not only INSERT.
 */

let pgContainer: StartedPostgreSqlContainer;
let prismaImports: typeof import("../../lib/prisma.js");
let fixA: TenantFixture;
let premiseB: string;
let sewerCommodityId: string;

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
  const { prisma } = prismaImports;
  await resetDb();
  fixA = await makeTenantFixture(prisma, TENANT_A);

  await seedAsPlatform(async () => {
    const premise = await prisma.premise.create({
      data: {
        utilityId: fixA.utilityId,
        addressLine1: "2 Other Street",
        city: "Testville",
        state: "TS",
        zip: "00000",
        premiseType: "RESIDENTIAL",
        commodityIds: [fixA.commodityId],
        status: "ACTIVE",
      },
    });
    premiseB = premise.id;

    const sewer = await prisma.commodity.create({
      data: { utilityId: fixA.utilityId, code: "SEWER-T", name: "Sewer" },
    });
    sewerCommodityId = sewer.id;
  });
});

/** An agreement, with no service point of its own yet. */
async function agreement(opts: {
  number: string;
  commodityId?: string;
  status?: "PENDING" | "ACTIVE" | "FINAL";
  startDate?: string;
  endDate?: string;
}) {
  const { prisma } = prismaImports;
  return seedAsPlatform(async () =>
    prisma.serviceAgreement.create({
      data: {
        utilityId: fixA.utilityId,
        agreementNumber: opts.number,
        accountId: fixA.accountId,
        commodityId: opts.commodityId ?? fixA.commodityId,
        rateServiceClassId: await serviceClassFor(
          prisma,
          fixA.utilityId,
          opts.commodityId ?? fixA.commodityId,
        ),
        startDate: new Date(opts.startDate ?? "2024-01-01"),
        endDate: opts.endDate ? new Date(opts.endDate) : null,
        status: opts.status ?? "ACTIVE",
      },
    }),
  );
}

/** A service point on it. The write under test. */
function openPoint(opts: {
  agreementId: string;
  premiseId: string;
  startDate?: string;
  endDate?: string;
}) {
  const { prisma } = prismaImports;
  return seedAsPlatform(async () =>
    prisma.servicePoint.create({
      data: {
        utilityId: fixA.utilityId,
        serviceAgreementId: opts.agreementId,
        premiseId: opts.premiseId,
        type: "METERED",
        status: "ACTIVE",
        startDate: new Date(opts.startDate ?? "2024-01-01"),
        endDate: opts.endDate ? new Date(opts.endDate) : null,
      },
    }),
  );
}

const REFUSAL = /ONE_LIVE_SERVICE_PER_PREMISE/;

describe("one live service per premise and commodity (real DB)", () => {
  it("refuses a second live point at the same premise for the same commodity", async () => {
    const first = await agreement({ number: "SA-ONE" });
    await openPoint({ agreementId: first.id, premiseId: fixA.premiseId });

    const second = await agreement({ number: "SA-TWO" });
    /*
     * The whole sentence, not just the marker: it has to name the
     * agreement already there, or an operator cannot act on it. This is
     * also what pins the choice of `check_violation` over
     * `unique_violation` — Prisma recognises 23505 and replaces the
     * message with "Unique constraint failed", so with that code this
     * assertion fails while the write is still correctly refused.
     * `middleware/error-handler.ts` turns this into the 409 a caller
     * sees.
     */
    await expect(
      openPoint({ agreementId: second.id, premiseId: fixA.premiseId }),
    ).rejects.toThrow(/ONE_LIVE_SERVICE_PER_PREMISE: agreement SA-ONE already serves this premise/);
  });

  /*
   * Two CSRs opening service at one address at once. Under READ COMMITTED
   * neither transaction's check can see the other's uncommitted point, so
   * a check without a lock lets both commit. The first transaction is held
   * open after its insert; the second must wait for it and then be refused
   * — without the advisory lock (20261127090000) it commits at once and
   * this fails with two fulfilled.
   */
  it("refuses the second of two openings that race at one premise", async () => {
    const { prisma } = prismaImports;
    const a = await agreement({ number: "SA-RACE-A" });
    const b = await agreement({ number: "SA-RACE-B" });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

    const insert = (agreementId: string, holdOpen: Promise<void>) =>
      seedAsPlatform(async () =>
        prisma.$transaction(
          async (tx) => {
            await tx.servicePoint.create({
              data: {
                utilityId: fixA.utilityId,
                serviceAgreementId: agreementId,
                premiseId: fixA.premiseId,
                type: "METERED",
                status: "ACTIVE",
                startDate: new Date("2024-01-01"),
              },
            });
            await holdOpen;
          },
          { timeout: 30_000, maxWait: 30_000 },
        ),
      );

    const first = insert(a.id, gate);
    await pause(750); // the first has inserted and holds the lock
    const second = insert(b.id, Promise.resolve());
    await pause(750); // the second is waiting on it, or — unlocked — already committed
    release();
    const settled = await Promise.allSettled([first, second]);

    expect(settled[0].status).toBe("fulfilled");
    expect(settled[1].status).toBe("rejected");
    expect(String((settled[1] as PromiseRejectedResult).reason)).toMatch(
      /ONE_LIVE_SERVICE_PER_PREMISE: agreement SA-RACE-A/,
    );
    const live = await seedAsPlatform(async () =>
      prisma.servicePoint.count({ where: { serviceAgreementId: { in: [a.id, b.id] } } }),
    );
    expect(live).toBe(1);
  });

  it("allows a different commodity at the same premise", async () => {
    const water = await agreement({ number: "SA-WATER" });
    await openPoint({ agreementId: water.id, premiseId: fixA.premiseId });

    const sewer = await agreement({ number: "SA-SEWER", commodityId: sewerCommodityId });
    const point = await openPoint({ agreementId: sewer.id, premiseId: fixA.premiseId });
    expect(point.premiseId).toBe(fixA.premiseId);
  });

  it("allows the same commodity at a different premise", async () => {
    const here = await agreement({ number: "SA-HERE" });
    await openPoint({ agreementId: here.id, premiseId: fixA.premiseId });

    const there = await agreement({ number: "SA-THERE" });
    const point = await openPoint({ agreementId: there.id, premiseId: premiseB });
    expect(point.premiseId).toBe(premiseB);
  });

  it("allows a successor that starts the day the predecessor's point ends", async () => {
    const leaving = await agreement({ number: "SA-OUT" });
    await openPoint({
      agreementId: leaving.id,
      premiseId: fixA.premiseId,
      startDate: "2024-01-01",
      endDate: "2024-07-01",
    });

    // `[)` on both sides, so 2024-07-01 belongs to the new occupant
    // only. A hand-over is the commonest thing that happens here and
    // must not be refused.
    const arriving = await agreement({ number: "SA-IN", startDate: "2024-07-01" });
    const point = await openPoint({
      agreementId: arriving.id,
      premiseId: fixA.premiseId,
      startDate: "2024-07-01",
    });
    expect(point.startDate.toISOString().slice(0, 10)).toBe("2024-07-01");
  });

  it("refuses a successor that starts before the predecessor's point ends", async () => {
    const leaving = await agreement({ number: "SA-OUT-LATE" });
    await openPoint({
      agreementId: leaving.id,
      premiseId: fixA.premiseId,
      startDate: "2024-01-01",
      endDate: "2024-07-01",
    });

    const arriving = await agreement({ number: "SA-IN-EARLY", startDate: "2024-06-01" });
    await expect(
      openPoint({
        agreementId: arriving.id,
        premiseId: fixA.premiseId,
        startDate: "2024-06-01",
      }),
    ).rejects.toThrow(REFUSAL);
  });

  it("ignores terminal agreements on both sides", async () => {
    const { prisma } = prismaImports;

    /*
     * A FINAL agreement whose point is still open in the data. The
     * product closes points when it closes an agreement, so this is a
     * hand-made shape — which is the point: the trigger must judge the
     * *status*, not assume the cascade ran, or a historical correction
     * becomes impossible.
     */
    const old = await agreement({
      number: "SA-HISTORY",
      status: "FINAL",
      endDate: "2024-06-30",
    });
    await openPoint({ agreementId: old.id, premiseId: fixA.premiseId });

    // A live agreement is not blocked by it.
    const live = await agreement({ number: "SA-LIVE" });
    const livePoint = await openPoint({ agreementId: live.id, premiseId: fixA.premiseId });
    expect(livePoint.id).toBeTruthy();

    // And a point added to a terminal agreement is not blocked by the
    // live one either — recording history is not opening a service.
    const alsoOld = await agreement({
      number: "SA-HISTORY-2",
      status: "FINAL",
      endDate: "2024-06-30",
    });
    const historicPoint = await openPoint({
      agreementId: alsoOld.id,
      premiseId: fixA.premiseId,
    });
    expect(historicPoint.id).toBeTruthy();

    // Three points at one premise, exactly one of them live.
    const all = await seedAsPlatform(async () =>
      prisma.servicePoint.findMany({ where: { premiseId: fixA.premiseId } }),
    );
    expect(all).toHaveLength(3);
  });

  it("judges an UPDATE too: a closed point cannot be reopened into a conflict", async () => {
    const { prisma } = prismaImports;

    const past = await agreement({ number: "SA-PAST" });
    const pastPoint = await openPoint({
      agreementId: past.id,
      premiseId: fixA.premiseId,
      startDate: "2024-01-01",
      endDate: "2024-07-01",
    });

    const now = await agreement({ number: "SA-NOW", startDate: "2024-07-01" });
    await openPoint({
      agreementId: now.id,
      premiseId: fixA.premiseId,
      startDate: "2024-07-01",
    });

    // Clearing the end date makes the old point unbounded, which
    // overlaps the current one. An INSERT-only trigger would miss this.
    await expect(
      seedAsPlatform(async () =>
        prisma.servicePoint.update({
          where: { id: pastPoint.id },
          data: { endDate: null },
        }),
      ),
    ).rejects.toThrow(REFUSAL);
  });

  /*
   * An overlap that predates the trigger — which is how the dev database
   * held three live electric agreements at one address. Every edit to one
   * of those rows met the overlap already there and was refused, even the
   * edit that ends it. An update that keeps or narrows its own dates at the
   * same premise cannot add an overlap, so it goes through; widening one is
   * still judged (20261127110000).
   */
  it("lets a pre-existing overlap be narrowed, and still refuses widening it", async () => {
    const { prisma } = prismaImports;
    const first = await agreement({ number: "SA-OLD-1" });
    await openPoint({ agreementId: first.id, premiseId: fixA.premiseId });
    const second = await agreement({ number: "SA-OLD-2" });
    // Written around the trigger, as data from before it existed was.
    await adminQuery("ALTER TABLE service_point DISABLE TRIGGER before_one_live_service_per_premise");
    let overlapping: { id: string };
    try {
      overlapping = await openPoint({
        agreementId: second.id,
        premiseId: fixA.premiseId,
        startDate: "2024-03-01",
        endDate: "2026-12-31",
      });
    } finally {
      await adminQuery("ALTER TABLE service_point ENABLE TRIGGER before_one_live_service_per_premise");
    }

    // Ending it earlier — the edit that resolves the overlap — is allowed.
    await expect(
      seedAsPlatform(async () =>
        prisma.servicePoint.update({
          where: { id: overlapping.id },
          data: { endDate: new Date("2025-06-30") },
        }),
      ),
    ).resolves.toBeTruthy();
    // Starting it earlier widens it, and is still judged.
    await expect(
      seedAsPlatform(async () =>
        prisma.servicePoint.update({
          where: { id: overlapping.id },
          data: { startDate: new Date("2024-01-01") },
        }),
      ),
    ).rejects.toThrow(REFUSAL);
  });
});
