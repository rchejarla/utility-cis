import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { bootPostgres } from "./_effective-dating-fixtures.js";

/**
 * Slice 1 — HTTP surface for manual posting: persistence, duplicate-post
 * 409, tenant scoping, and the accounts:EDIT / accounts:VIEW gates.
 */

const ACTOR = "00000000-0000-4000-8000-aaaa00000001";
const VIEWER = "00000000-0000-4000-8000-aaaa00000002";
const NO_PERMS = "00000000-0000-4000-8000-aaaa00000003";
// Records and reverses payments; deliberately has no accounts:EDIT, so the
// payment gate is tested on its own rather than riding on the posting one.
const PAYER = "00000000-0000-4000-8000-aaaa00000004";
// Raises fees and forgives charges. Holds no payments permission, so the
// ar_adjustments gates are tested on their own rather than riding on one
// subject that holds everything.
const ADJUSTER = "00000000-0000-4000-8000-aaaa00000005";
const utilityId = "00000000-0000-4000-8000-0000000000aa";
const otherUtilityId = "00000000-0000-4000-8000-0000000000bb";

let pgContainer: StartedPostgreSqlContainer;
let prismaImports: typeof import("../../lib/prisma.js");
let app: FastifyInstance;
let accountId: string;
let billingCycleId: string;
let otherAccountId: string;
let otherBillingCycleId: string;
const reasonIdFor: Record<string, string> = {};

function makeToken(sub: string = ACTOR) {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      sub,
      utility_id: utilityId,
      email: "tester@example.com",
      name: "Tester",
      role: "admin",
    }),
  ).toString("base64url");
  return `${header}.${payload}.fake-signature`;
}
const headers = (sub?: string) => ({ authorization: `Bearer ${makeToken(sub)}` });

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
  await prisma.tenantModule.create({ data: { utilityId, moduleKey: "accounts" } });
  await prisma.tenantModule.create({ data: { utilityId, moduleKey: "payments" } });
  await prisma.tenantModule.create({ data: { utilityId, moduleKey: "ar_adjustments" } });

  // Reason codes for the fee and adjustment routes. Tenant-scoped, so
  // these belong to `utilityId` only.
  for (const [code, appliesToType] of [
    ["LATE_FEE", "FEE"],
    ["OPENING_BALANCE", "ADJUSTMENT_DEBIT"],
    ["COURTESY_WAIVER", "ADJUSTMENT_CREDIT"],
    ["BAD_DEBT", "WRITE_OFF"],
  ] as const) {
    const r = await prisma.ledgerReasonDef.create({
      data: { utilityId, code, label: code, appliesToType },
    });
    reasonIdFor[appliesToType] = r.id;
  }

  // A second tenant with its own account, to prove tenant scoping.
  const otherCycle = await prisma.billingCycle.create({
    data: {
      utilityId: otherUtilityId,
      name: "R1",
      cycleCode: "R01",
      billDayOfMonth: 15,
      frequency: "MONTHLY",
    },
  });
  otherBillingCycleId = otherCycle.id;
  const otherAccount = await prisma.account.create({
    data: {
      utilityId: otherUtilityId,
      accountNumber: "ROUTES-OTHER",
      accountType: "RESIDENTIAL",
      status: "ACTIVE",
      billingCycleId: otherBillingCycleId,
      autoPostBills: false,
    },
  });
  otherAccountId = otherAccount.id;

  // Real users with real roles, so the permission gate actually runs
  // (a token with no cis_user row bypasses it).
  for (const [id, email, roleName, perms] of [
    [VIEWER, "viewer@example.com", "Viewer", { accounts: ["VIEW"], payments: ["VIEW"] }],
    [NO_PERMS, "none@example.com", "NoPerms", { accounts: [] }],
    [PAYER, "payer@example.com", "Payer", { accounts: ["VIEW"], payments: ["VIEW", "CREATE", "EDIT"] }],
    [ADJUSTER, "adjuster@example.com", "Adjuster", { accounts: ["VIEW"], ar_adjustments: ["VIEW", "CREATE", "EDIT"] }],
  ] as const) {
    const role = await prisma.role.create({
      data: { utilityId, name: roleName, permissions: perms },
    });
    await prisma.cisUser.create({
      data: { id, utilityId, email, name: roleName, isActive: true },
    });
    await prisma.userRole.create({ data: { utilityId, userId: id, roleId: role.id } });
  }
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
  // Applications first: they carry RESTRICT FKs onto ledger_entry, and
  // since slice 2 the payment and reverse routes actually write them.
  await prisma.ledgerApplication.deleteMany({});
  await prisma.ledgerEntry.deleteMany({});
  await prisma.bill.deleteMany({});
  await prisma.account.update({ where: { id: accountId }, data: { balance: 0, lastDueDate: null } });
});

