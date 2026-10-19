import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import type { FastifyInstance } from "fastify";
import { bootPostgres, ensurePrincipal, ACTOR } from "./_effective-dating-fixtures.js";

/**
 * A utility's roles, from above it.
 *
 * The tenant already administers its own roles at `/api/v1/roles`, gated
 * on `settings`. These routes are the same thing done *to* a named
 * utility rather than to the caller's own, which is the only part a
 * platform operator can do and a tenant cannot — and it is what a
 * utility with no working admin needs, since the detail page can show
 * "no staff" and until now nothing could act on it.
 *
 * Deliberately no new business logic. `role.service.ts` already takes
 * `utilityId` as its scoping argument and already carries the rules —
 * BR-RB-002 (a system role cannot be deleted), BR-RB-003 (nor one in
 * use), and the cache invalidation for every assignee on update. These
 * routes pass the id from the path instead of from the token, and the
 * tests below exist to prove the rules are still reached that way rather
 * than bypassed by a second code path.
 */

let pgContainer: StartedPostgreSqlContainer;
let prismaImports: typeof import("../../lib/prisma.js");
let svc: typeof import("../../services/provisioning.service.js");
let app: FastifyInstance;

const UTILITY = "00000000-0000-4000-8000-0000000000f1";
const OTHER = "00000000-0000-4000-8000-0000000000f2";
const ABSENT = "00000000-0000-4000-8000-0000000000ff";

