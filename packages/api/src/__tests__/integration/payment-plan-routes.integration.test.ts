import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import type { FastifyInstance } from "fastify";
import {
  bootPostgres,
  resetDb,
  makeTenantFixture,
  ensurePrincipal,
  seedAsPlatform,
  endAdminPool,
  truncateTables,
  ACTOR,
  TENANT_A,
  type TenantFixture,
} from "./_effective-dating-fixtures.js";
import { runAsTenant } from "../../lib/tenant-context.js";

vi.mock("../../lib/queues.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/queues.js")>()),
  enqueueSafely: vi.fn(async () => "test-job-id"),
}));

/**
 * The payment plan API.
 *
 * Task 10 of `docs/superpowers/plans/2026-10-28-payment-plans-slice-1.md`.
 *
 * The read returns derived progress and a derived schedule, not just the
 * stored columns: `status` says ACTIVE whether the customer is current
 * or three payments behind, and the schedule has no table behind it
 * because a stored copy of a derivable figure can disagree with the
 * ledger.
 */

let pgContainer: StartedPostgreSqlContainer;
let prismaImports: typeof import("../../lib/prisma.js");
let app: FastifyInstance;
let fix: TenantFixture;

function daysOut(n: number): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + n);
  return d;
}

const iso = (d: Date) => d.toISOString().slice(0, 10);

function makeToken(utilityId: string, actorId = ACTOR) {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      sub: actorId,
      utility_id: utilityId,
      email: "tester@example.com",
      name: "Tester",
      role: "admin",
    }),
  ).toString("base64url");
  return `${header}.${payload}.fake-signature`;
}

const headers = () => ({ authorization: `Bearer ${makeToken(TENANT_A)}` });

async function reasonId(code: string): Promise<string> {
  return seedAsPlatform(async () => {
    const r = await prismaImports.prisma.ledgerReasonDef.findFirstOrThrow({
      where: { utilityId: TENANT_A, code },
      select: { id: true },
    });
    return r.id;
  });
}

/** A posted bill, so a BILL_CHARGE debit can exist (CHECK constraint). */
async function bill(total: string) {
  return seedAsPlatform(async () =>
    prismaImports.prisma.bill.create({
      data: {
        utilityId: TENANT_A,
        accountId: fix.accountId,
        billingCycleId: fix.billingCycleId,
        billNumber: `BILL-ROUTES-${Math.floor(Math.random() * 1e6)}`,
        periodStart: daysOut(-90),
        periodEnd: daysOut(-60),
        billDate: daysOut(-60),
        dueDate: daysOut(-30),
        subtotal: total,
        taxes: "0.00",
        credits: "0.00",
        total,
      },
    }),
  );
}

async function debit(opts: {
  amount: string;
  type?: "ADJUSTMENT_DEBIT" | "FEE" | "BILL_CHARGE";
  reasonCode?: string | null;
  billId?: string;
  assessedOnId?: string;
}) {
  const code = opts.reasonCode === undefined ? "OPENING_BALANCE" : opts.reasonCode;
  const reason = code === null ? null : await reasonId(code);
  return seedAsPlatform(async () =>
    prismaImports.prisma.ledgerEntry.create({
      data: {
        utilityId: TENANT_A,
        accountId: fix.accountId,
        type: opts.type ?? "ADJUSTMENT_DEBIT",
        amount: opts.amount,
        openAmount: opts.amount,
        effectiveDate: daysOut(-90),
        dueDate: daysOut(-60),
        reasonId: reason,
        billId: opts.billId ?? null,
        assessedOnId: opts.assessedOnId ?? null,
      },
    }),
  );
}

const post = (url: string, body: Record<string, unknown>) =>
  app.inject({ method: "POST", url, headers: headers(), payload: body as object });
const get = (url: string) =>
  app.inject({ method: "GET", url, headers: headers() });

beforeAll(async () => {
  const booted = await bootPostgres({ utilities: [TENANT_A] });
  pgContainer = booted.container;
  prismaImports = await import("../../lib/prisma.js");
  const appImports = await import("../../app.js");
  app = await appImports.buildApp();
  await app.ready();
}, 240_000);

afterAll(async () => {
  await app?.close().catch(() => {});
  await prismaImports?.prisma.$disconnect().catch(() => {});
  await prismaImports?.pool.end().catch(() => {});
  await endAdminPool();
  await pgContainer?.stop().catch(() => {});
});

