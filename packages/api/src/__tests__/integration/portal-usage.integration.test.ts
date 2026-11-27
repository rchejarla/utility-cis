import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import type { FastifyInstance } from "fastify";
import {
  bootPostgres,
  resetDb,
  makeTenantFixture,
  TENANT_A,
  type TenantFixture,
  ensurePrincipal,
  truncateTables,
  seedAsPlatform,
  endAdminPool,
} from "./_effective-dating-fixtures.js";

/**
 * `GET /portal/api/agreements/:agreementId/usage`.
 *
 * It had no test at all, and it was wrong for every TOU customer: a TOU
 * meter's month holds a total read *and* one row per TOU period that
 * reconcile to it, and the page summed every row — so the customer's
 * month showed about double what they used and were billed for. The
 * endpoint now returns the monthly figures itself, by the rating engine's
 * rule (the total wins; the buckets stand in where there is none), and
 * marks each row with its TOU period.
 */

let pgContainer: StartedPostgreSqlContainer;
let prismaImports: typeof import("../../lib/prisma.js");
let appImports: typeof import("../../app.js");
let app: FastifyInstance;
let fixA: TenantFixture;

let mineCustomerId: string;
let mineAgreementId: string;
let strangerAgreementId: string;
let portalUserId: string;

const PORTAL_MODULES = ["portal_usage", "accounts"];

function makeToken(opts: { utilityId: string; actorId: string; customerId?: string }) {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      sub: opts.actorId,
      utility_id: opts.utilityId,
      email: "customer@example.com",
      name: "Portal Customer",
      role: "portal",
      ...(opts.customerId ? { customer_id: opts.customerId } : {}),
    }),
  ).toString("base64url");
  return `${header}.${payload}.fake-signature`;
}

beforeAll(async () => {
  const booted = await bootPostgres({ utilities: [TENANT_A] });
  pgContainer = booted.container;
  prismaImports = await import("../../lib/prisma.js");
  appImports = await import("../../app.js");
  app = await appImports.buildApp();
  await app.ready();
}, 180_000);

afterAll(async () => {
  await app?.close().catch(() => {});
  await prismaImports?.prisma.$disconnect().catch(() => {});
  await prismaImports?.pool.end().catch(() => {});
  await endAdminPool();
  await pgContainer?.stop().catch(() => {});
});

beforeEach(() =>
  seedAsPlatform(async () => {
    const { prisma } = prismaImports;
    await resetDb();
    await truncateTables("user_role, contact, cis_user, role");
    fixA = await makeTenantFixture(prisma, TENANT_A);
    await ensurePrincipal(prisma, TENANT_A);
    for (const moduleKey of PORTAL_MODULES) {
      await prisma.utilityModule.create({ data: { utilityId: fixA.utilityId, moduleKey } });
    }
    const rbac = await import("../../services/rbac.service.js");
    await rbac.invalidateTenantModulesCache(fixA.utilityId);

    const mkCustomer = (firstName: string) =>
      prisma.customer.create({
        data: { utilityId: fixA.utilityId, customerType: "INDIVIDUAL", firstName, lastName: "Test" },
      });
    const mine = await mkCustomer("Ada");
    const stranger = await mkCustomer("Grace");
    mineCustomerId = mine.id;

    const mkAgreement = async (customerId: string, n: string) => {
      const account = await prisma.account.create({
        data: {
          utilityId: fixA.utilityId,
          accountNumber: `PU-${n}`,
          accountType: "RESIDENTIAL",
          status: "ACTIVE",
          billingCycleId: fixA.billingCycleId,
          customerId,
        },
      });
      return prisma.serviceAgreement.create({
        data: {
          utilityId: fixA.utilityId,
          agreementNumber: `SA-PU-${n}`,
          accountId: account.id,
          commodityId: fixA.commodityId,
          startDate: new Date("2026-01-01"),
          status: "ACTIVE",
        },
      });
    };
    mineAgreementId = (await mkAgreement(mine.id, "MINE")).id;
    strangerAgreementId = (await mkAgreement(stranger.id, "OTHER")).id;

    const role = await prisma.role.create({
      data: { utilityId: fixA.utilityId, name: "Portal Customer", permissions: { portal_usage: ["VIEW"] } },
    });
    const user = await prisma.cisUser.create({
      data: {
        utilityId: fixA.utilityId,
        email: "ada@example.com",
        name: "Ada Test",
        isActive: true,
        customerId: mine.id,
      },
    });
    portalUserId = user.id;
    await prisma.userRole.create({ data: { utilityId: fixA.utilityId, userId: user.id, roleId: role.id } });
  }),
);

