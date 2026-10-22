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
} from "./_effective-dating-fixtures.js";

/**
 * `GET /portal/api/accounts/:accountId/bills`.
 *
 * The admin route for the same list, `GET /api/v1/accounts/:id/bills`,
 * filters on tenant and account and deliberately never asks whose
 * account it is — a CSR may read any account in the tenant. That makes
 * it unusable from the portal twice over: a portal token does not hold
 * `accounts:VIEW`, and granting it would let any logged-in customer
 * read a stranger's bills by passing their account id.
 *
 * So the portal gets its own route whose query carries the caller's
 * `customerId`. The ownership case below is the reason this file
 * exists; the other two pin the guards that make it safe.
 */

let pgContainer: StartedPostgreSqlContainer;
let prismaImports: typeof import("../../lib/prisma.js");
let appImports: typeof import("../../app.js");
let app: FastifyInstance;
let fixA: TenantFixture;

/** Mine's account, and a stranger's in the same tenant. */
let mineCustomerId: string;
let mineAccountId: string;
let strangerAccountId: string;
let portalUserId: string;

const PORTAL_MODULES = ["portal_accounts", "accounts"];

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
  await pgContainer?.stop().catch(() => {});
});

beforeEach(async () => {
  const { prisma } = prismaImports;
  await resetDb(prisma);
  await prisma.$executeRawUnsafe(
    "TRUNCATE TABLE user_role, contact, cis_user, role RESTART IDENTITY CASCADE",
  );
  fixA = await makeTenantFixture(prisma, TENANT_A);
  await ensurePrincipal(prisma, TENANT_A);

  for (const moduleKey of PORTAL_MODULES) {
    await prisma.utilityModule.create({
      data: { utilityId: fixA.utilityId, moduleKey },
    });
  }
  const rbac = await import("../../services/rbac.service.js");
  await rbac.invalidateTenantModulesCache(fixA.utilityId);

  // Two customers in one tenant, each with an account and one bill.
  const mine = await prisma.customer.create({
    data: {
      utilityId: fixA.utilityId,
      customerType: "INDIVIDUAL",
      firstName: "Ada",
      lastName: "Lovelace",
    },
  });
  mineCustomerId = mine.id;
  const stranger = await prisma.customer.create({
    data: {
      utilityId: fixA.utilityId,
      customerType: "INDIVIDUAL",
      firstName: "Grace",
      lastName: "Hopper",
    },
  });

  const mkAccount = async (customerId: string, number: string) =>
    prisma.account.create({
      data: {
        utilityId: fixA.utilityId,
        accountNumber: number,
        accountType: "RESIDENTIAL",
        status: "ACTIVE",
        billingCycleId: fixA.billingCycleId,
        customerId,
      },
    });
  mineAccountId = (await mkAccount(mine.id, "PB-MINE")).id;
  strangerAccountId = (await mkAccount(stranger.id, "PB-OTHER")).id;

  // Posted, because that is the only kind of bill a customer can see —
  // an unposted one is a calculation nobody owes yet. The case below
  // pins that exclusion.
  const mkBill = async (accountId: string, billNumber: string, total: string) =>
    prisma.bill.create({
      data: {
        utilityId: fixA.utilityId,
        accountId,
        billingCycleId: fixA.billingCycleId,
        periodStart: new Date("2026-02-01"),
        periodEnd: new Date("2026-02-28"),
        billDate: new Date("2026-03-01"),
        dueDate: new Date("2026-03-31"),
        subtotal: total,
        taxes: "0.0000",
        credits: "0.0000",
        total,
        billNumber,
        postedAt: new Date("2026-03-01"),
      },
    });
  await mkBill(mineAccountId, "PB-1001", "90.0000");
  await mkBill(strangerAccountId, "PB-2001", "7777.0000");

  // The portal principal: a CisUser carrying the customer FK, holding a
  // tenant-wide Portal Customer role with portal_* permissions only.
  const role = await prisma.role.create({
    data: {
      utilityId: fixA.utilityId,
      name: "Portal Customer",
      permissions: { portal_accounts: ["VIEW"] },
    },
  });
  const user = await prisma.cisUser.create({
    data: {
      utilityId: fixA.utilityId,
      email: "ada@example.com",
      name: "Ada Lovelace",
      isActive: true,
      customerId: mine.id,
    },
  });
  portalUserId = user.id;
  await prisma.userRole.create({
    data: { utilityId: fixA.utilityId, userId: user.id, roleId: role.id },
  });
});

