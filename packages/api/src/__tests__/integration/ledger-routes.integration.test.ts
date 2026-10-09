import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { bootPostgres } from "./_effective-dating-fixtures.js";

/**
 * Slice 1 — HTTP surface for manual posting. Covers the Review Focus
 * case of posting the same Bill twice surfacing as 409, not a 500.
 */

const ACTOR = "00000000-0000-4000-8000-aaaa00000001";
const utilityId = "00000000-0000-4000-8000-0000000000aa";

let pgContainer: StartedPostgreSqlContainer;
let prismaImports: typeof import("../../lib/prisma.js");
let app: FastifyInstance;
let accountId: string;
let billingCycleId: string;

function makeToken() {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      sub: ACTOR,
      utility_id: utilityId,
      email: "tester@example.com",
      name: "Tester",
      role: "admin",
    }),
  ).toString("base64url");
  return `${header}.${payload}.fake-signature`;
}
const headers = () => ({ authorization: `Bearer ${makeToken()}` });

beforeAll(async () => {
  const booted = await bootPostgres();
  pgContainer = booted.container;
  prismaImports = await import("../../lib/prisma.js");
  const appImports = await import("../../app.js");
  app = await appImports.buildApp();
  await app.ready();

  const { prisma } = prismaImports;
  const cycle = await prisma.billingCycle.create({
    data: { utilityId, name: "R1", cycleCode: "R01", billDayOfMonth: 15, frequency: "MONTHLY" },
  });
  billingCycleId = cycle.id;
  const account = await prisma.account.create({
    data: {
      utilityId,
      accountNumber: "ROUTES-001",
      accountType: "RESIDENTIAL",
      status: "ACTIVE",
      billingCycleId,
      autoPostBills: false,
    },
  });
  accountId = account.id;
  await prisma.tenantModule.create({ data: { utilityId, moduleKey: "agreements" } });
  const rbac = await import("../../services/rbac.service.js");
  await rbac.invalidateTenantModulesCache(utilityId);
}, 180_000);

afterAll(async () => {
  await app?.close();
  await prismaImports?.prisma.$disconnect();
  await pgContainer?.stop();
});

beforeEach(async () => {
  const { prisma } = prismaImports;
  await prisma.ledgerEntry.deleteMany({});
  await prisma.bill.deleteMany({});
  await prisma.account.update({ where: { id: accountId }, data: { balance: 0, lastDueDate: null } });
});

async function makeBill(total = "25.0000"): Promise<string> {
  const { prisma } = prismaImports;
  const bill = await prisma.bill.create({
    data: {
      utilityId,
      accountId,
      billingCycleId,
      periodStart: new Date("2026-04-16"),
      periodEnd: new Date("2026-05-15"),
      billDate: new Date("2026-05-15"),
      dueDate: new Date("2026-06-14"),
      subtotal: total,
      taxes: "0",
      credits: "0",
      total,
      billNumber: `BILL-R-${Math.random().toString(36).slice(2, 8)}`,
    },
  });
  return bill.id;
}

describe("POST /api/v1/bills/:id/post", () => {
  it("posts the bill and returns the new balance", async () => {
    const billId = await makeBill();
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/bills/${billId}/post`,
      headers: headers(),
      payload: {},
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.amount).toBe("25.00");
    expect(body.balance).toBe("25.00");
  });

  // Review Focus: duplicate post must be a clean 409
  it("returns 409 when the bill is already posted", async () => {
    const billId = await makeBill();
    const first = await app.inject({
      method: "POST",
      url: `/api/v1/bills/${billId}/post`,
      headers: headers(),
      payload: {},
    });
    expect(first.statusCode).toBe(201);

    const second = await app.inject({
      method: "POST",
      url: `/api/v1/bills/${billId}/post`,
      headers: headers(),
      payload: {},
    });
    expect(second.statusCode).toBe(409);
    expect(JSON.parse(second.body).error.code).toBe("BILL_ALREADY_POSTED");
  });

  it("returns 404 for an unknown bill", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/bills/00000000-0000-4000-8000-00000000dead/post",
      headers: headers(),
      payload: {},
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("GET /api/v1/accounts/:id/unposted-bills", () => {
  it("lists only bills with no postedAt", async () => {
    const unposted = await makeBill("10.0000");
    const posted = await makeBill("20.0000");
    await app.inject({
      method: "POST",
      url: `/api/v1/bills/${posted}/post`,
      headers: headers(),
      payload: {},
    });

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/accounts/${accountId}/unposted-bills`,
      headers: headers(),
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.map((b: { id: string }) => b.id)).toEqual([unposted]);
  });
});
