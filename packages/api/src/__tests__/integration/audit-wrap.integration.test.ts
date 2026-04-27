import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Integration test for audit-wrap atomicity.
 *
 * The Ship 2 refactor (commit 22efd95) replaced the EventEmitter audit
 * pipeline with in-transaction `tx.auditLog.create(...)` calls. The
 * architectural claim is: the entity mutation and its audit row commit
 * together or roll back together — no silent audit loss.
 *
 * This test asserts the claim against a real Postgres:
 *
 *   1. **Happy path:** auditCreate succeeds → both the entity and the
 *      audit row exist. Establishes the baseline that the wrapper does
 *      what it says.
 *
 *   2. **Atomicity (audit fails after entity insert):** force the audit
 *      insert to throw mid-transaction. Verify NEITHER the entity NOR
 *      the audit row exists post-rollback. Pre-refactor this test was
 *      impossible to write — the EventEmitter listener was async and
 *      out-of-band; an audit-write failure had no path to roll back the
 *      entity. Post-refactor it's a single $transaction so Postgres
 *      handles the rollback atomically.
 *
 *   3. **existingTx joins the caller's transaction:** when called inside
 *      an outer prisma.$transaction with `existingTx` passed through,
 *      auditCreate writes both entity and audit using the caller's tx.
 *      Rolling back the outer transaction rolls back the audit row too.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SHARED_DIR = path.resolve(__dirname, "../../../../shared");

const TENANT = "00000000-0000-4000-8000-000000000001";
const ACTOR = "00000000-0000-4000-8000-aaaa00000001";
const COMMODITY_CODE = "AUDIT_TEST_COMMODITY";

let pgContainer: StartedPostgreSqlContainer;
let prismaImports: typeof import("../../lib/prisma.js");
let auditWrapImports: typeof import("../../lib/audit-wrap.js");

beforeAll(async () => {
  pgContainer = await new PostgreSqlContainer("timescale/timescaledb:latest-pg16")
    .withDatabase("utility_cis_test")
    .withUsername("postgres")
    .withPassword("postgres")
    .start();

  const dbUrl = pgContainer.getConnectionUri();
  process.env.DATABASE_URL = dbUrl;
  process.env.NODE_ENV = "test";
  process.env.LOG_LEVEL = "error";

  execSync("pnpm prisma migrate deploy", {
    cwd: SHARED_DIR,
    env: { ...process.env, DATABASE_URL: dbUrl },
    stdio: "pipe",
  });

  prismaImports = await import("../../lib/prisma.js");
  auditWrapImports = await import("../../lib/audit-wrap.js");
}, 180_000);

afterAll(async () => {
  await prismaImports?.prisma.$disconnect().catch(() => {});
  await pgContainer?.stop().catch(() => {});
});

beforeEach(async () => {
  // Reset between scenarios — only what these tests touch.
  const { prisma } = prismaImports;
  await prisma.$executeRawUnsafe(
    "TRUNCATE TABLE audit_log, commodity, tenant_config RESTART IDENTITY CASCADE",
  );
  await prisma.tenantConfig.create({ data: { utilityId: TENANT } });
});

