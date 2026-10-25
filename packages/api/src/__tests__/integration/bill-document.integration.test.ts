import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import type { FastifyInstance } from "fastify";
import type { Prisma } from "@utility-cis/shared/src/generated/prisma";
import { runAsTenant } from "../../lib/tenant-context.js";
import {
  bootPostgres,
  ensurePrincipal,
  truncateTables,
  seedAsPlatform,
  endAdminPool,
} from "./_effective-dating-fixtures.js";

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
/** Audit rows record who acted; the service now requires the name. */
const ACTOR_NAME = "Document Generator";

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
let presentation: typeof import("../../services/bill-presentation.service.js");
let posting: typeof import("../../services/ar/posting.service.js");
let acError: typeof import("../../lib/apptor-connect/files-client.js").ApptorConnectError;
let app: FastifyInstance;

/**
 * An unsigned dev token, the shape the auth middleware accepts when
 * `alg: "none"`.
 *
 * This comment used to say that no CisUser row is seeded, so the
 * middleware's backwards-compatibility path skipped the per-permission
 * check. That path is gone — it handed every permission to any token
 * whose subject had no row — so the principal is seeded in `beforeAll`
 * with a role that grants everything. The cases here are still about
 * status mapping rather than RBAC; the difference is that the permission
 * they need is now granted rather than waived.
 */
/**
 * The two services as a route reaches them: acting for the tenant, not
 * merely naming it.
 *
 * Both already take the tenant as their first argument, and in
 * production that value came from a request whose middleware had
 * entered the scope — so the argument and the scope are always the same
 * id. A direct service test has the argument and not the scope, and on
 * a connection `cis_app` holds, a tenant table read with no scope raises
 * rather than returning the wrong rows. `args[0]` keeps the case that
 * acts as `OTHER_UTILITY` acting as `OTHER_UTILITY`.
 */
const generateBillDocument = (...args: Parameters<typeof svc.generateBillDocument>) =>
  runAsTenant(args[0], async () => svc.generateBillDocument(...args));

const readBillDocument = (...args: Parameters<typeof svc.readBillDocument>) =>
  runAsTenant(args[0], async () => svc.readBillDocument(...args));

const loadBillPresentation = (
  ...args: Parameters<typeof presentation.loadBillPresentation>
) => runAsTenant(args[0], async () => presentation.loadBillPresentation(...args));

const postBill = (...args: Parameters<typeof posting.postBill>) =>
  runAsTenant(args[0], async () => posting.postBill(...args));

/**
 * Every direct database touch in this file, under the fixture authority.
 *
 * None of them is the thing under test — the routes are, and each route
 * call runs as `cis_app` acting for the tenant its own request
 * establishes. These are rows being arranged, or rows being read back to
 * check what a route did, and several cases deliberately arrange a
 * second tenant's bill, which a tenant-scoped connection could not do.
 *
 * One accessor rather than forty wraps, so a new case cannot forget.
 */
const db = <T>(fn: (p: typeof prismaImports.prisma) => Promise<T>): Promise<T> =>
  // `async` with an `await` inside, not a bare `() => fn(...)`. A
  // `PrismaPromise` is lazy: built by the call, executed only when
  // something awaits it. Returning one out of the scope runs the query
  // after the scope has exited, which is the exact bug that made
  // dev-login answer USER_NOT_FOUND against a correct policy.
  seedAsPlatform(async () => await fn(prismaImports.prisma));

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
  const booted = await bootPostgres({ utilities: [OTHER_UTILITY, UTILITY] });
  pgContainer = booted.container;
  prismaImports = await import("../../lib/prisma.js");
  svc = await import("../../services/bill-document.service.js");
  presentation = await import("../../services/bill-presentation.service.js");
  posting = await import("../../services/ar/posting.service.js");
  acError = (await import("../../lib/apptor-connect/files-client.js")).ApptorConnectError;
  app = await (await import("../../app.js")).buildApp();
  await app.ready();
}, 180_000);

afterAll(async () => {
  await app?.close().catch(() => {});
  // `$disconnect` does not dispose a pool the application owns — that
  // is the driver-adapter contract — so the pools are ended here.
  // Without it the container stops while connections are live and
  // Postgres reports 57P01 as an unhandled error after a green run.
  await prismaImports?.prisma.$disconnect().catch(() => {});
  await prismaImports?.pool.end().catch(() => {});
  await endAdminPool();
  await pgContainer?.stop().catch(() => {});
});

beforeEach(async () => {
  put.mockReset().mockResolvedValue(undefined);
  get.mockReset();
  // Every table postedBill() writes, including the rate rows a
  // bill_segment_line's required source FKs need — leave one out and the
  // second test in the file collides on a unique code rather than
  // testing anything.
  await truncateTables("audit_log, bill_document, bill_segment_line, bill_segment, bill, service_agreement, account, customer, billing_address, billing_cycle, rate_component, rate_component_kind, rate_schedule, commodity, utility_config, utility_module, user_role, cis_user, role, notification, notification_template");
  await ensurePrincipal(prismaImports.prisma, UTILITY);
});

/** Audit rows this entity produced, oldest first. */
async function auditTrail(): Promise<Array<{ action: string; eventType: string }>> {
  /*
   * Deliberately cross-tenant, and so platform authority rather than
   * `runAsTenant`: this read carries no tenant predicate, so it sees
   * whatever tenant's rows exist, and the cases that post a bill for a
   * second tenant depend on that. Scoping it would quietly change what
   * those assertions mean.
   */
  return seedAsPlatform(async () => {
    const rows = await prismaImports.prisma.auditLog.findMany({
      where: { entityType: "BillDocument" },
      orderBy: { createdAt: "asc" },
    });
    return rows.map((r) => ({
      action: r.action,
      eventType: (r.metadata as { eventType?: string } | null)?.eventType ?? "",
    }));

  });
}

/**
 * A posted bill with one segment carrying two lines, a named customer
 * with a billing address, and complete issuer settings — the minimum
 * from which a bill can legitimately be rendered.
 */
