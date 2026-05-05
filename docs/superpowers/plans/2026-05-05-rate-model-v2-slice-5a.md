# Rate Model v2 — Slice 5a: Single-SA Bill Creation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist the v2 rate engine's output as `Bill` and `BillLine` rows so an operator can generate a real bill for a service agreement and view the line-by-line breakdown in the UI.

**Architecture:** Add `Bill` + `BillLine` Prisma models with RLS. New `bill.service.ts` orchestrates `loadBase → manifest → loadVariables → rate → persist + audit + mark MeterReads` in one Prisma transaction. Three HTTP endpoints (create, list-per-SA, get) plus a "Bills" tab on the SA detail page with a create dialog and a line-breakdown modal. Loader-registry construction is extracted from the Slice 4 e2e test into a reusable factory.

**Tech Stack:** Prisma 5 + PostgreSQL 16, Fastify + Zod, Next.js 14 App Router, decimal.js for money, vitest + testcontainers for integration tests.

**Spec:** [`docs/superpowers/specs/2026-05-05-rate-model-v2-slice-5a.md`](../specs/2026-05-05-rate-model-v2-slice-5a.md)

---

## Task 1: Bill + BillLine Prisma models + migration

**Files:**
- Modify: `packages/shared/prisma/schema.prisma` (add `Bill`, `BillLine`, back-relation on `ServiceAgreement`)
- Create: `packages/shared/prisma/migrations/20260505100000_add_bill_billline/migration.sql`

- [ ] **Step 1: Add `Bill` and `BillLine` Prisma models**

Append to `packages/shared/prisma/schema.prisma` (right after `BillingCycle`, around line 583):

```prisma
/// Slice 5a — persisted output of the v2 rate engine for one SA + one period.
/// Immutable financial record. Slice 5c (rebill) will add a self-relation to
/// chain corrections; for now each Bill is a leaf.
model Bill {
  id                   String   @id @default(uuid()) @db.Uuid
  utilityId            String   @map("utility_id") @db.Uuid
  serviceAgreementId   String   @map("service_agreement_id") @db.Uuid
  periodStart          DateTime @map("period_start") @db.Date
  periodEnd            DateTime @map("period_end") @db.Date
  subtotal             Decimal  @map("subtotal") @db.Decimal(14, 4)
  taxes                Decimal  @map("taxes") @db.Decimal(14, 4)
  credits              Decimal  @map("credits") @db.Decimal(14, 4)
  total                Decimal  @map("total") @db.Decimal(14, 4)
  minimumFloorApplied  Boolean  @map("minimum_floor_applied")
  billNumber           String   @map("bill_number") @db.VarChar(50)
  createdAt            DateTime @default(now()) @map("created_at") @db.Timestamptz

  serviceAgreement     ServiceAgreement @relation(fields: [serviceAgreementId], references: [id], onDelete: Restrict)
  lines                BillLine[]

  @@unique([utilityId, billNumber])
  @@index([utilityId, serviceAgreementId, periodStart])
  @@index([utilityId, periodEnd])
  @@map("bill")
}

model BillLine {
  id                  String   @id @default(uuid()) @db.Uuid
  utilityId           String   @map("utility_id") @db.Uuid
  billId              String   @map("bill_id") @db.Uuid
  label               String   @map("label") @db.VarChar(255)
  kindCode            String   @map("kind_code") @db.VarChar(50)
  amount              Decimal  @map("amount") @db.Decimal(14, 4)
  quantity            Decimal? @map("quantity") @db.Decimal(14, 4)
  sourceScheduleId    String   @map("source_schedule_id") @db.Uuid
  sourceComponentId   String   @map("source_component_id") @db.Uuid
  sortOrder           Int      @map("sort_order")

  bill                Bill          @relation(fields: [billId], references: [id], onDelete: Cascade)
  sourceSchedule      RateSchedule  @relation(fields: [sourceScheduleId], references: [id], onDelete: Restrict)
  sourceComponent     RateComponent @relation(fields: [sourceComponentId], references: [id], onDelete: Restrict)

  @@index([billId, sortOrder])
  @@index([utilityId, sourceComponentId])
  @@map("bill_line")
}
```

Add the back-relation to `ServiceAgreement` (around line 389 next to `wqaValues`):

```prisma
  bills            Bill[]
```

Add back-relations to `RateSchedule` and `RateComponent` (so the `BillLine.sourceSchedule` / `sourceComponent` relations compile):

`RateSchedule` (right next to `components RateComponent[]` and `saAssignments`):
```prisma
  billLines         BillLine[]
```

`RateComponent` (right next to `rateSchedule`):
```prisma
  billLines       BillLine[]
```

- [ ] **Step 2: Hand-write the migration SQL**

Create `packages/shared/prisma/migrations/20260505100000_add_bill_billline/migration.sql`:

```sql
-- Slice 5a — Bill + BillLine
-- Persisted output of the v2 rate engine.
CREATE TABLE "bill" (
  "id"                     UUID         NOT NULL DEFAULT gen_random_uuid(),
  "utility_id"             UUID         NOT NULL,
  "service_agreement_id"   UUID         NOT NULL,
  "period_start"           DATE         NOT NULL,
  "period_end"             DATE         NOT NULL,
  "subtotal"               DECIMAL(14,4) NOT NULL,
  "taxes"                  DECIMAL(14,4) NOT NULL,
  "credits"                DECIMAL(14,4) NOT NULL,
  "total"                  DECIMAL(14,4) NOT NULL,
  "minimum_floor_applied"  BOOLEAN      NOT NULL,
  "bill_number"            VARCHAR(50)  NOT NULL,
  "created_at"             TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT "bill_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "bill_service_agreement_fkey"
    FOREIGN KEY ("service_agreement_id") REFERENCES "service_agreement"("id") ON DELETE RESTRICT
);
CREATE UNIQUE INDEX "bill_utility_bill_number_key" ON "bill"("utility_id", "bill_number");
CREATE INDEX "bill_sa_period_idx" ON "bill"("utility_id", "service_agreement_id", "period_start");
CREATE INDEX "bill_period_end_idx" ON "bill"("utility_id", "period_end");

ALTER TABLE "bill" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "bill_tenant_isolation" ON "bill"
  USING (utility_id = current_setting('app.current_utility_id')::uuid);

CREATE TABLE "bill_line" (
  "id"                   UUID          NOT NULL DEFAULT gen_random_uuid(),
  "utility_id"           UUID          NOT NULL,
  "bill_id"              UUID          NOT NULL,
  "label"                VARCHAR(255)  NOT NULL,
  "kind_code"            VARCHAR(50)   NOT NULL,
  "amount"               DECIMAL(14,4) NOT NULL,
  "quantity"             DECIMAL(14,4),
  "source_schedule_id"   UUID          NOT NULL,
  "source_component_id"  UUID          NOT NULL,
  "sort_order"           INTEGER       NOT NULL,
  CONSTRAINT "bill_line_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "bill_line_bill_fkey"
    FOREIGN KEY ("bill_id") REFERENCES "bill"("id") ON DELETE CASCADE,
  CONSTRAINT "bill_line_schedule_fkey"
    FOREIGN KEY ("source_schedule_id") REFERENCES "rate_schedule"("id") ON DELETE RESTRICT,
  CONSTRAINT "bill_line_component_fkey"
    FOREIGN KEY ("source_component_id") REFERENCES "rate_component"("id") ON DELETE RESTRICT
);
CREATE INDEX "bill_line_bill_sort_idx" ON "bill_line"("bill_id", "sort_order");
CREATE INDEX "bill_line_component_idx" ON "bill_line"("utility_id", "source_component_id");

ALTER TABLE "bill_line" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "bill_line_tenant_isolation" ON "bill_line"
  USING (utility_id = current_setting('app.current_utility_id')::uuid);
```