function token(claims: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${header}.${payload}.fake-signature`;
}

const PLATFORM_ACTOR = "00000000-0000-4000-8000-aaaa0000f001";
const platformHeaders = {
  authorization: `Bearer ${token({ sub: PLATFORM_ACTOR, platform: true, email: "ops@example.gov", name: "Ops" })}`,
  "content-type": "application/json",
};
// DELETE carries no body, so it must not claim a JSON content-type —
// Fastify answers FST_ERR_CTP_EMPTY_JSON_BODY if it does. `api-client`
// strips the header for exactly this reason.
const platformAuthOnly = {
  authorization: `Bearer ${token({ sub: PLATFORM_ACTOR, platform: true, email: "ops@example.gov", name: "Ops" })}`,
};
const tenantHeaders = {
  authorization: `Bearer ${token({ sub: ACTOR, utility_id: UTILITY, email: "t@example.gov", name: "T" })}`,
  "content-type": "application/json",
};

beforeAll(async () => {
  const booted = await bootPostgres();
  pgContainer = booted.container;
  prismaImports = await import("../../lib/prisma.js");
  svc = await import("../../services/provisioning.service.js");
  const appImports = await import("../../app.js");
  app = await appImports.buildApp();
  await app.ready();
}, 180_000);

afterAll(async () => {
  await prismaImports?.prisma.$disconnect().catch(() => {});
  await pgContainer?.stop().catch(() => {});
});

beforeEach(async () => {
  const { prisma } = prismaImports;
  for (const id of [UTILITY, OTHER]) {
    await prisma.userRole.deleteMany({ where: { utilityId: id } });
    await prisma.cisUser.deleteMany({ where: { utilityId: id } });
    await prisma.role.deleteMany({ where: { utilityId: id } });
    await prisma.utilityModule.deleteMany({ where: { utilityId: id } });
    await prisma.utility.deleteMany({ where: { id } });
  }
  await prisma.cisUser.deleteMany({ where: { utilityId: null } });
  await svc.provisionTenant({ utilityId: UTILITY, name: "City of Roles" });
  await svc.provisionTenant({ utilityId: OTHER, name: "Other Utility" });
  await prisma.cisUser.create({
    data: { id: PLATFORM_ACTOR, utilityId: null, email: "ops@example.gov", name: "Ops", isActive: true },
  });
  await ensurePrincipal(prisma, UTILITY);
});

const rolesUrl = (id: string) => `/api/v1/platform/utilities/${id}/roles`;

describe("a utility's roles, read from above", () => {
  it("lists the six a provisioned utility starts with", async () => {
    const res = await app.inject({ method: "GET", url: rolesUrl(UTILITY), headers: platformHeaders });

    expect(res.statusCode).toBe(200);
    const names = JSON.parse(res.body).data.map((r: { name: string }) => r.name);
    expect(names).toContain("System Admin");
    expect(names).toHaveLength(7); // six presets + the integration fixture's
  });

  it("refuses a tenant admin, even for its own utility", async () => {
    // The tenant has its own /api/v1/roles for that. This route acts on a
    // utility named in the path, which is authority no tenant holds.
    const res = await app.inject({ method: "GET", url: rolesUrl(UTILITY), headers: tenantHeaders });

    expect(res.statusCode).toBe(403);
  });

  it("answers 404 for a utility that does not exist", async () => {
    // Not an empty list: an operator who mistypes an id should be told,
    // not shown a utility with no roles.
    const res = await app.inject({ method: "GET", url: rolesUrl(ABSENT), headers: platformHeaders });

    expect(res.statusCode).toBe(404);
  });
});

describe("adding and editing", () => {
  it("creates a role on the utility named in the path", async () => {
    const res = await app.inject({
      method: "POST",
      url: rolesUrl(UTILITY),
      headers: platformHeaders,
      payload: { name: "Auditor", description: "Reads the log", permissions: { audit_log: ["VIEW"] } },
    });

    expect(res.statusCode).toBe(201);
    const { prisma } = prismaImports;
    expect(await prisma.role.count({ where: { utilityId: UTILITY, name: "Auditor" } })).toBe(1);
  });

  it("puts it on that utility and no other", async () => {
    await app.inject({
      method: "POST",
      url: rolesUrl(UTILITY),
      headers: platformHeaders,
      payload: { name: "Auditor", permissions: { audit_log: ["VIEW"] } },
    });

    const { prisma } = prismaImports;
    expect(await prisma.role.count({ where: { utilityId: OTHER, name: "Auditor" } })).toBe(0);
  });

  it("refuses a name the utility already uses", async () => {
    // @@unique([utilityId, name]) — surfaced rather than thrown raw.
    const res = await app.inject({
      method: "POST",
      url: rolesUrl(UTILITY),
      headers: platformHeaders,
      payload: { name: "System Admin", permissions: { audit_log: ["VIEW"] } },
    });

    expect(res.statusCode).toBe(409);
  });

  it("edits a role's permissions", async () => {
    const { prisma } = prismaImports;
    const role = await prisma.role.findFirstOrThrow({ where: { utilityId: UTILITY, name: "CSR" } });

    const res = await app.inject({
      method: "PATCH",
      url: `${rolesUrl(UTILITY)}/${role.id}`,
      headers: platformHeaders,
      payload: { permissions: { customers: ["VIEW"] } },
    });

    expect(res.statusCode).toBe(200);
    const after = await prisma.role.findUniqueOrThrow({ where: { id: role.id } });
    expect(after.permissions).toEqual({ customers: ["VIEW"] });
  });

  it("refuses to edit a role belonging to another utility", async () => {
    // The role id is all a caller supplies, so the scoping has to come
    // from the path — otherwise this edits any role in any utility.
    const { prisma } = prismaImports;
    const foreign = await prisma.role.findFirstOrThrow({ where: { utilityId: OTHER, name: "CSR" } });

    const res = await app.inject({
      method: "PATCH",
      url: `${rolesUrl(UTILITY)}/${foreign.id}`,
      headers: platformHeaders,
      payload: { permissions: { customers: ["VIEW"] } },
    });

    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    const after = await prisma.role.findUniqueOrThrow({ where: { id: foreign.id } });
    expect(after.permissions).not.toEqual({ customers: ["VIEW"] });
  });
});

describe("deleting", () => {
  it("deletes a role nobody holds", async () => {
    const { prisma } = prismaImports;
    const role = await prisma.role.create({
      data: { utilityId: UTILITY, name: "Spare", permissions: { audit_log: ["VIEW"] } },
    });

    const res = await app.inject({
      method: "DELETE",
      url: `${rolesUrl(UTILITY)}/${role.id}`,
      headers: platformAuthOnly,
    });

    expect(res.statusCode).toBeLessThan(300);
    expect(await prisma.role.count({ where: { id: role.id } })).toBe(0);
  });

  it("refuses a system role — BR-RB-002 still applies through this door", async () => {
    const { prisma } = prismaImports;
    const preset = await prisma.role.findFirstOrThrow({
      where: { utilityId: UTILITY, name: "System Admin" },
    });

    const res = await app.inject({
      method: "DELETE",
      url: `${rolesUrl(UTILITY)}/${preset.id}`,
      headers: platformAuthOnly,
    });

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error.code).toBe("SYSTEM_ROLE");
    expect(await prisma.role.count({ where: { id: preset.id } })).toBe(1);
  });

  it("refuses a role somebody holds — BR-RB-003 too", async () => {
    const { prisma } = prismaImports;
    const role = await prisma.role.create({
      data: { utilityId: UTILITY, name: "Held", permissions: { audit_log: ["VIEW"] } },
    });
    const user = await prisma.cisUser.create({
      data: { utilityId: UTILITY, email: "holder@example.gov", name: "Holder" },
    });
    await prisma.userRole.create({
      data: { utilityId: UTILITY, userId: user.id, accountId: null, roleId: role.id },
    });

    const res = await app.inject({
      method: "DELETE",
      url: `${rolesUrl(UTILITY)}/${role.id}`,
      headers: platformAuthOnly,
    });

    expect(res.statusCode).toBe(400);
    expect(await prisma.role.count({ where: { id: role.id } })).toBe(1);
  });
});
