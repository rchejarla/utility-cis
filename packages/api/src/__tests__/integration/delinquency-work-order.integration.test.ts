import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import {
  bootPostgres,
  resetDb,
  makeTenantFixture,
  seedAsPlatform,
  endAdminPool,
  truncateTables,
  ACTOR,
  TENANT_A,
  TENANT_B,
  type TenantFixture,
} from "./_effective-dating-fixtures.js";
import { runAsTenant } from "../../lib/tenant-context.js";

/*
 * `evaluateAll` sends notices, which enqueue. Mocked so a run leaves
 * nothing behind in the dev Redis that looks like real stuck work.
 */
vi.mock("../../lib/queues.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/queues.js")>()),
  enqueueSafely: vi.fn(async () => "test-job-id"),
}));

/**
 * The field work a delinquency tier implies (#198).
 *
 * Task 6 of `docs/superpowers/plans/2026-10-25-collections-wiring.md`.
 *
 * A sweep rather than part of the action's transaction, and the
 * asymmetry is the reason: a *late* work order costs nothing, a
 * *duplicate* fee is a wrong bill. `createServiceRequest` also opens a
 * transaction of its own for the request-number counter, so calling it
 * inside the action's transaction would hold a second pooled connection
 * while the first holds the account lock — under an hourly fan-out
 * across tenants, that is how a pool runs dry.
 *
 * Keyed on state — which live actions have no service request — so it is
 * idempotent by construction and recovers on the next tick if the
 * service request module was unavailable.
 */

let pgContainer: StartedPostgreSqlContainer;
let prismaImports: typeof import("../../lib/prisma.js");
let svc: typeof import("../../services/delinquency.service.js");
let wo: typeof import("../../services/delinquency-work-order.service.js");
let fixA: TenantFixture;
let fixB: TenantFixture;

const evaluateAll = (utilityId: string) =>
  runAsTenant(utilityId, async () => svc.evaluateAll(utilityId));

const sweepWorkOrders = (utilityId: string) =>
  runAsTenant(utilityId, async () => wo.sweepDelinquencyWorkOrders(utilityId));

function daysAgo(n: number): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - n);
  return d;
}

/** A shut-off tier, optionally naming the work order it dispatches. */
async function shutOffRule(opts: {
  utilityId?: string;
  tier?: number;
  serviceRequestTypeCode?: string | null;
}) {
  const utilityId = opts.utilityId ?? TENANT_A;
  return seedAsPlatform(async () =>
    prismaImports.prisma.delinquencyRule.create({
      data: {
        utilityId,
        name: `Tier ${opts.tier ?? 3} — shut-off`,
        tier: opts.tier ?? 3,
        daysPastDue: 45,
        minBalance: "1.00",
        actionType: "SHUT_OFF_ELIGIBLE",
        autoApply: true,
        isActive: true,
        effectiveDate: daysAgo(365),
        serviceRequestTypeCode:
          opts.serviceRequestTypeCode === undefined
            ? "SHUT_OFF"
            : opts.serviceRequestTypeCode,
      },
    }),
  );
}

async function pastDue(opts: { utilityId?: string; accountId: string; days: number }) {
  return seedAsPlatform(async () =>
    prismaImports.prisma.account.update({
      where: { id: opts.accountId },
      data: { balance: "100.00", lastDueDate: daysAgo(opts.days) },
    }),
  );
}

async function requests(utilityId = TENANT_A) {
  return seedAsPlatform(async () =>
    prismaImports.prisma.serviceRequest.findMany({
      where: { utilityId },
      orderBy: { requestNumber: "asc" },
    }),
  );
}

beforeAll(async () => {
  const booted = await bootPostgres({ utilities: [TENANT_A, TENANT_B] });
  pgContainer = booted.container;
  prismaImports = await import("../../lib/prisma.js");
  svc = await import("../../services/delinquency.service.js");
  wo = await import("../../services/delinquency-work-order.service.js");
}, 240_000);

afterAll(async () => {
  await prismaImports?.prisma.$disconnect().catch(() => {});
  await prismaImports?.pool.end().catch(() => {});
  await endAdminPool();
  await pgContainer?.stop().catch(() => {});
});

beforeEach(async () => {
  await resetDb();
  await truncateTables(
    "service_request, service_request_counter, service_request_type_def, sla, delinquency_action, delinquency_rule",
  );
  fixA = await makeTenantFixture(prismaImports.prisma, TENANT_A);
  fixB = await makeTenantFixture(prismaImports.prisma, TENANT_B);
  await seedAsPlatform(async () =>
    prismaImports.prisma.serviceRequestTypeDef.createMany({
      data: [
        { code: "SHUT_OFF", label: "Shut off for non-payment" },
        { code: "RECONNECT", label: "Reconnect after payment" },
      ],
      skipDuplicates: true,
    }),
  );
});

