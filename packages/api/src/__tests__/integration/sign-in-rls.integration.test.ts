import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import pg from "pg";
import { bootPostgres, TENANT_A, TENANT_B } from "./_effective-dating-fixtures.js";

/**
 * Signing in, on a connection the policies apply to.
 *
 * Task 8 Step 5 of `docs/superpowers/plans/2026-10-24-rls-enforcement.md`:
 * the step that finds the queries which never had tenant context. The
 * three sign-in routes are where they concentrate, because they are the
 * only routes that read the database *before* there is a request scope
 * to inherit — `skipAuth` is exactly the statement that no user exists
 * yet, so the hooks have nothing to establish a scope from.
 *
 * Under the old superuser connection every one of them worked while
 * searching every tenant at once. Under `cis_app` an unscoped read of a
 * tenant table does not return the wrong rows — it raises 22P02 on
 * `''::uuid`, which is the fail-loud form Task 2 chose. So each
 * assertion below is a 200 that could not have been reached by accident.
 *
 * Everything runs as `cis_app`, never the container's superuser: a
 * superuser is exempt from RLS and would pass either way.
 */

const utilityId = TENANT_A;
const otherUtility = TENANT_B;

let pgContainer: StartedPostgreSqlContainer;
let prismaImports: typeof import("../../lib/prisma.js");
let app: FastifyInstance;

const SHARED_ACCOUNT_NUMBER = "SIGNIN-SHARED-001";
/** Exists in tenant B and in no other tenant. */
const B_ONLY_ACCOUNT_NUMBER = "SIGNIN-B-ONLY-001";
const customerIds: Record<string, string> = {};

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
      /*
       * Both tenants get an account with the SAME account number. That
       * is legal — the constraint is `@@unique([utility_id,
       * account_number])` — and it is the condition the register route
       * ignored: it looked an account number up with no tenant at all.
       */
      for (const uid of [utilityId, otherUtility]) {
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
        const customer = await seeder.customer.create({
          data: {
            utilityId: uid,
            customerType: "INDIVIDUAL",
            firstName: "Sign",
            lastName: "In",
            email: uid === utilityId ? "signin.a@test.com" : "signin.b@test.com",
          },
        });
        customerIds[uid] = customer.id;
        await seeder.account.create({
          data: {
            utilityId: uid,
            accountNumber: SHARED_ACCOUNT_NUMBER,
            accountType: "RESIDENTIAL",
            status: "ACTIVE",
            billingCycleId: cycle.id,
            customerId: customer.id,
          },
        });
        if (uid === otherUtility) {
          // Tenant B alone holds this number. Registering for tenant A
          // with it must find nothing; an unscoped lookup finds this
          // row and mints a token for B's customer.
          await seeder.account.create({
            data: {
              utilityId: uid,
              accountNumber: B_ONLY_ACCOUNT_NUMBER,
              accountType: "RESIDENTIAL",
              status: "ACTIVE",
              billingCycleId: cycle.id,
              customerId: customer.id,
            },
          });
        }
        const role = await seeder.role.create({
          data: {
            utilityId: uid,
            name: "Portal Customer",
            description: "seeded",
            permissions: {},
          },
        });
        // A staff user with a tenant-wide role: dev-login reads cis_user
        // and then user_role, and the second read is the one that
        // raised once the first was scoped and the second was not.
        const staff = await seeder.cisUser.create({
          data: {
            utilityId: uid,
            email: uid === utilityId ? "staff.a@test.com" : "staff.b@test.com",
            name: "Staff",
            isActive: true,
          },
        });
        await seeder.userRole.create({
          data: { utilityId: uid, userId: staff.id, accountId: null, roleId: role.id },
        });
        // An already-registered portal user, for the login route.
        const portalCustomer = await seeder.customer.create({
          data: {
            utilityId: uid,
            customerType: "INDIVIDUAL",
            firstName: "Portal",
            lastName: "User",
          },
        });
        const portalUser = await seeder.cisUser.create({
          data: {
            utilityId: uid,
            email: uid === utilityId ? "portal.a@test.com" : "portal.b@test.com",
            name: "Portal User",
            customerId: portalCustomer.id,
            isActive: true,
          },
        });
        await seeder.userRole.create({
          data: { utilityId: uid, userId: portalUser.id, accountId: null, roleId: role.id },
        });
      }

      // The platform operator: a cis_user with no tenant and no role.
      await seeder.cisUser.create({
        data: {
          utilityId: null,
          email: "operator@platform.test.com",
          name: "Platform Operator",
          isActive: true,
        },
      });
    } finally {
      await seeder.$disconnect().catch(() => {});
    }
  } finally {
    await superuserPool.end();
  }

  const asRoleUrl = (role: string) => booted.dbUrl.replace(/\/\/[^@]+@/, `//${role}:probe@`);
  process.env.DATABASE_URL = asRoleUrl("cis_app");
  process.env.DATABASE_URL_PLATFORM = asRoleUrl("cis_platform");
  process.env.ENABLE_DEV_AUTH_ENDPOINTS = "true";

  prismaImports = await import("../../lib/prisma.js");
  const appImports = await import("../../app.js");
  app = await appImports.buildApp();
  await app.ready();
}, 240_000);

