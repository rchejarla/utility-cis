import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import type { FastifyInstance } from "fastify";
import {
  bootPostgres,
  resetDb,
  makeTenantFixture,
  TENANT_A,
  ACTOR,
  type TenantFixture,
  ensurePrincipal,
  seedAsPlatform,
  endAdminPool,
  serviceClassFor,
} from "./_effective-dating-fixtures.js";

/**
 * An agreement's service class, required since 2026-11-28 (spec 05), over
 * HTTP. A rate charge restricted to a class applies only to agreements in
 * it, so an agreement with none silently missed those charges — and no
 * screen could set one. Pinned: the class list the pickers read; that
 * create refuses a class that is another commodity's, retired, or absent;
 * that the class is stored; and that an edit can correct it, with the same
 * checks.
 */

let pgContainer: StartedPostgreSqlContainer;
let prismaImports: typeof import("../../lib/prisma.js");
let app: FastifyInstance;
let fix: TenantFixture;
let residentialId: string;
let commercialId: string;
let otherCommodityClassId: string;
let retiredId: string;

const asPlatform = <T>(fn: () => Promise<T>): Promise<T> => seedAsPlatform(async () => await fn());

function makeToken() {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({ sub: ACTOR, utility_id: TENANT_A, email: "tester@example.com", name: "Tester", role: "admin" }),
  ).toString("base64url");
  return `${header}.${payload}.fake-signature`;
}
const headers = () => ({ authorization: `Bearer ${makeToken()}` });

beforeAll(async () => {
  const booted = await bootPostgres({ utilities: [TENANT_A] });
  pgContainer = booted.container;
  prismaImports = await import("../../lib/prisma.js");
  app = await (await import("../../app.js")).buildApp();
  await app.ready();
}, 180_000);

afterAll(async () => {
  await app?.close().catch(() => {});
  await prismaImports?.prisma.$disconnect().catch(() => {});
  await prismaImports?.pool.end().catch(() => {});
  await endAdminPool();
  await pgContainer?.stop().catch(() => {});
});

beforeEach(() =>
  asPlatform(async () => {
    const { prisma } = prismaImports;
    await resetDb();
    fix = await makeTenantFixture(prisma, TENANT_A);
    await ensurePrincipal(prisma, TENANT_A);
    await prisma.utilityModule.create({ data: { utilityId: fix.utilityId, moduleKey: "agreements" } });
    await (await import("../../services/rbac.service.js")).invalidateTenantModulesCache(fix.utilityId);

    residentialId = await serviceClassFor(prisma, fix.utilityId, fix.commodityId, "residential");
    commercialId = await serviceClassFor(prisma, fix.utilityId, fix.commodityId, "commercial");
    retiredId = await serviceClassFor(prisma, fix.utilityId, fix.commodityId, "old_class");
    await prisma.rateServiceClass.update({ where: { id: retiredId }, data: { isActive: false } });
    const electric = await prisma.commodity.create({
      data: { utilityId: fix.utilityId, code: "ELEC-T", name: "Electric" },
    });
    otherCommodityClassId = await serviceClassFor(prisma, fix.utilityId, electric.id, "residential");
  }),
);

const create = (rateServiceClassId: string | undefined) =>
  app.inject({
    method: "POST",
    url: "/api/v1/service-agreements",
    headers: headers(),
    payload: {
      accountId: fix.accountId,
      premiseId: fix.premiseId,
      commodityId: fix.commodityId,
      ...(rateServiceClassId ? { rateServiceClassId } : {}),
      startDate: "2026-01-01",
      meters: [{ meterId: fix.meterId }],
    },
  });
const codeOf = (res: { json: () => { code?: string; error?: { code?: string } } }) =>
  res.json().error?.code ?? res.json().code;

describe("service class on an agreement", () => {
  it("lists the commodity's active classes for the pickers", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/service-agreements/service-classes?commodityId=${fix.commodityId}`,
      headers: headers(),
    });

    expect(res.statusCode, res.body).toBe(200);
    const codes = res.json().data.map((c: { code: string }) => c.code).sort();
    expect(codes).toEqual(["commercial", "residential"]); // not the retired one, not electric's
  });

  it("is required on create", async () => {
    const res = await create(undefined);

    expect(res.statusCode).toBe(400);
  });

  it("refuses another commodity's class, and a retired one", async () => {
    const other = await create(otherCommodityClassId);
    expect(other.statusCode).toBe(400);
    expect(codeOf(other)).toBe("SERVICE_CLASS_INVALID");

    const retired = await create(retiredId);
    expect(retired.statusCode).toBe(400);
    expect(codeOf(retired)).toBe("SERVICE_CLASS_INVALID");
  });

  it("stores the class, and an edit can correct it with the same checks", async () => {
    const created = await create(residentialId);
    expect(created.statusCode, created.body).toBe(201);
    const sa = created.json();
    expect(sa.rateServiceClass.code).toBe("residential");

    const bad = await app.inject({
      method: "PATCH",
      url: `/api/v1/service-agreements/${sa.id}`,
      headers: headers(),
      payload: { rateServiceClassId: otherCommodityClassId },
    });
    expect(bad.statusCode).toBe(400);

    const fixed = await app.inject({
      method: "PATCH",
      url: `/api/v1/service-agreements/${sa.id}`,
      headers: headers(),
      payload: { rateServiceClassId: commercialId },
    });
    expect(fixed.statusCode, fixed.body).toBe(200);
    expect(fixed.json().rateServiceClass.code).toBe("commercial");
  });
});