async function postedBill(
  opts: {
    utilityId?: string;
    issuer?: Record<string, string> | null;
    storage?: boolean;
    /**
     * Money, at the 4dp the whole stack actually stores. The default is
     * exact to cents, which every fixture on this branch was — and that
     * is precisely why nothing noticed that the printed lines and the
     * totals box round in different orders. Pass sub-cent amounts to
     * exercise it.
     */
    money?: { lines: [string, string][]; subtotal: string; taxes: string; total: string };
  } = {},
): Promise<string> {
  /*
   * Arranging rows, so the authority the fixtures use. The routes under
   * test still run as `cis_app` acting for the tenant their own request
   * establishes, which is what this suite exists to exercise.
   */
  return seedAsPlatform(async () => {
    const { prisma } = prismaImports;
    const utilityId = opts.utilityId ?? UTILITY;
    const suffix = utilityId.slice(-4);
    const amounts =
      opts.money ??
      ({
        lines: [
          ["Base charge", "20.0000"],
          ["Usage", "80.0000"],
        ],
        subtotal: "100.0000",
        taxes: "7.5000",
        total: "107.5000",
      } as const);

    const settings: Record<string, unknown> = {};
    if (opts.issuer !== null) settings.issuer = opts.issuer ?? ISSUER;
    if (opts.storage !== false) settings.billDocuments = { storageIntegration: "cis-bills" };
    await prisma.utilityConfig.create({
      data: { utilityId, settings: settings as Prisma.InputJsonObject },
    });

    for (const moduleKey of MODULES) {
      await prisma.utilityModule.create({ data: { utilityId, moduleKey } });
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
        readDayOfMonth: 1, billDayOfMonth: 15,
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
        subtotal: amounts.subtotal,
        taxes: amounts.taxes,
        credits: "0.0000",
        total: amounts.total,
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
        subtotal: amounts.subtotal,
        taxes: amounts.taxes,
        credits: "0.0000",
        total: amounts.total,
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
    for (const [i, [label, amount]] of amounts.lines.entries()) {
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

  });
}

describe("bill documents", () => {
  it("renders once, stores a pointer, and is idempotent", async () => {
    const billId = await postedBill();

    const first = await generateBillDocument(UTILITY, billId, ACTOR, ACTOR_NAME);
    const second = await generateBillDocument(UTILITY, billId, ACTOR, ACTOR_NAME);

    expect(put).toHaveBeenCalledTimes(1);
    expect(second.id).toBe(first.id);
    expect(first.objectKey).toBe(`bills/${UTILITY}/${billId}.pdf`);
    expect(first.sha256).toHaveLength(64);
    expect(first.byteSize).toBeGreaterThan(0);
    expect(first.storageIntegration).toBe("cis-bills");
    expect(first.templateKey).toBe("default-bill-v1");
  }, 60_000);

  /**
   * This service wrote its audit rows with no actor name, because
   * `AuditContext.actorName` was optional and nothing noticed the
   * omission. Every `BillDocument` row in the dev database — all
   * twenty — carried a null actor while every other entity's rows
   * carried one, so the UI fell back to printing a raw uuid.
   */
  it("names the actor on the audit row it writes", async () => {
    const billId = await postedBill();
    const row = await generateBillDocument(UTILITY, billId, ACTOR, ACTOR_NAME);

    const audit = await db((p) => p.auditLog.findFirstOrThrow({
      where: { utilityId: UTILITY, entityType: "BillDocument", entityId: row.id },
    }));
    expect(audit.actorId).toBe(ACTOR);
    expect(audit.actorName).toBe(ACTOR_NAME);
  }, 60_000);

  /**
   * The storage design: this service addresses a file by pointer —
   * integration name plus key — and never by url. apptor-connect holds
   * the vendor credential and mints a link per operation, so a url
   * reaching either the row or the client's arguments would mean a
   * capability link had been persisted.
   *
   * This used to assert that the returned row's JSON contained no
   * "http", which no field of `BillDocumentRow` could have held in the
   * first place. The assertion that can fail is about what the service
   * asks the files client for.
   */
  it("addresses the file by pointer, never by url", async () => {
    const billId = await postedBill();
    const row = await generateBillDocument(UTILITY, billId, ACTOR, ACTOR_NAME);

    const args = put.mock.calls[0][0] as Record<string, unknown>;
    expect(args).toMatchObject({
      integration: "cis-bills",
      key: `bills/${UTILITY}/${billId}.pdf`,
    });
    expect(Object.keys(args)).not.toContain("url");
    // The stored row names the same pointer, and nothing resembling one
    // of apptor-connect's minted links.
    expect(row.objectKey).toBe(`bills/${UTILITY}/${billId}.pdf`);
    expect(row.storageIntegration).toBe("cis-bills");
    const persisted = await db((p) => p.billDocument.findFirstOrThrow({
      where: { billId },
    }));
    expect(Object.values(persisted).join(" ")).not.toMatch(/https?:\/\//);
  }, 60_000);

  /**
   * The read path holds the row and the bytes, and so is the only place
   * that can notice them disagreeing. Every bug this feature has had was
   * exactly that disagreement, and this path used to compare nothing —
   * it would have served a stale or foreign object as the customer's
   * bill.
   */
  it("refuses bytes that do not match the hash recorded for them", async () => {
    const billId = await postedBill();
    const row = await generateBillDocument(UTILITY, billId, ACTOR, ACTOR_NAME);
    // Same length, different content: a size check alone would pass.
    const wrong = Buffer.alloc(row.byteSize, 0x41);
    get.mockResolvedValue(wrong);

    await expect(readBillDocument(UTILITY, billId)).rejects.toThrow(/sha256/i);
  }, 60_000);

  it("refuses bytes of the wrong length for the row", async () => {
    const billId = await postedBill();
    await generateBillDocument(UTILITY, billId, ACTOR, ACTOR_NAME);
    get.mockResolvedValue(Buffer.from("%PDF-truncated"));

    await expect(readBillDocument(UTILITY, billId)).rejects.toThrow(/bytes/i);
  }, 60_000);

  it("round-trips the stored bytes on read", async () => {
    const billId = await postedBill();
    const row = await generateBillDocument(UTILITY, billId, ACTOR, ACTOR_NAME);
    const uploaded = (put.mock.calls[0][0] as { body: Buffer }).body;
    get.mockResolvedValue(uploaded);

    const { bytes } = await readBillDocument(UTILITY, billId);

    expect(bytes.subarray(0, 5).toString()).toBe("%PDF-");
    expect(bytes.length).toBe(row.byteSize);
  }, 60_000);

  it("re-renders in place when forced, and records the new hash", async () => {
    const billId = await postedBill();
    const first = await generateBillDocument(UTILITY, billId, ACTOR, ACTOR_NAME);

    const forced = await generateBillDocument(UTILITY, billId, ACTOR, ACTOR_NAME, { force: true });

    expect(put).toHaveBeenCalledTimes(2);
    expect(forced.id).toBe(first.id);
    expect(forced.objectKey).toBe(first.objectKey);
    expect(forced.sha256).toHaveLength(64);
  }, 60_000);

  /**
   * Found by exercising a real apptor-connect, which 404s an integration
   * it does not hold. The local fake accepted every name, so a row
   * pointing at a store without the object looked healthy: the bytes went
   * to the tenant's current integration while the row kept the one it was
   * first stored under, and every later download answered 502 with the new
   * bytes orphaned.
   */
  it("moves the stored pointer when the tenant's storage integration changes", async () => {
    const billId = await postedBill();
    await generateBillDocument(UTILITY, billId, ACTOR, ACTOR_NAME);

    await db((p) => p.utilityConfig.update({
      where: { utilityId: UTILITY },
      data: {
        settings: {
          issuer: ISSUER,
          billDocuments: { storageIntegration: "cis-bills-v2" },
        } as Prisma.InputJsonObject,
      },
    }));
    const moved = await generateBillDocument(UTILITY, billId, ACTOR, ACTOR_NAME, { force: true });

    // The upload went to the new integration, so the row has to name it.
    expect(put.mock.calls[1][0]).toMatchObject({ integration: "cis-bills-v2" });
    expect(moved.storageIntegration).toBe("cis-bills-v2");
    const row = await db((p) => p.billDocument.findFirstOrThrow({ where: { billId } }));
    expect(row.storageIntegration).toBe("cis-bills-v2");
  }, 60_000);

  /**
   * The interleaving neither earlier review pass could see, because this
   * file had no concurrent case at all.
   *
   * A creates the claim and blocks mid-upload. B adopts that claim,
   * uploads, and completes it. A's upload then fails. A owns the row, so
   * an ownership-only rule deletes it — discarding B's finished
   * document, orphaning its bytes, and leaving an audit row naming a row
   * that is gone. That is the same end state as a race loser deleting
   * the winner's claim, reached from the other side.
   *
   * Ordering is forced rather than hoped for: the first upload parks on
   * a promise this test rejects by hand.
   */
  it("does not delete a completed document when the creator's own upload fails", async () => {
    const billId = await postedBill();

    let startedFirstUpload!: () => void;
    const firstUploadStarted = new Promise<void>((resolve) => {
      startedFirstUpload = resolve;
    });
    let failFirstUpload!: (err: Error) => void;
    const firstUploadOutcome = new Promise<never>((_resolve, reject) => {
      failFirstUpload = reject;
    });

    let uploads = 0;
    put.mockImplementation(async () => {
      uploads += 1;
      if (uploads === 1) {
        startedFirstUpload();
        await firstUploadOutcome;
      }
      return undefined;
    });

    // A: claims the row, then parks inside putObject.
    const creator = generateBillDocument(UTILITY, billId, ACTOR, ACTOR_NAME);
    await firstUploadStarted;

    // B: adopts A's unfinished claim, uploads, and completes it.
    const adopter = await generateBillDocument(UTILITY, billId, ACTOR, ACTOR_NAME);
    expect(adopter.sha256).toHaveLength(64);

    // A's upload fails, after B has already stored.
    failFirstUpload(new acError("rejected", 503, "cis-bills"));
    await expect(creator).rejects.toThrow();

    // B's document survives, and the log records one creation, not two.
    const row = await db((p) => p.billDocument.findFirstOrThrow({ where: { billId } }));
    expect(row.sha256).toBe(adopter.sha256);
    expect(row.byteSize).toBe(adopter.byteSize);
    const created = (await auditTrail()).filter(
      (r) => r.eventType === "bill_document.created",
    );
    expect(created).toHaveLength(1);
  }, 60_000);

  it("leaves no row when the upload fails", async () => {
    const billId = await postedBill();
    put.mockRejectedValueOnce(new acError("rejected", 503, "cis-bills"));

    await expect(generateBillDocument(UTILITY, billId, ACTOR, ACTOR_NAME)).rejects.toThrow();

    const count = await db((p) => p.billDocument.count({ where: { billId } }));
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

    await generateBillDocument(UTILITY, billId, ACTOR, ACTOR_NAME);
    await generateBillDocument(UTILITY, billId, ACTOR, ACTOR_NAME);

    expect(await auditTrail()).toEqual([
      { action: "CREATE", eventType: "bill_document.created" },
    ]);
  }, 60_000);

  it("leaves no audit trail when the upload fails", async () => {
    const billId = await postedBill();
    put.mockRejectedValueOnce(new acError("rejected", 503, "cis-bills"));

    await expect(generateBillDocument(UTILITY, billId, ACTOR, ACTOR_NAME)).rejects.toThrow();

    expect(await auditTrail()).toEqual([]);
  }, 60_000);

  it("audits a forced re-render as a revision of the stored document", async () => {
    const billId = await postedBill();
    await generateBillDocument(UTILITY, billId, ACTOR, ACTOR_NAME);

    await generateBillDocument(UTILITY, billId, ACTOR, ACTOR_NAME, { force: true });

    expect(await auditTrail()).toEqual([
      { action: "CREATE", eventType: "bill_document.created" },
      { action: "UPDATE", eventType: "bill_document.revised" },
    ]);
  }, 60_000);

  /**
   * A bill that has been paid against has to say so.
   *
   * And it has to say so from the applications, bounded at the bill
   * date: the ledger keeps moving after a bill is issued, so a document
   * that reads it live stops being a record of what the customer was
   * shown — a reprint would quietly restate itself. A payment arriving
   * after the bill date belongs on the next bill.
   */
    /*
   * Whole body under the fixture authority: it builds a ledger by hand
   * and the ids are used further down, so wrapping only the writes would
   * scope their names away. The route call still enters its own tenant
   * scope.
   */
  it("prints the payments applied to it, and only those by the bill date", () =>
    seedAsPlatform(async () => {
      const billId = await postedBill();
      const { prisma } = prismaImports;
      const bill = await prisma.bill.findUniqueOrThrow({ where: { id: billId } });

      const charge = await prisma.ledgerEntry.create({
        data: {
          utilityId: UTILITY,
          accountId: bill.accountId,
          type: "BILL_CHARGE",
          amount: "107.50",
          openAmount: "37.50",
          effectiveDate: bill.billDate,
          billId,
        },
      });
      const byBillDate = await prisma.ledgerEntry.create({
        data: {
          utilityId: UTILITY,
          accountId: bill.accountId,
          type: "PAYMENT",
          amount: "-60.00",
          openAmount: "0.00",
          effectiveDate: new Date("2026-02-20"),
          tender: "CHECK",
        },
      });
      const afterBillDate = await prisma.ledgerEntry.create({
        data: {
          utilityId: UTILITY,
          accountId: bill.accountId,
          type: "PAYMENT",
          amount: "-10.00",
          openAmount: "0.00",
          effectiveDate: new Date("2026-03-20"),
          tender: "CARD",
        },
      });
      for (const [credit, amount] of [
        [byBillDate, "60.00"],
        [afterBillDate, "10.00"],
      ] as const) {
        await prisma.ledgerApplication.create({
          data: { utilityId: UTILITY, creditId: credit.id, debitId: charge.id, amount },
        });
      }

      const p = await loadBillPresentation(UTILITY, billId);

      expect(p.settlement?.applied).toHaveLength(1);
      expect(p.settlement?.applied[0]?.label).toBe("Payment (check)");
      expect(p.settlement?.applied[0]?.amount).toBe("-60.00");
      expect(p.settlement?.applied[0]?.date.toISOString().slice(0, 10)).toBe("2026-02-20");
      expect(p.settlement?.appliedTotal).toBe("-60.00");
      // 107.50 raised, 60.00 received by the bill date.
      expect(p.settlement?.amountDue).toBe("47.50");
      // The stub asks for what is left, not the charge.
      expect(p.remittance.amountDue).toBe("47.50");
      expect(p.totals.total).toBe("107.50");
  
    }),
    60_000,
  );

  it("leaves a bill with nothing applied to it unchanged", async () => {
    const billId = await postedBill();

    const p = await loadBillPresentation(UTILITY, billId);

    expect(p.settlement).toBeNull();
    expect(p.remittance.amountDue).toBe("107.50");
  }, 60_000);

  it("refuses an unposted bill", async () => {
    const billId = await postedBill();
    await db((p) => p.bill.update({ where: { id: billId }, data: { postedAt: null } }));

    await expect(generateBillDocument(UTILITY, billId, ACTOR, ACTOR_NAME)).rejects.toMatchObject({
      code: "NOT_POSTED",
    });
    expect(put).not.toHaveBeenCalled();
  }, 60_000);

  it("refuses when the tenant has no storage integration configured", async () => {
    const billId = await postedBill({ storage: false });

    await expect(generateBillDocument(UTILITY, billId, ACTOR, ACTOR_NAME)).rejects.toMatchObject({
      code: "STORAGE_NOT_CONFIGURED",
    });
    expect(put).not.toHaveBeenCalled();
  }, 60_000);

  /**
   * The ceiling is this deployment's, so the refusal has to be ours.
   *
   * Verified against the real files plane on 2026-10-14: an upload over
   * the `maxBytes` the link was minted with comes back 413, and the
   * route maps every `ApptorConnectError` to 502 STORAGE_UNAVAILABLE —
   * which would send an operator to investigate a store that is working
   * perfectly. Refused before the upload now, naming both numbers, and
   * the store is never asked.
   */
  it("refuses a PDF over this deployment's ceiling, before uploading it", async () => {
    const billId = await postedBill();
    const cfg = await import("../../config.js");
    const ceiling = cfg.config.BILL_DOCUMENT_MAX_BYTES;
    (cfg.config as { BILL_DOCUMENT_MAX_BYTES: number }).BILL_DOCUMENT_MAX_BYTES = 1024;

    try {
      const err = await generateBillDocument(UTILITY, billId, ACTOR, ACTOR_NAME).catch((e: unknown) => e);

      expect((err as { code: string }).code).toBe("DOCUMENT_TOO_LARGE");
      expect((err as Error).message).toMatch(/1024/);
      expect((err as Error).message).toMatch(/BILL_DOCUMENT_MAX_BYTES/);
      expect(put).not.toHaveBeenCalled();
      // Generated before the claim, so a bill that cannot be stored
      // leaves no row to read as an undownloadable document.
      expect(
        await db((p) => p.billDocument.findFirst({ where: { billId } })),
      ).toBeNull();
    } finally {
      (cfg.config as { BILL_DOCUMENT_MAX_BYTES: number }).BILL_DOCUMENT_MAX_BYTES = ceiling;
    }
  }, 60_000);

  it("refuses when issuer identity is incomplete, naming the fields", async () => {
    const billId = await postedBill({
      issuer: { utilityName: "City of Testville Utilities" },
    });

    const err = await generateBillDocument(UTILITY, billId, ACTOR, ACTOR_NAME).catch((e: unknown) => e);

    expect((err as { code: string }).code).toBe("ISSUER_INCOMPLETE");
    expect((err as { missing: string[] }).missing).toContain("remittanceCity");
    expect(put).not.toHaveBeenCalled();
  }, 60_000);

  it("keeps a document invisible to another tenant", async () => {
    const billId = await postedBill();
    await generateBillDocument(UTILITY, billId, ACTOR, ACTOR_NAME);

    await expect(readBillDocument(OTHER_UTILITY, billId)).rejects.toThrow();
  }, 60_000);

  it("totals on the rendered presentation reconcile to the bill's own columns", async () => {
    const billId = await postedBill();

    const p = await loadBillPresentation(UTILITY, billId);

    expect(p.totals.subtotal).toBe("100.00");
    expect(p.groups[0].subtotal).toBe("100.00");
    expect(p.totals.total).toBe("107.50");
    // Exact to cents, so the two rounding orders coincide and there is
    // nothing to disclose.
    expect(p.totals.rounding).toBeNull();
  }, 60_000);

  /**
   * The same claim, on money the stack can actually produce.
   *
   * The rate engine never rounds and `bill_segment_line.amount` is 4dp,
   * so a half-cent line is ordinary. Two lines of 16.1050 print as 16.11
   * each under a group subtotal of 32.22, while the stored subtotal of
   * 32.2100 rounds to 32.21 — the bill stated both and did not add up.
   * Every fixture on this branch was exact to cents, which is why the
   * test above passed either way.
   *
   * `Total due` still has to be what the ledger raised, so the cent is
   * disclosed as its own line instead of being absorbed.
   */
  it("prints an itemisation that adds up when lines carry half-cents", async () => {
    const billId = await postedBill({
      money: {
        lines: [
          ["Water Service Charge", "16.1050"],
          ["Sewer Service Charge", "16.1050"],
        ],
        subtotal: "32.2100",
        taxes: "0.0000",
        total: "32.2100",
      },
    });

    const p = await loadBillPresentation(UTILITY, billId);

    // What the customer can add up.
    expect(p.groups[0].lines.map((l) => l.amount)).toEqual(["16.11", "16.11"]);
    expect(p.groups[0].subtotal).toBe("32.22");
    expect(p.totals.subtotal).toBe("32.22");
    // What the ledger says is owed, which is what the stub asks for.
    expect(p.totals.total).toBe("32.21");
    expect(p.remittance.amountDue).toBe("32.21");
    // And the line that makes the two reconcile on the page.
    expect(p.totals.rounding).toBe("-0.01");
    const printed =
      Number(p.totals.subtotal) + Number(p.totals.taxes) - Number(p.totals.credits) +
      Number(p.totals.rounding);
    expect(printed.toFixed(2)).toBe(p.totals.total);
  }, 60_000);
});

/**
 * Give the acting user a tenant-wide role carrying exactly these
 * `accounts` permissions. Without a CisUser row the authorization
 * middleware skips permission checks entirely, so a test that cares
 * about authority has to seed one.
 */
async function grantAccounts(permissions: string[]): Promise<void> {
  /*
   * Arranging rows, so the authority the fixtures use. The routes under
   * test still run as `cis_app` acting for the tenant their own request
   * establishes, which is what this suite exists to exercise.
   */
  return seedAsPlatform(async () => {
    const { prisma } = prismaImports;
    const role = await prisma.role.create({
      data: { utilityId: UTILITY, name: `Role ${permissions.join("-")}`, permissions: { accounts: permissions } },
    });
    // Upserted, not created: `ensurePrincipal` in beforeEach already made
    // this actor so the cases that never call this helper can authenticate
    // at all. This one narrows the permissions rather than inventing the
    // user.
    await prisma.cisUser.upsert({
      where: { id: ACTOR },
      update: { utilityId: UTILITY, isActive: true },
      create: { id: ACTOR, utilityId: UTILITY, email: "tester@example.com", name: "Tester", isActive: true },
    });
    const assignment = await prisma.userRole.findFirst({
      where: { userId: ACTOR, accountId: null },
      select: { id: true },
    });
    if (assignment) {
      await prisma.userRole.update({ where: { id: assignment.id }, data: { roleId: role.id } });
    } else {
      await prisma.userRole.create({
        data: { utilityId: UTILITY, userId: ACTOR, accountId: null, roleId: role.id },
      });
    }
    const rbac = await import("../../services/rbac.service.js");
    await rbac.invalidateUserRoleCache(ACTOR, UTILITY);

  });
}

/** The customer who holds the account the bill was raised against. */
async function customerIdOf(billId: string): Promise<string> {
  /*
   * Deliberately cross-tenant, and so platform authority rather than
   * `runAsTenant`: this read carries no tenant predicate, so it sees
   * whatever tenant's rows exist, and the cases that post a bill for a
   * second tenant depend on that. Scoping it would quietly change what
   * those assertions mean.
   */
  return seedAsPlatform(async () => {
    const bill = await prismaImports.prisma.bill.findUniqueOrThrow({
      where: { id: billId },
      select: { account: { select: { customerId: true } } },
    });
    // Account.customerId is nullable in the schema; the fixture always
    // sets one, so an absent customer means the fixture broke.
    const customerId = bill.account.customerId;
    if (!customerId) throw new Error(`Bill ${billId} has no account customer`);
    return customerId;

  });
}

describe("bill document endpoints", () => {
  it("streams the stored PDF as an attachment named for the bill", async () => {
    const billId = await postedBill();
    await generateBillDocument(UTILITY, billId, ACTOR, ACTOR_NAME);
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
    expect(JSON.parse(res.body).error.code).toBe("NOT_GENERATED");
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
    await db((p) => p.bill.update({
      where: { id: billId },
      data: { postedAt: null },
    }));

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
    await generateBillDocument(UTILITY, billId, ACTOR, ACTOR_NAME);
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
    await generateBillDocument(UTILITY, billId, ACTOR, ACTOR_NAME);
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
    await generateBillDocument(UTILITY, billId, ACTOR, ACTOR_NAME);
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
    // Replaced in place, never accumulated: one bill, one document row.
    // This used to compare `id` across the three response bodies, which
    // stopped meaning anything when the response narrowed to describing
    // bytes rather than storage — both sides read `undefined` and the
    // assertion passed vacuously. The invariant is checked where it
    // lives instead.
    expect(await db((p) => p.billDocument.count({ where: { billId } }))).toBe(1);
    // An unforced repeat hands back the same stored generation.
    expect(JSON.parse(again.body)).toEqual(JSON.parse(generate.body));
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

/**
 * Delivering a bill — Bozeman #132.
 *
 * Here rather than in a file of its own because the precondition *is* a
 * posted bill with a rendered document, which `postedBill` already
 * builds; a parallel fixture is the thing that diverges.
 *
 * A delivery is a `notification` row, not a table of its own. That row
 * already records the channel, the address, the status, the provider's
 * message id, the attempts and the error, with a queue draining it — so
 * these cases assert against the outbox, and what they are really
 * pinning is which bills are allowed into it.
 */
describe("delivering a posted bill", () => {
  const DELIVER_EVENT = "billing.bill_ready";

  /** The tenant's template for the event, without which nothing sends. */
  async function template(): Promise<void> {
    await db((p) => p.notificationTemplate.create({
      data: {
        utilityId: UTILITY,
        name: "Bill Ready",
        eventType: DELIVER_EVENT,
        channels: { email: { subject: "Your bill", body: "Bill {{billNumber}} is ready." } },
        variables: [],
        isActive: true,
      },
    }));
  }

  /** A rendered document, which is the thing being delivered. */
  async function document(billId: string): Promise<void> {
    await db((p) => p.billDocument.create({
      data: {
        utilityId: UTILITY,
        billId,
        storageIntegration: "dev-files",
        objectKey: `bills/${billId}.pdf`,
        byteSize: 1024,
        documentType: "BILL",
        templateKey: "default-bill",
        isPaperless: false,
      },
    }));
  }

  /** An address to send to. The fixture's customer has none by design. */
  async function reachable(billId: string): Promise<void> {
    const bill = await db((p) => p.bill.findUniqueOrThrow({
      where: { id: billId },
      select: { account: { select: { customerId: true } } },
    }));
    await db((p) => p.customer.update({
      where: { id: bill.account.customerId! },
      data: { email: "jane.smith@example.com" },
    }));
  }

  function deliver(billId: string) {
    return app.inject({
      method: "POST",
      url: `/api/v1/bills/${billId}/deliver`,
      headers: staffHeaders(),
    });
  }

  it("queues one email against the bill, and says which outbox row it is", async () => {
    const billId = await postedBill();
    await Promise.all([template(), document(billId), reachable(billId)]);

    const res = await deliver(billId);

    expect(res.statusCode).toBe(202);
    const { notificationId } = JSON.parse(res.body);

    const queued = await db((p) => p.notification.findUniqueOrThrow({
      where: { id: notificationId },
    }));
    // The row is the delivery record: what, to whom, by which channel,
    // and not yet sent — the worker owns that part.
    expect(queued.billId).toBe(billId);
    expect(queued.eventType).toBe(DELIVER_EVENT);
    expect(queued.channel).toBe("EMAIL");
    expect(queued.recipientEmail).toBe("jane.smith@example.com");
    expect(queued.status).toBe("PENDING");
    expect(queued.sentAt).toBeNull();
  }, 60_000);

  it("refuses a bill that has not been posted", async () => {
    const billId = await postedBill();
    await Promise.all([template(), document(billId), reachable(billId)]);
    await db((p) => p.bill.update({
      where: { id: billId },
      data: { postedAt: null },
    }));

    const res = await deliver(billId);

    // Nobody owes an unposted bill. Sending it would ask a customer for
    // money the utility has not decided to charge.
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).error.code).toBe("BILL_NOT_POSTED");
    expect(await db((p) => p.notification.count())).toBe(0);
  }, 60_000);

  it("refuses a bill with nothing rendered to send", async () => {
    const billId = await postedBill();
    await Promise.all([template(), reachable(billId)]);

    const res = await deliver(billId);

    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).error.code).toBe("NO_BILL_DOCUMENT");
  }, 60_000);

  it("refuses when there is no address, and says what to do instead", async () => {
    const billId = await postedBill();
    await Promise.all([template(), document(billId)]);

    const res = await deliver(billId);

    expect(res.statusCode).toBe(422);
    const body = JSON.parse(res.body);
    expect(body.error.code).toBe("NO_EMAIL_ADDRESS");
    expect(body.error.message).toMatch(/by post/i);
  }, 60_000);

  /*
   * The quiet failure that would be worst: `sendNotification` answers
   * null when a tenant has no active template and logs it, which is
   * right for a scheduled notice and wrong for a person pressing Send —
   * they would be told it worked and nothing would arrive.
   */
  it("refuses when the tenant has no template for the event", async () => {
    const billId = await postedBill();
    await Promise.all([document(billId), reachable(billId)]);

    const res = await deliver(billId);

    expect(res.statusCode).toBe(422);
    expect(JSON.parse(res.body).error.code).toBe("NO_ACTIVE_TEMPLATE");
    expect(await db((p) => p.notification.count())).toBe(0);
  }, 60_000);

  it("refuses a second send while the first is still queued", async () => {
    const billId = await postedBill();
    await Promise.all([template(), document(billId), reachable(billId)]);

    expect((await deliver(billId)).statusCode).toBe(202);
    const second = await deliver(billId);

    // One click, one email. A resend is legitimate; two copies from one
    // operator's double-click is not.
    expect(second.statusCode).toBe(409);
    expect(JSON.parse(second.body).error.code).toBe("DELIVERY_IN_FLIGHT");
    expect(await db((p) => p.notification.count({ where: { billId } }))).toBe(1);
  }, 60_000);

  it("allows a resend once the first attempt has finished", async () => {
    const billId = await postedBill();
    await Promise.all([template(), document(billId), reachable(billId)]);
    const first = JSON.parse((await deliver(billId)).body).notificationId;
    await db((p) => p.notification.update({
      where: { id: first },
      data: { status: "SENT", sentAt: new Date() },
    }));

    // Utilities resend bills constantly — a deleted email, a wrong
    // address, a customer asking on the phone — and each attempt is its
    // own fact rather than an overwrite of the last.
    expect((await deliver(billId)).statusCode).toBe(202);
    expect(await db((p) => p.notification.count({ where: { billId } }))).toBe(2);
  }, 60_000);

  it("lists every attempt against the bill, newest first", async () => {
    const billId = await postedBill();
    await Promise.all([template(), document(billId), reachable(billId)]);
    const first = JSON.parse((await deliver(billId)).body).notificationId;
    await db((p) => p.notification.update({
      where: { id: first },
      data: { status: "FAILED", error: "mailbox unavailable", attempts: 1 },
    }));
    await deliver(billId);

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/bills/${billId}/deliveries`,
      headers: staffHeaders(),
    });

    expect(res.statusCode).toBe(200);
    const rows = JSON.parse(res.body) as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(2);
    expect(rows[0]!.status).toBe("PENDING");
    // The failure is still on the record, with its reason — the point of
    // a row per attempt rather than a column on the bill.
    expect(rows[1]!.status).toBe("FAILED");
    expect(rows[1]!.error).toBe("mailbox unavailable");
  }, 60_000);
});

/**
 * Bill holds — Bozeman #136.
 *
 * A held bill can neither post nor be delivered. It is not cancelled and
 * not reversed; nothing further happens to it until somebody releases
 * it.
 *
 * Both gates, which is the decision these cases exist to pin. Posting is
 * the irreversible step — a wrong charge is undone by a reversal on the
 * ledger, in full view, never by an edit — so a hold that stopped only
 * delivery would let the bill somebody is unsure about become money
 * owed, move the balance, and reach the portal and delinquency while
 * they were still looking at it.
 */
describe("holding a bill", () => {
  function hold(billId: string, reason = "Read looks wrong — re-reading the meter") {
    return app.inject({
      method: "POST",
      url: `/api/v1/bills/${billId}/hold`,
      headers: staffHeaders(),
      payload: { reason },
    });
  }

  function release(billId: string) {
    return app.inject({
      method: "POST",
      url: `/api/v1/bills/${billId}/release`,
      headers: staffHeaders(),
    });
  }

  /** An unposted bill, which is what a hold usually meets. */
  async function unposted(): Promise<string> {
    const billId = await postedBill();
    await db((p) => p.bill.update({
      where: { id: billId },
      data: { postedAt: null },
    }));
    return billId;
  }

  it("stops the bill becoming money owed", async () => {
    const billId = await unposted();
    expect((await hold(billId)).statusCode).toBe(204);

    await expect(
      postBill(UTILITY, ACTOR, "Tester", billId),
    ).rejects.toMatchObject({ code: "BILL_ON_HOLD" });

    // Not posted, and nothing on the ledger — the hold stops the whole
    // act rather than leaving a half-written one.
    const after = await db((p) => p.bill.findUniqueOrThrow({ where: { id: billId } }));
    expect(after.postedAt).toBeNull();
    expect(await db((p) => p.ledgerEntry.count({ where: { billId } }))).toBe(0);
  }, 60_000);

  it("stops the bill leaving the building", async () => {
    const billId = await postedBill();
    await hold(billId, "Customer disputing last month");

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/bills/${billId}/deliver`,
      headers: staffHeaders(),
    });

    expect(res.statusCode).toBe(409);
    const body = JSON.parse(res.body);
    expect(body.error.code).toBe("BILL_ON_HOLD");
    // The reason travels with the refusal: the operator should not have
    // to go and look up why it stopped.
    expect(body.error.message).toMatch(/disputing last month/);
  }, 60_000);

  it("refuses a hold with no reason", async () => {
    const billId = await unposted();

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/bills/${billId}/hold`,
      headers: staffHeaders(),
      payload: { reason: "   " },
    });

    // A hold nobody can explain is one nobody can clear.
    expect(res.statusCode).toBe(400);
  }, 60_000);

  it("lets the bill through once released", async () => {
    const billId = await unposted();
    await hold(billId);
    expect((await release(billId)).statusCode).toBe(204);

    await expect(
      postBill(UTILITY, ACTOR, "Tester", billId),
    ).resolves.toMatchObject({ billId });
  }, 60_000);

  it("refuses to release a bill that is not held", async () => {
    const billId = await unposted();
    expect((await release(billId)).statusCode).toBe(409);
  }, 60_000);

  it("lists what is held, for the worklist", async () => {
    const billId = await unposted();
    await hold(billId, "Meter re-read booked");

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/bills/held",
      headers: staffHeaders(),
    });

    expect(res.statusCode).toBe(200);
    const rows = JSON.parse(res.body) as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(billId);
    expect(rows[0]!.holdReason).toBe("Meter re-read booked");
    // Who it belongs to, because a worklist of bill ids is unusable.
    expect(rows[0]!.accountNumber).toBeTruthy();
  }, 60_000);
});

/**
 * A standing hold on the account — the rule, as against a bill's state.
 *
 * It exists because it has to reach bills that do not exist yet: a
 * move-out pending a final read, a bankruptcy, a legal hold. A per-bill
 * hold cannot say that.
 *
 * Nothing is stamped onto the bills. The gates read the account's reason
 * alongside the bill's, so lifting the rule frees everything at once and
 * there is nothing to reconcile. An earlier version copied the reason
 * onto each unposted bill and released by matching that string back,
 * which breaks as soon as somebody edits the reason.
 *
 * Billing itself still happens. Not billing a held account would push
 * the period into the next one, and a run that bills two periods at once
 * is the failure this system has already produced — a twenty-one-month
 * catch-up segment.
 */
describe("holding an account's billing", () => {
  async function accountOf(billId: string): Promise<string> {
    const bill = await db((p) => p.bill.findUniqueOrThrow({
      where: { id: billId },
      select: { accountId: true },
    }));
    return bill.accountId;
  }

  function holdAccount(accountId: string, reason = "Move-out pending final read") {
    return app.inject({
      method: "POST",
      url: `/api/v1/accounts/${accountId}/billing-hold`,
      headers: staffHeaders(),
      payload: { reason },
    });
  }

  function releaseAccount(accountId: string) {
    return app.inject({
      method: "POST",
      url: `/api/v1/accounts/${accountId}/billing-release`,
      headers: staffHeaders(),
    });
  }

  /** An unposted bill on a held account. */
  async function heldByAccount(): Promise<{ billId: string; accountId: string }> {
    const billId = await postedBill();
    await db((p) => p.bill.update({
      where: { id: billId },
      data: { postedAt: null },
    }));
    const accountId = await accountOf(billId);
    expect((await holdAccount(accountId)).statusCode).toBe(200);
    return { billId, accountId };
  }

  it("stops its bills posting, without touching the bills themselves", async () => {
    const { billId } = await heldByAccount();

    await expect(
      postBill(UTILITY, ACTOR, "Tester", billId),
    ).rejects.toMatchObject({ code: "BILL_ON_HOLD" });

    // The rule did the stopping. The bill carries no reason of its own,
    // which is what makes releasing the account sufficient.
    const after = await db((p) => p.bill.findUniqueOrThrow({ where: { id: billId } }));
    expect(after.holdReason).toBeNull();
    expect(after.postedAt).toBeNull();
  }, 60_000);

  it("stops its bills being delivered", async () => {
    const billId = await postedBill();
    const accountId = await accountOf(billId);
    await holdAccount(accountId, "Bankruptcy — legal hold");

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/bills/${billId}/deliver`,
      headers: staffHeaders(),
    });

    expect(res.statusCode).toBe(409);
    const body = JSON.parse(res.body);
    expect(body.error.code).toBe("BILL_ON_HOLD");
    expect(body.error.message).toMatch(/Bankruptcy/);
  }, 60_000);

  it("frees everything the moment it is lifted", async () => {
    const { billId, accountId } = await heldByAccount();

    expect((await releaseAccount(accountId)).statusCode).toBe(200);

    await expect(
      postBill(UTILITY, ACTOR, "Tester", billId),
    ).resolves.toMatchObject({ billId });
  }, 60_000);

  it("leaves a bill held on its own terms held", async () => {
    const { billId, accountId } = await heldByAccount();
    await app.inject({
      method: "POST",
      url: `/api/v1/bills/${billId}/hold`,
      headers: staffHeaders(),
      payload: { reason: "Disputed line" },
    });

    await releaseAccount(accountId);

    // True by construction now rather than by matching reason strings:
    // releasing an account was never a decision about this bill.
    const after = await db((p) => p.bill.findUniqueOrThrow({ where: { id: billId } }));
    expect(after.holdReason).toBe("Disputed line");
    await expect(
      postBill(UTILITY, ACTOR, "Tester", billId),
    ).rejects.toMatchObject({ code: "BILL_ON_HOLD" });
  }, 60_000);

  it("shows an account-held bill on the worklist, and says why it is there", async () => {
    const { billId } = await heldByAccount();

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/bills/held",
      headers: staffHeaders(),
    });

    const rows = JSON.parse(res.body) as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(billId);
    expect(rows[0]!.holdReason).toMatch(/Move-out pending/);
    // Which of the two holds it, because releasing the wrong one does
    // nothing and the operator should not have to guess.
    expect(rows[0]!.heldByAccount).toBe(true);
  }, 60_000);
});

