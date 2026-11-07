import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import type { FastifyInstance } from "fastify";
import {
  meterReadRowSchema,
  paginatedSchema,
  readingProgressSchema,
} from "@utility-cis/shared";
import {
  bootPostgres,
  resetDb,
  makeTenantFixture,
  TENANT_A,
  ACTOR,
  type TenantFixture,
  endAdminPool,
  ensurePrincipal,
  seedAsPlatform,
} from "./_effective-dating-fixtures.js";

/**
 * Does the API still send what the screens read?
 *
 * **Nothing asked this before.** The web package hand-declares its own
 * interface for every response — 169 of them — and all 818 of its tests
 * mock `apiClient` wholesale, so the contract between the two sides was
 * asserted in neither. Three bugs in one day came of it: a list page
 * whose interface simply never declared `billedAt`, so a column could
 * not have worked; a pagination envelope read as `total` when the API
 * sends `meta.total`; and a client call missing the body argument the
 * client requires, which only `tsc` caught.
 *
 * So the response shapes now live in `@utility-cis/shared` as Zod
 * schemas: the web derives its types from them, and this file parses a
 * **real HTTP response** through the same schema. That closes the loop
 * in both directions — a field the UI needs and the API stops sending
 * fails here, and a field the API renames fails to compile in every
 * page that reads it.
 *
 * The schemas are deliberately **not** `.strict()`. They state what the
 * UI depends on, not everything a route happens to include, so adding a
 * field to a response is not a breaking change — only taking one away.
 */

vi.mock("../../lib/queues.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/queues.js")>()),
  enqueueSafely: vi.fn(async () => "test-job-id"),
}));

let pgContainer: StartedPostgreSqlContainer;
let prismaImports: typeof import("../../lib/prisma.js");
let app: FastifyInstance;
let fixA: TenantFixture;

function headers() {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      sub: ACTOR,
      utility_id: TENANT_A,
      email: "tester@example.com",
      name: "Tester",
      role: "admin",
    }),
  ).toString("base64url");
  return { authorization: `Bearer ${header}.${payload}.fake-signature` };
}

beforeAll(async () => {
  const booted = await bootPostgres({ utilities: [TENANT_A] });
  pgContainer = booted.container;
  prismaImports = await import("../../lib/prisma.js");
  const appImports = await import("../../app.js");
  app = await appImports.buildApp();
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
  seedAsPlatform(async () => {
    const { prisma } = prismaImports;
    await resetDb();
    fixA = await makeTenantFixture(prisma, TENANT_A);
    await ensurePrincipal(prisma, TENANT_A);
    await prisma.utilityModule.create({
      data: { utilityId: TENANT_A, moduleKey: "meter_reads" },
    });
    const rbac = await import("../../services/rbac.service.js");
    await rbac.invalidateTenantModulesCache(TENANT_A);
  }));

/** One read, with the relations the log's columns show. */
async function seedRead(over: { exceptionCode?: string; billed?: boolean } = {}) {
  await seedAsPlatform(async () => {
    const { prisma } = prismaImports;
    const sa = await prisma.serviceAgreement.create({
      data: {
        utilityId: TENANT_A,
        agreementNumber: "SA-CONTRACT",
        accountId: fixA.accountId,
        commodityId: fixA.commodityId,
        startDate: new Date("2026-01-01"),
        status: "ACTIVE",
      },
      select: { id: true },
    });
    await prisma.meterRead.create({
      data: {
        utilityId: TENANT_A,
        meterId: fixA.meterId,
        serviceAgreementId: sa.id,
        uomId: fixA.uomId,
        readDate: new Date("2026-02-08"),
        readDatetime: new Date("2026-02-08T10:00:00Z"),
        reading: "1200.0000",
        priorReading: "1000.0000",
        consumption: "200.0000",
        readType: "ACTUAL",
        readSource: "AMR",
        exceptionCode: over.exceptionCode ?? null,
        billedAt: over.billed ? new Date("2026-02-12T00:00:00Z") : null,
      },
    });
  });
}

describe("GET /api/v1/meter-reads", () => {
  it("sends the row shape the read log reads", async () => {
    await seedRead();

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/meter-reads",
      headers: headers(),
    });

    expect(res.statusCode).toBe(200);
    const parsed = paginatedSchema(meterReadRowSchema).safeParse(JSON.parse(res.body));
    // The message, not just the boolean: a schema failure here has to
    // name the field, or it is a worse error than the one it replaced.
    expect(parsed.success ? null : parsed.error.issues).toBeNull();
  });

  it("sends the fields the columns actually print", async () => {
    await seedRead({ exceptionCode: "CONSECUTIVE_ESTIMATE", billed: true });

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/meter-reads",
      headers: headers(),
    });

    const row = paginatedSchema(meterReadRowSchema).parse(JSON.parse(res.body)).data[0]!;
    // Each of these is a column on the screen, and `billedAt` is the
    // one whose absence from the web's own interface meant the ❄
    // indicator could not have worked even once it had a writer.
    expect(row.meter?.meterNumber).toBeTruthy();
    expect(row.uom?.code).toBeTruthy();
    expect(row.serviceAgreement?.agreementNumber).toBe("SA-CONTRACT");
    expect(row.exceptionCode).toBe("CONSECUTIVE_ESTIMATE");
    expect(row.billedAt).not.toBeNull();
    expect(row.consumption).toBe("200");
  });
});

describe("GET /api/v1/meter-reads/progress", () => {
  it("sends the shape the progress screen reads", async () => {
    await seedRead();

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/meter-reads/progress?billingCycleId=${fixA.billingCycleId}`,
      headers: headers(),
    });

    expect(res.statusCode).toBe(200);
    const parsed = readingProgressSchema.safeParse(JSON.parse(res.body));
    expect(parsed.success ? null : parsed.error.issues).toBeNull();
  });

  it("sends its timestamps as strings, which is what a JSON body can carry", async () => {
    await seedRead();

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/meter-reads/progress?billingCycleId=${fixA.billingCycleId}`,
      headers: headers(),
    });

    const body = readingProgressSchema.parse(JSON.parse(res.body));
    /*
     * The service builds this response rather than handing back Prisma
     * rows, so its return type *is* the shared schema's type — which
     * means the compiler checks the producing side too, not only the
     * reading side. `Date` in that type would have been a lie: it is a
     * string by the time anybody reads it.
     */
    expect(typeof body.windowStart).toBe("string");
    expect(new Date(body.windowStart).toISOString()).toBe(body.windowStart);
  });
});
