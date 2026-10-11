import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import type { FastifyInstance } from "fastify";
import type { Prisma } from "@utility-cis/shared/src/generated/prisma";
import { bootPostgres } from "./_effective-dating-fixtures.js";

/**
 * BillDocument end to end against a real database.
 *
 * apptor-connect is faked, not run: standing up a JVM service and a
 * cloud bucket per test file would multiply an already long suite for
 * no coverage of our own logic. The client module's contract test
 * (src/__tests__/lib/apptor-connect-files-client.test.ts) is what
 * notices if their contract moves.
 */

const put = vi.fn();
const get = vi.fn();

vi.mock("../../lib/apptor-connect/files-client.js", () => ({
  putObject: (...args: unknown[]) => put(...args),
  getObject: (...args: unknown[]) => get(...args),
  ApptorConnectError: class ApptorConnectError extends Error {
    constructor(
      message: string,
      readonly status: number | null,
      readonly integration: string,
    ) {
      super(message);
      this.name = "ApptorConnectError";
    }
  },
}));

const UTILITY = "00000000-0000-4000-8000-0000000000aa";
const OTHER_UTILITY = "00000000-0000-4000-8000-0000000000bb";
const ACTOR = "00000000-0000-4000-8000-aaaa00000001";

const ISSUER = {
  utilityName: "City of Testville Utilities",
  utilityLegalName: "City of Testville, Montana",
  remittanceAddressLine1: "PO Box 1230",
  remittanceCity: "Testville",
  remittanceState: "MT",
  remittancePostalCode: "59771",
};

/** Modules the endpoints are gated on; absent, every request is a 403. */
const MODULES = ["accounts", "portal_billing"];

let pgContainer: StartedPostgreSqlContainer;
let prismaImports: typeof import("../../lib/prisma.js");
let svc: typeof import("../../services/bill-document.service.js");
let acError: typeof import("../../lib/apptor-connect/files-client.js").ApptorConnectError;
let app: FastifyInstance;

/**
 * An unsigned dev token, the shape the auth middleware accepts when
 * `alg: "none"`. No CisUser row is seeded, so the authorization
 * middleware's own backwards-compatibility path skips the per-permission
 * check — these cases are about status mapping, not about RBAC.
 */
function token(claims: Record<string, unknown> = {}): string {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      sub: ACTOR,
      utility_id: UTILITY,
      email: "tester@example.com",
      name: "Tester",
      role: "admin",
      ...claims,
    }),
  ).toString("base64url");
  return `${header}.${payload}.fake-signature`;
}

const staffHeaders = () => ({ authorization: `Bearer ${token()}` });
const portalHeaders = (customerId: string) => ({
  authorization: `Bearer ${token({ customer_id: customerId })}`,
});

beforeAll(async () => {
  const booted = await bootPostgres();
  pgContainer = booted.container;
  prismaImports = await import("../../lib/prisma.js");
  svc = await import("../../services/bill-document.service.js");
  acError = (await import("../../lib/apptor-connect/files-client.js")).ApptorConnectError;
  app = await (await import("../../app.js")).buildApp();
  await app.ready();
}, 180_000);

afterAll(async () => {
  await app?.close().catch(() => {});
  await prismaImports?.prisma.$disconnect().catch(() => {});
  await pgContainer?.stop().catch(() => {});
});

beforeEach(async () => {
  put.mockReset().mockResolvedValue(undefined);
  get.mockReset();
  const { prisma } = prismaImports;
  // Every table postedBill() writes, including the rate rows a
  // bill_segment_line's required source FKs need — leave one out and the
  // second test in the file collides on a unique code rather than
  // testing anything.
  await prisma.$executeRawUnsafe(
    `TRUNCATE TABLE audit_log, bill_document, bill_segment_line, bill_segment, bill, service_agreement, account, customer, billing_address, billing_cycle, rate_component, rate_component_kind, rate_schedule, commodity, tenant_config, tenant_module, user_role, cis_user, role RESTART IDENTITY CASCADE`,
  );
});

/** Audit rows this entity produced, oldest first. */
async function auditTrail(): Promise<Array<{ action: string; eventType: string }>> {
  const rows = await prismaImports.prisma.auditLog.findMany({
    where: { entityType: "BillDocument" },
    orderBy: { createdAt: "asc" },
  });
  return rows.map((r) => ({
    action: r.action,
    eventType: (r.metadata as { eventType?: string } | null)?.eventType ?? "",
  }));
}