/**
 * Why a bill cannot be sent, said on the list rather than discovered by
 * pressing Send.
 *
 * "Not sent" conflated five different situations: nobody has pressed
 * Send yet, the bill is not posted, it is held, nothing has been
 * rendered, or the customer has no address. The first is "I have not
 * got to it"; the rest are "this will never go until somebody fixes
 * something", and a worklist that cannot tell them apart is not a
 * worklist.
 *
 * The reasons come from the same function `deliverBill` throws by, so
 * the label on the row and the refusal on the button cannot drift —
 * which is the failure that has cost the most time in this codebase.
 */
describe("a bill list says why a bill cannot be sent", () => {
  async function listed(billId: string) {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/bills",
      headers: staffHeaders(),
    });
    expect(res.statusCode).toBe(200);
    const rows = JSON.parse(res.body).data as Array<Record<string, any>>;
    return rows.find((r) => r.id === billId)!;
  }

  it("names the hold", async () => {
    const billId = await postedBill();
    await db((p) => p.bill.update({
      where: { id: billId },
      data: { holdReason: "Disputed" },
    }));

    expect((await listed(billId)).blockedReason).toBe("BILL_ON_HOLD");
  }, 60_000);

  it("names a missing document", async () => {
    const billId = await postedBill();

    // postedBill renders nothing; the PDF is produced on demand.
    expect((await listed(billId)).blockedReason).toBe("NO_BILL_DOCUMENT");
  }, 60_000);

  it("names a missing address", async () => {
    const billId = await postedBill();
    await db((p) => p.billDocument.create({
      data: {
        utilityId: UTILITY,
        billId,
        storageIntegration: "dev-files",
        objectKey: `bills/${billId}.pdf`,
        byteSize: 1024,
        documentType: "BILL",
        templateKey: "default-bill",
        isPaperless: false,
      },
    }));

    // The fixture's customer has no email by design.
    expect((await listed(billId)).blockedReason).toBe("NO_EMAIL_ADDRESS");
  }, 60_000);

  it("says nothing is in the way when a bill is ready to go", async () => {
    const billId = await postedBill();
    await db((p) => p.billDocument.create({
      data: {
        utilityId: UTILITY,
        billId,
        storageIntegration: "dev-files",
        objectKey: `bills/${billId}.pdf`,
        byteSize: 1024,
        documentType: "BILL",
        templateKey: "default-bill",
        isPaperless: false,
      },
    }));
    const bill = await db((p) => p.bill.findUniqueOrThrow({
      where: { id: billId },
      select: { account: { select: { customerId: true } } },
    }));
    await db((p) => p.customer.update({
      where: { id: bill.account.customerId! },
      data: { email: "jane.smith@example.com" },
    }));

    // Null is the only state an operator acts on by pressing Send.
    expect((await listed(billId)).blockedReason).toBeNull();
  }, 60_000);
});