const asCustomer = () => ({
  authorization: `Bearer ${makeToken({ utilityId: TENANT_A, actorId: portalUserId, customerId: mineCustomerId })}`,
});

/** One read on the fixture meter: a total (dial reading) or a TOU bucket (no dial). */
function seedRead(agreementId: string, day: string, consumption: number, peakCode: string | null, meterId?: string) {
  return seedAsPlatform(async () =>
    prismaImports.prisma.meterRead.create({
      data: {
        utilityId: fixA.utilityId,
        meterId: meterId ?? fixA.meterId,
        serviceAgreementId: agreementId,
        uomId: fixA.uomId,
        readDate: new Date(day),
        readDatetime: new Date(`${day}T12:00:00Z`),
        reading: peakCode === null ? 5000 + consumption : null,
        priorReading: peakCode === null ? 5000 : null,
        consumption,
        peakCode,
        readType: "ACTUAL",
        readSource: "AMR",
      },
    }),
  );
}

const usage = (agreementId: string) =>
  app.inject({
    method: "GET",
    url: `/portal/api/agreements/${agreementId}/usage?from=2026-05&to=2026-07`,
    headers: asCustomer(),
  });

describe("GET /portal/api/agreements/:agreementId/usage", () => {
  it("counts a TOU meter's month once — the total read, not the total plus its buckets", async () => {
    await seedRead(mineAgreementId, "2026-06-08", 623, null);
    await seedRead(mineAgreementId, "2026-06-08", 132, "peak");
    await seedRead(mineAgreementId, "2026-06-08", 89, "mid_peak");
    await seedRead(mineAgreementId, "2026-06-08", 402, "off_peak");

    const res = await usage(mineAgreementId);

    expect(res.statusCode).toBe(200);
    const body = res.json();
    // 623, not 1,246.
    expect(body.monthly).toEqual([{ month: "2026-06", total: 623 }]);
    // Each row says what it is, and a bucket has no dial reading.
    const buckets = body.data.filter((r: { peakCode: string | null }) => r.peakCode !== null);
    expect(buckets).toHaveLength(3);
    expect(buckets.every((r: { reading: unknown }) => r.reading === null)).toBe(true);
  });

  it("falls back to the buckets for a meter that has no total read", async () => {
    await seedRead(mineAgreementId, "2026-06-30", 140, "peak");
    await seedRead(mineAgreementId, "2026-06-30", 485.5, "off_peak");

    const res = await usage(mineAgreementId);

    expect(res.json().monthly).toEqual([{ month: "2026-06", total: 625.5 }]);
  });

  it("keeps an ordinary meter's months as they were", async () => {
    await seedRead(mineAgreementId, "2026-05-08", 28, null);
    await seedRead(mineAgreementId, "2026-06-08", 32, null);

    const res = await usage(mineAgreementId);

    expect(res.json().monthly).toEqual([
      { month: "2026-05", total: 28 },
      { month: "2026-06", total: 32 },
    ]);
  });

  it("does not serve another customer's agreement", async () => {
    await seedRead(strangerAgreementId, "2026-06-08", 7777, null, fixA.meterId2);

    const res = await usage(strangerAgreementId);

    expect(res.statusCode).toBe(404);
    expect(res.body).not.toContain("7777");
  });
});