describe("dispatching the shut-off work order", () => {
  it("raises one work order per live shut-off action", async () => {
    await shutOffRule({});
    await pastDue({ accountId: fixA.accountId, days: 50 });
    await evaluateAll(TENANT_A);

    const result = await sweepWorkOrders(TENANT_A);

    expect(result.created).toBe(1);
    const rows = await requests();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.requestType).toBe("SHUT_OFF");
    expect(rows[0]!.accountId).toBe(fixA.accountId);
    expect(rows[0]!.source).toBe("DELINQUENCY_WORKFLOW");
    expect(rows[0]!.delinquencyActionId).not.toBeNull();
    // Nobody raised it, so nobody is recorded as having raised it. The
    // source column is what says where it came from.
    expect(rows[0]!.createdBy).toBeNull();
  });

  it("raises nothing on a second pass", async () => {
    await shutOffRule({});
    await pastDue({ accountId: fixA.accountId, days: 50 });
    await evaluateAll(TENANT_A);
    await sweepWorkOrders(TENANT_A);

    const again = await sweepWorkOrders(TENANT_A);

    expect(again.created).toBe(0);
    expect(await requests()).toHaveLength(1);
  });

  /*
   * The sweep asks whether a request was ever created, not whether one
   * is open. An operator who cancels a disconnection has decided
   * something, and a scheduler that raises it again every hour would
   * overrule them sixty times a day.
   */
  it("does not recreate one an operator cancelled", async () => {
    await shutOffRule({});
    await pastDue({ accountId: fixA.accountId, days: 50 });
    await evaluateAll(TENANT_A);
    await sweepWorkOrders(TENANT_A);
    await seedAsPlatform(async () =>
      prismaImports.prisma.serviceRequest.updateMany({
        where: { utilityId: TENANT_A },
        data: { status: "CANCELLED" },
      }),
    );

    const again = await sweepWorkOrders(TENANT_A);

    expect(again.created).toBe(0);
    expect(await requests()).toHaveLength(1);
  });

  /*
   * A tier that names no type dispatches nothing. That is what makes
   * this configuration rather than a rule inferred from actionType:
   * a utility whose field crews work off their own system wants the
   * notice tiers and no work orders at all.
   */
  it("raises nothing for a tier that names no work order type", async () => {
    await shutOffRule({ serviceRequestTypeCode: null });
    await pastDue({ accountId: fixA.accountId, days: 50 });
    await evaluateAll(TENANT_A);

    const result = await sweepWorkOrders(TENANT_A);

    expect(result.created).toBe(0);
    expect(await requests()).toHaveLength(0);
  });

  it("does not reach another tenant's actions", async () => {
    await shutOffRule({ utilityId: TENANT_B });
    await pastDue({ accountId: fixB.accountId, days: 50 });
    await evaluateAll(TENANT_B);

    const result = await sweepWorkOrders(TENANT_A);

    expect(result.created).toBe(0);
    expect(await requests(TENANT_A)).toHaveLength(0);
    expect(await requests(TENANT_B)).toHaveLength(0);
  });

  /*
   * One unroutable account must not stop the rest. The type code is
   * validated when the rule is saved, but a type can be deactivated
   * afterwards, and then every account on that tier would throw.
   */
  it("skips an action whose type has since been deactivated and still dispatches the others", async () => {
    await shutOffRule({ tier: 3, serviceRequestTypeCode: "SHUT_OFF" });
    await shutOffRule({ tier: 4, serviceRequestTypeCode: "RECONNECT" });
    await pastDue({ accountId: fixA.accountId, days: 60 });
    await evaluateAll(TENANT_A);
    await seedAsPlatform(async () =>
      prismaImports.prisma.serviceRequestTypeDef.updateMany({
        where: { code: "SHUT_OFF" },
        data: { isActive: false },
      }),
    );

    const result = await sweepWorkOrders(TENANT_A);

    expect(result.created).toBe(1);
    expect((await requests()).map((r) => r.requestType)).toEqual(["RECONNECT"]);
  });
});

describe("saving a tier that names a work order type", () => {
  it("refuses a type code the tenant does not have", async () => {
    await expect(
      runAsTenant(TENANT_A, async () => {
        const { assertServiceRequestTypeCode } = await import(
          "../../services/service-request-type-def.service.js"
        );
        return assertServiceRequestTypeCode(TENANT_A, "NO_SUCH_TYPE");
      }),
    ).rejects.toMatchObject({ code: "SERVICE_REQUEST_TYPE_UNKNOWN" });
  });
});

describe("the actor behind an automated request", () => {
  it("records the automated actor on the audit row, not on the request", async () => {
    await shutOffRule({});
    await pastDue({ accountId: fixA.accountId, days: 50 });
    await evaluateAll(TENANT_A);
    await sweepWorkOrders(TENANT_A);

    const audits = await seedAsPlatform(async () =>
      prismaImports.prisma.auditLog.findMany({
        where: { utilityId: TENANT_A, entityType: "ServiceRequest" },
        select: { actorId: true, actorName: true, action: true },
      }),
    );
    expect(audits).toHaveLength(1);
    expect(audits[0]!.action).toBe("CREATE");
    expect(audits[0]!.actorId).toBe(svc.AUTOMATED_ACTOR_ID);
    expect(audits[0]!.actorName).toBe(svc.AUTOMATED_ACTOR_NAME);
    expect(ACTOR).not.toBe(svc.AUTOMATED_ACTOR_ID);
  });
});
