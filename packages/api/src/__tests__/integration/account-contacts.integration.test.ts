import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import type { FastifyInstance } from "fastify";
import {
  bootPostgres,
  resetDb,
  makeTenantFixture,
  TENANT_A,
  type TenantFixture,
} from "./_effective-dating-fixtures.js";

/**
 * End-to-end test of the unified Contacts tab service.
 *   - GET /accounts/:id/contacts-unified returns Contact rows ∪
 *     CisUser+UserRole rows scoped to the account.
 *   - POST /contacts/:id/promote turns a Contact into a CisUser +
 *     UserRole; email-match links to an existing user when one
 *     already exists.
 *   - PATCH /user-roles/:id changes the role on a per-account row.
 *   - DELETE /user-roles/:id revokes the per-account assignment but
 *     leaves the CisUser intact.
 */

let pgContainer: StartedPostgreSqlContainer;
let prismaImports: typeof import("../../lib/prisma.js");
let appImports: typeof import("../../app.js");
let app: FastifyInstance;
let fixA: TenantFixture;

const ENABLED_MODULES = ["accounts", "customers"];
const ACTOR_ID = "00000000-0000-4000-8000-aaaa00000001";

function makeToken(utilityId: string, actorId = ACTOR_ID) {
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

beforeAll(async () => {
  const booted = await bootPostgres();
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
  // The shared resetDb doesn't touch auth tables — clear them so each
  // test starts with no roles / users / per-account assignments.
  await prisma.$executeRawUnsafe(
    "TRUNCATE TABLE user_role, contact, cis_user, role RESTART IDENTITY CASCADE",
  );
  fixA = await makeTenantFixture(prisma, TENANT_A);

  for (const moduleKey of ENABLED_MODULES) {
    await prisma.tenantModule.create({
      data: { utilityId: fixA.utilityId, moduleKey },
    });
  }
  const rbac = await import("../../services/rbac.service.js");
  await rbac.invalidateTenantModulesCache(fixA.utilityId);
});

describe("GET /api/v1/accounts/:id/contacts-unified", () => {
  it("returns Contact rows + UserRole-joined rows for the account", async () => {
    const { prisma } = prismaImports;
    // Seed: one record-only Contact + one CisUser with a per-account
    // UserRole for this account.
    await prisma.contact.create({
      data: {
        utilityId: fixA.utilityId,
        accountId: fixA.accountId,
        firstName: "Tom",
        lastName: "Smith",
        email: "tom@example.com",
      },
    });
    const role = await prisma.role.create({
      data: {
        utilityId: fixA.utilityId,
        name: "Portal Billing",
        permissions: { portal_billing: ["VIEW"] },
      },
    });
    const user = await prisma.cisUser.create({
      data: {
        utilityId: fixA.utilityId,
        email: "alice@example.com",
        name: "Alice Walker",
        isActive: true,
      },
    });
    await prisma.userRole.create({
      data: {
        utilityId: fixA.utilityId,
        userId: user.id,
        accountId: fixA.accountId,
        roleId: role.id,
      },
    });

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/accounts/${fixA.accountId}/contacts-unified`,
      headers: headers(),
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data).toHaveLength(2);
    const contact = body.data.find((r: { type: string }) => r.type === "contact");
    const portalUser = body.data.find((r: { type: string }) => r.type === "user");
    expect(contact?.email).toBe("tom@example.com");
    expect(portalUser?.email).toBe("alice@example.com");
    expect(portalUser?.roleName).toBe("Portal Billing");
    expect(portalUser?.inviteStatus).toBe("pending"); // never logged in
  });
});

describe("POST /api/v1/contacts/:id/promote", () => {
  it("creates CisUser + UserRole and deletes the source Contact", async () => {
    const { prisma } = prismaImports;
    const contact = await prisma.contact.create({
      data: {
        utilityId: fixA.utilityId,
        accountId: fixA.accountId,
        firstName: "Jane",
        lastName: "Doe",
        email: "jane@example.com",
      },
    });
    const role = await prisma.role.create({
      data: {
        utilityId: fixA.utilityId,
        name: "Portal Primary",
        permissions: { portal_billing: ["VIEW", "EDIT"] },
      },
    });

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/contacts/${contact.id}/promote`,
      headers: headers(),
      payload: { roleId: role.id },
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.alreadyExisted).toBe(false);
    expect(body.userId).toBeTruthy();
    expect(body.userRoleId).toBeTruthy();

    // Source Contact deleted.
    const contactAfter = await prisma.contact.findUnique({ where: { id: contact.id } });
    expect(contactAfter).toBeNull();

    // CisUser + UserRole created.
    const user = await prisma.cisUser.findUniqueOrThrow({ where: { id: body.userId } });
    expect(user.email).toBe("jane@example.com");
    const userRole = await prisma.userRole.findUniqueOrThrow({ where: { id: body.userRoleId } });
    expect(userRole.accountId).toBe(fixA.accountId);
    expect(userRole.roleId).toBe(role.id);
  });

  it("links to an existing CisUser when the contact's email matches", async () => {
    const { prisma } = prismaImports;
    const existingUser = await prisma.cisUser.create({
      data: {
        utilityId: fixA.utilityId,
        email: "shared@example.com",
        name: "Existing User",
        isActive: true,
      },
    });
    const contact = await prisma.contact.create({
      data: {
        utilityId: fixA.utilityId,
        accountId: fixA.accountId,
        firstName: "Same",
        lastName: "Person",
        email: "shared@example.com",
      },
    });
    const role = await prisma.role.create({
      data: {
        utilityId: fixA.utilityId,
        name: "Portal Authorized",
        permissions: { portal_accounts: ["VIEW"] },
      },
    });

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/contacts/${contact.id}/promote`,
      headers: headers(),
      payload: { roleId: role.id },
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.alreadyExisted).toBe(true);
    expect(body.userId).toBe(existingUser.id);

    // No duplicate CisUser created.
    const usersWithEmail = await prisma.cisUser.count({
      where: { utilityId: fixA.utilityId, email: "shared@example.com" },
    });
    expect(usersWithEmail).toBe(1);
  });

  it("rejects promotion of a contact without an email", async () => {
    const { prisma } = prismaImports;
    const contact = await prisma.contact.create({
      data: {
        utilityId: fixA.utilityId,
        accountId: fixA.accountId,
        firstName: "NoEmail",
        lastName: "Person",
      },
    });
    const role = await prisma.role.create({
      data: {
        utilityId: fixA.utilityId,
        name: "Portal Billing",
        permissions: {},
      },
    });

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/contacts/${contact.id}/promote`,
      headers: headers(),
      payload: { roleId: role.id },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error.code).toBe("EMAIL_REQUIRED");
  });
});

