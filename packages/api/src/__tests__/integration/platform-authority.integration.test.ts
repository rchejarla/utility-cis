import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import pg from "pg";
import { bootPostgres, TENANT_A, TENANT_B } from "./_effective-dating-fixtures.js";

/**
 * The authority a request runs under, over HTTP.
 *
 * Task 6 of `docs/superpowers/plans/2026-10-24-rls-enforcement.md`.
 *
 * `tenant-context.integration.test.ts` proves the two pools are selected
 * correctly when `runAsPlatform` is called directly. This proves the
 * thing that actually matters: that a *request* to a platform route
 * runs inside that scope, which needs the context to be established in a
 * Fastify hook and to survive into the handler.
 *
 * That assumption is the reason this file exists rather than a unit
 * test. An `onRequest` hook establishes an AsyncLocalStorage scope only
 * if the rest of the lifecycle is invoked from inside it — which is why
 * the hook takes the callback form and calls `done()` within `run`. If
 * that were wrong, every assertion below would fail while
 * `runAsPlatform` kept passing in isolation.
 *
 * Everything runs as `cis_app` and `cis_platform`, never as the
 * container's superuser, because a superuser is exempt from RLS and a
 * suite running as one cannot tell whether any of this works.
 */

const utilityId = TENANT_A;
const otherUtility = TENANT_B;
const PLATFORM_ACTOR = "00000000-0000-4000-8000-aaaa0000f001";

let pgContainer: StartedPostgreSqlContainer;
let prismaImports: typeof import("../../lib/prisma.js");
let app: FastifyInstance;

function tokenFor(claims: Record<string, unknown>) {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${header}.${payload}.fake-signature`;
}

const platformHeaders = {
  // `platform: true` is the claim the middleware keys on; a tenant token
  // carries `utility_id` instead, and the two are refused on each
  // other's routes.
  authorization: `Bearer ${tokenFor({
    sub: PLATFORM_ACTOR,
    platform: true,
    email: "operator@platform.test",
    name: "Platform Operator",
  })}`,
};

beforeAll(async () => {
  const booted = await bootPostgres({ utilities: [utilityId, otherUtility] });
  pgContainer = booted.container;

  const superuserPool = new pg.Pool({ connectionString: booted.dbUrl });
  try {
    await superuserPool.query(`ALTER ROLE cis_app LOGIN PASSWORD 'probe'`);
    await superuserPool.query(`ALTER ROLE cis_platform LOGIN PASSWORD 'probe'`);

    const { PrismaClient } = await import("@utility-cis/shared/src/generated/prisma");
    const { PrismaPg } = await import("@prisma/adapter-pg");
    const seeder = new PrismaClient({ adapter: new PrismaPg(superuserPool) });
    try {
      // The platform actor: a cis_user with no tenant and no role, which
      // is the whole of its authority.
      await seeder.cisUser.create({
        data: {
          id: PLATFORM_ACTOR,
          utilityId: null,
          email: "operator@platform.test",
          name: "Platform Operator",
          isActive: true,
        },
      });
      for (const [uid, number] of [
        [utilityId, "PA-A-001"],
        [otherUtility, "PA-B-001"],
      ] as const) {
        const cycle = await seeder.billingCycle.create({
          data: {
            utilityId: uid,
            name: "R1",
            cycleCode: "R01",
            readDayOfMonth: 1,
            billDayOfMonth: 15,
            frequency: "MONTHLY",
          },
        });
        await seeder.account.create({
          data: {
            utilityId: uid,
            accountNumber: number,
            accountType: "RESIDENTIAL",
            status: "ACTIVE",
            billingCycleId: cycle.id,
          },
        });
      }
    } finally {
      await seeder.$disconnect().catch(() => {});
    }
  } finally {
    await superuserPool.end();
  }

  const asRoleUrl = (role: string) => booted.dbUrl.replace(/\/\/[^@]+@/, `//${role}:probe@`);
  process.env.DATABASE_URL = asRoleUrl("cis_app");
  process.env.DATABASE_URL_PLATFORM = asRoleUrl("cis_platform");

  prismaImports = await import("../../lib/prisma.js");
  const appImports = await import("../../app.js");
  app = await appImports.buildApp();
  await app.ready();
}, 240_000);

afterAll(async () => {
  if (app) await app.close();
  await prismaImports?.prisma.$disconnect().catch(() => {});
  await pgContainer?.stop().catch(() => {});
});

describe("a platform request", () => {
  /*
   * The console's reason for existing: it lists tenants. Under an
   * enforcing policy a connection with no tenant set reads *nothing*, so
   * "returns both" is the assertion — an empty list would be the failure
   * this task exists to prevent, and it raises no error.
   */
  it("reads every tenant, not none and not one", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/platform/utilities",
      headers: platformHeaders,
    });

    expect(res.statusCode).toBe(200);
    const ids: string[] = JSON.parse(res.body).data.map((u: { id: string }) => u.id);
    expect(ids).toEqual(expect.arrayContaining([utilityId, otherUtility]));
  });

  /*
   * And it found the actor at all. `cis_user.utility_id` is null for the
   * platform actor, and before Task 2a its policy had no NULL branch —
   * so this would have been a 403 that looked exactly like the role
   * split failing rather than a policy hiding one row.
   */
  it("authorises against a row the policy used to hide", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/platform/users",
      headers: platformHeaders,
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).data.some((u: { email: string }) => u.email === "operator@platform.test")).toBe(true);
  });

  it("still refuses a tenant token on a platform route", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/platform/utilities",
      headers: {
        authorization: `Bearer ${tokenFor({
          sub: "00000000-0000-4000-8000-aaaa0000f002",
          utility_id: utilityId,
          email: "staff@a.test",
          name: "A Staff",
          role: "admin",
        })}`,
      },
    });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).error.code).toBe("PLATFORM_REQUIRED");
  });
});
