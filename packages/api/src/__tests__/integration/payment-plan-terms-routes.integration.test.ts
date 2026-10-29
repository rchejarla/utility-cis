import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import type { FastifyInstance } from "fastify";
import {
  bootPostgres,
  resetDb,
  makeTenantFixture,
  ensurePrincipal,
  seedAsPlatform,
  endAdminPool,
  truncateTables,
  ACTOR,
  TENANT_A,
} from "./_effective-dating-fixtures.js";
import { DEFAULT_PLAN_TERMS } from "@utility-cis/shared";

vi.mock("../../lib/queues.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/queues.js")>()),
  enqueueSafely: vi.fn(async () => "test-job-id"),
}));

/**
 * The plan terms namespace, over HTTP.
 *
 * This file exists because the review found the save path broken for
 * every freshly provisioned tenant and the suite silent about it: the
 * Task 3 tests are web-only and mock `apiClient`, so nothing executed
 * the SQL. `patchSettingsNamespace`'s whole justification is that its
 * INSERT arm covers "every tenant until something writes a config row",
 * and that arm had never run.
 */

let pgContainer: StartedPostgreSqlContainer;
let prismaImports: typeof import("../../lib/prisma.js");
let app: FastifyInstance;

function makeToken(utilityId: string, actorId = ACTOR) {
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

const get = () =>
  app.inject({ method: "GET", url: "/api/v1/delinquency/plan-terms", headers: headers() });

const put = (body: Record<string, unknown>) =>
  app.inject({
    method: "PUT",
    url: "/api/v1/delinquency/plan-terms",
    headers: headers(),
    payload: body as object,
  });

/** Every term, so a PUT carries the whole namespace as the screen does. */
const whole = (over: Record<string, unknown> = {}) => ({ ...DEFAULT_PLAN_TERMS, ...over });

/** A tenant that has never had a config row — the state of a new one. */
async function dropConfigRow() {
  await seedAsPlatform(async () => {
    await prismaImports.prisma.utilityConfig.deleteMany({ where: { utilityId: TENANT_A } });
  });
}

async function storedNamespace(): Promise<Record<string, unknown> | null> {
  const row = await seedAsPlatform(async () =>
    prismaImports.prisma.utilityConfig.findUnique({
      where: { utilityId: TENANT_A },
      select: { settings: true },
    }),
  );
  const settings = (row?.settings ?? null) as Record<string, unknown> | null;
  return (settings?.paymentPlans as Record<string, unknown>) ?? null;
}

beforeAll(async () => {
  const booted = await bootPostgres({ utilities: [TENANT_A] });
  pgContainer = booted.container;
  prismaImports = await import("../../lib/prisma.js");
  const appImports = await import("../../app.js");
  app = await appImports.buildApp();
  await app.ready();
}, 240_000);

afterAll(async () => {
  await app?.close().catch(() => {});
  await prismaImports?.prisma.$disconnect().catch(() => {});
  await prismaImports?.pool.end().catch(() => {});
  await endAdminPool();
  await pgContainer?.stop().catch(() => {});
});

beforeEach(async () => {
  await resetDb();
  await truncateTables("user_role, cis_user, role, utility_module");
  await makeTenantFixture(prismaImports.prisma, TENANT_A);
  await ensurePrincipal(prismaImports.prisma, TENANT_A);
  await seedAsPlatform(async () => {
    await prismaImports.prisma.utilityModule.create({
      data: { utilityId: TENANT_A, moduleKey: "delinquency" },
    });
    const rbac = await import("../../services/rbac.service.js");
    await rbac.invalidateTenantModulesCache(TENANT_A);
  });
});

describe("the plan terms namespace, over HTTP", () => {
  it("saves for a tenant that has no config row at all", async () => {
    // Every tenant, until something writes one. `utility_config.updated_at`
    // is NOT NULL with no database default, and Prisma's `@updatedAt` is
    // client-side — so a raw INSERT that omits it is a 23502 and the
    // screen can never save.
    await dropConfigRow();

    const res = await put(whole({ downPaymentPercent: 15 }));

    expect(res.statusCode).toBe(200);
    expect(await storedNamespace()).toMatchObject({ downPaymentPercent: 15 });
  });

  it("saves for a tenant that already has one", async () => {
    const res = await put(whole({ graceDays: 2 }));

    expect(res.statusCode).toBe(200);
    expect(await storedNamespace()).toMatchObject({ graceDays: 2 });
  });

  it("reads back what it stored", async () => {
    await put(whole({ downPaymentPercent: 10, maxInstallments: 24 }));

    const res = await get();

    expect(res.statusCode).toBe(200);
    expect(res.json().terms).toMatchObject({
      downPaymentPercent: 10,
      maxInstallments: 24,
      // Untouched terms keep their defaults.
      graceDays: DEFAULT_PLAN_TERMS.graceDays,
    });
  });

  it("answers the shipped defaults for a tenant that never saved", async () => {
    await dropConfigRow();

    const res = await get();

    expect(res.statusCode).toBe(200);
    expect(res.json().terms).toEqual(DEFAULT_PLAN_TERMS);
  });

  it("leaves another namespace in the column alone", async () => {
    // Eight namespaces share `settings`, each with its own screen. The
    // lost-update this SQL exists to prevent.
    await seedAsPlatform(async () => {
      await prismaImports.prisma.utilityConfig.update({
        where: { utilityId: TENANT_A },
        data: { settings: { issuer: { name: "City of Testville" } } },
      });
    });

    await put(whole({ graceDays: 7 }));

    const row = await seedAsPlatform(async () =>
      prismaImports.prisma.utilityConfig.findUniqueOrThrow({
        where: { utilityId: TENANT_A },
        select: { settings: true },
      }),
    );
    const settings = row.settings as Record<string, Record<string, unknown>>;
    expect(settings.issuer).toEqual({ name: "City of Testville" });
    expect(settings.paymentPlans).toMatchObject({ graceDays: 7 });
  });

  it("moves updated_at when it writes, so the column does not go stale", async () => {
    const before = await seedAsPlatform(async () =>
      prismaImports.prisma.utilityConfig.findUniqueOrThrow({
        where: { utilityId: TENANT_A },
        select: { updatedAt: true },
      }),
    );

    await put(whole({ graceDays: 4 }));

    const after = await seedAsPlatform(async () =>
      prismaImports.prisma.utilityConfig.findUniqueOrThrow({
        where: { utilityId: TENANT_A },
        select: { updatedAt: true },
      }),
    );
    expect(after.updatedAt.getTime()).toBeGreaterThan(before.updatedAt.getTime());
  });

  it("refuses a misspelled term rather than storing it to be ignored", async () => {
    const res = await put({ ...whole(), graceDayz: 5 });

    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBeLessThan(500);
  });

  it("refuses an instalment range that offers no valid plan", async () => {
    const res = await put(whole({ minInstallments: 6, maxInstallments: 3 }));

    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBeLessThan(500);
  });
});
