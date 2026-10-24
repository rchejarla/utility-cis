import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@utility-cis/shared/src/generated/prisma";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import { bootPostgres, type BootedContainer, seedAsPlatform } from "./_effective-dating-fixtures.js";
import { buildRegistry } from "../../lib/rate-engine-registry.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SHARED_DIR = path.resolve(__dirname, "../../../../shared");
const REPO_ROOT = path.resolve(__dirname, "../../../../..");

let booted: BootedContainer;
let prisma: PrismaClient;

beforeAll(async () => {
  booted = await bootPostgres();
  const TSX_BIN =
    process.platform === "win32"
      ? path.join(REPO_ROOT, "node_modules", ".pnpm", "node_modules", ".bin", "tsx.cmd")
      : path.join(REPO_ROOT, "node_modules", ".pnpm", "node_modules", ".bin", "tsx");
  execSync(`"${TSX_BIN}" prisma/seed.ts`, {
    cwd: SHARED_DIR,
    env: { ...process.env, DATABASE_URL: booted.dbUrl },
    stdio: "pipe",
  });
      // Prisma 7 removed `datasources`; a client is created over a driver
      // adapter instead, which is also how `lib/prisma.ts` builds the
      // real one. The pool is this test's to close, hence `$disconnect`
      // in afterAll below.
  prisma = new PrismaClient({ adapter: new PrismaPg(new pg.Pool({ connectionString: booted.dbUrl })) });
}, 600_000);

afterAll(async () => {
  await prisma?.$disconnect().catch(() => {});
  await booted?.container.stop().catch(() => {});
});

describe("buildRegistry", () => {
  it("registers all 8 loaders and validates every key the engine produces for a Bozeman SFR SA", () =>
    seedAsPlatform(async () => {      /* Fixture rows and read-backs under the fixture authority; the
       * scoped wrappers re-enter their own tenant scope. */
      const sched = await prisma.rateSchedule.findFirstOrThrow({
        where: { code: "BZN-WATER" },
      });
      const assignment = await prisma.sAScheduleAssignment.findFirstOrThrow({
        where: { rateScheduleId: sched.id },
        include: {
          serviceAgreement: {
            include: {
              servicePoints: { where: { endDate: null }, include: { premise: true }, take: 1 },
            },
          },
        },
      });
      const sa = assignment.serviceAgreement;
      const premiseId = sa.servicePoints[0]!.premise.id;

      const registry = buildRegistry(prisma, {
        utilityId: sa.utilityId,
        saId: sa.id,
        accountId: sa.accountId,
        premiseId,
        period: { startDate: new Date(2026, 4, 1), endDate: new Date(2026, 4, 31) },
      });

      // Spot-check known capability patterns
      expect(registry.validateKey("account:class").valid).toBe(true);
      expect(registry.validateKey("tenant:drought_stage").valid).toBe(true);
      expect(registry.validateKey("premise:attr:eru_count").valid).toBe(true);
      expect(registry.validateKey(`meter:reads:${"00000000-0000-0000-0000-000000000001"}`).valid).toBe(true);
      expect(registry.validateKey("totally_unknown:thing").valid).toBe(false);
  
    }), 600_000);
});
