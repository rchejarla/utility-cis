import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { bootPostgres } from "./_effective-dating-fixtures.js";

/**
 * The platform's own operators.
 *
 * A platform actor can only be created by SQL or the seed today, which
 * is the same gap §1.5 described for tenants: the one identity that sits
 * above tenants has no way to make another one.
 *
 * Its own service rather than part of provisioning, because it is a
 * different subject — provisioning brings *tenants* into existence, this
 * manages the people who do that.
 *
 * Deactivation is the interesting half. It is how an operator is
 * revoked, so it has to invalidate the cached lookup (a 300s TTL is a
 * five-minute window on a revoked operator), and it must refuse to
 * remove the last active one: a deployment with no platform operator
 * cannot appoint another, and the recovery is SQL.
 */

let pgContainer: StartedPostgreSqlContainer;
let prismaImports: typeof import("../../lib/prisma.js");
let svc: typeof import("../../services/platform-user.service.js");

beforeAll(async () => {
  const booted = await bootPostgres();
  pgContainer = booted.container;
  prismaImports = await import("../../lib/prisma.js");
  svc = await import("../../services/platform-user.service.js");
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
  await prismaImports.prisma.cisUser.deleteMany({ where: { utilityId: null } });
});

describe("platform operators", () => {
  it("creates one, belonging to no tenant", async () => {
    const actor = await svc.createPlatformUser({ email: "ops@example.gov", name: "Pat Operator" });

    expect(actor).toMatchObject({ email: "ops@example.gov", name: "Pat Operator", isActive: true });
    const row = await prismaImports.prisma.cisUser.findFirstOrThrow({ where: { id: actor.id } });
    expect(row.utilityId).toBeNull();
  });

  it("gives it no role, because being the platform actor is the authority", async () => {
    const actor = await svc.createPlatformUser({ email: "ops@example.gov", name: "Pat" });

    expect(await prismaImports.prisma.userRole.count({ where: { userId: actor.id } })).toBe(0);
  });

  it("lowercases the email, so the account can be signed in to", async () => {
    // dev-login and every other lookup normalise; an address stored with
    // a capital is an operator who cannot log in.
    const actor = await svc.createPlatformUser({ email: "Ops@Example.GOV", name: "Pat" });

    expect(actor.email).toBe("ops@example.gov");
  });

  it("refuses an address another operator already holds", async () => {
    await svc.createPlatformUser({ email: "ops@example.gov", name: "First" });

    await expect(
      svc.createPlatformUser({ email: "ops@example.gov", name: "Second" }),
    ).rejects.toMatchObject({ code: "PLATFORM_EMAIL_TAKEN" });
  });

  it("refuses a case variant of an address already held", async () => {
    await svc.createPlatformUser({ email: "ops@example.gov", name: "First" });

    await expect(
      svc.createPlatformUser({ email: "OPS@EXAMPLE.GOV", name: "Second" }),
    ).rejects.toMatchObject({ code: "PLATFORM_EMAIL_TAKEN" });
  });

  it("lists operators, newest last, with whether each is active", async () => {
    await svc.createPlatformUser({ email: "a@example.gov", name: "A" });
    const b = await svc.createPlatformUser({ email: "b@example.gov", name: "B" });
    await svc.setPlatformUserActive(b.id, false);

    const all = await svc.listPlatformUsers();

    expect(all.map((u) => u.email)).toEqual(["a@example.gov", "b@example.gov"]);
    expect(all.map((u) => u.isActive)).toEqual([true, false]);
  });

  it("lists no tenant user, however many exist", async () => {
    const { prisma } = prismaImports;
    await prisma.utility.create({ data: { id: "00000000-0000-4000-8000-0000000000d1", name: "T" } });
    await prisma.cisUser.create({
      data: {
        utilityId: "00000000-0000-4000-8000-0000000000d1",
        email: "staff@tenant.gov",
        name: "Tenant Staff",
      },
    });
    await svc.createPlatformUser({ email: "ops@example.gov", name: "Pat" });

    expect((await svc.listPlatformUsers()).map((u) => u.email)).toEqual(["ops@example.gov"]);
  });

  it("deactivates and reactivates", async () => {
    const a = await svc.createPlatformUser({ email: "a@example.gov", name: "A" });
    await svc.createPlatformUser({ email: "b@example.gov", name: "B" });

    expect((await svc.setPlatformUserActive(a.id, false)).isActive).toBe(false);
    expect((await svc.setPlatformUserActive(a.id, true)).isActive).toBe(true);
  });

  it("refuses to deactivate the last active operator", async () => {
    // A deployment with no active platform operator cannot appoint
    // another one — the only recovery is SQL.
    const only = await svc.createPlatformUser({ email: "only@example.gov", name: "Only" });

    await expect(svc.setPlatformUserActive(only.id, false)).rejects.toMatchObject({
      code: "LAST_PLATFORM_OPERATOR",
    });
    expect((await svc.listPlatformUsers())[0].isActive).toBe(true);
  });

  it("counts only active operators when deciding that", async () => {
    // Two rows, one already inactive: deactivating the other still
    // leaves nobody, so it is still refused.
    const a = await svc.createPlatformUser({ email: "a@example.gov", name: "A" });
    const b = await svc.createPlatformUser({ email: "b@example.gov", name: "B" });
    await svc.setPlatformUserActive(b.id, false);

    await expect(svc.setPlatformUserActive(a.id, false)).rejects.toMatchObject({
      code: "LAST_PLATFORM_OPERATOR",
    });
  });

  it("refuses an operator that does not exist", async () => {
    await expect(
      svc.setPlatformUserActive("00000000-0000-4000-8000-0000000000ef", false),
    ).rejects.toMatchObject({ code: "PLATFORM_USER_NOT_FOUND" });
  });

  it("will not deactivate a tenant user through this door", async () => {
    const { prisma } = prismaImports;
    // The id is all a caller supplies, so the lookup has to insist the
    // row has no tenant — otherwise this is a route to deactivating any
    // user in any tenant.
    await prisma.utility.create({ data: { id: "00000000-0000-4000-8000-0000000000d2", name: "T2" } });
    const staff = await prisma.cisUser.create({
      data: {
        utilityId: "00000000-0000-4000-8000-0000000000d2",
        email: "staff2@tenant.gov",
        name: "Tenant Staff",
      },
    });
    await svc.createPlatformUser({ email: "ops@example.gov", name: "Pat" });

    await expect(svc.setPlatformUserActive(staff.id, false)).rejects.toMatchObject({
      code: "PLATFORM_USER_NOT_FOUND",
    });
    expect(
      (await prisma.cisUser.findFirstOrThrow({ where: { id: staff.id } })).isActive,
    ).toBe(true);
  });
});