- [ ] **Step 3: Apply migration and regenerate Prisma client**

Stop any running API dev process first (Windows DLL lock).

Run from `packages/shared/`:
```bash
unset DATABASE_URL
DATABASE_URL=postgresql://cis:cis_dev_password@localhost:5432/utility_cis pnpm exec prisma migrate deploy
DATABASE_URL=postgresql://cis:cis_dev_password@localhost:5432/utility_cis pnpm exec prisma generate
```

Expected output: "1 migration applied" + "Generated Prisma Client".

- [ ] **Step 4: Verify the schema compiles**

Run from repo root:
```bash
pnpm --filter @utility-cis/api exec tsc --noEmit
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/prisma/schema.prisma packages/shared/prisma/migrations/
git commit -m "feat(bills): Bill + BillLine entities (slice 5a task 1)"
```

---

## Task 2: BILL_CREATED event constant + bill validators

**Files:**
- Modify: `packages/shared/src/events/index.ts` (add `BILL_CREATED`)
- Create: `packages/shared/src/validators/bill.ts`
- Modify: `packages/shared/src/validators/index.ts` (re-export `bill.ts`)

- [ ] **Step 1: Add the event type**

Edit `packages/shared/src/events/index.ts`. Add to the `EVENT_TYPES` object after `BILLING_CYCLE_UPDATED`:

```ts
  BILL_CREATED: "bill.created",
```

- [ ] **Step 2: Write the validator file**

Create `packages/shared/src/validators/bill.ts`:

```ts
import { z } from "zod";

/**
 * Slice 5a — bill creation request.
 *
 * The route extracts saId from the URL params; the body carries only
 * the period range. Both endpoints use ISO date strings (YYYY-MM-DD)
 * — the bill is keyed on a calendar day range, not a timestamp.
 */
export const createBillSchema = z
  .object({
    periodStart: z.string().date(),
    periodEnd: z.string().date(),
  })
  .strict();

export type CreateBillInput = z.infer<typeof createBillSchema>;
```

- [ ] **Step 3: Re-export from the validators index**

Find the existing pattern in `packages/shared/src/validators/index.ts` and add a line:

```ts
export * from "./bill";
```

(No `.js` extension — matches the `09a141d` fix for shared validators that Next.js's bundler resolution can't follow `.js` to `.ts`.)

- [ ] **Step 4: Typecheck**

Run from repo root:
```bash
pnpm --filter @utility-cis/shared exec tsc --noEmit
pnpm --filter @utility-cis/api exec tsc --noEmit
pnpm --filter @utility-cis/web exec tsc --noEmit
```

Expected: no errors in any package.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/events/index.ts packages/shared/src/validators/bill.ts packages/shared/src/validators/index.ts
git commit -m "feat(bills): BILL_CREATED event + createBillSchema validator (slice 5a task 2)"
```

---

## Task 3: Registry factory — extract loader registration

**Files:**
- Create: `packages/api/src/lib/rate-engine-registry.ts`
- Create: `packages/api/src/__tests__/integration/rate-engine-registry.integration.test.ts`

- [ ] **Step 1: Write the failing test first**

Create `packages/api/src/__tests__/integration/rate-engine-registry.integration.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@utility-cis/shared/src/generated/prisma";
import { bootPostgres, type BootedContainer } from "./_effective-dating-fixtures.js";
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
  prisma = new PrismaClient({ datasources: { db: { url: booted.dbUrl } } });
}, 600_000);

afterAll(async () => {
  await prisma?.$disconnect().catch(() => {});
  await booted?.container.stop().catch(() => {});
});

describe("buildRegistry", () => {
  it("registers all 8 loaders and validates every key the engine produces for a Bozeman SFR SA", async () => {
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
  }, 600_000);
});
```

- [ ] **Step 2: Run the test to verify it fails (no buildRegistry yet)**

Run from `packages/api/`:
```bash
pnpm exec vitest run --config vitest.integration.config.ts rate-engine-registry
```

Expected: FAIL with "Cannot find module '../../lib/rate-engine-registry.js'".

- [ ] **Step 3: Implement the factory**

Create `packages/api/src/lib/rate-engine-registry.ts`:

```ts
import type { PrismaClient } from "@utility-cis/shared/src/generated/prisma";
import { VariableRegistry } from "./rate-engine-loaders/index.js";
import { AccountLoader } from "./rate-engine-loaders/loaders/account-loader.js";
import { MeterLoader } from "./rate-engine-loaders/loaders/meter-loader.js";
import { WqaLoader } from "./rate-engine-loaders/loaders/wqa-loader.js";
import { TenantLoader } from "./rate-engine-loaders/loaders/tenant-loader.js";
import { PremiseLoader } from "./rate-engine-loaders/loaders/premise-loader.js";
import { IndexLoader } from "./rate-engine-loaders/loaders/index-loader.js";
import { LinkedCommodityLoader } from "./rate-engine-loaders/loaders/linked-commodity-loader.js";
import { ItemsLoader } from "./rate-engine-loaders/loaders/items-loader.js";

/**
 * Slice 5a task 3 — single source of truth for assembling a `VariableRegistry`
 * stocked with all 8 v2 loaders. The Slice 4 e2e test wired this inline; the
 * bill service needs the same wiring per-bill, so we factor it out here.
 *
 * Each loader is constructed against a (prisma, utilityId, …) tuple. Some
 * loaders are SA-scoped (Account, Wqa, Items, LinkedCommodity), some are
 * meter/period-scoped (Meter), some are premise-scoped (Premise), some are
 * tenant-scoped only (Tenant, Index).
 */
export interface RegistryContext {
  utilityId: string;
  saId: string;
  accountId: string;
  premiseId: string;
  period: { startDate: Date; endDate: Date };
}