/**
 * A posted bill with one segment carrying two lines, a named customer
 * with a billing address, and complete issuer settings — the minimum
 * from which a bill can legitimately be rendered.
 */
async function postedBill(
  opts: { utilityId?: string; issuer?: Record<string, string> | null; storage?: boolean } = {},
): Promise<string> {
  const { prisma } = prismaImports;
  const utilityId = opts.utilityId ?? UTILITY;
  const suffix = utilityId.slice(-4);

  const settings: Record<string, unknown> = {};
  if (opts.issuer !== null) settings.issuer = opts.issuer ?? ISSUER;
  if (opts.storage !== false) settings.billDocuments = { storageIntegration: "cis-bills" };
  await prisma.tenantConfig.create({
    data: { utilityId, settings: settings as Prisma.InputJsonObject },
  });

  for (const moduleKey of MODULES) {
    await prisma.tenantModule.create({ data: { utilityId, moduleKey } });
  }
  const rbac = await import("../../services/rbac.service.js");
  await rbac.invalidateTenantModulesCache(utilityId);

  const commodity = await prisma.commodity.create({
    data: { utilityId, code: `WATER-${suffix}`, name: "Water" },
  });
  const cycle = await prisma.billingCycle.create({
    data: {
      utilityId,
      name: "Residential",
      cycleCode: `R-${suffix}`,
      billDayOfMonth: 15,
      frequency: "MONTHLY",
    },
  });
  const customer = await prisma.customer.create({
    data: { utilityId, customerType: "INDIVIDUAL", firstName: "Jane", lastName: "Smith" },
  });
  const account = await prisma.account.create({
    data: {
      utilityId,
      accountNumber: `A-${suffix}`,
      accountType: "RESIDENTIAL",
      status: "ACTIVE",
      billingCycleId: cycle.id,
      customerId: customer.id,
    },
  });
  await prisma.billingAddress.create({
    data: {
      utilityId,
      accountId: account.id,
      addressLine1: "12 Elm St",
      city: "Testville",
      state: "MT",
      zip: "59771",
    },
  });
  const agreement = await prisma.serviceAgreement.create({
    data: {
      utilityId,
      agreementNumber: `SA-${suffix}`,
      accountId: account.id,
      commodityId: commodity.id,
      startDate: new Date("2026-01-01"),
      status: "ACTIVE",
    },
  });
  const bill = await prisma.bill.create({
    data: {
      utilityId,
      accountId: account.id,
      billingCycleId: cycle.id,
      periodStart: new Date("2026-02-01"),
      periodEnd: new Date("2026-02-28"),
      billDate: new Date("2026-03-01"),
      dueDate: new Date("2026-03-31"),
      subtotal: "100.0000",
      taxes: "7.5000",
      credits: "0.0000",
      total: "107.5000",
      billNumber: `B-${suffix}`,
      postedAt: new Date("2026-03-01"),
    },
  });
  const segment = await prisma.billSegment.create({
    data: {
      utilityId,
      serviceAgreementId: agreement.id,
      billId: bill.id,
      periodStart: new Date("2026-02-01"),
      periodEnd: new Date("2026-02-28"),
      subtotal: "100.0000",
      taxes: "7.5000",
      credits: "0.0000",
      total: "107.5000",
      minimumFloorApplied: false,
      segmentNumber: `SEG-${suffix}`,
    },
  });
  const schedule = await prisma.rateSchedule.create({
    data: {
      utilityId,
      code: `RS-${suffix}`,
      name: "Residential Water",
      commodityId: commodity.id,
      effectiveDate: new Date("2026-01-01"),
    },
  });
  const kind = await prisma.rateComponentKind.create({
    data: { utilityId, code: `fixed-${suffix}`, label: "Fixed" },
  });
  const component = await prisma.rateComponent.create({
    data: {
      utilityId,
      rateScheduleId: schedule.id,
      kindCode: kind.code,
      label: "Base charge",
      predicate: {},
      quantitySource: { type: "fixed" },
      pricing: { type: "flat", amount: "20.0000" },
      sortOrder: 1,
      effectiveDate: new Date("2026-01-01"),
    },
  });
  for (const [i, [label, amount]] of [
    ["Base charge", "20.0000"],
    ["Usage", "80.0000"],
  ].entries()) {
    await prisma.billSegmentLine.create({
      data: {
        utilityId,
        billSegmentId: segment.id,
        label,
        kindCode: kind.code,
        amount,
        sourceScheduleId: schedule.id,
        sourceComponentId: component.id,
        sortOrder: i + 1,
      },
    });
  }

  return bill.id;
}

