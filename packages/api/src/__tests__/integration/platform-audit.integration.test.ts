import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { bootPostgres } from "./_effective-dating-fixtures.js";

/**
 * What was done to a utility, and by whom.
 *
 * Every platform mutation wrote nothing to the audit log: provisioning,
 * suspending, reactivating, toggling a module, editing a role. So a
 * tenant admin could see every change their own staff made and nothing
 * an operator did *to them* — which is backwards, since the outside
 * actor is the one worth recording. Nobody could answer "why is this
 * suspended" or "who turned off our billing module".
 *
 * The row goes in **that tenant's** log, which is the precedent D6 sets
 * for the one platform capability it discusses in this much detail:
 * impersonation, it says, "needs to be written into the *tenant's* own
 * audit log". `audit_log.utility_id` is NOT NULL, so there is nowhere
 * else for it to go anyway.
 *
 * `source` is what distinguishes it. The column already separates
 * `scheduler:<queue>` from everything else — the retention sweep filters
 * on it — so a platform action takes `platform:<actorId>`, and an
 * operation run from the CLI takes `script:<name>`. A tenant's own staff
 * action still writes NULL there, which is the pre-existing convention:
 * the schema comment claims `user:<cisUserId>` but `writeAuditRow` has
 * never written one.
 */

let pgContainer: StartedPostgreSqlContainer;
let prismaImports: typeof import("../../lib/prisma.js");
let svc: typeof import("../../services/provisioning.service.js");

const UTILITY = "00000000-0000-4000-8000-0000000000d1";
const OPERATOR = "00000000-0000-4000-8000-aaaa0000d001";
const operator = { id: OPERATOR, name: "Pat Operator", source: `platform:${OPERATOR}` };

beforeAll(async () => {
  const booted = await bootPostgres();
  pgContainer = booted.container;
  prismaImports = await import("../../lib/prisma.js");
  svc = await import("../../services/provisioning.service.js");
}, 180_000);

afterAll(async () => {
  // `$disconnect` does not dispose a pool the application owns — that
  // is the driver-adapter contract — so the pools are ended here.
  // Without it the container stops while connections are live and
  // Postgres reports 57P01 as an unhandled error after a green run.
  await prismaImports?.prisma.$disconnect().catch(() => {});
  await prismaImports?.pool.end().catch(() => {});
  await pgContainer?.stop().catch(() => {});
});

beforeEach(async () => {
  const { prisma } = prismaImports;
  await prisma.auditLog.deleteMany({ where: { utilityId: UTILITY } });
  await prisma.userRole.deleteMany({ where: { utilityId: UTILITY } });
  await prisma.cisUser.deleteMany({ where: { utilityId: UTILITY } });
  await prisma.role.deleteMany({ where: { utilityId: UTILITY } });
  await prisma.utilityModule.deleteMany({ where: { utilityId: UTILITY } });
  await prisma.utility.deleteMany({ where: { id: UTILITY } });
});

async function auditRows(entityType?: string) {
  const { prisma } = prismaImports;
  return prisma.auditLog.findMany({
    where: { utilityId: UTILITY, ...(entityType ? { entityType } : {}) },
    orderBy: { createdAt: "asc" },
  });
}

describe("provisioning", () => {
  it("records who brought the utility into existence", async () => {
    await svc.provisionTenant({ utilityId: UTILITY, name: "City of Audit" }, operator);

    const [row] = await auditRows("Utility");
    expect(row).toMatchObject({
      utilityId: UTILITY,
      entityId: UTILITY,
      action: "CREATE",
      actorId: OPERATOR,
      actorName: "Pat Operator",
      source: `platform:${OPERATOR}`,
    });
  });

  it("writes nothing for a dry run", async () => {
    // The audit row is inside the same transaction the dry run rolls
    // back, so a preview cannot leave a trace claiming it happened.
    await svc.provisionTenant(
      { utilityId: UTILITY, name: "City of Audit", dryRun: true },
      operator,
    );

    expect(await auditRows()).toHaveLength(0);
  });

  it("attributes a run with no operator to the script, rather than to nobody", async () => {
    // The CLI has no signed-in actor. `actorId` is nullable for exactly
    // this case — the scheduler paths do the same — and the name says
    // what ran rather than leaving the row unattributed.
    await svc.provisionTenant({ utilityId: UTILITY, name: "City of Audit" });

    const [row] = await auditRows("Utility");
    expect(row).toMatchObject({ actorId: null, source: "script:provision-tenant" });
    expect(row.actorName).toBeTruthy();
  });
});

describe("suspending and reactivating", () => {
  beforeEach(async () => {
    await svc.provisionTenant({ utilityId: UTILITY, name: "City of Audit" }, operator);
    await prismaImports.prisma.auditLog.deleteMany({ where: { utilityId: UTILITY } });
  });

  it("records the suspension, with what changed", async () => {
    await svc.suspendUtility(UTILITY, operator);

    const [row] = await auditRows("Utility");
    expect(row).toMatchObject({ action: "UPDATE", actorName: "Pat Operator" });
    expect(row.beforeState).toMatchObject({ status: "ACTIVE" });
    expect(row.afterState).toMatchObject({ status: "SUSPENDED" });
  });

  it("records the reactivation separately", async () => {
    await svc.suspendUtility(UTILITY, operator);
    await svc.reactivateUtility(UTILITY, operator);

    const rows = await auditRows("Utility");
    expect(rows).toHaveLength(2);
    expect(rows[1].afterState).toMatchObject({ status: "ACTIVE" });
  });

  it("writes nothing when the utility does not exist", async () => {
    await expect(
      svc.suspendUtility("00000000-0000-4000-8000-0000000000df", operator),
    ).rejects.toMatchObject({ code: "UTILITY_NOT_FOUND" });

    expect(await auditRows()).toHaveLength(0);
  });
});