describe("PATCH /api/v1/user-roles/:id", () => {
  it("changes the role on a per-account UserRole", async () => {
    const { prisma } = prismaImports;
    const r1 = await prisma.role.create({
      data: { utilityId: fixA.utilityId, name: "Portal Billing", permissions: {} },
    });
    const r2 = await prisma.role.create({
      data: { utilityId: fixA.utilityId, name: "Portal Primary", permissions: {} },
    });
    const user = await prisma.cisUser.create({
      data: { utilityId: fixA.utilityId, email: "u@example.com", name: "U", isActive: true },
    });
    const ur = await prisma.userRole.create({
      data: {
        utilityId: fixA.utilityId,
        userId: user.id,
        accountId: fixA.accountId,
        roleId: r1.id,
      },
    });

    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/user-roles/${ur.id}`,
      headers: headers(),
      payload: { roleId: r2.id },
    });
    expect(res.statusCode).toBe(204);

    const updated = await prisma.userRole.findUniqueOrThrow({ where: { id: ur.id } });
    expect(updated.roleId).toBe(r2.id);
  });

  it("refuses to change a tenant-wide assignment via this endpoint", async () => {
    const { prisma } = prismaImports;
    const r1 = await prisma.role.create({
      data: { utilityId: fixA.utilityId, name: "Admin", permissions: {} },
    });
    const r2 = await prisma.role.create({
      data: { utilityId: fixA.utilityId, name: "Viewer", permissions: {} },
    });
    const user = await prisma.cisUser.create({
      data: { utilityId: fixA.utilityId, email: "v@example.com", name: "V", isActive: true },
    });
    const ur = await prisma.userRole.create({
      data: {
        utilityId: fixA.utilityId,
        userId: user.id,
        accountId: null,
        roleId: r1.id,
      },
    });

    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/user-roles/${ur.id}`,
      headers: headers(),
      payload: { roleId: r2.id },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error.code).toBe("TENANT_WIDE_ASSIGNMENT");
  });
});

describe("DELETE /api/v1/user-roles/:id", () => {
  it("revokes a per-account UserRole; CisUser remains", async () => {
    const { prisma } = prismaImports;
    const role = await prisma.role.create({
      data: { utilityId: fixA.utilityId, name: "Portal Billing", permissions: {} },
    });
    const user = await prisma.cisUser.create({
      data: { utilityId: fixA.utilityId, email: "x@example.com", name: "X", isActive: true },
    });
    const ur = await prisma.userRole.create({
      data: {
        utilityId: fixA.utilityId,
        userId: user.id,
        accountId: fixA.accountId,
        roleId: role.id,
      },
    });

    const res = await app.inject({
      method: "DELETE",
      url: `/api/v1/user-roles/${ur.id}`,
      headers: headers(),
    });
    expect(res.statusCode).toBe(204);

    expect(await prisma.userRole.findUnique({ where: { id: ur.id } })).toBeNull();
    expect(await prisma.cisUser.findUnique({ where: { id: user.id } })).not.toBeNull();
  });
});