describe("bill documents", () => {
  it("renders once, stores a pointer, and is idempotent", async () => {
    const billId = await postedBill();

    const first = await svc.renderBillDocument(UTILITY, billId, ACTOR);
    const second = await svc.renderBillDocument(UTILITY, billId, ACTOR);

    expect(put).toHaveBeenCalledTimes(1);
    expect(second.id).toBe(first.id);
    expect(first.objectKey).toBe(`bills/${UTILITY}/${billId}.pdf`);
    expect(first.sha256).toHaveLength(64);
    expect(first.byteSize).toBeGreaterThan(0);
    expect(first.storageIntegration).toBe("cis-bills");
    expect(first.templateKey).toBe("default-bill-v1");
  }, 60_000);

  it("stores no url, only a pointer", async () => {
    const billId = await postedBill();
    const row = await svc.renderBillDocument(UTILITY, billId, ACTOR);

    expect(JSON.stringify(row)).not.toContain("http");
  }, 60_000);

  it("round-trips the stored bytes on read", async () => {
    const billId = await postedBill();
    const row = await svc.renderBillDocument(UTILITY, billId, ACTOR);
    const uploaded = (put.mock.calls[0][0] as { body: Buffer }).body;
    get.mockResolvedValue(uploaded);

    const { bytes } = await svc.readBillDocument(UTILITY, billId);

    expect(bytes.subarray(0, 5).toString()).toBe("%PDF-");
    expect(bytes.length).toBe(row.byteSize);
  }, 60_000);

  it("re-renders in place when forced, and records the new hash", async () => {
    const billId = await postedBill();
    const first = await svc.renderBillDocument(UTILITY, billId, ACTOR);

    const forced = await svc.renderBillDocument(UTILITY, billId, ACTOR, { force: true });

    expect(put).toHaveBeenCalledTimes(2);
    expect(forced.id).toBe(first.id);
    expect(forced.objectKey).toBe(first.objectKey);
    expect(forced.sha256).toHaveLength(64);
  }, 60_000);

  it("leaves no row when the upload fails", async () => {
    const billId = await postedBill();
    put.mockRejectedValueOnce(new acError("rejected", 503, "cis-bills"));

    await expect(svc.renderBillDocument(UTILITY, billId, ACTOR)).rejects.toThrow();

    const count = await prismaImports.prisma.billDocument.count({ where: { billId } });
    expect(count).toBe(0);
  }, 60_000);

  /**
   * The audit log must not claim a document exists that does not. The
   * row is claimed before the upload so the unique constraint can
   * arbitrate concurrent renders, but a claim is not a document: only
   * the completed store is audited, and only once.
   */
  it("audits the document once, when it becomes real", async () => {
    const billId = await postedBill();

    await svc.renderBillDocument(UTILITY, billId, ACTOR);
    await svc.renderBillDocument(UTILITY, billId, ACTOR);

    expect(await auditTrail()).toEqual([
      { action: "CREATE", eventType: "bill_document.created" },
    ]);
  }, 60_000);

  it("leaves no audit trail when the upload fails", async () => {
    const billId = await postedBill();
    put.mockRejectedValueOnce(new acError("rejected", 503, "cis-bills"));

    await expect(svc.renderBillDocument(UTILITY, billId, ACTOR)).rejects.toThrow();

    expect(await auditTrail()).toEqual([]);
  }, 60_000);

  it("audits a forced re-render as a revision of the stored document", async () => {
    const billId = await postedBill();
    await svc.renderBillDocument(UTILITY, billId, ACTOR);

    await svc.renderBillDocument(UTILITY, billId, ACTOR, { force: true });

    expect(await auditTrail()).toEqual([
      { action: "CREATE", eventType: "bill_document.created" },
      { action: "UPDATE", eventType: "bill_document.revised" },
    ]);
  }, 60_000);

  it("refuses an unposted bill", async () => {
    const billId = await postedBill();
    await prismaImports.prisma.bill.update({ where: { id: billId }, data: { postedAt: null } });

    await expect(svc.renderBillDocument(UTILITY, billId, ACTOR)).rejects.toMatchObject({
      code: "NOT_POSTED",
    });
    expect(put).not.toHaveBeenCalled();
  }, 60_000);

  it("refuses when the tenant has no storage integration configured", async () => {
    const billId = await postedBill({ storage: false });

    await expect(svc.renderBillDocument(UTILITY, billId, ACTOR)).rejects.toMatchObject({
      code: "STORAGE_NOT_CONFIGURED",
    });
    expect(put).not.toHaveBeenCalled();
  }, 60_000);

  it("refuses when issuer identity is incomplete, naming the fields", async () => {
    const billId = await postedBill({
      issuer: { utilityName: "City of Testville Utilities" },
    });

    const err = await svc.renderBillDocument(UTILITY, billId, ACTOR).catch((e: unknown) => e);

    expect((err as { code: string }).code).toBe("ISSUER_INCOMPLETE");
    expect((err as { missing: string[] }).missing).toContain("remittanceCity");
    expect(put).not.toHaveBeenCalled();
  }, 60_000);

  it("keeps a document invisible to another tenant", async () => {
    const billId = await postedBill();
    await svc.renderBillDocument(UTILITY, billId, ACTOR);

    await expect(svc.readBillDocument(OTHER_UTILITY, billId)).rejects.toThrow();
  }, 60_000);

  it("totals on the rendered presentation reconcile to the bill's own columns", async () => {
    const billId = await postedBill();
    const { loadBillPresentation } = await import("../../services/bill-presentation.service.js");

    const p = await loadBillPresentation(UTILITY, billId);

    expect(p.totals.subtotal).toBe("100.00");
    expect(p.groups[0].subtotal).toBe("100.00");
    expect(p.totals.total).toBe("107.50");
  }, 60_000);
});