describe("module changes", () => {
  beforeEach(async () => {
    await svc.provisionTenant({ utilityId: UTILITY, name: "City of Audit" }, operator);
    await prismaImports.prisma.auditLog.deleteMany({ where: { utilityId: UTILITY } });
  });

  it("records which module was turned off", async () => {
    await svc.setUtilityModule(UTILITY, "containers", false, operator);

    const [row] = await auditRows("UtilityModule");
    expect(row).toMatchObject({ action: "UPDATE", source: `platform:${OPERATOR}` });
    expect(row.afterState).toMatchObject({ moduleKey: "containers", isEnabled: false });
  });

  it("records turning it back on", async () => {
    await svc.setUtilityModule(UTILITY, "containers", false, operator);
    await svc.setUtilityModule(UTILITY, "containers", true, operator);

    const rows = await auditRows("UtilityModule");
    expect(rows).toHaveLength(2);
    expect(rows[1].afterState).toMatchObject({ isEnabled: true });
  });

  it("writes nothing for a module the code does not have", async () => {
    await expect(
      svc.setUtilityModule(UTILITY, "not_a_module", false, operator),
    ).rejects.toMatchObject({ code: "UNKNOWN_MODULE" });

    expect(await auditRows()).toHaveLength(0);
  });
});

describe("role changes", () => {
  let roleSvc: typeof import("../../services/role.service.js");

  beforeEach(async () => {
    await svc.provisionTenant({ utilityId: UTILITY, name: "City of Audit" }, operator);
    roleSvc = await import("../../services/role.service.js");
    await prismaImports.prisma.auditLog.deleteMany({ where: { utilityId: UTILITY } });
  });

  it("records a role being created", async () => {
    await roleSvc.createRole(
      UTILITY,
      { name: "Auditor", permissions: { audit_log: ["VIEW"] } },
      { actorId: OPERATOR, actorName: "Pat Operator", source: `platform:${OPERATOR}` },
    );

    const [row] = await auditRows("Role");
    expect(row).toMatchObject({ action: "CREATE", source: `platform:${OPERATOR}` });
    expect(row.afterState).toMatchObject({ name: "Auditor" });
  });

  it("records what a role's permissions changed from", async () => {
    const { prisma } = prismaImports;
    const role = await prisma.role.findFirstOrThrow({ where: { utilityId: UTILITY, name: "CSR" } });

    await roleSvc.updateRole(
      UTILITY,
      role.id,
      { permissions: { customers: ["VIEW"] } },
      { actorId: OPERATOR, actorName: "Pat Operator", source: `platform:${OPERATOR}` },
    );

    const [row] = await auditRows("Role");
    expect(row.beforeState).toMatchObject({ name: "CSR" });
    expect(row.afterState).toMatchObject({ permissions: { customers: ["VIEW"] } });
  });

  it("records what a deleted role granted, since nothing can be looked up after", async () => {
    const { prisma } = prismaImports;
    const role = await prisma.role.create({
      data: { utilityId: UTILITY, name: "Spare", permissions: { audit_log: ["VIEW"] } },
    });

    await roleSvc.deleteRole(UTILITY, role.id, {
      actorId: OPERATOR,
      actorName: "Pat Operator",
      source: `platform:${OPERATOR}`,
    });

    const [row] = await auditRows("Role");
    expect(row).toMatchObject({ action: "DELETE" });
    expect(row.beforeState).toMatchObject({ name: "Spare" });
  });

  it("writes nothing when a refusal stops the delete", async () => {
    const { prisma } = prismaImports;
    const preset = await prisma.role.findFirstOrThrow({
      where: { utilityId: UTILITY, name: "System Admin" },
    });

    await expect(
      roleSvc.deleteRole(UTILITY, preset.id, { actorId: OPERATOR, actorName: "Pat" }),
    ).rejects.toMatchObject({ code: "SYSTEM_ROLE" });

    expect(await auditRows("Role")).toHaveLength(0);
  });

  it("attributes a tenant's own admin without a platform source", async () => {
    // Both paths write a row; `source` is what tells them apart, and the
    // tenant's own action leaves it NULL by the column's convention.
    await roleSvc.createRole(
      UTILITY,
      { name: "Local", permissions: { audit_log: ["VIEW"] } },
      { actorId: "00000000-0000-4000-8000-aaaa0000d002", actorName: "Tenant Admin" },
    );

    const [row] = await auditRows("Role");
    expect(row).toMatchObject({ actorName: "Tenant Admin", source: null });
  });
});

describe("the tenant's own view of it", () => {
  it("puts platform actions in the tenant's log, where its admins can read them", async () => {
    // The point of the whole exercise: a tenant can see what was done to
    // it from outside, in the same place it sees its own staff's changes.
    await svc.provisionTenant({ utilityId: UTILITY, name: "City of Audit" }, operator);
    await svc.suspendUtility(UTILITY, operator);

    const rows = await auditRows();
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(rows.every((r) => r.utilityId === UTILITY)).toBe(true);
    // And distinguishable from the tenant's own staff, who write NULL.
    expect(rows.every((r) => r.source?.startsWith("platform:"))).toBe(true);
  });
});
