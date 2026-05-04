import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@utility-cis/shared/src/generated/prisma";
import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  bootPostgres,
  type BootedContainer,
} from "./_effective-dating-fixtures.js";
import { createRateComponentSchema } from "@utility-cis/shared";

/**
 * Slice 1 task 10 — seed sanity.
 *
 * Boots a Postgres container, applies migrations (via bootPostgres),
 * runs the v2 prisma seed, then asserts the post-seed invariants:
 *
 *   - every rate schedule has at least one component
 *   - every active SA has at least one rate-schedule assignment
 *   - every component validates against the current Zod schema
 *   - rate service classes are unique on (utility, commodity, code)
 *   - rate_component_kind globals match the registered code list
 *   - rate_assignment_role globals match the registered code list
 *
 * This is the canonical post-seed health check: if a future change to
 * the schema or grammar drifts the seed out of valid shape, this suite
 * catches it before the dev DB does.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SHARED_DIR = path.resolve(__dirname, "../../../../shared");

let booted: BootedContainer;
let prisma: PrismaClient;

beforeAll(async () => {
  booted = await bootPostgres();

  // Run the v2 prisma seed (seed.ts) against the freshly migrated DB.
  // bootPostgres already applied migrations; we just invoke the seeder
  // with the test container's DATABASE_URL. We resolve `tsx` from the
  // monorepo's pnpm store because the shared package doesn't list it
  // as a dev dep — the dev shell resolves it from the workspace root.
  const REPO_ROOT = path.resolve(__dirname, "../../../../..");
  const TSX_BIN = process.platform === "win32"
    ? path.join(REPO_ROOT, "node_modules", ".pnpm", "node_modules", ".bin", "tsx.cmd")
    : path.join(REPO_ROOT, "node_modules", ".pnpm", "node_modules", ".bin", "tsx");
  execSync(`"${TSX_BIN}" prisma/seed.ts`, {
    cwd: SHARED_DIR,
    env: { ...process.env, DATABASE_URL: booted.dbUrl },
    stdio: "pipe",
  });

  prisma = new PrismaClient({ datasources: { db: { url: booted.dbUrl } } });
}, 300_000);

afterAll(async () => {
  await prisma?.$disconnect().catch(() => {});
  await booted?.container.stop().catch(() => {});
});

describe("seed sanity", () => {
  it("every rate schedule has at least one component", async () => {
    const schedules = await prisma.rateSchedule.findMany({
      include: { _count: { select: { components: true } } },
    });
    expect(schedules.length).toBeGreaterThan(0);
    for (const s of schedules) {
      expect(s._count.components, `schedule ${s.code} has no components`).toBeGreaterThan(0);
    }
  });

  it("every active SA has at least one rate-schedule assignment", async () => {
    const sas = await prisma.serviceAgreement.findMany({
      where: { status: { in: ["ACTIVE", "PENDING"] } },
      include: { _count: { select: { rateScheduleAssignments: true } } },
    });
    expect(sas.length).toBeGreaterThan(0);
    for (const sa of sas) {
      expect(
        sa._count.rateScheduleAssignments,
        `SA ${sa.agreementNumber} has no rate-schedule assignments`,
      ).toBeGreaterThan(0);
    }
  });

  it("every component validates against the current Zod schema", async () => {
    const components = await prisma.rateComponent.findMany();
    expect(components.length).toBeGreaterThan(0);
    for (const c of components) {
      const result = createRateComponentSchema.safeParse({
        kindCode: c.kindCode,
        label: c.label,
        predicate: c.predicate,
        quantitySource: c.quantitySource,
        pricing: c.pricing,
        sortOrder: c.sortOrder,
        effectiveDate: c.effectiveDate.toISOString().slice(0, 10),
      });
      if (!result.success) {
        throw new Error(
          `Component ${c.id} (${c.label}) failed validation: ${JSON.stringify(result.error.format())}`,
        );
      }
    }
  });

  it("rate service classes have unique (utility, commodity, code)", async () => {
    const classes = await prisma.rateServiceClass.findMany();
    expect(classes.length).toBeGreaterThan(0);
    const seen = new Set<string>();
    for (const c of classes) {
      const key = `${c.utilityId}|${c.commodityId}|${c.code}`;
      expect(seen.has(key), `duplicate class key: ${key}`).toBe(false);
      seen.add(key);
    }
  });

  it("rate_component_kind has the 11 expected globals", async () => {
    const globals = await prisma.rateComponentKind.findMany({
      where: { utilityId: null },
    });
    const expected = [
      "service_charge",
      "consumption",
      "derived_consumption",
      "non_meter",
      "item_price",
      "one_time_fee",
      "surcharge",
      "tax",
      "credit",
      "reservation_charge",
      "minimum_bill",
    ];
    expect(globals.map((g) => g.code).sort()).toEqual(expected.sort());
  });

  it("rate_assignment_role has the 5 expected globals", async () => {
    const globals = await prisma.rateAssignmentRole.findMany({
      where: { utilityId: null },
    });
    const expected = ["primary", "delivery", "supply", "rider", "opt_in"];
    expect(globals.map((g) => g.code).sort()).toEqual(expected.sort());
  });
});