/**
 * Give the acting user a tenant-wide role carrying exactly these
 * `accounts` permissions. Without a CisUser row the authorization
 * middleware skips permission checks entirely, so a test that cares
 * about authority has to seed one.
 */
async function grantAccounts(permissions: string[]): Promise<void> {
  const { prisma } = prismaImports;
  const role = await prisma.role.create({
    data: { utilityId: UTILITY, name: `Role ${permissions.join("-")}`, permissions: { accounts: permissions } },
  });
  await prisma.cisUser.create({
    data: { id: ACTOR, utilityId: UTILITY, email: "tester@example.com", name: "Tester", isActive: true },
  });
  await prisma.userRole.create({
    data: { utilityId: UTILITY, userId: ACTOR, accountId: null, roleId: role.id },
  });
  const rbac = await import("../../services/rbac.service.js");
  await rbac.invalidateUserRoleCache(ACTOR, UTILITY);
}

/** The customer who holds the account the bill was raised against. */
async function customerIdOf(billId: string): Promise<string> {
  const bill = await prismaImports.prisma.bill.findUniqueOrThrow({
    where: { id: billId },
    select: { account: { select: { customerId: true } } },
  });
  // Account.customerId is nullable in the schema; the fixture always
  // sets one, so an absent customer means the fixture broke.
  const customerId = bill.account.customerId;
  if (!customerId) throw new Error(`Bill ${billId} has no account customer`);
  return customerId;
}