afterAll(async () => {
  if (app) await app.close();
  // `$disconnect` does not dispose a pool the application owns — that
  // is the driver-adapter contract — so the pools are ended here.
  // Without it the container stops while connections are live and
  // Postgres reports 57P01 as an unhandled error after a green run.
  await prismaImports?.prisma.$disconnect().catch(() => {});
  await prismaImports?.pool.end().catch(() => {});
  await pgContainer?.stop().catch(() => {});
});

describe("signing in without a request scope to inherit", () => {
  /*
   * Two queries, one scope. The user lookup was scoped first and the
   * role lookup was not, which raised 22P02 rather than returning the
   * wrong role — so a 200 here is the whole handler running inside the
   * tenant, not just its first statement.
   */
  it("mints a staff token, reading cis_user and user_role in one tenant", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/dev-login",
      payload: { email: "staff.a@test.com", utilityId },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).user.roleName).toBe("Portal Customer");
  });

  /*
   * The third unauthenticated database read, and the only one with no
   * tenant to name: the platform operator is identified by
   * `utility_id IS NULL`, which is the whole of its authority.
   *
   * It runs on `cis_app` with no scope — the least authority that can
   * answer the question — and reaches the row through the NULL branch
   * Task 2a added to the `cis_user` policy. Before that branch existed
   * this was a sign-in that failed while looking exactly like the role
   * split being broken.
   */
  it("mints a platform token with no tenant anywhere in the request", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/dev-login",
      payload: { email: "operator@platform.test.com", platform: true },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).redirectTo).toBe("/platform/utilities");
  });

  it("mints a portal token, reading cis_user, user_role and the login stamp", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/portal/api/auth/login",
      payload: { email: "portal.a@test.com", utilityId },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.user.customerId).toBeTruthy();
    expect(body.token).toMatch(/^[\w-]+\.[\w-]+\.dev$/);
  });

  /*
   * The register route reads `account`, `role` and `cis_user` and then
   * writes two rows in a transaction — five statements with no tenant
   * anywhere, because the account number was treated as globally
   * unique. It is not.
   */
  it("registers against the account in the tenant it was given", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/portal/api/auth/register",
      payload: {
        accountNumber: SHARED_ACCOUNT_NUMBER,
        email: "signin.a@test.com",
        name: "New Portal User",
        utilityId,
      },
    });
    expect(res.statusCode).toBe(201);
    // Asserted on WHICH customer, not on the email that was sent in:
    // both tenants hold this account number, and the one that matters
    // is that the row found belongs to the tenant that was named.
    expect(JSON.parse(res.body).user.customerId).toBe(customerIds[utilityId]);
  });

  /*
   * And the reason the tenant has to be named rather than discovered.
   * This number exists only in tenant B, and the email matches B's
   * customer, so every check the handler makes would have passed: the
   * unscoped lookup finds B's account and registration mints a portal
   * token bound to B's customer, for a caller who named tenant A.
   *
   * Refused by not being found. Which tenant holds an account number is
   * not an unauthenticated caller's to learn, so this is the same 400
   * an unknown number gets rather than a distinguishable error.
   *
   * **What this pins, measured rather than assumed.** Removing
   * `utilityId` from the handler's `where` leaves this test green: with
   * the scope in place, the policy refuses B's row before the predicate
   * is reached. So this assertion holds the RLS policy, not the `where`
   * clause — which is the result the whole plan was for. The predicate
   * stays because it is the half that still works if someone connects
   * as a bypassing role, and because a tenant named in the query is
   * readable at the call site; it is belt to the policy's braces. The
   * mutation that *does* turn this red is removing the scope, and that
   * is the one `runAsTenant` above exists to prevent.
   */
  it("does not reach another tenant's account", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/portal/api/auth/register",
      payload: {
        accountNumber: B_ONLY_ACCOUNT_NUMBER,
        email: "signin.b@test.com",
        name: "Cross Tenant",
        utilityId,
      },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error.code).toBe("ACCOUNT_NOT_FOUND");
  });
});