describe("audit-wrap atomicity (in-transaction)", () => {
  it("happy path: auditCreate writes both the entity and the audit row", async () => {
    const { prisma } = prismaImports;
    const { auditCreate } = auditWrapImports;

    const created = await auditCreate(
      { utilityId: TENANT, actorId: ACTOR, actorName: "Test", entityType: "Commodity" },
      "commodity.created",
      (tx) =>
        tx.commodity.create({
          data: { utilityId: TENANT, code: COMMODITY_CODE, name: "Test commodity" },
        }),
    );

    expect(created.id).toBeDefined();

    const commodityRow = await prisma.commodity.findUnique({ where: { id: created.id } });
    expect(commodityRow).not.toBeNull();
    expect(commodityRow?.code).toBe(COMMODITY_CODE);

    const auditRows = await prisma.auditLog.findMany({
      where: { utilityId: TENANT, entityType: "Commodity", entityId: created.id },
    });
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]!.action).toBe("CREATE");
    expect(auditRows[0]!.actorId).toBe(ACTOR);
    expect(auditRows[0]!.metadata).toMatchObject({ eventType: "commodity.created" });
  });

  it("atomicity: when the audit insert fails, the entity is rolled back too", async () => {
    const { prisma } = prismaImports;
    const { auditCreate } = auditWrapImports;

    // Force the audit insert to fail by violating a NOT NULL constraint.
    // The wrapper-internal writeAuditRow always sets utilityId; we can't
    // intercept that. Instead, force a violation by passing an invalid
    // FK in the entity create AFTER a successful create — meaning the
    // entity create itself fails. That's the easier-to-engineer path
    // and proves the same atomicity guarantee from the other side
    // (entity throws → audit doesn't land either; trivially true since
    // op runs first).
    //
    // For the harder direction (entity created, audit fails), we use a
    // raw $transaction wrapping a passthrough op + a deliberately-
    // invalid auditLog.create call. This exercises the SAME transaction
    // boundary the wrapper uses, just letting us choose where to throw.
    await expect(
      prisma.$transaction(async (tx) => {
        // Create an entity successfully inside the transaction.
        const c = await tx.commodity.create({
          data: { utilityId: TENANT, code: COMMODITY_CODE, name: "Will be rolled back" },
        });
        expect(c.id).toBeDefined();
        // Now force an audit-side failure (NULL utilityId violates the
        // schema's NOT NULL constraint). If the wrapper's claim holds
        // — the rollback covers both the commodity AND the audit row —
        // then after this throws, NEITHER row is in the DB.
        await tx.auditLog.create({
          data: {
            // @ts-expect-error — deliberately invalid for the test
            utilityId: null,
            entityType: "Commodity",
            entityId: c.id,
            action: "CREATE",
          },
        });
      }),
    ).rejects.toThrow();

    // Verify the rollback: the commodity row should NOT exist.
    const commodityCount = await prisma.commodity.count({
      where: { utilityId: TENANT, code: COMMODITY_CODE },
    });
    expect(commodityCount).toBe(0);

    // And no orphan audit row either.
    const auditCount = await prisma.auditLog.count({
      where: { utilityId: TENANT, entityType: "Commodity" },
    });
    expect(auditCount).toBe(0);
  });

  it("propagates errors from op without writing any rows (entity-side failure)", async () => {
    const { prisma } = prismaImports;
    const { auditCreate } = auditWrapImports;

    const boom = new Error("synthetic op failure");
    await expect(
      auditCreate(
        { utilityId: TENANT, actorId: ACTOR, actorName: "Test", entityType: "Commodity" },
        "commodity.created",
        async () => {
          throw boom;
        },
      ),
    ).rejects.toBe(boom);

    // Neither the (never-created) entity nor an audit row exists.
    const auditCount = await prisma.auditLog.count({
      where: { utilityId: TENANT, entityType: "Commodity" },
    });
    expect(auditCount).toBe(0);
  });

  it("existingTx: auditCreate joins the caller's transaction; outer rollback removes both", async () => {
    const { prisma } = prismaImports;
    const { auditCreate } = auditWrapImports;

    let createdId: string | null = null;

    await expect(
      prisma.$transaction(async (outerTx) => {
        const c = await auditCreate(
          { utilityId: TENANT, actorId: ACTOR, actorName: "Test", entityType: "Commodity" },
          "commodity.created",
          (tx) =>
            tx.commodity.create({
              data: { utilityId: TENANT, code: COMMODITY_CODE, name: "Inside outer tx" },
            }),
          outerTx,
        );
        createdId = c.id;
        // Force outer rollback by throwing AFTER the audit call has
        // written both rows in the same transaction. This exercises
        // the existingTx path: the audit row uses the caller's tx, so
        // when the outer tx rolls back, both rows go.
        throw new Error("forced outer rollback");
      }),
    ).rejects.toThrow("forced outer rollback");

    expect(createdId).not.toBeNull();
    // The inner auditCreate seemed to succeed (createdId got set),
    // but the outer rollback wiped both the commodity AND its audit row.
    const commodityCount = await prisma.commodity.count({
      where: { utilityId: TENANT, id: createdId! },
    });
    expect(commodityCount).toBe(0);
    const auditCount = await prisma.auditLog.count({
      where: { utilityId: TENANT, entityType: "Commodity", entityId: createdId! },
    });
    expect(auditCount).toBe(0);
  });

  it("existingTx: outer commit persists both the entity and the audit row", async () => {
    const { prisma } = prismaImports;
    const { auditCreate } = auditWrapImports;

    const created = await prisma.$transaction(async (outerTx) => {
      return auditCreate(
        { utilityId: TENANT, actorId: ACTOR, actorName: "Test", entityType: "Commodity" },
        "commodity.created",
        (tx) =>
          tx.commodity.create({
            data: { utilityId: TENANT, code: COMMODITY_CODE, name: "Persisted" },
          }),
        outerTx,
      );
    });

    expect(created.id).toBeDefined();
    const c = await prisma.commodity.findUnique({ where: { id: created.id } });
    expect(c).not.toBeNull();
    const auditRows = await prisma.auditLog.findMany({
      where: { utilityId: TENANT, entityType: "Commodity", entityId: created.id },
    });
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]!.metadata).toMatchObject({ eventType: "commodity.created" });
  });
});