export function buildRegistry(prisma: PrismaClient, ctx: RegistryContext): VariableRegistry {
  const r = new VariableRegistry();
  r.register(new AccountLoader(prisma, ctx.utilityId, ctx.saId));
  r.register(new MeterLoader(prisma, ctx.utilityId, ctx.period));
  r.register(new WqaLoader(prisma, ctx.utilityId, ctx.saId));
  r.register(new TenantLoader(prisma, ctx.utilityId));
  r.register(new PremiseLoader(prisma, ctx.utilityId, ctx.premiseId));
  r.register(new IndexLoader(prisma, ctx.utilityId));
  r.register(
    new LinkedCommodityLoader(prisma, ctx.utilityId, ctx.period, {
      id: ctx.saId,
      accountId: ctx.accountId,
      premiseId: ctx.premiseId,
    }),
  );
  r.register(new ItemsLoader(prisma, ctx.utilityId, ctx.saId));
  return r;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run from `packages/api/`:
```bash
pnpm exec vitest run --config vitest.integration.config.ts rate-engine-registry
```

Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/lib/rate-engine-registry.ts packages/api/src/__tests__/integration/rate-engine-registry.integration.test.ts
git commit -m "feat(bills): buildRegistry factory for v2 loader stack (slice 5a task 3)"
```

---

## Task 4: bill.service.ts — orchestration + persist

**Files:**
- Create: `packages/api/src/services/bill.service.ts`

This task has no dedicated unit test — its correctness is verified end-to-end by Task 8's integration test. We deliberately *don't* mock the engine pipeline because (a) the engine is already covered by Slice 3/4 tests, and (b) a stub-based test of the orchestration adds little signal beyond shape and would diverge from real behavior.

- [ ] **Step 1: Write the service file**

Create `packages/api/src/services/bill.service.ts`:

```ts
import { Prisma } from "@utility-cis/shared/src/generated/prisma";
import { prisma } from "../lib/prisma.js";
import { auditCreate } from "../lib/audit-wrap.js";
import { EVENT_TYPES } from "@utility-cis/shared";
import * as engine from "../lib/rate-engine/index.js";
import { loadBase } from "../lib/rate-engine-loaders/index.js";
import { buildRegistry } from "../lib/rate-engine-registry.js";
import type { Decimal as JsDecimal } from "../lib/rate-engine/decimal.js";

export interface CreateBillInput {
  periodStart: Date;
  periodEnd: Date;
}

export interface BillLineRow {
  id: string;
  label: string;
  kindCode: string;
  amount: string;       // serialized decimal
  quantity: string | null;
  sourceScheduleId: string;
  sourceComponentId: string;
  sortOrder: number;
}

export interface BillSummary {
  id: string;
  utilityId: string;
  serviceAgreementId: string;
  periodStart: Date;
  periodEnd: Date;
  subtotal: string;
  taxes: string;
  credits: string;
  total: string;
  minimumFloorApplied: boolean;
  billNumber: string;
  createdAt: Date;
}

export interface BillWithLines extends BillSummary {
  lines: BillLineRow[];
}

function decToFixed(d: JsDecimal | null | undefined): string | null {
  if (d == null) return null;
  return d.toFixed(4);
}

function decToFixedRequired(d: JsDecimal): string {
  return d.toFixed(4);
}

function billNumberPrefix(d: Date): string {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  return `BILL-${yyyy}${mm}-`;
}

/**
 * Allocate a per-tenant sequential bill number. The unique index on
 * (utility_id, bill_number) makes a tight race produce a 23505 that the
 * route layer can map to a 409 — but the human-in-the-loop create flow
 * makes a race almost impossible.
 */
async function nextBillNumber(
  tx: Prisma.TransactionClient,
  utilityId: string,
  now: Date,
): Promise<string> {
  const prefix = billNumberPrefix(now);
  const count = await tx.bill.count({
    where: { utilityId, billNumber: { startsWith: prefix } },
  });
  return `${prefix}${count + 1}`;
}

export async function createBillForServiceAgreement(
  utilityId: string,
  actorId: string,
  actorName: string,
  saId: string,
  input: CreateBillInput,
): Promise<BillWithLines> {
  if (input.periodEnd < input.periodStart) {
    throw Object.assign(new Error("periodEnd must be on/after periodStart"), {
      statusCode: 400,
      code: "INVALID_PERIOD",
    });
  }

  return auditCreate(
    { utilityId, actorId, actorName, entityType: "Bill" },
    EVENT_TYPES.BILL_CREATED,
    async (tx) => {
      // 1. loadBase — assignments + components + snapshots
      const base = await loadBase(tx as unknown as typeof prisma, saId, input, utilityId);

      if (base.assignments.length === 0) {
        throw Object.assign(
          new Error("Service agreement has no rate schedule assignments overlapping this period"),
          { statusCode: 400, code: "NO_ACTIVE_ASSIGNMENTS" },
        );
      }

      // 2. publish gate — every assigned schedule must be Published
      const unpublished = await tx.rateSchedule.findMany({
        where: {
          id: { in: base.assignments.map((a) => a.rateScheduleId) },
          publishedAt: null,
        },
        select: { id: true, code: true, version: true },
      });
      if (unpublished.length > 0) {
        const detail = unpublished.map((s) => `${s.code} v${s.version}`).join(", ");
        throw Object.assign(
          new Error(
            `Cannot bill against unpublished rate schedule(s): ${detail}. Publish them first.`,
          ),
          { statusCode: 409, code: "SCHEDULE_NOT_PUBLISHED" },
        );
      }

      // 3. manifest — collect schedule-driven keys
      const manifestKeys = engine.manifest(base);

      // 4. Pre-load meter-keyed vars (engine infers meter ids from
      //    meter:reads:* keys at rate time; we add them up-front so the
      //    engine doesn't have to call back into the registry).
      const spMeters = await tx.serviceAgreement.findUniqueOrThrow({
        where: { id: saId, utilityId },
        select: {
          servicePoints: {
            where: { endDate: null },
            include: { meters: { where: { removedDate: null }, select: { meterId: true } } },
          },
        },
      });
      const meterIds = spMeters.servicePoints.flatMap((sp) => sp.meters.map((m) => m.meterId));
      const meterKeys = meterIds.flatMap((id) => [`meter:reads:${id}`, `meter:size:${id}`]);

      // 5. registry + loadVariables
      const registry = buildRegistry(tx as unknown as typeof prisma, {
        utilityId,
        saId,
        accountId: base.sa.accountId,
        premiseId: base.sa.premiseId,
        period: input,
      });
      const vars = await registry.loadVariables([...manifestKeys, ...meterKeys]);

      // 6. rate
      const result = engine.rate({ base, vars });

      // 7. allocate bill number + persist Bill row
      const now = new Date();
      const billNumber = await nextBillNumber(tx, utilityId, now);
      const bill = await tx.bill.create({
        data: {
          utilityId,
          serviceAgreementId: saId,
          periodStart: input.periodStart,
          periodEnd: input.periodEnd,
          subtotal: new Prisma.Decimal(decToFixedRequired(result.totals.subtotal)),
          taxes: new Prisma.Decimal(decToFixedRequired(result.totals.taxes)),
          credits: new Prisma.Decimal(decToFixedRequired(result.totals.credits)),
          total: new Prisma.Decimal(decToFixedRequired(result.totals.total)),
          minimumFloorApplied: result.totals.minimumFloorApplied,
          billNumber,
        },
      });

      // 8. persist BillLine rows preserving engine order
      const lineRows = result.lines.map((line, idx) => ({
        utilityId,
        billId: bill.id,
        label: line.label,
        kindCode: line.kindCode,
        amount: new Prisma.Decimal(decToFixedRequired(line.amount)),
        quantity:
          line.quantity != null
            ? new Prisma.Decimal(decToFixedRequired(line.quantity))
            : null,
        sourceScheduleId: line.sourceScheduleId,
        sourceComponentId: line.sourceComponentId,
        sortOrder: (idx + 1) * 100,
      }));
      if (lineRows.length > 0) {
        await tx.billLine.createMany({ data: lineRows });
      }

      // 9. mark MeterReads consumed by the engine. The engine consumes
      //    every read for the meter that overlaps the period via
      //    MeterLoader, so we mark all reads in the period that aren't
      //    already billedAt.
      if (meterIds.length > 0) {
        await tx.meterRead.updateMany({
          where: {
            utilityId,
            meterId: { in: meterIds },
            readDate: { gte: input.periodStart, lte: input.periodEnd },
            billedAt: null,
          },
          data: { billedAt: now },
        });
      }

      return assembleBillWithLines(tx, utilityId, bill.id);
    },
  );
}

async function assembleBillWithLines(
  tx: Prisma.TransactionClient,
  utilityId: string,
  id: string,
): Promise<BillWithLines> {
  const bill = await tx.bill.findUniqueOrThrow({
    where: { id, utilityId },
    include: { lines: { orderBy: { sortOrder: "asc" } } },
  });
  return {
    id: bill.id,
    utilityId: bill.utilityId,
    serviceAgreementId: bill.serviceAgreementId,
    periodStart: bill.periodStart,
    periodEnd: bill.periodEnd,
    subtotal: bill.subtotal.toFixed(4),
    taxes: bill.taxes.toFixed(4),
    credits: bill.credits.toFixed(4),
    total: bill.total.toFixed(4),
    minimumFloorApplied: bill.minimumFloorApplied,
    billNumber: bill.billNumber,
    createdAt: bill.createdAt,
    lines: bill.lines.map((l) => ({
      id: l.id,
      label: l.label,
      kindCode: l.kindCode,
      amount: l.amount.toFixed(4),
      quantity: l.quantity ? l.quantity.toFixed(4) : null,
      sourceScheduleId: l.sourceScheduleId,
      sourceComponentId: l.sourceComponentId,
      sortOrder: l.sortOrder,
    })),
  };
}

export async function listBillsForServiceAgreement(
  utilityId: string,
  saId: string,
): Promise<BillSummary[]> {
  const bills = await prisma.bill.findMany({
    where: { utilityId, serviceAgreementId: saId },
    orderBy: { periodStart: "desc" },
  });
  return bills.map((b) => ({
    id: b.id,
    utilityId: b.utilityId,
    serviceAgreementId: b.serviceAgreementId,
    periodStart: b.periodStart,
    periodEnd: b.periodEnd,
    subtotal: b.subtotal.toFixed(4),
    taxes: b.taxes.toFixed(4),
    credits: b.credits.toFixed(4),
    total: b.total.toFixed(4),
    minimumFloorApplied: b.minimumFloorApplied,
    billNumber: b.billNumber,
    createdAt: b.createdAt,
  }));
}

export async function getBill(utilityId: string, id: string): Promise<BillWithLines> {
  return assembleBillWithLines(prisma as unknown as Prisma.TransactionClient, utilityId, id);
}
```

Note on the `tx as unknown as typeof prisma` cast: `loadBase` and the loaders accept a `PrismaClient`, but inside an audit transaction we hold a `Prisma.TransactionClient`. The two share the model accessors we use; the cast is the established pattern in `audit-wrap.ts`. This is the one place we accept it — don't propagate the cast pattern elsewhere.

- [ ] **Step 2: Typecheck**

Run from repo root:
```bash
pnpm --filter @utility-cis/api exec tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add packages/api/src/services/bill.service.ts
git commit -m "feat(bills): bill.service orchestrates engine + persists Bill+lines (slice 5a task 4)"
```

---

## Task 5: HTTP routes — POST + GET list + GET detail

**Files:**
- Create: `packages/api/src/routes/service-agreement-bills.ts`
- Create: `packages/api/src/routes/bills.ts`
- Modify: `packages/api/src/app.ts` (register the two route plugins)

- [ ] **Step 1: Write the SA-scoped routes**

Create `packages/api/src/routes/service-agreement-bills.ts`:

```ts
import type { FastifyInstance } from "fastify";
import { idParamSchema } from "../lib/route-schemas.js";
import { createBillSchema } from "@utility-cis/shared";
import {
  createBillForServiceAgreement,
  listBillsForServiceAgreement,
} from "../services/bill.service.js";

export async function serviceAgreementBillRoutes(app: FastifyInstance) {
  app.post(
    "/api/v1/service-agreements/:id/bills",
    { config: { module: "agreements", permission: "EDIT" } },
    async (request, reply) => {
      const { utilityId, id: actorId, name: actorName } = request.user;
      const { id: saId } = idParamSchema.parse(request.params);
      const body = createBillSchema.parse(request.body);
      const bill = await createBillForServiceAgreement(
        utilityId,
        actorId,
        actorName,
        saId,
        {
          periodStart: new Date(body.periodStart),
          periodEnd: new Date(body.periodEnd),
        },
      );
      return reply.status(201).send(bill);
    },
  );

  app.get(
    "/api/v1/service-agreements/:id/bills",
    { config: { module: "agreements", permission: "VIEW" } },
    async (request, reply) => {
      const { utilityId } = request.user;
      const { id: saId } = idParamSchema.parse(request.params);
      const bills = await listBillsForServiceAgreement(utilityId, saId);
      return reply.send(bills);
    },
  );
}
```

- [ ] **Step 2: Write the bill-id route**

Create `packages/api/src/routes/bills.ts`:

```ts
import type { FastifyInstance } from "fastify";
import { idParamSchema } from "../lib/route-schemas.js";
import { getBill } from "../services/bill.service.js";

export async function billRoutes(app: FastifyInstance) {
  app.get(
    "/api/v1/bills/:id",
    { config: { module: "agreements", permission: "VIEW" } },
    async (request, reply) => {
      const { utilityId } = request.user;
      const { id } = idParamSchema.parse(request.params);
      const bill = await getBill(utilityId, id);
      return reply.send(bill);
    },
  );
}
```

- [ ] **Step 3: Register the route plugins**

Find the route registrations in `packages/api/src/app.ts` (search for `app.register(rateScheduleRoutes)` or similar) and add right after, in the same style:

```ts
import { serviceAgreementBillRoutes } from "./routes/service-agreement-bills.js";
import { billRoutes } from "./routes/bills.js";
// ...
app.register(serviceAgreementBillRoutes);
app.register(billRoutes);
```

- [ ] **Step 4: Typecheck**

Run from repo root:
```bash
pnpm --filter @utility-cis/api exec tsc --noEmit
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/routes/service-agreement-bills.ts packages/api/src/routes/bills.ts packages/api/src/app.ts
git commit -m "feat(bills): POST/GET bill HTTP routes (slice 5a task 5)"
```

---

## Task 6: Bills tab — UI list + create dialog + detail modal

**Files:**
- Create: `packages/web/components/bills/bills-tab.tsx`
- Create: `packages/web/components/bills/bill-detail-dialog.tsx`
- Modify: `packages/web/app/service-agreements/[id]/page.tsx` (add `"bills"` tab key + render)

- [ ] **Step 1: Write the detail dialog**

Create `packages/web/components/bills/bill-detail-dialog.tsx`:

```tsx
"use client";

import { useEffect, useState } from "react";
import { apiClient } from "@/lib/api-client";

interface BillLine {
  id: string;
  label: string;
  kindCode: string;
  amount: string;
  quantity: string | null;
  sourceScheduleId: string;
  sourceComponentId: string;
  sortOrder: number;
}
interface BillWithLines {
  id: string;
  billNumber: string;
  periodStart: string;
  periodEnd: string;
  subtotal: string;
  taxes: string;
  credits: string;
  total: string;
  minimumFloorApplied: boolean;
  lines: BillLine[];
}

const fmt = (s: string) => `$${parseFloat(s).toFixed(2)}`;

export function BillDetailDialog({ billId, onClose }: { billId: string; onClose: () => void }) {
  const [bill, setBill] = useState<BillWithLines | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    apiClient
      .get<BillWithLines>(`/api/v1/bills/${billId}`)
      .then(setBill)
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [billId]);

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.6)",
        zIndex: 100,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "var(--bg-card)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius)",
          padding: "24px",
          width: "640px",
          maxHeight: "80vh",
          overflowY: "auto",
        }}
      >
        {loading || !bill ? (
          <div style={{ color: "var(--text-muted)" }}>Loading...</div>
        ) : (
          <>
            <h3 style={{ margin: "0 0 8px", fontSize: "16px", color: "var(--text-primary)" }}>
              {bill.billNumber}
            </h3>
            <div style={{ fontSize: "12px", color: "var(--text-muted)", marginBottom: "16px" }}>
              {bill.periodStart.slice(0, 10)} → {bill.periodEnd.slice(0, 10)}
            </div>

            <table style={{ width: "100%", borderCollapse: "collapse", marginBottom: "16px" }}>
              <thead>
                <tr style={{ background: "var(--bg-elevated)" }}>
                  <th style={th}>Line</th>
                  <th style={th}>Kind</th>
                  <th style={{ ...th, textAlign: "right" }}>Qty</th>
                  <th style={{ ...th, textAlign: "right" }}>Amount</th>
                </tr>
              </thead>
              <tbody>
                {bill.lines.map((l) => (
                  <tr key={l.id}>
                    <td style={td}>{l.label}</td>
                    <td style={{ ...td, color: "var(--text-muted)", fontSize: "11px" }}>
                      {l.kindCode}
                    </td>
                    <td style={{ ...td, textAlign: "right", fontFamily: "monospace" }}>
                      {l.quantity ? parseFloat(l.quantity).toFixed(2) : "—"}
                    </td>
                    <td style={{ ...td, textAlign: "right", fontFamily: "monospace" }}>
                      {fmt(l.amount)}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={3} style={{ ...td, textAlign: "right", fontWeight: 600 }}>
                    Subtotal
                  </td>
                  <td style={{ ...td, textAlign: "right", fontFamily: "monospace", fontWeight: 600 }}>
                    {fmt(bill.subtotal)}
                  </td>
                </tr>
                {parseFloat(bill.taxes) !== 0 && (
                  <tr>
                    <td colSpan={3} style={{ ...td, textAlign: "right" }}>Taxes</td>
                    <td style={{ ...td, textAlign: "right", fontFamily: "monospace" }}>
                      {fmt(bill.taxes)}
                    </td>
                  </tr>
                )}
                {parseFloat(bill.credits) !== 0 && (
                  <tr>
                    <td colSpan={3} style={{ ...td, textAlign: "right" }}>Credits</td>
                    <td style={{ ...td, textAlign: "right", fontFamily: "monospace" }}>
                      {fmt(bill.credits)}
                    </td>
                  </tr>
                )}
                <tr>
                  <td colSpan={3} style={{ ...td, textAlign: "right", fontWeight: 700 }}>Total</td>
                  <td style={{ ...td, textAlign: "right", fontFamily: "monospace", fontWeight: 700 }}>
                    {fmt(bill.total)}
                  </td>
                </tr>
              </tfoot>
            </table>

            <div style={{ display: "flex", justifyContent: "flex-end" }}>
              <button onClick={onClose} style={btn}>Close</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

const th: React.CSSProperties = {
  padding: "8px 12px",
  fontSize: "11px",
  textAlign: "left",
  textTransform: "uppercase",
  letterSpacing: "0.05em",
  color: "var(--text-muted)",
  borderBottom: "1px solid var(--border)",
};
const td: React.CSSProperties = {
  padding: "8px 12px",
  fontSize: "13px",
  color: "var(--text-primary)",
  borderBottom: "1px solid var(--border-subtle)",
};
const btn: React.CSSProperties = {
  padding: "7px 16px",
  borderRadius: "var(--radius)",
  border: "1px solid var(--border)",
  background: "transparent",
  color: "var(--text-secondary)",
  fontSize: "12px",
  cursor: "pointer",
  fontFamily: "inherit",
};
```

- [ ] **Step 2: Write the bills tab**

Create `packages/web/components/bills/bills-tab.tsx`:

```tsx
"use client";

import { useEffect, useState } from "react";
import { DatePicker } from "@/components/ui/date-picker";
import { apiClient } from "@/lib/api-client";
import { useToast } from "@/components/ui/toast";
import { BillDetailDialog } from "./bill-detail-dialog";

interface BillSummary {
  id: string;
  billNumber: string;
  periodStart: string;
  periodEnd: string;
  total: string;
  createdAt: string;
}

const fmt = (s: string) => `$${parseFloat(s).toFixed(2)}`;

export function BillsTab({ saId, canEdit }: { saId: string; canEdit: boolean }) {
  const { toast } = useToast();
  const [bills, setBills] = useState<BillSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshKey, setRefreshKey] = useState(0);
  const [showDialog, setShowDialog] = useState(false);
  const [periodStart, setPeriodStart] = useState("");
  const [periodEnd, setPeriodEnd] = useState("");
  const [creating, setCreating] = useState(false);
  const [openBillId, setOpenBillId] = useState<string | null>(null);

  useEffect(() => {
    apiClient
      .get<BillSummary[]>(`/api/v1/service-agreements/${saId}/bills`)
      .then(setBills)
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [saId, refreshKey]);

  const handleCreate = async () => {
    if (!periodStart || !periodEnd) return;
    setCreating(true);
    try {
      await apiClient.post(`/api/v1/service-agreements/${saId}/bills`, {
        periodStart,
        periodEnd,
      });
      toast("Bill generated", "success");
      setShowDialog(false);
      setPeriodStart("");
      setPeriodEnd("");
      setRefreshKey((k) => k + 1);
    } catch (err) {
      const msg =
        err instanceof Error ? err.message.replace(/^API error \d+:\s*/, "") : "Bill generation failed";
      toast(msg, "error");
    } finally {
      setCreating(false);
    }
  };

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: "12px" }}>
        {canEdit && (
          <button
            onClick={() => setShowDialog(true)}
            style={{
              padding: "7px 16px",
              borderRadius: "var(--radius)",
              border: "none",
              background: "var(--accent-primary)",
              color: "#fff",
              fontSize: "12px",
              fontWeight: 500,
              cursor: "pointer",
              fontFamily: "inherit",
            }}
          >
            Generate Bill
          </button>
        )}
      </div>

      {loading ? (
        <div style={{ color: "var(--text-muted)", padding: "24px 0" }}>Loading...</div>
      ) : bills.length === 0 ? (
        <div
          style={{
            color: "var(--text-muted)",
            padding: "32px 0",
            textAlign: "center",
            fontSize: "13px",
          }}
        >
          No bills yet. Click <b>Generate Bill</b> above to create one for a period.
        </div>
      ) : (
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ background: "var(--bg-elevated)" }}>
              <th style={th}>Bill #</th>
              <th style={th}>Period</th>
              <th style={{ ...th, textAlign: "right" }}>Total</th>
              <th style={th}>Created</th>
              <th style={th}></th>
            </tr>
          </thead>
          <tbody>
            {bills.map((b) => (
              <tr key={b.id}>
                <td style={{ ...td, fontFamily: "monospace", fontSize: "12px" }}>{b.billNumber}</td>
                <td style={td}>
                  {b.periodStart.slice(0, 10)} → {b.periodEnd.slice(0, 10)}
                </td>
                <td style={{ ...td, textAlign: "right", fontFamily: "monospace", fontWeight: 600 }}>
                  {fmt(b.total)}
                </td>
                <td style={{ ...td, color: "var(--text-muted)", fontSize: "12px" }}>
                  {new Date(b.createdAt).toLocaleString()}
                </td>
                <td style={td}>
                  <button
                    onClick={() => setOpenBillId(b.id)}
                    style={{
                      background: "none",
                      border: "none",
                      color: "var(--accent-primary)",
                      fontSize: "12px",
                      cursor: "pointer",
                      fontFamily: "inherit",
                    }}
                  >
                    View →
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {showDialog && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.6)",
            zIndex: 100,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <div
            style={{
              background: "var(--bg-card)",
              border: "1px solid var(--border)",
              borderRadius: "var(--radius)",
              padding: "24px",
              width: "420px",
            }}
          >
            <h3 style={{ margin: "0 0 16px", fontSize: "16px", color: "var(--text-primary)" }}>
              Generate Bill
            </h3>
            <div style={{ marginBottom: "12px" }}>
              <label
                style={{ fontSize: "12px", color: "var(--text-muted)", display: "block", marginBottom: "6px" }}
              >
                Period Start
              </label>
              <DatePicker value={periodStart} onChange={setPeriodStart} />
            </div>
            <div style={{ marginBottom: "16px" }}>
              <label
                style={{ fontSize: "12px", color: "var(--text-muted)", display: "block", marginBottom: "6px" }}
              >
                Period End
              </label>
              <DatePicker value={periodEnd} onChange={setPeriodEnd} />
            </div>
            <div style={{ display: "flex", gap: "8px", justifyContent: "flex-end" }}>
              <button
                onClick={() => setShowDialog(false)}
                style={{
                  padding: "7px 16px",
                  borderRadius: "var(--radius)",
                  border: "1px solid var(--border)",
                  background: "transparent",
                  color: "var(--text-secondary)",
                  fontSize: "12px",
                  cursor: "pointer",
                  fontFamily: "inherit",
                }}
              >
                Cancel
              </button>
              <button
                onClick={handleCreate}
                disabled={creating || !periodStart || !periodEnd}
                style={{
                  padding: "7px 16px",
                  borderRadius: "var(--radius)",
                  border: "none",
                  background: "var(--accent-primary)",
                  color: "#fff",
                  fontSize: "12px",
                  fontWeight: 500,
                  cursor: creating || !periodStart || !periodEnd ? "not-allowed" : "pointer",
                  opacity: creating || !periodStart || !periodEnd ? 0.6 : 1,
                  fontFamily: "inherit",
                }}
              >
                {creating ? "Generating..." : "Generate"}
              </button>
            </div>
          </div>
        </div>
      )}

      {openBillId && (
        <BillDetailDialog billId={openBillId} onClose={() => setOpenBillId(null)} />
      )}
    </div>
  );
}

const th: React.CSSProperties = {
  padding: "10px 12px",
  fontSize: "11px",
  textAlign: "left",
  textTransform: "uppercase",
  letterSpacing: "0.05em",
  color: "var(--text-muted)",
  borderBottom: "1px solid var(--border)",
};
const td: React.CSSProperties = {
  padding: "10px 12px",
  fontSize: "13px",
  color: "var(--text-primary)",
  borderBottom: "1px solid var(--border-subtle)",
};
```

- [ ] **Step 3: Wire the new tab into the SA detail page**

In `packages/web/app/service-agreements/[id]/page.tsx`:

1. Add import near the other component imports:

```tsx
import { BillsTab } from "@/components/bills/bills-tab";
```

2. Find the `tabs={[...]}` array (around line 406) and add the new tab key right after `meters`:

```tsx
{ key: "bills", label: "Bills" },
```

3. Find the `{activeTab === "billing" && ...}` render block and add an adjacent block (above or below it):

```tsx
{activeTab === "bills" && <BillsTab saId={id} canEdit={canEdit} />}
```

If `canEdit` isn't already in scope on this page, derive it the same way other actions do (`const { canEdit } = usePermission("agreements")`).

- [ ] **Step 4: Typecheck the web package**

Run from repo root:
```bash
pnpm --filter @utility-cis/web exec tsc --noEmit
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add packages/web/components/bills/ packages/web/app/service-agreements/[id]/page.tsx
git commit -m "feat(bills): Bills tab on SA detail with create + detail dialog (slice 5a task 6)"
```

---

## Task 7: End-to-end integration test — Bozeman SFR golden case

**Files:**
- Create: `packages/api/src/__tests__/integration/bill-creation.integration.test.ts`

- [ ] **Step 1: Write the integration test**

Create `packages/api/src/__tests__/integration/bill-creation.integration.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { bootPostgres } from "./_effective-dating-fixtures.js";

/**
 * Slice 5a task 7 — POST /api/v1/service-agreements/:id/bills produces a
 * persisted Bill with line items matching the Slice 4 golden test:
 * Bozeman SFR water customer, May 2026, 12 HCF read → $69.65 subtotal.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SHARED_DIR = path.resolve(__dirname, "../../../../shared");
const REPO_ROOT = path.resolve(__dirname, "../../../../..");

let pgContainer: StartedPostgreSqlContainer;
let prismaImports: typeof import("../../lib/prisma.js");
let appImports: typeof import("../../app.js");
let app: FastifyInstance;

let utilityId: string;
let saId: string;

const ACTOR_ID = "00000000-0000-4000-8000-aaaa00000001";

function makeToken(uid: string) {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      sub: ACTOR_ID,
      utility_id: uid,
      email: "tester@example.com",
      name: "Tester",
      role: "admin",
    }),
  ).toString("base64url");
  return `${header}.${payload}.fake-signature`;
}
const headers = () => ({ authorization: `Bearer ${makeToken(utilityId)}` });

beforeAll(async () => {
  const booted = await bootPostgres();
  pgContainer = booted.container;

  const TSX_BIN =
    process.platform === "win32"
      ? path.join(REPO_ROOT, "node_modules", ".pnpm", "node_modules", ".bin", "tsx.cmd")
      : path.join(REPO_ROOT, "node_modules", ".pnpm", "node_modules", ".bin", "tsx");
  execSync(`"${TSX_BIN}" prisma/seed.ts`, {
    cwd: SHARED_DIR,
    env: { ...process.env, DATABASE_URL: booted.dbUrl },
    stdio: "pipe",
  });

  prismaImports = await import("../../lib/prisma.js");
  appImports = await import("../../app.js");
  app = await appImports.buildApp();
  await app.ready();

  // Pick the Bozeman SFR water SA seeded by the v2 seed.
  const { prisma } = prismaImports;
  const sched = await prisma.rateSchedule.findFirstOrThrow({
    where: { code: "BZN-WATER" },
  });
  const assignment = await prisma.sAScheduleAssignment.findFirstOrThrow({
    where: {
      rateScheduleId: sched.id,
      roleCode: "primary",
      serviceAgreement: { rateServiceClass: { code: "single_family" } },
    },
    include: {
      serviceAgreement: {
        include: {
          servicePoints: {
            where: { endDate: null },
            include: { meters: { include: { meter: true } } },
            take: 1,
          },
        },
      },
    },
  });
  saId = assignment.serviceAgreementId;
  utilityId = assignment.serviceAgreement.utilityId;

  // Seed meter size + a single 12 HCF read for May 2026.
  const meterId = assignment.serviceAgreement.servicePoints[0]!.meters[0]!.meterId;
  await prisma.meter.update({
    where: { id: meterId },
    data: { customFields: { size: '5/8"' } as object },
  });
  const meter = await prisma.meter.findUniqueOrThrow({
    where: { id: meterId },
    select: { uomId: true },
  });
  await prisma.meterRead.create({
    data: {
      utilityId,
      meterId,
      serviceAgreementId: saId,
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
}, 600_000);

afterAll(async () => {
  await app?.close().catch(() => {});
  await prismaImports?.prisma.$disconnect().catch(() => {});
  await pgContainer?.stop().catch(() => {});
});

beforeEach(async () => {
  const { prisma } = prismaImports;
  // Wipe any bills from a prior test in the same suite — keep meters / SAs.
  await prisma.$executeRawUnsafe("DELETE FROM bill_line");
  await prisma.$executeRawUnsafe("DELETE FROM bill");
  await prisma.$executeRawUnsafe(
    "UPDATE meter_read SET billed_at = NULL WHERE service_agreement_id = $1",
    saId,
  );
});

describe("POST /api/v1/service-agreements/:id/bills — Bozeman SFR golden", () => {
  it("creates a Bill with $69.65 subtotal and persists lines", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/service-agreements/${saId}/bills`,
      headers: headers(),
      payload: { periodStart: "2026-05-01", periodEnd: "2026-05-31" },
    });

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(parseFloat(body.subtotal).toFixed(2)).toBe("69.65");
    expect(body.lines.length).toBeGreaterThanOrEqual(2);

    const serviceLine = body.lines.find((l: any) => l.kindCode === "service_charge");
    expect(parseFloat(serviceLine.amount).toFixed(2)).toBe("22.31");

    const consumption = body.lines.find(
      (l: any) => l.kindCode === "consumption" && l.label.includes("Single Family"),
    );
    expect(parseFloat(consumption.amount).toFixed(2)).toBe("47.34");

    // DB row exists
    const { prisma } = prismaImports;
    const dbBill = await prisma.bill.findUniqueOrThrow({
      where: { id: body.id, utilityId },
      include: { lines: true },
    });
    expect(dbBill.lines.length).toBe(body.lines.length);
    expect(dbBill.subtotal.toFixed(2)).toBe("69.65");

    // MeterRead consumed
    const consumed = await prisma.meterRead.findFirst({
      where: { serviceAgreementId: saId, billedAt: { not: null } },
    });
    expect(consumed).not.toBeNull();
  }, 600_000);

  it("GET /service-agreements/:id/bills returns the new bill", async () => {
    const create = await app.inject({
      method: "POST",
      url: `/api/v1/service-agreements/${saId}/bills`,
      headers: headers(),
      payload: { periodStart: "2026-05-01", periodEnd: "2026-05-31" },
    });
    expect(create.statusCode).toBe(201);

    const list = await app.inject({
      method: "GET",
      url: `/api/v1/service-agreements/${saId}/bills`,
      headers: headers(),
    });
    expect(list.statusCode).toBe(200);
    const arr = JSON.parse(list.body);
    expect(Array.isArray(arr)).toBe(true);
    expect(arr.length).toBe(1);
  }, 600_000);

  it("GET /bills/:id returns full bill with lines", async () => {
    const create = await app.inject({
      method: "POST",
      url: `/api/v1/service-agreements/${saId}/bills`,
      headers: headers(),
      payload: { periodStart: "2026-05-01", periodEnd: "2026-05-31" },
    });
    const created = JSON.parse(create.body);

    const get = await app.inject({
      method: "GET",
      url: `/api/v1/bills/${created.id}`,
      headers: headers(),
    });
    expect(get.statusCode).toBe(200);
    const fetched = JSON.parse(get.body);
    expect(fetched.id).toBe(created.id);
    expect(fetched.lines.length).toBe(created.lines.length);
  }, 600_000);

  it("returns 400 INVALID_PERIOD when periodEnd < periodStart", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/service-agreements/${saId}/bills`,
      headers: headers(),
      payload: { periodStart: "2026-05-31", periodEnd: "2026-05-01" },
    });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error?.code).toBe("INVALID_PERIOD");
  });

  it("returns 400 NO_ACTIVE_ASSIGNMENTS for a period before any assignment", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/service-agreements/${saId}/bills`,
      headers: headers(),
      payload: { periodStart: "1999-01-01", periodEnd: "1999-01-31" },
    });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error?.code).toBe("NO_ACTIVE_ASSIGNMENTS");
  });

  it("returns 409 SCHEDULE_NOT_PUBLISHED when an assigned schedule has publishedAt = NULL", async () => {
    const { prisma } = prismaImports;
    // Find the schedule the SA is assigned to and force it back to draft.
    const a = await prisma.sAScheduleAssignment.findFirstOrThrow({
      where: { serviceAgreementId: saId },
    });
    await prisma.rateSchedule.update({
      where: { id: a.rateScheduleId },
      data: { publishedAt: null },
    });
    try {
      const res = await app.inject({
        method: "POST",
        url: `/api/v1/service-agreements/${saId}/bills`,
        headers: headers(),
        payload: { periodStart: "2026-05-01", periodEnd: "2026-05-31" },
      });
      expect(res.statusCode).toBe(409);
      const body = JSON.parse(res.body);
      expect(body.error?.code).toBe("SCHEDULE_NOT_PUBLISHED");
    } finally {
      // Restore for any later tests.
      await prisma.rateSchedule.update({
        where: { id: a.rateScheduleId },
        data: { publishedAt: new Date(2026, 0, 1) },
      });
    }
  }, 600_000);
});
```

- [ ] **Step 2: Run the test**

Run from `packages/api/`:
```bash
pnpm exec vitest run --config vitest.integration.config.ts bill-creation
```

Expected: 6 tests pass.

If any test fails:
- `INVALID_PERIOD` not surfaced → check `bill.service.ts` Step 1 throws with statusCode 400.
- `SCHEDULE_NOT_PUBLISHED` mis-routed → confirm seeded schedule actually has `publishedAt` set; if the seed leaves it null the publish gate may fire on the golden test.
- Subtotal off by a cent → re-run Slice 4 e2e (`pnpm exec vitest run --config vitest.integration.config.ts e2e-rating`) to confirm engine still produces $69.65; only diverge after that's clean.

- [ ] **Step 3: Commit**

```bash
git add packages/api/src/__tests__/integration/bill-creation.integration.test.ts
git commit -m "test(bills): Bozeman SFR golden bill creation end-to-end (slice 5a task 7)"
```

---

## Task 8: Verify the seeded golden schedule is Published, fix seed if needed

The Slice 4 e2e test passed, but it never invoked the publish gate. Slice 5a's billing flow does — we need the seeded `BZN-WATER` rate schedule to have `publishedAt` set, otherwise the golden integration test from Task 7 will trip the new 409 SCHEDULE_NOT_PUBLISHED branch.

**Files:**
- Modify: `packages/shared/prisma/seed.ts` (only if the seeded schedules don't already set `publishedAt`)

- [ ] **Step 1: Inspect the seed**

Run from repo root:
```bash
grep -n "publishedAt\|RateSchedule" packages/shared/prisma/seed.ts | head -20
```

If the existing seed sets `publishedAt` on every `RateSchedule.create(...)` call, this task is a no-op — skip to step 4 to confirm the test runs.

- [ ] **Step 2: If publishedAt is missing — patch the seed**

For every `RateSchedule.create(...)` (or `upsert(...)`) call in `packages/shared/prisma/seed.ts`, ensure the data block includes:

```ts
publishedAt: new Date(),
```

Place it next to `version: 1` for visual symmetry. Don't touch the test fixtures in `packages/api/src/__tests__/integration/_effective-dating-fixtures.ts` — those are intentionally drafts.

- [ ] **Step 3: Re-seed locally and confirm**

Run from repo root with the API dev process stopped:
```bash
unset DATABASE_URL
DATABASE_URL=postgresql://cis:cis_dev_password@localhost:5432/utility_cis pnpm --filter @utility-cis/shared exec tsx prisma/seed.ts
```

Expected: seed completes without error. Spot-check via `psql`:
```bash
docker exec -it utility-cis-postgres psql -U cis -d utility_cis \
  -c "SELECT code, version, published_at FROM rate_schedule WHERE code='BZN-WATER';"
```

`published_at` should be non-NULL.

- [ ] **Step 4: Re-run the bill-creation integration test**

```bash
cd packages/api && pnpm exec vitest run --config vitest.integration.config.ts bill-creation
```

Expected: 6 tests pass (same as Task 7).

- [ ] **Step 5: Commit (skip if Step 1 showed the seed already publishes)**

```bash
git add packages/shared/prisma/seed.ts
git commit -m "chore(seed): publish v2 rate schedules so they bill (slice 5a task 8)"
```

---

## Task 9: Manual UI verification

**Files:** none

- [ ] **Step 1: Stop the dev API; re-run setup_db.bat to apply migration + seed**

From repo root:
```bash
./stop_db.bat
./setup_db.bat
```

- [ ] **Step 2: Start the API and Web**

Two terminals:
```bash
pnpm --filter @utility-cis/api dev
pnpm --filter @utility-cis/web dev
```

- [ ] **Step 3: Walk through the flow**

In a browser at http://localhost:3000:

1. Log in as the seeded admin.
2. Navigate to a Bozeman SFR water service agreement (Service Agreements → filter by commodity Water → pick one with class single_family).
3. Click the **Bills** tab.
4. Click **Generate Bill**.
5. Set Period Start = 2026-05-01, Period End = 2026-05-31.
6. Click **Generate**. Expect a toast "Bill generated" and a new row in the table with total $69.65.
7. Click **View** on the new row. Expect the modal showing:
   - Service Charge — 5/8" meter $22.31
   - Single Family Tier 1/2/etc consumption lines summing to $47.34
   - Subtotal $69.65, Total $69.65
8. Refresh the page. The Bills tab should still show the bill.

- [ ] **Step 4: Note any UI rough edges**

Bills tab styling, dialog spacing, error-toast wording. Open issues for anything that doesn't match the existing CIS aesthetic per CLAUDE.md (DM Sans, existing tokens). Do not silently rewrite the styling here — surface to the user.

---

## Self-review (done before handoff)

**Spec coverage:**
- Bill + BillLine entities → Task 1 ✓
- Service function with three errors (INVALID_PERIOD, NO_ACTIVE_ASSIGNMENTS, SCHEDULE_NOT_PUBLISHED) → Task 4 + 7 ✓
- Three HTTP endpoints (POST, GET list, GET detail) → Task 5, tests in Task 7 ✓
- Mark MeterRead.billedAt → Task 4 step 1 (item 9) + Task 7 assertion ✓
- Bills tab on SA detail with create dialog + detail modal → Task 6 ✓
- Bozeman SFR golden bill = $69.65 → Task 7 ✓
- Audit row for BILL_CREATED → Task 4 (auditCreate wrapper) + Task 2 (event constant) ✓
- buildRegistry factory → Task 3 ✓
- Seed must yield publishable schedules → Task 8 ✓

**Type consistency:**
- `BillSummary` / `BillWithLines` / `BillLineRow` field names match between `bill.service.ts` and the UI types in `bills-tab.tsx` / `bill-detail-dialog.tsx` (string-encoded decimals, sortOrder int).
- Route paths use `:id` consistently with `idParamSchema.parse(request.params)`.
- `EVENT_TYPES.BILL_CREATED` referenced in service matches the constant defined in Task 2.

**No placeholders:** every step contains the actual code or command an engineer would run.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-05-rate-model-v2-slice-5a.md`. Two execution options:

1. **Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