const asCustomer = () => ({
  authorization: `Bearer ${makeToken({
    utilityId: TENANT_A,
    actorId: portalUserId,
    customerId: mineCustomerId,
  })}`,
});

describe("GET /portal/api/accounts/:accountId/bills", () => {
  it("returns the caller's own account's bills", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/portal/api/accounts/${mineAccountId}/bills`,
      headers: asCustomer(),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    const rows = Array.isArray(body) ? body : body.data;
    expect(rows).toHaveLength(1);
    expect(rows[0].billNumber).toBe("PB-1001");
  });

  it("does not serve another customer's account in the same tenant", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/portal/api/accounts/${strangerAccountId}/bills`,
      headers: asCustomer(),
    });

    // Not 200-with-empty and not 403: the account is not the caller's to
    // know about. Whatever the status, the stranger's figures must not
    // appear in the body.
    expect(res.statusCode).toBe(404);
    expect(res.body).not.toContain("PB-2001");
    expect(res.body).not.toContain("7777");
  });

  it("omits a bill that has not been posted", async () => {
    const { prisma } = prismaImports;
    // A bill is a calculation until it is posted: it has raised no
    // receivable and moved no balance, so the customer does not owe it.
    // The admin AR tab excludes these for the same reason — showing one
    // here invites a call about a charge that does not exist.
    await prisma.bill.create({
      data: {
        utilityId: fixA.utilityId,
        accountId: mineAccountId,
        billingCycleId: fixA.billingCycleId,
        periodStart: new Date("2026-03-01"),
        periodEnd: new Date("2026-03-31"),
        billDate: new Date("2026-04-01"),
        dueDate: new Date("2026-04-30"),
        subtotal: "55.0000",
        taxes: "0.0000",
        credits: "0.0000",
        total: "55.0000",
        billNumber: "PB-DRAFT",
        postedAt: null,
      },
    });
    const res = await app.inject({
      method: "GET",
      url: `/portal/api/accounts/${mineAccountId}/bills`,
      headers: asCustomer(),
    });

    expect(res.statusCode).toBe(200);
    const rows = res.json().data;
    expect(rows.map((r: { billNumber: string }) => r.billNumber)).toEqual(["PB-1001"]);
  });

  it("carries each account's balance and the total owed on the dashboard", async () => {
    const { prisma } = prismaImports;
    // `Account.balance` is the maintained cache of what the account
    // owes, recomputed from the ledger in the same transaction that
    // posts a receivable. The portal dashboard showed a figure derived
    // from mock invoices until 2026-10-22; this is the real one, and it
    // is summed server-side so the client cannot disagree with it.
    await prisma.account.update({
      where: { id: mineAccountId },
      data: { balance: "90.00" },
    });
    const second = await prisma.account.create({
      data: {
        utilityId: fixA.utilityId,
        accountNumber: "PB-MINE-2",
        accountType: "RESIDENTIAL",
        status: "ACTIVE",
        billingCycleId: fixA.billingCycleId,
        customerId: mineCustomerId,
        balance: "10.50",
      },
    });

    const res = await app.inject({
      method: "GET",
      url: "/portal/api/dashboard",
      headers: asCustomer(),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Number(body.amountDue)).toBe(100.5);
    const byNumber = Object.fromEntries(
      body.accounts.map((a: { accountNumber: string; balance: string }) => [
        a.accountNumber,
        Number(a.balance),
      ]),
    );
    expect(byNumber["PB-MINE"]).toBe(90);
    expect(byNumber["PB-MINE-2"]).toBe(10.5);
    expect(second.id).toBeTruthy();
  });

  it("refuses a token that carries no customer", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/portal/api/accounts/${mineAccountId}/bills`,
      headers: {
        authorization: `Bearer ${makeToken({
          utilityId: TENANT_A,
          actorId: portalUserId,
        })}`,
      },
    });

    expect(res.statusCode).toBe(403);
    expect(res.body).not.toContain("PB-1001");
  });
});