beforeEach(async () => {
  await resetDb();
  await truncateTables(
    "payment_plan_debit, payment_plan, delinquency_action, delinquency_rule, ledger_application, ledger_entry, ledger_reason_def, bill_segment_line, bill_segment, bill_document, bill, user_role, cis_user, role, utility_module, audit_log",
  );
  fix = await makeTenantFixture(prismaImports.prisma, TENANT_A);
  await ensurePrincipal(prismaImports.prisma, TENANT_A);
  await seedAsPlatform(async () => {
    const { seedDefaultReasons } = await import("../../services/ar/reason.service.js");
    await seedDefaultReasons(TENANT_A, ACTOR, "Tester");
    await prismaImports.prisma.utilityModule.create({
      data: { utilityId: TENANT_A, moduleKey: "delinquency" },
    });
    const rbac = await import("../../services/rbac.service.js");
    await rbac.invalidateTenantModulesCache(TENANT_A);
  });
});

describe("POST /api/v1/accounts/:id/payment-plans", () => {
  it("agrees a plan and answers with the schedule the customer agreed to", async () => {
    const d = await debit({ amount: "300.00" });

    const res = await post(`/api/v1/accounts/${fix.accountId}/payment-plans`, {
      entryIds: [d.id],
      installmentCount: 3,
      startDate: iso(daysOut(0)),
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.totalBalance).toBe("300.00");
    expect(body.downPayment).toBe("75.00");
    // The down payment plus three instalments.
    expect(body.schedule).toHaveLength(4);
    expect(body.schedule[0]).toEqual({ dueDate: iso(daysOut(0)), amount: "75.00" });
  });

  it("refuses an instalment count outside the terms, as a 422 naming the bound", async () => {
    const d = await debit({ amount: "300.00" });

    const res = await post(`/api/v1/accounts/${fix.accountId}/payment-plans`, {
      entryIds: [d.id],
      installmentCount: 2,
      startDate: iso(daysOut(0)),
    });

    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("INSTALLMENTS_BELOW_MINIMUM");
  });

  it("refuses a body with no debts, before it reaches the service", async () => {
    const res = await post(`/api/v1/accounts/${fix.accountId}/payment-plans`, {
      entryIds: [],
      installmentCount: 3,
      startDate: iso(daysOut(0)),
    });

    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBeLessThan(500);
  });

  it("refuses a second active plan, as a 422 a CSR can read", async () => {
    const a = await debit({ amount: "300.00" });
    const b = await debit({ amount: "100.00" });
    await post(`/api/v1/accounts/${fix.accountId}/payment-plans`, {
      entryIds: [a.id],
      installmentCount: 3,
      startDate: iso(daysOut(0)),
    });

    const res = await post(`/api/v1/accounts/${fix.accountId}/payment-plans`, {
      entryIds: [b.id],
      installmentCount: 3,
      startDate: iso(daysOut(0)),
    });

    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("PLAN_ALREADY_ACTIVE");
  });
});

describe("GET /api/v1/accounts/:id/payment-plans", () => {
  it("lists the account's plans, newest first", async () => {
    const d = await debit({ amount: "300.00" });
    await post(`/api/v1/accounts/${fix.accountId}/payment-plans`, {
      entryIds: [d.id],
      installmentCount: 3,
      startDate: iso(daysOut(0)),
    });

    const res = await get(`/api/v1/accounts/${fix.accountId}/payment-plans`);

    expect(res.statusCode).toBe(200);
    expect(res.json().data).toHaveLength(1);
    expect(res.json().data[0].status).toBe("ACTIVE");
  });

  it("answers an empty list for an account with no plans", async () => {
    const res = await get(`/api/v1/accounts/${fix.accountId}/payment-plans`);
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual([]);
  });
});

describe("GET /api/v1/payment-plans/:id", () => {
  it("returns derived progress, which the status column cannot express", async () => {
    const d = await debit({ amount: "300.00" });
    const created = await post(`/api/v1/accounts/${fix.accountId}/payment-plans`, {
      entryIds: [d.id],
      installmentCount: 3,
      startDate: iso(daysOut(0)),
    });
    const planId = created.json().planId;

    const res = await get(`/api/v1/payment-plans/${planId}`);

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe("ACTIVE");
    /*
     * The down payment is due **today** and unpaid, which is `due` but
     * not yet `late` — design §7 distinguishes "the date has arrived"
     * from "the date has passed". This assertion originally demanded
     * `onTrack: false`, which pinned the off-by-one the review found:
     * a plan starting on the customer's payday reported them a payment
     * behind at 03:00 that morning.
     */
    expect(body.progress).toMatchObject({
      onTrack: true,
      installmentsBehind: 0,
      due: 1,
      remaining: "300.00",
    });
  });

  it("returns the derived schedule, with no instalment table behind it", async () => {
    const d = await debit({ amount: "300.00" });
    const created = await post(`/api/v1/accounts/${fix.accountId}/payment-plans`, {
      entryIds: [d.id],
      installmentCount: 3,
      startDate: iso(daysOut(0)),
    });

    const res = await get(`/api/v1/payment-plans/${created.json().planId}`);

    expect(res.json().schedule).toHaveLength(4);
    const total = res
      .json()
      .schedule.reduce((sum: number, r: { amount: string }) => sum + Number(r.amount), 0);
    expect(total.toFixed(2)).toBe("300.00");
  });

  it("names each covered debt's bill, its assessed-on bill, or neither", async () => {
    // Mirrors the AR tab's Bill column: a bill charge names its bill, a
    // late fee names the bill it punishes, and an opening balance names
    // nothing — two of three real debits have no bill_id.
    const b = await bill("55.37");
    const charge = await debit({
      amount: "55.37",
      type: "BILL_CHARGE",
      reasonCode: null,
      billId: b.id,
    });
    const fee = await debit({
      amount: "25.00",
      type: "FEE",
      reasonCode: "LATE_FEE",
      assessedOnId: charge.id,
    });
    const opening = await debit({ amount: "100.00" });

    const created = await post(`/api/v1/accounts/${fix.accountId}/payment-plans`, {
      entryIds: [charge.id, fee.id, opening.id],
      installmentCount: 3,
      startDate: iso(daysOut(0)),
    });
    const res = await get(`/api/v1/payment-plans/${created.json().planId}`);

    const byId = Object.fromEntries(
      res.json().covers.map((c: { entryId: string }) => [c.entryId, c]),
    );
    expect(byId[charge.id].billNumber).toBe(b.billNumber);
    expect(byId[fee.id].assessedOnBillNumber).toBe(b.billNumber);
    expect(byId[opening.id].billNumber).toBeNull();
    expect(byId[opening.id].assessedOnBillNumber).toBeNull();
  });

  it("answers 404 for a plan that is not this tenant's", async () => {
    const res = await get("/api/v1/payment-plans/00000000-0000-4000-8000-00000000dead");
    expect(res.statusCode).toBe(404);
  });
});

describe("POST /api/v1/payment-plans/:id/cancel", () => {
  it("cancels a live plan", async () => {
    const d = await debit({ amount: "300.00" });
    const created = await post(`/api/v1/accounts/${fix.accountId}/payment-plans`, {
      entryIds: [d.id],
      installmentCount: 3,
      startDate: iso(daysOut(0)),
    });

    const res = await post(`/api/v1/payment-plans/${created.json().planId}/cancel`, {
      notes: "Customer asked to stop",
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("CANCELLED");
  });

  it("answers 404 for a plan that does not exist", async () => {
    const res = await post(
      "/api/v1/payment-plans/00000000-0000-4000-8000-00000000dead/cancel",
      {},
    );
    expect(res.statusCode).toBe(404);
  });
});

describe("authorization", () => {
  it("refuses a caller with no delinquency permission", async () => {
    // The module is enabled above; this strips the verb.
    await seedAsPlatform(async () => {
      const role = await prismaImports.prisma.role.findFirstOrThrow({
        where: { utilityId: TENANT_A },
        select: { id: true },
      });
      await prismaImports.prisma.role.update({
        where: { id: role.id },
        data: { permissions: { accounts: ["VIEW"] } },
      });
      const rbac = await import("../../services/rbac.service.js");
      await rbac.invalidateTenantModulesCache(TENANT_A);
    });

    const res = await get(`/api/v1/accounts/${fix.accountId}/payment-plans`);

    expect(res.statusCode).toBe(403);
  });
});
