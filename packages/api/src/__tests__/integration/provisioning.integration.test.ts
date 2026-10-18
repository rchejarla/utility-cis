import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { MODULES } from "@utility-cis/shared";
import { bootPostgres } from "./_effective-dating-fixtures.js";

/**
 * Bringing a tenant into existence.
 *
 * Until now there was no way: `utility.create` and `utilityModule.create`
 * appeared nowhere outside tests, so onboarding a second utility meant a
 * developer running SQL, and a freshly migrated database answered 403 on
 * every gated route because no `utility_module` rows existed (§1.5 of the
 * tenancy design note).
 *
 * Against a real database rather than a mocked client, because what is
 * being tested is constraints and transaction boundaries — a half
 * provisioned tenant, a colliding admin email, a rename — none of which a
 * mock can show. `bootPostgres` is called with no `utilities`: this
 * function is what creates them.
 */

let pgContainer: StartedPostgreSqlContainer;
let prismaImports: typeof import("../../lib/prisma.js");
let svc: typeof import("../../services/provisioning.service.js");

const NEW_TENANT = "00000000-0000-4000-8000-0000000000f1";
const OTHER = "00000000-0000-4000-8000-0000000000f2";

beforeAll(async () => {
  const booted = await bootPostgres();
  pgContainer = booted.container;
  prismaImports = await import("../../lib/prisma.js");
  svc = await import("../../services/provisioning.service.js");
}, 180_000);

afterAll(async () => {
  await prismaImports?.prisma.$disconnect().catch(() => {});
  await pgContainer?.stop().catch(() => {});
});

beforeEach(async () => {
  const { prisma } = prismaImports;
  // Children first: utility_id is ON DELETE RESTRICT.
  for (const id of [NEW_TENANT, OTHER]) {
    await prisma.userRole.deleteMany({ where: { utilityId: id } });
    await prisma.cisUser.deleteMany({ where: { utilityId: id } });
    await prisma.role.deleteMany({ where: { utilityId: id } });
    await prisma.utilityModule.deleteMany({ where: { utilityId: id } });
    await prisma.utility.deleteMany({ where: { id } });
  }
});