/**
 * What the bill says about money that did not come from the rate engine.
 *
 * Task 8 of `docs/superpowers/plans/2026-10-25-collections-wiring.md`.
 *
 * A late fee raises the account balance and produces no
 * `BillSegmentLine` — lines come entirely from rating, and each carries
 * a `sourceScheduleId` and `sourceComponentId` because a line *is* a
 * rated charge. So without this the customer receives a bill for
 * consumption, owes more than it says, and has nothing explaining the
 * difference.
 *
 * Bounded at the bill's own `billDate` on one side and the previous
 * bill's on the other. The upper bound is not optional: a document that
 * reads the ledger at render time stops being a record of what the
 * customer was shown, which is the property `sha256` and byte-stable
 * regeneration exist to protect — a reprint of last March must not
 * acquire a fee raised in April.
 */
describe("account activity on a bill", () => {
  /** The account, agreement and rate rows `postedBill` left behind. */
  async function context(billId: string) {
    return db(async (p) => {
      const bill = await p.bill.findUniqueOrThrow({
        where: { id: billId },
        select: {
          accountId: true,
          billingCycleId: true,
          segments: { select: { serviceAgreementId: true } },
        },
      });
      const schedule = await p.rateSchedule.findFirstOrThrow({ where: { utilityId: UTILITY } });
      const kind = await p.rateComponentKind.findFirstOrThrow({ where: { utilityId: UTILITY } });
      const component = await p.rateComponent.findFirstOrThrow({ where: { utilityId: UTILITY } });
      return {
        accountId: bill.accountId,
        agreementId: bill.segments[0]!.serviceAgreementId,
        billingCycleId: bill.billingCycleId,
        scheduleId: schedule.id,
        kindCode: kind.code,
        componentId: component.id,
      };
    });
  }

  type Ctx = Awaited<ReturnType<typeof context>>;

  /** A second bill on the same account, later than the first. */
  async function laterBill(
    ctx: Ctx,
    opts: { number: string; billDate: string; periodStart: string; periodEnd: string },
  ): Promise<string> {
    return db(async (p) => {
      const bill = await p.bill.create({
        data: {
          utilityId: UTILITY,
          accountId: ctx.accountId,
          billingCycleId: ctx.billingCycleId,
          periodStart: new Date(opts.periodStart),
          periodEnd: new Date(opts.periodEnd),
          billDate: new Date(opts.billDate),
          dueDate: new Date(opts.billDate),
          subtotal: "50.0000",
          taxes: "0.0000",
          credits: "0.0000",
          total: "50.0000",
          billNumber: opts.number,
          postedAt: new Date(opts.billDate),
        },
      });
      const segment = await p.billSegment.create({
        data: {
          utilityId: UTILITY,
          serviceAgreementId: ctx.agreementId,
          billId: bill.id,
          periodStart: new Date(opts.periodStart),
          periodEnd: new Date(opts.periodEnd),
          subtotal: "50.0000",
          taxes: "0.0000",
          credits: "0.0000",
          total: "50.0000",
          minimumFloorApplied: false,
          segmentNumber: `SEG-${opts.number}`,
        },
      });
      await p.billSegmentLine.create({
        data: {
          utilityId: UTILITY,
          billSegmentId: segment.id,
          label: "Base charge",
          kindCode: ctx.kindCode,
          amount: "50.0000",
          sourceScheduleId: ctx.scheduleId,
          sourceComponentId: ctx.componentId,
          sortOrder: 1,
        },
      });
      return bill.id;
    });
  }

  /*
   * `ledger_reason_def` survives the beforeEach: its only foreign key is
   * to `utility`, which is not truncated, so nothing cascades to it. A
   * fixed code would collide on (utility_id, code) with the previous
   * case rather than testing anything, so each one gets its own.
   */
  let reasonSeq = 0;

  /** A fee on the account, as the delinquency ladder would raise it. */
  async function feeOn(
    ctx: Ctx,
    opts: { label: string; amount: string; on: string },
  ) {
    const code = `ACTIVITY_FEE_${++reasonSeq}`;
    return db(async (p) => {
      const reason = await p.ledgerReasonDef.create({
        data: { utilityId: UTILITY, code, label: opts.label, appliesToType: "FEE" },
      });
      return p.ledgerEntry.create({
        data: {
          utilityId: UTILITY,
          accountId: ctx.accountId,
          type: "FEE",
          amount: opts.amount,
          openAmount: opts.amount,
          effectiveDate: new Date(opts.on),
          dueDate: new Date(opts.on),
          reasonId: reason.id,
        },
      });
    });
  }

  /*
   * The bill's own BILL_CHARGE, written directly: `postedBill` already
   * marks the bill posted, so `postBill` refuses it as posted twice.
   */
  async function chargeFor(ctx: Ctx, billId: string): Promise<string> {
    return db(async (p) => {
      const entry = await p.ledgerEntry.create({
        data: {
          utilityId: UTILITY,
          accountId: ctx.accountId,
          type: "BILL_CHARGE",
          billId,
          amount: "107.50",
          openAmount: "107.50",
          effectiveDate: new Date("2026-03-01"),
          dueDate: new Date("2026-03-31"),
        },
      });
      return entry.id;
    });
  }

  it("shows a fee raised before the bill date, in the tenant's own words", async () => {
    const billId = await postedBill();
    const ctx = await context(billId);
    await feeOn(ctx, {
      label: "Late payment fee", amount: "25.00", on: "2026-02-10",
    });

    const p = await loadBillPresentation(UTILITY, billId);

    expect(p.activity).not.toBeNull();
    expect(p.activity!.entries).toHaveLength(1);
    expect(p.activity!.entries[0]!.label).toBe("Late payment fee");
    expect(p.activity!.entries[0]!.amount).toBe("25.00");
    expect(p.activity!.total).toBe("25.00");
  });

  it("does not show a fee raised after the bill date", async () => {
    const billId = await postedBill();
    const ctx = await context(billId);
    await feeOn(ctx, {
      label: "Late payment fee", amount: "25.00", on: "2026-03-15",
    });

    const p = await loadBillPresentation(UTILITY, billId);

    expect(p.activity).toBeNull();
  });

  it("shows only what happened since the previous bill", async () => {
    const firstId = await postedBill();
    const ctx = await context(firstId);
    await feeOn(ctx, {
      label: "Earlier charge", amount: "10.00", on: "2026-02-10",
    });
    await feeOn(ctx, {
      label: "Late payment fee", amount: "25.00", on: "2026-03-20",
    });
    const secondId = await laterBill(ctx, {
      number: "B-SECOND", billDate: "2026-04-01",
      periodStart: "2026-03-01", periodEnd: "2026-03-31",
    });

    const first = await loadBillPresentation(UTILITY, firstId);
    const second = await loadBillPresentation(UTILITY, secondId);

    expect(first.activity!.entries.map((e) => e.label)).toEqual(["Earlier charge"]);
    expect(second.activity!.entries.map((e) => e.label)).toEqual(["Late payment fee"]);
  });

  it("prints no activity block when nothing happened", async () => {
    const billId = await postedBill();

    const p = await loadBillPresentation(UTILITY, billId);

    expect(p.activity).toBeNull();
  });

  /*
   * The bill's own charge is the bill. Repeating it under activity would
   * show the customer the same money twice.
   */
  it("does not repeat the bill's own charge", async () => {
    const billId = await postedBill();
    const ctx = await context(billId);
    await chargeFor(ctx, billId);

    const p = await loadBillPresentation(UTILITY, billId);

    expect(p.activity).toBeNull();
  });

  /*
   * A payment already itemised under "Payments and credits received"
   * must not appear again under activity.
   */
  it("does not repeat a payment already shown as settled", async () => {
    const billId = await postedBill();
    const ctx = await context(billId);
    const chargeId = await chargeFor(ctx, billId);
    await db(async (p) => {
      const charge = await p.ledgerEntry.findUniqueOrThrow({ where: { id: chargeId } });
      const paid = await p.ledgerEntry.create({
        data: {
          utilityId: UTILITY,
          accountId: ctx.accountId,
          type: "PAYMENT",
          amount: "-20.00",
          openAmount: "0.00",
          effectiveDate: new Date("2026-02-20"),
          tender: "CASH",
        },
      });
      await p.ledgerApplication.create({
        data: { utilityId: UTILITY, creditId: paid.id, debitId: charge.id, amount: "20.00" },
      });
      await p.ledgerEntry.update({
        where: { id: charge.id },
        data: { openAmount: charge.amount.minus(20) },
      });
    });

    const p = await loadBillPresentation(UTILITY, billId);

    expect(p.settlement!.applied).toHaveLength(1);
    expect(p.activity).toBeNull();
  });

  /*
   * The property the upper bound exists for. A reprint has to produce
   * the document the customer was sent, not a fresher one.
   */
  it("reprints byte-identically after a later fee is raised", async () => {
    const billId = await postedBill();
    const ctx = await context(billId);
    const first = await generateBillDocument(UTILITY, billId, ACTOR, ACTOR_NAME);

    await feeOn(ctx, {
      label: "Late payment fee", amount: "25.00", on: "2026-04-10",
    });
    const reprint = await generateBillDocument(UTILITY, billId, ACTOR, ACTOR_NAME, {
      force: true,
    });

    expect(reprint.sha256).toBe(first.sha256);
    expect(reprint.byteSize).toBe(first.byteSize);
  }, 60_000);
});