describe("bill document endpoints", () => {
  it("streams the stored PDF as an attachment named for the bill", async () => {
    const billId = await postedBill();
    await svc.renderBillDocument(UTILITY, billId, ACTOR);
    get.mockResolvedValue((put.mock.calls[0][0] as { body: Buffer }).body);

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/bills/${billId}/document`,
      headers: staffHeaders(),
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("application/pdf");
    expect(res.headers["content-disposition"]).toBe(
      `attachment; filename="bill-B-00aa.pdf"`,
    );
    expect(res.rawPayload.subarray(0, 5).toString()).toBe("%PDF-");
  }, 60_000);

  it("answers 404 when nothing has been rendered yet", async () => {
    const billId = await postedBill();

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/bills/${billId}/document`,
      headers: staffHeaders(),
    });

    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).error.code).toBe("NOT_RENDERED");
    expect(get).not.toHaveBeenCalled();
  }, 60_000);

  it("answers 422 naming the issuer fields the tenant has not filled in", async () => {
    const billId = await postedBill({
      issuer: { utilityName: "City of Testville Utilities" },
    });

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/bills/${billId}/document`,
      headers: staffHeaders(),
    });

    expect(res.statusCode).toBe(422);
    const body = JSON.parse(res.body);
    expect(body.error.code).toBe("ISSUER_INCOMPLETE");
    expect(body.error.missing).toContain("remittanceCity");
    expect(put).not.toHaveBeenCalled();
  }, 60_000);

  it("answers 409 for a bill that is not posted", async () => {
    const billId = await postedBill();
    await prismaImports.prisma.bill.update({
      where: { id: billId },
      data: { postedAt: null },
    });

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/bills/${billId}/document`,
      headers: staffHeaders(),
    });

    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).error.code).toBe("NOT_POSTED");
  }, 60_000);

  /**
   * A minted link is a bearer credential. The body names the integration
   * so an operator can find the misconfiguration, and nothing else.
   */
  it("answers 502 naming the integration, never a link, when the store rejects", async () => {
    const billId = await postedBill();
    put.mockRejectedValueOnce(new acError("rejected", 503, "cis-bills"));

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/bills/${billId}/document`,
      headers: staffHeaders(),
    });

    expect(res.statusCode).toBe(502);
    const body = JSON.parse(res.body);
    expect(body.error.integration).toBe("cis-bills");
    expect(res.body).not.toContain("http");
    expect(res.body).not.toContain("sig=");
  }, 60_000);

  it("lets a customer download a bill on their own account", async () => {
    const billId = await postedBill();
    await svc.renderBillDocument(UTILITY, billId, ACTOR);
    get.mockResolvedValue((put.mock.calls[0][0] as { body: Buffer }).body);

    const res = await app.inject({
      method: "GET",
      url: `/portal/api/bills/${billId}/document`,
      headers: portalHeaders(await customerIdOf(billId)),
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("application/pdf");
  }, 60_000);

  /**
   * The bill exists and has a document; it simply is not theirs. The
   * answer must be identical to one for a bill id that does not exist,
   * or the status alone confirms which ids are real.
   */
  it("hides another customer's bill from the portal", async () => {
    const billId = await postedBill();
    await svc.renderBillDocument(UTILITY, billId, ACTOR);
    get.mockResolvedValue((put.mock.calls[0][0] as { body: Buffer }).body);

    const res = await app.inject({
      method: "GET",
      url: `/portal/api/bills/${billId}/document`,
      headers: portalHeaders("00000000-0000-4000-8000-00000000cccc"),
    });

    expect(res.statusCode).toBe(404);
    expect(get).not.toHaveBeenCalled();
  }, 60_000);

  /**
   * Producing a document writes — a row, and an object in the tenant's
   * store — so a user who may only look at accounts cannot trigger it.
   * Downloading one that already exists is a read, and stays on VIEW.
   */
  it("refuses to produce a document for a user who only holds accounts:VIEW", async () => {
    const billId = await postedBill();
    await grantAccounts(["VIEW"]);
    await svc.renderBillDocument(UTILITY, billId, ACTOR);
    get.mockResolvedValue((put.mock.calls[0][0] as { body: Buffer }).body);
    put.mockClear();

    const produce = await app.inject({
      method: "POST",
      url: `/api/v1/bills/${billId}/document`,
      headers: staffHeaders(),
    });
    const download = await app.inject({
      method: "GET",
      url: `/api/v1/bills/${billId}/document`,
      headers: staffHeaders(),
    });

    expect(produce.statusCode).toBe(403);
    expect(download.statusCode).toBe(200);
    expect(put).not.toHaveBeenCalled();
  }, 60_000);

  it("lets accounts:EDIT produce and replace a document", async () => {
    const billId = await postedBill();
    await grantAccounts(["VIEW", "EDIT"]);

    const generate = await app.inject({
      method: "POST",
      url: `/api/v1/bills/${billId}/document`,
      headers: staffHeaders(),
    });
    const again = await app.inject({
      method: "POST",
      url: `/api/v1/bills/${billId}/document`,
      headers: staffHeaders(),
    });
    const forced = await app.inject({
      method: "POST",
      url: `/api/v1/bills/${billId}/document?force=true`,
      headers: staffHeaders(),
    });

    expect([generate.statusCode, again.statusCode, forced.statusCode]).toEqual([200, 200, 200]);
    // The unforced repeat must not re-upload; the forced one must.
    expect(put).toHaveBeenCalledTimes(2);
    expect(JSON.parse(again.body).id).toBe(JSON.parse(generate.body).id);
    expect(JSON.parse(forced.body).id).toBe(JSON.parse(generate.body).id);
  }, 60_000);

  it("refuses a portal download on a staff token with no customer claim", async () => {
    const billId = await postedBill();

    const res = await app.inject({
      method: "GET",
      url: `/portal/api/bills/${billId}/document`,
      headers: staffHeaders(),
    });

    expect(res.statusCode).toBe(403);
  }, 60_000);
});
