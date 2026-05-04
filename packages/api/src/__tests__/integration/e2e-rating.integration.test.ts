import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@utility-cis/shared/src/generated/prisma";
import {
  bootPostgres,
  type BootedContainer,
} from "./_effective-dating-fixtures.js";
import * as engine from "../../lib/rate-engine/index.js";
import {
  VariableRegistry,
  loadBase,
} from "../../lib/rate-engine-loaders/index.js";
import { AccountLoader } from "../../lib/rate-engine-loaders/loaders/account-loader.js";
import { MeterLoader } from "../../lib/rate-engine-loaders/loaders/meter-loader.js";
import { TenantLoader } from "../../lib/rate-engine-loaders/loaders/tenant-loader.js";
import { PremiseLoader } from "../../lib/rate-engine-loaders/loaders/premise-loader.js";
import { IndexLoader } from "../../lib/rate-engine-loaders/loaders/index-loader.js";
import { WqaLoader } from "../../lib/rate-engine-loaders/loaders/wqa-loader.js";
import { LinkedCommodityLoader } from "../../lib/rate-engine-loaders/loaders/linked-commodity-loader.js";
import { ItemsLoader } from "../../lib/rate-engine-loaders/loaders/items-loader.js";

/**
 * Slice 4 task 8 — End-to-end integration test.
 *
 * Boots Postgres, runs the v2 seed, picks a Bozeman SFR water SA,
 * inserts a single 12 HCF meter read for May 2026, and runs the full
 * pipeline:
 *
 *   loadBase(saId, period) → engine.manifest(base)
 *                          → registry.loadVariables(keys + meter:reads/size)
 *                          → engine.rate({ base, vars })
 *
 * The result must match the Slice 3 SFR golden test exactly:
 *   service_charge $22.31 + tier-walked usage $47.34 = $69.65 subtotal.
 *
 * If this test passes, the loader system + rate engine + DB are wired
 * correctly for real-world billing — Slice 4 is proven.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SHARED_DIR = path.resolve(__dirname, "../../../../shared");
const REPO_ROOT = path.resolve(__dirname, "../../../../..");

let booted: BootedContainer;
let prisma: PrismaClient;

beforeAll(async () => {
  booted = await bootPostgres();

  // Run the v2 prisma seed — same TSX_BIN resolution as the Slice 1
  // seed-sanity suite. The shared package doesn't list `tsx` as a
  // dev dep; it lives at the workspace root.
  const TSX_BIN =
    process.platform === "win32"
      ? path.join(
          REPO_ROOT,
          "node_modules",
          ".pnpm",
          "node_modules",
          ".bin",
          "tsx.cmd",
        )
      : path.join(
          REPO_ROOT,
          "node_modules",
          ".pnpm",
          "node_modules",
          ".bin",
          "tsx",
        );
  execSync(`"${TSX_BIN}" prisma/seed.ts`, {
    cwd: SHARED_DIR,
    env: { ...process.env, DATABASE_URL: booted.dbUrl },
    stdio: "pipe",
  });

  prisma = new PrismaClient({
    datasources: { db: { url: booted.dbUrl } },
  });
}, 600_000);

afterAll(async () => {
  await prisma?.$disconnect().catch(() => {});
  await booted?.container.stop().catch(() => {});
});

describe("End-to-end rating: seeded Bozeman SFR water → $69.65 subtotal", () => {
  it("loadBase → manifest → loadVariables → rate produces correct dollar output", async () => {
    // 1. Find the seeded Bozeman water schedule
    const waterSchedule = await prisma.rateSchedule.findFirstOrThrow({
      where: { code: "BZN-WATER" },
    });

    // 2. Find a SFR water SA assigned to this schedule
    const assignment = await prisma.sAScheduleAssignment.findFirstOrThrow({
      where: {
        rateScheduleId: waterSchedule.id,
        roleCode: "primary",
        serviceAgreement: {
          rateServiceClass: { code: "single_family" },
        },
      },
      include: {
        serviceAgreement: {
          include: {
            rateServiceClass: { select: { code: true } },
            servicePoints: {
              where: { endDate: null },
              include: { meters: { include: { meter: true } }, premise: true },
              take: 1,
            },
          },
        },
      },
    });

    const sa = assignment.serviceAgreement;
    expect(sa.rateServiceClass?.code).toBe("single_family");

    // 3. Locate the SA's meter + seed a 12 HCF read for May 2026
    const meterAssignment = sa.servicePoints[0]?.meters[0];
    if (!meterAssignment) {
      throw new Error("Seeded SFR SA has no meter — adjust fixture or seed");
    }
    const meterId = meterAssignment.meterId;

    // The service_charge component does a `lookup by meter_size`; the
    // MeterLoader reads `meter.customFields.size`. Set it inline.
    await prisma.meter.update({
      where: { id: meterId },
      data: { customFields: { size: '5/8"' } as object },
    });

    const meter = await prisma.meter.findUniqueOrThrow({
      where: { id: meterId },
      select: { uomId: true, utilityId: true },
    });

    await prisma.meterRead.create({
      data: {
        utilityId: meter.utilityId,
        meterId,
        serviceAgreementId: sa.id,
        uomId: meter.uomId,
        readDate: new Date(2026, 4, 31),
        readDatetime: new Date(2026, 4, 31, 12, 0, 0),
        reading: 100,
        priorReading: 88,
        consumption: 12,
        readType: "ACTUAL",
        readSource: "MANUAL",
      },
    });

    // 4. Period = May 2026
    const period = {
      startDate: new Date(2026, 4, 1),
      endDate: new Date(2026, 4, 31),
    };
    const utilityId = sa.utilityId;

    // 5. loadBase
    const base = await loadBase(prisma, sa.id, period, utilityId);

    expect(base.assignments.length).toBeGreaterThan(0);
    expect(base.assignments.some((a) => a.schedule.code === "BZN-WATER")).toBe(
      true,
    );
    expect(base.sa.rateServiceClassCode).toBe("single_family");

    // 6. Build registry with all 8 loaders
    const registry = new VariableRegistry();
    registry.register(new AccountLoader(prisma, utilityId, sa.id));
    registry.register(new MeterLoader(prisma, utilityId, period));
    registry.register(new WqaLoader(prisma, utilityId, sa.id));
    registry.register(new TenantLoader(prisma, utilityId));
    registry.register(new PremiseLoader(prisma, utilityId, base.sa.premiseId));
    registry.register(new IndexLoader(prisma, utilityId));
    registry.register(
      new LinkedCommodityLoader(prisma, utilityId, period, {
        id: sa.id,
        accountId: sa.accountId,
        premiseId: base.sa.premiseId,
      }),
    );
    registry.register(new ItemsLoader(prisma, utilityId, sa.id));

    // 7. manifest — collect schedule-driven keys
    const manifestKeys = engine.manifest(base);

    // The engine's predicate evaluator infers the meter id from
    // `meter:reads:*` keys at rate time. Pre-load the meter-keyed
    // vars manually so the engine can run end-to-end.
    const allKeys = [
      ...manifestKeys,
      `meter:size:${meterId}`,
      `meter:reads:${meterId}`,
    ];

    // 8. loadVariables
    const vars = await registry.loadVariables(allKeys);

    // 9. rate
    const result = engine.rate({ base, vars });

    // 10. Assert dollar output matches Slice 3 SFR golden test exactly.
    //   service_charge $22.31 + tier-walked usage $47.34 = $69.65
    expect(result.totals.subtotal.toFixed(2)).toBe("69.65");

    const serviceLine = result.lines.find(
      (l) => l.kindCode === "service_charge",
    );
    expect(serviceLine?.amount.toFixed(2)).toBe("22.31");

    const consumptionLine = result.lines.find(
      (l) =>
        l.kindCode === "consumption" && l.label.includes("Single Family"),
    );
    expect(consumptionLine?.amount.toFixed(2)).toBe("47.34");
  }, 600_000);
});