async function makeBill(
  total = "25.0000",
  tenant: { utilityId: string; accountId: string; billingCycleId: string } = {
    utilityId,
    accountId,
    billingCycleId,
  },
): Promise<string> {
  const { prisma } = prismaImports;
  const bill = await prisma.bill.create({
    data: {
      utilityId: tenant.utilityId,
      accountId: tenant.accountId,
      billingCycleId: tenant.billingCycleId,
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

    // Persistence, not just a response body.
    const { prisma } = prismaImports;
    expect(await prisma.ledgerEntry.count()).toBe(1);
    const account = await prisma.account.findUniqueOrThrow({ where: { id: accountId } });
    expect(account.balance.toString()).toBe("25");
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

  // A well-shaped but impossible date used to pass the regex, become an
  // Invalid Date, and reach Prisma inside the posting transaction, which
  // answered 400 PRISMA_VALIDATION — "the database client rejected the
  // input shape" for what is plainly a bad request body. Asserting the
  // code, not just the status, is what makes this test discriminate.
  it("returns 400 for an effectiveDate that is not a real date", async () => {
    const billId = await makeBill();
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/bills/${billId}/post`,
      headers: headers(),
      payload: { effectiveDate: "2026-13-45" },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error.code).toBe("VALIDATION_ERROR");
    expect(await prismaImports.prisma.ledgerEntry.count()).toBe(0);
  });

  it("returns 404 for an unknown bill", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/bills/00000000-0000-4000-8000-00000000dead/post",
      headers: headers(),
      payload: {},
    });
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).error.code).toBe("BILL_NOT_FOUND");
  });

  it("returns 404 for another tenant's bill and posts nothing", async () => {
    const otherBill = await makeBill("30.0000", {
      utilityId: otherUtilityId,
      accountId: otherAccountId,
      billingCycleId: otherBillingCycleId,
    });
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/bills/${otherBill}/post`,
      headers: headers(),
      payload: {},
    });
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).error.code).toBe("BILL_NOT_FOUND");
    expect(await prismaImports.prisma.ledgerEntry.count()).toBe(0);
  });

  it("returns 403 for a user without accounts:EDIT and posts nothing", async () => {
    const billId = await makeBill();
    for (const sub of [VIEWER, NO_PERMS]) {
      const res = await app.inject({
        method: "POST",
        url: `/api/v1/bills/${billId}/post`,
        headers: headers(sub),
        payload: {},
      });
      expect(res.statusCode).toBe(403);
      expect(JSON.parse(res.body).error.code).toBe("FORBIDDEN");
    }
    expect(await prismaImports.prisma.ledgerEntry.count()).toBe(0);
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

  it("does not list another tenant's unposted bills", async () => {
    await makeBill("40.0000", {
      utilityId: otherUtilityId,
      accountId: otherAccountId,
      billingCycleId: otherBillingCycleId,
    });
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/accounts/${otherAccountId}/unposted-bills`,
      headers: headers(),
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).data).toEqual([]);
  });

  it("allows a VIEW-only user to list, and rejects a user without accounts:VIEW", async () => {
    const billId = await makeBill();
    const viewer = await app.inject({
      method: "GET",
      url: `/api/v1/accounts/${accountId}/unposted-bills`,
      headers: headers(VIEWER),
    });
    expect(viewer.statusCode).toBe(200);
    expect(JSON.parse(viewer.body).data.map((b: { id: string }) => b.id)).toEqual([billId]);

    const none = await app.inject({
      method: "GET",
      url: `/api/v1/accounts/${accountId}/unposted-bills`,
      headers: headers(NO_PERMS),
    });
    expect(none.statusCode).toBe(403);
  });
});

describe("GET /api/v1/ar/reconciliation", () => {
  // This tenant has only the `accounts` module enabled. A 200 here is
  // therefore the regression guard on the gate itself: while the route
  // asked for `tenant_profile`, the authorization middleware answered
  // 403 MODULE_DISABLED and this tenant could not reach its own AR
  // reconciliation at all.
  it("reports no drift on a clean tenant, to a VIEW-only user", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/ar/reconciliation",
      headers: headers(VIEWER),
    });
    expect(res.statusCode).toBe(200);
    // `checked` rides on the response, not just the service return: an
    // empty `drift` with no population is the same payload a check that
    // could see nothing would send, so the route has to carry the count
    // for the screen to tell those apart.
    expect(JSON.parse(res.body)).toEqual({ ok: true, checked: 1, drift: [] });
  });

  it("reports the account whose cached balance was changed behind the ledger's back", async () => {
    const billId = await makeBill();
    const posted = await app.inject({
      method: "POST",
      url: `/api/v1/bills/${billId}/post`,
      headers: headers(),
      payload: {},
    });
    expect(posted.statusCode).toBe(201);

    // Straight to the column, bypassing every posting path — the only
    // way the cache can drift is something that is not the ledger
    // writing it.
    const { prisma } = prismaImports;
    await prisma.$executeRawUnsafe(
      "UPDATE account SET balance = 999.99 WHERE id = $1::uuid",
      accountId,
    );

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/ar/reconciliation",
      headers: headers(VIEWER),
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(false);
    expect(body.checked).toBe(1);
    expect(body.drift).toEqual([
      {
        accountId,
        accountNumber: "ROUTES-001",
        cached: "999.99",
        ledger: "25.00",
        // Names which cache drifted. There are two -- the receivable and
        // the deposit held -- and they mean different things.
        field: "balance",
      },
    ]);
  });

  it("rejects a user without accounts:VIEW", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/ar/reconciliation",
      headers: headers(NO_PERMS),
    });
    expect(res.statusCode).toBe(403);
  });
});

describe("POST /api/v1/accounts/:id/payments", () => {
  it("records a payment and returns the new balance", async () => {
    const billId = await makeBill("25.0000");
    const posted = await app.inject({
      method: "POST",
      url: `/api/v1/bills/${billId}/post`,
      headers: headers(),
      payload: {},
    });
    expect(posted.statusCode).toBe(201);

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/accounts/${accountId}/payments`,
      headers: headers(PAYER),
      payload: { amount: "10.00", tender: "CHECK" },
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.amount).toBe("-10.00");
    expect(body.balance).toBe("15.00");
    expect(body.applied).toHaveLength(1);
    expect(body.unapplied).toBe("0.00");
  });

  // Review Focus: a negative amount must not become a charge.
  it("returns 400 for a negative or zero amount and records nothing", async () => {
    for (const amount of ["-10.00", "0.00"]) {
      const res = await app.inject({
        method: "POST",
        url: `/api/v1/accounts/${accountId}/payments`,
        headers: headers(PAYER),
        payload: { amount, tender: "CHECK" },
      });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error.code).toBe("VALIDATION_ERROR");
    }
    expect(await prismaImports.prisma.ledgerEntry.count()).toBe(0);
  });

  it("returns 403 without payments:CREATE and records nothing", async () => {
    for (const sub of [VIEWER, NO_PERMS]) {
      const res = await app.inject({
        method: "POST",
        url: `/api/v1/accounts/${accountId}/payments`,
        headers: headers(sub),
        payload: { amount: "10.00", tender: "CHECK" },
      });
      expect(res.statusCode).toBe(403);
    }
    expect(await prismaImports.prisma.ledgerEntry.count()).toBe(0);
  });

  it("returns 404 for another tenant's account and records nothing", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/accounts/${otherAccountId}/payments`,
      headers: headers(PAYER),
      payload: { amount: "10.00", tender: "CHECK" },
    });
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).error.code).toBe("ACCOUNT_NOT_FOUND");
    expect(await prismaImports.prisma.ledgerEntry.count()).toBe(0);
  });
});

describe("POST /api/v1/ledger-entries/:id/reverse", () => {
  async function postedEntryId(total = "25.0000"): Promise<string> {
    const billId = await makeBill(total);
    const posted = await app.inject({
      method: "POST",
      url: `/api/v1/bills/${billId}/post`,
      headers: headers(),
      payload: {},
    });
    expect(posted.statusCode).toBe(201);
    return JSON.parse(posted.body).entryId;
  }

  it("reverses a payment and reports no dependent fees", async () => {
    await postedEntryId();
    const paid = await app.inject({
      method: "POST",
      url: `/api/v1/accounts/${accountId}/payments`,
      headers: headers(PAYER),
      payload: { amount: "25.00", tender: "CHECK" },
    });
    const { paymentId } = JSON.parse(paid.body);

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/ledger-entries/${paymentId}/reverse`,
      headers: headers(PAYER),
      payload: {},
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.amount).toBe("25.00");
    expect(body.balance).toBe("25.00");
    expect(body.dependentFees).toEqual([]);
    expect(body.restored).toHaveLength(1);
  });

  it("returns 409 on a second reverse of the same entry", async () => {
    const entryId = await postedEntryId();

    const first = await app.inject({
      method: "POST",
      url: `/api/v1/ledger-entries/${entryId}/reverse`,
      headers: headers(PAYER),
      payload: {},
    });
    expect(first.statusCode).toBe(201);

    const second = await app.inject({
      method: "POST",
      url: `/api/v1/ledger-entries/${entryId}/reverse`,
      headers: headers(PAYER),
      payload: {},
    });
    expect(second.statusCode).toBe(409);
    expect(JSON.parse(second.body).error.code).toBe("ENTRY_ALREADY_REVERSED");
  });

  it("returns 403 without payments:EDIT", async () => {
    const entryId = await postedEntryId();
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/ledger-entries/${entryId}/reverse`,
      headers: headers(VIEWER),
      payload: {},
    });
    expect(res.statusCode).toBe(403);
    expect(await prismaImports.prisma.ledgerEntry.count({ where: { type: "REVERSAL" } })).toBe(0);
  });

  it("returns 404 for an entry in another tenant", async () => {
    const { prisma } = prismaImports;
    const strayReason = await prisma.ledgerReasonDef.create({
      data: {
        utilityId: otherUtilityId,
        code: `ROUTES-STRAY-${Math.random().toString(36).slice(2, 7)}`,
        label: "Stray",
        appliesToType: "ADJUSTMENT_DEBIT",
      },
    });
    const stray = await prisma.ledgerEntry.create({
      data: {
        utilityId: otherUtilityId,
        accountId: otherAccountId,
        type: "ADJUSTMENT_DEBIT",
        amount: "10.00",
        openAmount: "10.00",
        dueDate: new Date("2026-06-14"),
        effectiveDate: new Date("2026-06-14"),
        reasonId: strayReason.id,
      },
    });
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/ledger-entries/${stray.id}/reverse`,
      headers: headers(PAYER),
      payload: {},
    });
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).error.code).toBe("ENTRY_NOT_FOUND");
  });

  it("returns 400 for a reasonId that is not a uuid", async () => {
    const entryId = await postedEntryId();
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/ledger-entries/${entryId}/reverse`,
      headers: headers(PAYER),
      payload: { reasonId: "nope" },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error.code).toBe("VALIDATION_ERROR");
  });
});

describe("GET /api/v1/ar/reasons", () => {
  it("lists the tenant's reason codes to an ar_adjustments:VIEW user", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/ar/reasons",
      headers: headers(ADJUSTER),
    });
    expect(res.statusCode).toBe(200);
    const codes = JSON.parse(res.body).data.map((r: { code: string }) => r.code);
    expect(codes).toContain("LATE_FEE");
    expect(codes).toContain("BAD_DEBT");
  });

  it("filters by appliesToType", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/ar/reasons?appliesToType=WRITE_OFF",
      headers: headers(ADJUSTER),
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).data.map((r: { code: string }) => r.code)).toEqual(["BAD_DEBT"]);
  });

  it("returns 403 without ar_adjustments:VIEW", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/ar/reasons",
      headers: headers(PAYER),
    });
    expect(res.statusCode).toBe(403);
  });
});

describe("POST /api/v1/accounts/:id/fees", () => {
  it("raises a fee and returns the new balance", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/accounts/${accountId}/fees`,
      headers: headers(ADJUSTER),
      payload: { amount: "25.00", reasonId: reasonIdFor.FEE, dueDate: "2026-07-14" },
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.amount).toBe("25.00");
    expect(body.balance).toBe("25.00");
  });

  it("returns 400 without a reasonId and writes nothing", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/accounts/${accountId}/fees`,
      headers: headers(ADJUSTER),
      payload: { amount: "25.00" },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error.code).toBe("VALIDATION_ERROR");
    expect(await prismaImports.prisma.ledgerEntry.count()).toBe(0);
  });

  // Review Focus, through HTTP: the reason has to suit the type.
  it("returns 422 when the reason is not a FEE reason", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/accounts/${accountId}/fees`,
      headers: headers(ADJUSTER),
      payload: { amount: "25.00", reasonId: reasonIdFor.WRITE_OFF },
    });
    expect(res.statusCode).toBe(422);
    expect(JSON.parse(res.body).error.code).toBe("REASON_TYPE_MISMATCH");
    expect(await prismaImports.prisma.ledgerEntry.count()).toBe(0);
  });

  it("returns 403 without ar_adjustments:CREATE and writes nothing", async () => {
    for (const sub of [VIEWER, PAYER]) {
      const res = await app.inject({
        method: "POST",
        url: `/api/v1/accounts/${accountId}/fees`,
        headers: headers(sub),
        payload: { amount: "25.00", reasonId: reasonIdFor.FEE },
      });
      expect(res.statusCode).toBe(403);
    }
    expect(await prismaImports.prisma.ledgerEntry.count()).toBe(0);
  });

  it("returns 404 for another tenant's account", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/accounts/${otherAccountId}/fees`,
      headers: headers(ADJUSTER),
      payload: { amount: "25.00", reasonId: reasonIdFor.FEE },
    });
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).error.code).toBe("ACCOUNT_NOT_FOUND");
  });
});

describe("POST /api/v1/accounts/:id/adjustments", () => {
  it("raises a manual charge", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/accounts/${accountId}/adjustments`,
      headers: headers(ADJUSTER),
      payload: { amount: "75.00", reasonId: reasonIdFor.ADJUSTMENT_DEBIT },
    });
    expect(res.statusCode).toBe(201);
    expect(JSON.parse(res.body).balance).toBe("75.00");
  });

  it("returns 403 without ar_adjustments:CREATE", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/accounts/${accountId}/adjustments`,
      headers: headers(VIEWER),
      payload: { amount: "75.00", reasonId: reasonIdFor.ADJUSTMENT_DEBIT },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe("POST /api/v1/accounts/:id/waivers and /write-offs", () => {
  async function postedCharge(total = "25.0000"): Promise<string> {
    const billId = await makeBill(total);
    const posted = await app.inject({
      method: "POST",
      url: `/api/v1/bills/${billId}/post`,
      headers: headers(),
      payload: {},
    });
    expect(posted.statusCode).toBe(201);
    return JSON.parse(posted.body).entryId;
  }

  it("waives a posted charge", async () => {
    const entryId = await postedCharge();
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/accounts/${accountId}/waivers`,
      headers: headers(ADJUSTER),
      payload: { amount: "25.00", reasonId: reasonIdFor.ADJUSTMENT_CREDIT, debitId: entryId },
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.amount).toBe("-25.00");
    expect(body.unapplied).toBe("0.00");
    expect(body.balance).toBe("0.00");
  });

  it("writes off a posted charge as a distinct act", async () => {
    const entryId = await postedCharge();
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/accounts/${accountId}/write-offs`,
      headers: headers(ADJUSTER),
      payload: { amount: "25.00", reasonId: reasonIdFor.WRITE_OFF, debitId: entryId },
    });
    expect(res.statusCode).toBe(201);
    expect(JSON.parse(res.body).balance).toBe("0.00");
    const { prisma } = prismaImports;
    expect(await prisma.ledgerEntry.count({ where: { type: "WRITE_OFF" } })).toBe(1);
    expect(await prisma.ledgerEntry.count({ where: { type: "ADJUSTMENT_CREDIT" } })).toBe(0);
  });

  it("returns 422 when a waiver cites a WRITE_OFF reason", async () => {
    const entryId = await postedCharge();
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/accounts/${accountId}/waivers`,
      headers: headers(ADJUSTER),
      payload: { amount: "25.00", reasonId: reasonIdFor.WRITE_OFF, debitId: entryId },
    });
    expect(res.statusCode).toBe(422);
    expect(JSON.parse(res.body).error.code).toBe("REASON_TYPE_MISMATCH");
  });

  it("returns 400 without a debitId", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/accounts/${accountId}/waivers`,
      headers: headers(ADJUSTER),
      payload: { amount: "25.00", reasonId: reasonIdFor.ADJUSTMENT_CREDIT },
    });
    expect(res.statusCode).toBe(400);
  });

  it("returns 403 without ar_adjustments:EDIT and writes nothing", async () => {
    const entryId = await postedCharge();
    const before = await prismaImports.prisma.ledgerEntry.count();
    for (const sub of [VIEWER, PAYER]) {
      const res = await app.inject({
        method: "POST",
        url: `/api/v1/accounts/${accountId}/waivers`,
        headers: headers(sub),
        payload: { amount: "25.00", reasonId: reasonIdFor.ADJUSTMENT_CREDIT, debitId: entryId },
      });
      expect(res.statusCode).toBe(403);
    }
    expect(await prismaImports.prisma.ledgerEntry.count()).toBe(before);
  });
});

describe("POST /api/v1/ar/reasons/seed-defaults", () => {
  // Without this route a tenant not created by the dev seeder has no
  // reason codes, so every fee, adjustment, waiver and write-off fails on
  // REASON_NOT_FOUND. The fixture seeds 4 of the 12 defaults by hand, so
  // the count here is a real number and not merely "did not throw".
  it("fills in the defaults the tenant is missing", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/ar/reasons/seed-defaults",
      headers: headers(ADJUSTER),
      payload: {},
    });
    expect(res.statusCode).toBe(201);
    expect(JSON.parse(res.body).created).toBe(8);

    const listed = await app.inject({
      method: "GET",
      url: "/api/v1/ar/reasons",
      headers: headers(ADJUSTER),
    });
    expect(JSON.parse(listed.body).data).toHaveLength(12);
  });

  it("is idempotent — a second call creates nothing", async () => {
    await app.inject({
      method: "POST",
      url: "/api/v1/ar/reasons/seed-defaults",
      headers: headers(ADJUSTER),
      payload: {},
    });
    const again = await app.inject({
      method: "POST",
      url: "/api/v1/ar/reasons/seed-defaults",
      headers: headers(ADJUSTER),
      payload: {},
    });
    expect(again.statusCode).toBe(201);
    expect(JSON.parse(again.body).created).toBe(0);
  });

  it("returns 403 without ar_adjustments:CREATE", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/ar/reasons/seed-defaults",
      headers: headers(PAYER),
      payload: {},
    });
    expect(res.statusCode).toBe(403);
  });
});

describe("GET /api/v1/accounts/:id/ledger", () => {
  it("returns the ledger with the balance and open count", async () => {
    const billId = await makeBill("25.0000");
    await app.inject({
      method: "POST",
      url: `/api/v1/bills/${billId}/post`,
      headers: headers(),
      payload: {},
    });

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/accounts/${accountId}/ledger`,
      headers: headers(VIEWER),
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.balance).toBe("25.00");
    expect(body.openCount).toBe(1);
    expect(body.data).toHaveLength(1);
    expect(body.data[0].type).toBe("BILL_CHARGE");
    expect(body.data[0].openAmount).toBe("25.00");
    expect(body.data[0].settled).toBe(false);
  });

  it("honours openOnly", async () => {
    const billId = await makeBill("25.0000");
    await app.inject({
      method: "POST",
      url: `/api/v1/bills/${billId}/post`,
      headers: headers(),
      payload: {},
    });
    await app.inject({
      method: "POST",
      url: `/api/v1/accounts/${accountId}/payments`,
      headers: headers(PAYER),
      payload: { amount: "25.00", tender: "CHECK" },
    });

    const all = await app.inject({
      method: "GET",
      url: `/api/v1/accounts/${accountId}/ledger`,
      headers: headers(VIEWER),
    });
    expect(JSON.parse(all.body).data).toHaveLength(2);

    const open = await app.inject({
      method: "GET",
      url: `/api/v1/accounts/${accountId}/ledger?openOnly=true`,
      headers: headers(VIEWER),
    });
    expect(JSON.parse(open.body).data).toEqual([]);
    expect(JSON.parse(open.body).balance).toBe("0.00");
  });

  // A CSR who may not take a payment still needs to see what is owed, so
  // this is accounts:VIEW and not one of the writing modules.
  it("returns 403 only when the user lacks accounts:VIEW", async () => {
    const allowed = await app.inject({
      method: "GET",
      url: `/api/v1/accounts/${accountId}/ledger`,
      headers: headers(ADJUSTER),
    });
    expect(allowed.statusCode).toBe(200);

    const denied = await app.inject({
      method: "GET",
      url: `/api/v1/accounts/${accountId}/ledger`,
      headers: headers(NO_PERMS),
    });
    expect(denied.statusCode).toBe(403);
  });

  it("returns 404 for another tenant's account", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/accounts/${otherAccountId}/ledger`,
      headers: headers(VIEWER),
    });
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).error.code).toBe("ACCOUNT_NOT_FOUND");
  });
});

/**
 * The tenant-wide receipts list, at the HTTP boundary.
 *
 * `listReceipts` is covered directly in receipt-list.integration.test.ts;
 * what is only testable here is the wiring — the path, the permission
 * gate and the strict query schema. A rename that moved the route
 * without moving the caller, or a query key the schema silently
 * swallowed, would leave every service test green.
 *
 * Every case pins itself to a date nothing else in this file uses, so
 * the totals stay deterministic however many entries earlier tests have
 * left on the shared account.
 */
describe("GET /api/v1/receipts", () => {
  const DAY = "2027-03-01";

  async function seedReceiptsDay(): Promise<void> {
    const { prisma } = prismaImports;
    await prisma.ledgerEntry.deleteMany({ where: { utilityId, effectiveDate: new Date(DAY) } });
    await prisma.ledgerEntry.create({
      data: {
        utilityId,
        accountId,
        type: "PAYMENT",
        amount: "-30.00",
        openAmount: "0.00",
        effectiveDate: new Date(DAY),
        tender: "CASH",
        externalRef: "RCPT-PAY",
      },
    });
    await prisma.ledgerEntry.create({
      data: {
        utilityId,
        accountId,
        type: "DEPOSIT",
        amount: "-120.00",
        openAmount: "-120.00",
        effectiveDate: new Date(DAY),
        tender: "CHECK",
        externalRef: "RCPT-DEP",
      },
    });
  }

  it("returns payments and deposits together, with the split beside the total", async () => {
    await seedReceiptsDay();
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/receipts?from=${DAY}&to=${DAY}`,
      headers: headers(PAYER),
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.meta.total).toBe(2);
    // 30.00 taken plus the 120.00 deposit, as the bank saw the day.
    expect(body.totalReceived).toBe("150.00");
    expect(body.subtotals).toEqual({ PAYMENT: "30.00", DEPOSIT: "120.00" });
    expect([...body.data].map((r: { type: string }) => r.type).sort()).toEqual([
      "DEPOSIT",
      "PAYMENT",
    ]);
  });

  it("narrows to one kind when asked", async () => {
    await seedReceiptsDay();
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/receipts?from=${DAY}&to=${DAY}&type=DEPOSIT`,
      headers: headers(PAYER),
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.meta.total).toBe(1);
    expect(body.data[0].externalRef).toBe("RCPT-DEP");
    expect(body.totalReceived).toBe("120.00");
  });

  // The schema is `.strict()`. A mistyped filter must be refused rather
  // than ignored: a query that silently drops `tendr=CASH` answers a
  // different question than the one asked, and looks authoritative.
  it("refuses an unknown query key rather than ignoring it", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/receipts?tendr=CASH`,
      headers: headers(PAYER),
    });
    expect(res.statusCode).toBe(400);
  });

  it("refuses a kind that is not a receipt", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/receipts?type=BILL_CHARGE`,
      headers: headers(PAYER),
    });
    expect(res.statusCode).toBe(400);
  });

  /**
   * ADJUSTER is the subject that makes this test say anything: it holds
   * `accounts:VIEW` and no payments permission at all. If the route were
   * gated on `accounts` — the module its neighbours in this file use —
   * ADJUSTER would be let in. VIEWER proves the gate is not stricter
   * than it should be, holding `payments:VIEW` and nothing more.
   */
  it("is gated on payments:VIEW, not on accounts", async () => {
    for (const sub of [ADJUSTER, NO_PERMS]) {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/receipts",
        headers: headers(sub),
      });
      expect(res.statusCode, `subject ${sub} must not reach receipts`).toBe(403);
    }

    const allowed = await app.inject({
      method: "GET",
      url: "/api/v1/receipts",
      headers: headers(VIEWER),
    });
    expect(allowed.statusCode, "payments:VIEW alone must suffice").toBe(200);
  });

  it("never returns another tenant's receipts", async () => {
    const { prisma } = prismaImports;
    await seedReceiptsDay();
    const theirs = await prisma.ledgerEntry.create({
      data: {
        utilityId: otherUtilityId,
        accountId: otherAccountId,
        type: "PAYMENT",
        amount: "-999.00",
        openAmount: "0.00",
        effectiveDate: new Date(DAY),
        tender: "CASH",
        externalRef: "THEIRS",
      },
    });
    try {
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/receipts?from=${DAY}&to=${DAY}`,
        headers: headers(PAYER),
      });
      const body = JSON.parse(res.body);
      expect(body.meta.total).toBe(2);
      expect(body.totalReceived).toBe("150.00");
      expect(JSON.stringify(body)).not.toContain("THEIRS");
    } finally {
      await prisma.ledgerEntry.delete({ where: { id: theirs.id } });
    }
  });
});