describe("provisionTenant", () => {
  it("creates a utility, its modules, and the preset roles", async () => {
    const { prisma } = prismaImports;

    const result = await svc.provisionTenant({ utilityId: NEW_TENANT, name: "City of Example" });

    expect(result).toMatchObject({ created: true, rolesCreated: 6, adminCreated: false });
    expect(result.modulesEnabled).toBe(MODULES.length);
    expect(await prisma.utility.findUniqueOrThrow({ where: { id: NEW_TENANT } })).toMatchObject({
      name: "City of Example",
      status: "ACTIVE",
    });
  });

  it("is a no-op when run twice", async () => {
    const { prisma } = prismaImports;

    await svc.provisionTenant({ utilityId: NEW_TENANT, name: "City of Example" });
    const second = await svc.provisionTenant({ utilityId: NEW_TENANT, name: "City of Example" });

    expect(second).toMatchObject({ created: false, modulesEnabled: 0, rolesCreated: 0 });
    expect(await prisma.role.count({ where: { utilityId: NEW_TENANT } })).toBe(6);
    expect(await prisma.utilityModule.count({ where: { utilityId: NEW_TENANT } })).toBe(
      MODULES.length,
    );
  });

  /**
   * Renaming is its own lifecycle operation. Doing it as a side effect of
   * re-provisioning would let a typo in a script rename a live tenant.
   */
  it("refuses to rename an existing utility", async () => {
    await svc.provisionTenant({ utilityId: NEW_TENANT, name: "City of Example" });

    await expect(
      svc.provisionTenant({ utilityId: NEW_TENANT, name: "Something Else" }),
    ).rejects.toMatchObject({ code: "UTILITY_NAME_MISMATCH" });
  });

  /**
   * Existence is keyed on the id, so nothing stopped two calls that each
   * generated their own id from producing two tenants with one name — and
   * neither the page nor `--name` without `--utility-id` supplies an id.
   * The operator who clicks Create twice means one tenant, and gets two
   * rows distinguishable only by a uuid in a tooltip.
   *
   * Refused rather than adopted: returning the existing tenant would
   * report success for a tenant this call did not create, and the caller
   * who did mean to re-provision has `--utility-id` for it.
   */
  it("refuses a name another utility already holds", async () => {
    const { prisma } = prismaImports;
    await svc.provisionTenant({ utilityId: OTHER, name: "City of Example" });

    await expect(
      svc.provisionTenant({ utilityId: NEW_TENANT, name: "City of Example" }),
    ).rejects.toMatchObject({ code: "UTILITY_NAME_TAKEN" });

    // The refusal precedes every write, so the second id does not exist.
    expect(await prisma.utility.findUnique({ where: { id: NEW_TENANT } })).toBeNull();
  });

  it("compares the name case-insensitively — two casings are one tenant to a reader", async () => {
    await svc.provisionTenant({ utilityId: OTHER, name: "City of Example" });

    await expect(
      svc.provisionTenant({ utilityId: NEW_TENANT, name: "CITY OF EXAMPLE" }),
    ).rejects.toMatchObject({ code: "UTILITY_NAME_TAKEN" });
  });

  it("still re-provisions the tenant that holds the name, by id", async () => {
    await svc.provisionTenant({ utilityId: NEW_TENANT, name: "City of Example" });

    // The name check must exempt its own holder, or every reseed breaks.
    const second = await svc.provisionTenant({ utilityId: NEW_TENANT, name: "City of Example" });
    expect(second).toMatchObject({ created: false, rolesCreated: 0 });
  });

  /**
   * A utility row with no roles reads as a provisioned tenant to every
   * existence check and cannot administer itself. One transaction, or
   * nothing.
   */
  it("leaves no tenant behind when provisioning fails partway", async () => {
    const { prisma } = prismaImports;

    // Fail at the last step, after the utility, 32 modules and 6 roles
    // are already written: cis_user.email is VARCHAR(255).
    //
    // A pre-existing role name does NOT work for this — roles are
    // created only when absent by (utilityId, name), which is the
    // idempotency the two no-op tests above rely on, so a squatter row
    // is skipped rather than colliding.
    await expect(
      svc.provisionTenant({
        utilityId: OTHER,
        name: "Half Provisioned",
        firstAdmin: { email: `${"e".repeat(300)}@example.gov`, name: "Too Long" },
      }),
    ).rejects.toThrow();

    // Nothing at all, not a shell that later reads as provisioned.
    expect(await prisma.utility.findUnique({ where: { id: OTHER } })).toBeNull();
    expect(await prisma.role.count({ where: { utilityId: OTHER } })).toBe(0);
    expect(await prisma.utilityModule.count({ where: { utilityId: OTHER } })).toBe(0);
    expect(await prisma.cisUser.count({ where: { utilityId: OTHER } })).toBe(0);
  });

  it("creates a first admin with the System Admin role when asked", async () => {
    const { prisma } = prismaImports;

    const result = await svc.provisionTenant({
      utilityId: NEW_TENANT,
      name: "City of Example",
      firstAdmin: { email: "admin@example.gov", name: "Pat Admin" },
    });

    expect(result.adminCreated).toBe(true);
    const user = await prisma.cisUser.findFirstOrThrow({
      where: { utilityId: NEW_TENANT, email: "admin@example.gov" },
    });
    const assignment = await prisma.userRole.findFirstOrThrow({
      where: { userId: user.id, accountId: null },
      include: { role: { select: { name: true } } },
    });
    expect(assignment.role.name).toBe("System Admin");
  });

  /**
   * `auth.ts` looks a user up by `email.toLowerCase()`. An admin stored
   * with a capital letter is therefore an admin who cannot log in — and
   * it is the only account the new tenant has.
   */
  it("stores the first admin's email lowercased, so login can find it", async () => {
    const { prisma } = prismaImports;

    await svc.provisionTenant({
      utilityId: NEW_TENANT,
      name: "City of Example",
      firstAdmin: { email: "Ops@CityOfExample.gov", name: "Pat Admin" },
    });

    const user = await prisma.cisUser.findFirstOrThrow({ where: { utilityId: NEW_TENANT } });
    expect(user.email).toBe("ops@cityofexample.gov");
  });

  it("treats a case variant of the admin email as the same admin", async () => {
    const { prisma } = prismaImports;

    await svc.provisionTenant({
      utilityId: NEW_TENANT,
      name: "City of Example",
      firstAdmin: { email: "ops@example.gov", name: "Pat Admin" },
    });
    const again = await svc.provisionTenant({
      utilityId: NEW_TENANT,
      name: "City of Example",
      firstAdmin: { email: "OPS@EXAMPLE.GOV", name: "Pat Admin" },
    });

    expect(again.adminCreated).toBe(false);
    expect(await prisma.cisUser.count({ where: { utilityId: NEW_TENANT } })).toBe(1);
  });

  it("reports an existing admin rather than failing on the unique index", async () => {
    const { prisma } = prismaImports;
    const firstAdmin = { email: "admin@example.gov", name: "Pat Admin" };

    await svc.provisionTenant({ utilityId: NEW_TENANT, name: "City of Example", firstAdmin });
    const again = await svc.provisionTenant({
      utilityId: NEW_TENANT,
      name: "City of Example",
      firstAdmin,
    });

    expect(again.adminCreated).toBe(false);
    expect(await prisma.cisUser.count({ where: { utilityId: NEW_TENANT } })).toBe(1);
  });

  it("enables only modules the code still has", async () => {
    const { prisma } = prismaImports;

    await svc.provisionTenant({ utilityId: NEW_TENANT, name: "City of Example" });

    const keys = (
      await prisma.utilityModule.findMany({
        where: { utilityId: NEW_TENANT },
        select: { moduleKey: true },
      })
    ).map((m) => m.moduleKey);
    expect(keys.filter((k) => !(MODULES as readonly string[]).includes(k))).toEqual([]);
  });

  it("rejects a profile it does not know", async () => {
    await expect(
      svc.provisionTenant({
        utilityId: NEW_TENANT,
        name: "City of Example",
        profile: "bozeman" as never,
      }),
    ).rejects.toMatchObject({ code: "UNKNOWN_PROFILE" });
  });

  // ─── dry run ───────────────────────────────────────────────────

  it("writes nothing on a dry run, but reports what it would do", async () => {
    const { prisma } = prismaImports;

    const planned = await svc.provisionTenant({
      utilityId: NEW_TENANT,
      name: "City of Example",
      firstAdmin: { email: "admin@example.gov", name: "Pat Admin" },
      dryRun: true,
    });

    expect(planned).toMatchObject({ created: true, rolesCreated: 6, adminCreated: true });
    expect(planned.modulesEnabled).toBe(MODULES.length);
    // The row it claims to have created is absent.
    expect(await prisma.utility.findUnique({ where: { id: NEW_TENANT } })).toBeNull();
    expect(await prisma.role.count({ where: { utilityId: NEW_TENANT } })).toBe(0);
  });

  it("reports a dry run against an existing tenant as the no-op it would be", async () => {
    await svc.provisionTenant({ utilityId: NEW_TENANT, name: "City of Example" });

    const planned = await svc.provisionTenant({
      utilityId: NEW_TENANT,
      name: "City of Example",
      dryRun: true,
    });

    expect(planned).toMatchObject({ created: false, modulesEnabled: 0, rolesCreated: 0 });
  });

  /**
   * The point of rolling back rather than predicting: a dry run meets the
   * same constraints the real run will, so it can refuse before anyone
   * commits to it.
   */
  it("refuses a rename on a dry run too", async () => {
    await svc.provisionTenant({ utilityId: NEW_TENANT, name: "City of Example" });

    await expect(
      svc.provisionTenant({ utilityId: NEW_TENANT, name: "Something Else", dryRun: true }),
    ).rejects.toMatchObject({ code: "UTILITY_NAME_MISMATCH" });
  });

  // ─── listing ───────────────────────────────────────────────────

  it("lists every utility with what it holds", async () => {
    await svc.provisionTenant({
      utilityId: NEW_TENANT,
      name: "City of Example",
      firstAdmin: { email: "admin@example.gov", name: "Pat Admin" },
    });

    const all = await svc.listUtilities();
    const mine = all.find((u) => u.id === NEW_TENANT);

    expect(mine).toMatchObject({
      name: "City of Example",
      status: "ACTIVE",
      moduleCount: MODULES.length,
      roleCount: 6,
      userCount: 1,
    });
  });
});