/**
 * Issuing a refund, at the HTTP boundary.
 *
 * `recordRefund` is covered directly in refund.integration.test.ts. What
 * is only testable here is the wiring: the path, the strict body schema,
 * and that the gate is `payments:CREATE` — the same authority as taking
 * money, because money moving either way is the cashier's act.
 *
 * On its own account, because a refund needs a credit balance and the
 * shared one accumulates debits from every test above.
 */
describe("POST /api/v1/accounts/:id/refunds", () => {
  let refundAccountId: string;

  beforeEach(async () => {
    const { prisma } = prismaImports;
    const account = await prisma.account.create({
      data: {
        utilityId,
        accountNumber: `REFUND-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
        accountType: "RESIDENTIAL",
        status: "ACTIVE",
        billingCycleId,
      },
    });
    refundAccountId = account.id;
    // A payment with nothing to apply to IS a credit balance.
    await prisma.ledgerEntry.create({
      data: {
        utilityId,
        accountId: refundAccountId,
        type: "PAYMENT",
        amount: "-80.00",
        openAmount: "-80.00",
        effectiveDate: new Date("2026-06-01"),
        tender: "CASH",
      },
    });
    await prisma.account.update({
      where: { id: refundAccountId },
      data: { balance: "-80.00" },
    });
  });

  it("issues a refund and returns the new balance", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/accounts/${refundAccountId}/refunds`,
      headers: headers(PAYER),
      payload: { amount: "80.00", source: "CREDIT", tender: "CHECK", externalRef: "CHQ-9001" },
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.amount).toBe("80.00");
    expect(body.source).toBe("CREDIT");
    expect(body.balance).toBe("0.00");
    expect(body.applied).toHaveLength(1);
  });

  it("returns 422 naming the available figure, and writes nothing", async () => {
    const { prisma } = prismaImports;
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/accounts/${refundAccountId}/refunds`,
      headers: headers(PAYER),
      payload: { amount: "100.00", source: "CREDIT" },
    });
    expect(res.statusCode).toBe(422);
    const body = JSON.parse(res.body);
    expect(body.error.code).toBe("REFUND_EXCEEDS_AVAILABLE");
    expect(body.error.message).toContain("80.00");
    expect(
      await prisma.ledgerEntry.count({ where: { accountId: refundAccountId, type: "REFUND" } }),
    ).toBe(0);
  });

  // `source` has no default on purpose: returning an overpayment and
  // releasing a deposit are different acts, and a default would pick one.
  it("requires source, and refuses one that is not a pool", async () => {
    for (const payload of [{ amount: "10.00" }, { amount: "10.00", source: "WHATEVER" }]) {
      const res = await app.inject({
        method: "POST",
        url: `/api/v1/accounts/${refundAccountId}/refunds`,
        headers: headers(PAYER),
        payload,
      });
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
    }
  });

  it("refuses an unknown body key rather than ignoring it", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/accounts/${refundAccountId}/refunds`,
      headers: headers(PAYER),
      payload: { amount: "10.00", source: "CREDIT", chequeNo: "9001" },
    });
    // `chequeNo` is not `externalRef`. Silently dropping it would lose
    // the cheque number off a disbursement record.
    expect(res.statusCode).toBe(400);
  });

  it("is gated on payments:CREATE", async () => {
    // VIEWER holds payments:VIEW and ADJUSTER holds none; neither may
    // send money out of the building.
    for (const sub of [VIEWER, ADJUSTER, NO_PERMS]) {
      const res = await app.inject({
        method: "POST",
        url: `/api/v1/accounts/${refundAccountId}/refunds`,
        headers: headers(sub),
        payload: { amount: "10.00", source: "CREDIT" },
      });
      expect(res.statusCode, `subject ${sub}`).toBe(403);
    }
  });

  it("returns 404 for another tenant's account", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/accounts/${otherAccountId}/refunds`,
      headers: headers(PAYER),
      payload: { amount: "10.00", source: "CREDIT" },
    });
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).error.code).toBe("ACCOUNT_NOT_FOUND");
  });
});
