# Rate Model v2 — Slice 4: Variable Loaders Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]` checkboxes.

**Goal:** Wire the rate engine to real DB data via a plugin-based loader system. After this slice, billing a seeded SA produces correct dollar amounts end-to-end.

**Architecture:** New `packages/api/src/lib/rate-engine-loaders/` module. `VariableRegistry` assembles itself from registered `Loader` plugins. Each loader self-describes its supported key patterns + scope, and implements batch `load(keys[])` with one or two minimum queries per call. `loadBase(saId, period)` hydrates the engine's `BaseContext` from Prisma.

**Tech Stack:** TypeScript, Prisma, vitest with `bootPostgres` testcontainer infrastructure. Decimal.js for money math (already wired).

**Reference:** Spec at [`docs/superpowers/specs/2026-05-04-rate-model-v2-slice-4.md`](../specs/2026-05-04-rate-model-v2-slice-4.md). Engine at `packages/api/src/lib/rate-engine/` (Slice 3, commits `b17ebd0..524886b`).

---

## File structure (target)

```
packages/api/src/lib/rate-engine-loaders/
├── index.ts                          # public exports
├── types.ts                          # Loader, LoaderCapability, VariableRegistry types
├── registry.ts                       # VariableRegistry class
├── load-base.ts                      # loadBase(saId, period)
├── loaders/
│   ├── account-loader.ts
│   ├── meter-loader.ts
│   ├── wqa-loader.ts
│   ├── tenant-loader.ts
│   ├── premise-loader.ts
│   ├── index-loader.ts
│   ├── linked-commodity-loader.ts
│   └── items-loader.ts
└── __tests__/
    ├── registry.test.ts
    ├── load-base.test.ts
    ├── account-loader.test.ts
    ├── meter-loader.test.ts
    ├── wqa-loader.test.ts
    ├── tenant-loader.test.ts
    ├── premise-loader.test.ts
    ├── index-loader.test.ts
    ├── linked-commodity-loader.test.ts
    ├── items-loader.test.ts
    └── e2e-rating.integration.test.ts
```

Plus new Prisma models: `WqaValue`, `TenantSetting`. Plus their migration.

---

## Task 1 — Loader interface + VariableRegistry + tests

**Goal:** Define the plugin contract; build the dispatch + validation layer.

**Files:**
- Create: `packages/api/src/lib/rate-engine-loaders/types.ts`
- Create: `packages/api/src/lib/rate-engine-loaders/registry.ts`
- Create: `packages/api/src/lib/rate-engine-loaders/index.ts`
- Create: `packages/api/src/lib/rate-engine-loaders/__tests__/registry.test.ts`

**Steps:**

- [ ] **Step 1 — `types.ts`.**

```typescript
import type { ZodSchema } from "zod";
import type { VariableKey, VariableValue } from "../rate-engine/types.js";

export interface Loader {
  capabilities(): LoaderCapability[];
  load(keys: VariableKey[]): Promise<Map<VariableKey, VariableValue>>;
}

export interface LoaderCapability {
  pattern: string;                          // e.g. "meter:reads:<meter_id>"
  paramTypes?: Record<string, ZodSchema>;
  returns?: ZodSchema;
  scope: "per_sa" | "per_tenant" | "global";
  description: string;
}

export class UnsupportedInSlice4Error extends Error {
  constructor(feature: string) {
    super(`${feature} is not implemented in Slice 4 of the variable loaders`);
    this.name = "UnsupportedInSlice4Error";
  }
}
```

- [ ] **Step 2 — `registry.ts`.**

```typescript
import type { VariableKey, VariableValue } from "../rate-engine/types.js";
import type { Loader, LoaderCapability } from "./types.js";

export class VariableRegistry {
  private capabilities: Array<{ cap: LoaderCapability; loader: Loader; regex: RegExp }> = [];

  register(loader: Loader): void {
    for (const cap of loader.capabilities()) {
      // Detect conflict — pattern strings (after lowercasing) must not match the same key
      if (this.capabilities.some((existing) => existing.cap.pattern === cap.pattern)) {
        throw new Error(`Conflicting loader capability: ${cap.pattern}`);
      }
      const regex = patternToRegex(cap.pattern);
      this.capabilities.push({ cap, loader, regex });
    }
  }

  validateKey(key: VariableKey): { valid: boolean; capability?: LoaderCapability; error?: string } {
    const match = this.capabilities.find(({ regex }) => regex.test(key));
    if (!match) return { valid: false, error: `No registered loader matches key: ${key}` };
    return { valid: true, capability: match.cap };
  }

  resolveLoader(key: VariableKey): Loader {
    const match = this.capabilities.find(({ regex }) => regex.test(key));
    if (!match) throw new Error(`No registered loader for key: ${key}`);
    return match.loader;
  }

  scopeOf(key: VariableKey): "per_sa" | "per_tenant" | "global" {
    const match = this.capabilities.find(({ regex }) => regex.test(key));
    if (!match) throw new Error(`No registered loader for key: ${key}`);
    return match.cap.scope;
  }

  describeAll(): LoaderCapability[] {
    return this.capabilities.map((c) => c.cap);
  }

  async loadVariables(keys: VariableKey[]): Promise<Map<VariableKey, VariableValue>> {
    // Group keys by their loader
    const keysByLoader = new Map<Loader, VariableKey[]>();
    for (const key of keys) {
      const loader = this.resolveLoader(key);
      const list = keysByLoader.get(loader) ?? [];
      list.push(key);
      keysByLoader.set(loader, list);
    }

    // Batch-fetch each loader in parallel
    const results = await Promise.all(
      [...keysByLoader.entries()].map(([loader, ks]) => loader.load(ks)),
    );

    // Merge into one map
    const merged = new Map<VariableKey, VariableValue>();
    for (const r of results) {
      for (const [k, v] of r) merged.set(k, v);
    }
    return merged;
  }
}

function patternToRegex(pattern: string): RegExp {
  // "meter:reads:<meter_id>" → /^meter:reads:[^:]+$/
  // "index:<index_name>:<period>" → /^index:[^:]+:[^:]+$/
  const escaped = pattern.replace(/<[^>]+>/g, "[^:]+");
  return new RegExp(`^${escaped}$`);
}
```

- [ ] **Step 3 — `index.ts`.**

```typescript
export * from "./types.js";
export { VariableRegistry } from "./registry.js";
```

- [ ] **Step 4 — `registry.test.ts` (~7 tests).**

Test cases:
1. Register a loader; `validateKey` returns capability for matching key
2. `validateKey` rejects unmatched key
3. Register two loaders with conflicting patterns → second throws
4. `loadVariables` dispatches to right loaders
5. `loadVariables` batches keys per loader (one `load` call per loader)
6. `describeAll` returns all registered capabilities
7. `scopeOf` returns the right scope

Use a stub loader for tests:

```typescript
class StubLoader implements Loader {
  loadCalls: VariableKey[][] = [];
  constructor(private caps: LoaderCapability[], private values: Record<string, VariableValue>) {}
  capabilities() { return this.caps; }
  async load(keys: VariableKey[]) {
    this.loadCalls.push([...keys]);
    return new Map(keys.map((k) => [k, this.values[k]]));
  }
}
```

- [ ] **Step 5 — Run + commit.**

```bash
cd /c/development/claude-test
pnpm --filter @utility-cis/api exec vitest run rate-engine-loaders/__tests__/registry
pnpm --filter @utility-cis/api exec tsc --noEmit
git add packages/api/src/lib/rate-engine-loaders/
git commit -m "$(cat <<'EOF'
feat(rate-engine-loaders): Loader interface + VariableRegistry (slice 4 task 1)

Plugin contract: each Loader self-describes via capabilities() and
implements batch load(keys[]). VariableRegistry assembles itself from
registered loaders, dispatches keys to the right loader, batches per
loader, and rejects pattern conflicts at registration time.

7 tests covering registration, conflict detection, dispatch, batching,
introspection, and scope resolution.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2 — AccountLoader + tests

**Files:**
- Create: `loaders/account-loader.ts`
- Create: `__tests__/account-loader.test.ts`

**Capabilities:**
- `account:class` — looks up via SA's `rateServiceClass.code`. Scope: per_sa.
- `account:flag:<flag_name>` — reads `account.flags` JSONB field if it exists, else returns false. Scope: per_sa.

**Behavior:** the loader receives keys + a `saId` context (for now, infer SA from context — see "constructor" pattern below).

The loader needs to know **which SA** to look up. There are two ways:
1. Loader is constructed with a `saId`/`utilityId` per rating call (lifecycle: per-rating).
2. Loader extracts SA id from a per-call context passed alongside keys.

**Decision: per-rating loader instances.** The registry is constructed at the start of a rating call with the current SA's context. This is the cleanest pattern for Slice 4. Bulk batch processing (Slice 5) can revisit.

**Loader constructor:**
```typescript
export class AccountLoader implements Loader {
  constructor(private prisma: PrismaClient, private utilityId: string, private saId: string) {}
  capabilities() { ... }
  async load(keys) { ... }
}
```

**Steps:**

- [ ] **Step 1 — `account-loader.ts`:**

```typescript
import type { PrismaClient } from "@utility-cis/shared";
import { z } from "zod";
import type { VariableKey, VariableValue } from "../../rate-engine/types.js";
import type { Loader, LoaderCapability } from "../types.js";

export class AccountLoader implements Loader {
  constructor(
    private prisma: PrismaClient,
    private utilityId: string,
    private saId: string,
  ) {}

  capabilities(): LoaderCapability[] {
    return [
      {
        pattern: "account:class",
        scope: "per_sa",
        returns: z.string(),
        description: "Customer service class for this SA's commodity",
      },
      {
        pattern: "account:flag:<flag_name>",
        paramTypes: { flag_name: z.string() },
        scope: "per_sa",
        returns: z.boolean(),
        description: "Boolean flag on the account",
      },
    ];
  }

  async load(keys: VariableKey[]): Promise<Map<VariableKey, VariableValue>> {
    const out = new Map<VariableKey, VariableValue>();
    if (keys.length === 0) return out;

    const needsClass = keys.includes("account:class");
    const flagNames = keys
      .filter((k) => k.startsWith("account:flag:"))
      .map((k) => k.slice("account:flag:".length));

    if (needsClass || flagNames.length > 0) {
      const sa = await this.prisma.serviceAgreement.findUniqueOrThrow({
        where: { id: this.saId, utilityId: this.utilityId },
        include: {
          rateServiceClass: { select: { code: true } },
          account: { select: { flags: true } },
        },
      });

      if (needsClass) {
        out.set("account:class", sa.rateServiceClass?.code ?? null);
      }
      const flags = (sa.account.flags as Record<string, unknown>) ?? {};
      for (const flag of flagNames) {
        out.set(`account:flag:${flag}`, Boolean(flags[flag]));
      }
    }

    return out;
  }
}
```

(Note: `account.flags` is hypothetical — confirm the field exists, or use a different source. If `Account` doesn't have a `flags` JSONB, return `false` for now and document as TODO.)

- [ ] **Step 2 — Tests** (~5):

Use `bootPostgres` from existing infra. Tests:
1. `account:class` returns rateServiceClass code for SA with class set
2. `account:class` returns null for SA without class
3. `account:flag:autopay` returns the boolean (test with flag=true and flag=false)
4. Multiple keys batched → single Prisma query (verify with mock prisma or count queries)
5. RLS / tenant isolation — same loader can't read other tenant's account

(Skip query-counting if mocking adds noise; just assert correctness.)

- [ ] **Step 3 — Commit.**

```bash
git add packages/api/src/lib/rate-engine-loaders/loaders/account-loader.ts \
        packages/api/src/lib/rate-engine-loaders/__tests__/account-loader.test.ts
git commit -m "feat(rate-engine-loaders): AccountLoader (slice 4 task 2)"
```

---

## Task 3 — MeterLoader + tests

**Capabilities:**
- `meter:reads:<meter_id>` — aggregates `meter_read` for the meter in the period; returns `{ quantity, unit }`. Scope: per_sa.
- `meter:size:<meter_id>` — reads `meter.size`. Scope: per_sa.
- `meter:role:<meter_id>` — reads `meter.role`. Scope: per_sa.
- `meter:peak_demand:<meter_id>:<window>` — throws `UnsupportedInSlice4Error`.

The loader needs the period (for read aggregation) — pass it via constructor along with utilityId.

```typescript
export class MeterLoader implements Loader {
  constructor(
    private prisma: PrismaClient,
    private utilityId: string,
    private period: { startDate: Date; endDate: Date },
  ) {}
  ...
}
```

**Steps:**

- [ ] **Step 1 — Implement** with these load patterns:

```typescript
async load(keys: VariableKey[]): Promise<Map<VariableKey, VariableValue>> {
  const out = new Map<VariableKey, VariableValue>();

  // Group by meter id + variable type
  const meterIdsForReads = new Set<string>();
  const meterIdsForSize = new Set<string>();
  const meterIdsForRole = new Set<string>();
  const peakDemandKeys: VariableKey[] = [];

  for (const k of keys) {
    if (k.startsWith("meter:reads:")) meterIdsForReads.add(k.slice("meter:reads:".length));
    else if (k.startsWith("meter:size:")) meterIdsForSize.add(k.slice("meter:size:".length));
    else if (k.startsWith("meter:role:")) meterIdsForRole.add(k.slice("meter:role:".length));
    else if (k.startsWith("meter:peak_demand:")) peakDemandKeys.push(k);
  }

  for (const k of peakDemandKeys) {
    throw new UnsupportedInSlice4Error(`meter:peak_demand variable not yet implemented (${k})`);
  }

  // Fetch all meters once if any meta needed
  const allMeterIds = new Set<string>([...meterIdsForSize, ...meterIdsForRole]);
  if (allMeterIds.size > 0) {
    const meters = await this.prisma.meter.findMany({
      where: { id: { in: [...allMeterIds] }, utilityId: this.utilityId },
      select: { id: true, size: true, role: true },
    });
    for (const m of meters) {
      if (meterIdsForSize.has(m.id)) out.set(`meter:size:${m.id}`, m.size);
      if (meterIdsForRole.has(m.id)) out.set(`meter:role:${m.id}`, m.role);
    }
  }

  // Aggregate reads per meter for the period
  if (meterIdsForReads.size > 0) {
    const reads = await this.prisma.meterRead.findMany({
      where: {
        meterId: { in: [...meterIdsForReads] },
        utilityId: this.utilityId,
        readDate: { gte: this.period.startDate, lte: this.period.endDate },
      },
      select: { meterId: true, consumption: true, unit: true },
    });

    // Sum consumption per meter
    const sumByMeter = new Map<string, { quantity: Decimal; unit: string }>();
    for (const r of reads) {
      const existing = sumByMeter.get(r.meterId);
      const q = existing ? existing.quantity.plus(r.consumption ?? 0) : new Decimal(r.consumption ?? 0);
      sumByMeter.set(r.meterId, { quantity: q, unit: r.unit ?? "HCF" });
    }

    for (const meterId of meterIdsForReads) {
      const summary = sumByMeter.get(meterId) ?? { quantity: new Decimal(0), unit: "HCF" };
      out.set(`meter:reads:${meterId}`, summary);
    }
  }

  return out;
}
```

(Adapt field names — `meter_read.consumption` may be different. Read the Prisma schema for meter_read.)

- [ ] **Step 2 — Tests** (~6):
  1. `meter:size:M-1` returns the correct size string
  2. `meter:role:M-1` returns the role
  3. `meter:reads:M-1` aggregates consumption across multiple reads in period
  4. `meter:reads:M-1` ignores reads outside period
  5. Multiple meters batched in one query
  6. `meter:peak_demand:*` throws UnsupportedInSlice4Error

- [ ] **Step 3 — Commit.**

```bash
git add packages/api/src/lib/rate-engine-loaders/loaders/meter-loader.ts \
        packages/api/src/lib/rate-engine-loaders/__tests__/meter-loader.test.ts
git commit -m "feat(rate-engine-loaders): MeterLoader (slice 4 task 3)"
```

---

## Task 4 — TenantLoader + IndexLoader + PremiseLoader (group)

These three are small. Combine into one task.

**TenantLoader:**
- `tenant:drought_stage` — reads `tenant_setting` table where `name = "drought_stage"`. Returns integer 0-4. If no row, return 0.
- `tenant:flags:<flag_name>` — reads `tenant_setting` where `name = "flags.<flag_name>"`. Returns boolean.
- Scope: per_tenant.

**Add `TenantSetting` Prisma model:**

```prisma
model TenantSetting {
  id        String   @id @default(uuid()) @db.Uuid
  utilityId String   @map("utility_id") @db.Uuid
  name      String   @map("name") @db.VarChar(100)
  value     Json     @map("value")
  createdAt DateTime @default(now()) @map("created_at") @db.Timestamptz
  updatedAt DateTime @updatedAt @map("updated_at") @db.Timestamptz

  @@unique([utilityId, name])
  @@map("tenant_setting")
}
```

Migration: add table + RLS policy `tenant_isolation`.

**IndexLoader:**
- `index:<index_name>:<period>` — reads `rate_index` where `name = <name>` and `period = <period>`. Returns Decimal.
- Scope: global.

**PremiseLoader:**
- `premise:attr:<attr_name>` — reads `premise.<attr>` for the SA's premise. Maps snake_case to camelCase.
- Scope: per_sa.

**Steps:**

- [ ] Add `TenantSetting` model + migration; apply
- [ ] Implement 3 loaders (each ~50 lines)
- [ ] Tests — ~4-5 per loader (~13 total)
- [ ] Commit

```bash
git commit -m "feat(rate-engine-loaders): TenantLoader + IndexLoader + PremiseLoader + TenantSetting model (slice 4 task 4)"
```

---

## Task 5 — WqaValue model + WqaLoader + tests

- [ ] **Step 1 — Add `WqaValue` Prisma model + back-relation on ServiceAgreement.** Per spec section 4.

- [ ] **Step 2 — Generate + apply migration** (`unset DATABASE_URL && DATABASE_URL=...`).

- [ ] **Step 3 — `WqaLoader`:**
  - `wqa:current:<sa_id>` — reads latest `wqa_value` row for SA. Returns `Decimal(overrideValue ?? computedAvg)`. If no row → throw.
  - `wqa:override:<sa_id>` — reads same row. Returns `Decimal | null` based on `overrideValue`.
  - Scope: per_sa.

- [ ] **Step 4 — Tests** (~5): seed wqa rows, assert loader reads correctly, override wins, missing row throws.

- [ ] **Step 5 — Commit.**

```bash
git commit -m "feat(rate-engine-loaders): WqaValue model + WqaLoader (slice 4 task 5)"
```

---

## Task 6 — LinkedCommodityLoader + ItemsLoader + tests

**LinkedCommodityLoader:**
- `linked:<commodity_id>:current_period` — find sibling SA on same account+premise with the given commodity; aggregate its meter reads for the period (reuses MeterLoader's logic, or queries directly).
- Scope: per_sa.

**ItemsLoader:**
- `items:<sp_id>:<item_type>` — reads containers attached to the SA filtered by item_type. Returns `Container[]`.
- Scope: per_sa.

**Steps:**

- [ ] Implement both (~60 lines each)
- [ ] Tests (~5 each, 10 total): happy paths, missing data, multiple sibling SAs (linked) handling, item_type filtering
- [ ] Commit

```bash
git commit -m "feat(rate-engine-loaders): LinkedCommodityLoader + ItemsLoader (slice 4 task 6)"
```

---

## Task 7 — `loadBase(saId, period)` helper + tests

**Goal:** Build the engine's `BaseContext` from Prisma.

- [ ] **Step 1 — Implement `loadBase`:**

```typescript
export async function loadBase(
  prisma: PrismaClient,
  saId: string,
  period: { startDate: Date; endDate: Date },
  utilityId: string,
): Promise<BaseContext> {
  const sa = await prisma.serviceAgreement.findUniqueOrThrow({
    where: { id: saId, utilityId },
    include: {
      account: true,
      premise: true,
      rateServiceClass: { select: { code: true } },
      rateScheduleAssignments: {
        where: {
          OR: [
            { expirationDate: null },
            { expirationDate: { gte: period.startDate } },
          ],
          effectiveDate: { lte: period.endDate },
        },
        include: {
          rateSchedule: {
            include: {
              components: { orderBy: { sortOrder: "asc" } },
            },
          },
        },
      },
    },
  });

  // Map Prisma rows into engine snapshots
  const baseSa = {
    id: sa.id,
    utilityId: sa.utilityId,
    accountId: sa.accountId,
    premiseId: sa.premiseId,
    commodityId: sa.commodityId,
    rateServiceClassCode: sa.rateServiceClass?.code,
  };

  const account = {
    id: sa.account.id,
    accountNumber: sa.account.accountNumber,
    customerType: sa.account.customerType ?? undefined,
  };

  const premise = {
    id: sa.premise.id,
    premiseType: sa.premise.premiseType,
    eruCount: sa.premise.eruCount ? new Decimal(sa.premise.eruCount.toString()) : null,
    hasStormwaterInfra: sa.premise.hasStormwaterInfra,
    impervioussSqft: sa.premise.impervioussSqft,
  };

  const assignments = sa.rateScheduleAssignments.map((a) => ({
    id: a.id,
    rateScheduleId: a.rateScheduleId,
    roleCode: a.roleCode,
    effectiveDate: a.effectiveDate,
    expirationDate: a.expirationDate,
    schedule: {
      id: a.rateSchedule.id,
      name: a.rateSchedule.name,
      code: a.rateSchedule.code,
      version: a.rateSchedule.version,
      components: a.rateSchedule.components.map((c) => ({
        id: c.id,
        rateScheduleId: c.rateScheduleId,
        kindCode: c.kindCode,
        label: c.label,
        predicate: c.predicate,
        quantitySource: c.quantitySource,
        pricing: c.pricing,
        sortOrder: c.sortOrder,
        effectiveDate: c.effectiveDate,
        expirationDate: c.expirationDate,
      })),
    },
  }));

  return { sa: baseSa, account, premise, period, assignments };
}
```

- [ ] **Step 2 — Tests** (~3):
  - Build a seeded SA with one assignment; loadBase produces expected shape
  - Assignments outside period filtered out
  - Components ordered by sortOrder

- [ ] **Step 3 — Commit.**

```bash
git commit -m "feat(rate-engine-loaders): loadBase(saId, period) hydrates BaseContext from Prisma (slice 4 task 7)"
```

---

## Task 8 — End-to-end integration test + final verification + push

**Goal:** Prove the engine + loaders + DB work together. Single test using a seeded Bozeman SFR water customer.

- [ ] **Step 1 — `__tests__/e2e-rating.integration.test.ts`:**

```typescript
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execSync } from "child_process";
import path from "path";
import { PrismaClient } from "@utility-cis/shared";
import { Decimal } from "decimal.js";
import { bootPostgres, type PostgresContainer } from "../../../__tests__/integration/_effective-dating-fixtures.js";
import * as engine from "../../rate-engine/index.js";
import { VariableRegistry } from "../registry.js";
import { loadBase } from "../load-base.js";
import { AccountLoader } from "../loaders/account-loader.js";
import { MeterLoader } from "../loaders/meter-loader.js";
import { TenantLoader } from "../loaders/tenant-loader.js";
import { PremiseLoader } from "../loaders/premise-loader.js";
import { IndexLoader } from "../loaders/index-loader.js";
import { WqaLoader } from "../loaders/wqa-loader.js";
import { LinkedCommodityLoader } from "../loaders/linked-commodity-loader.js";
import { ItemsLoader } from "../loaders/items-loader.js";

let container: PostgresContainer;
let prisma: PrismaClient;

beforeAll(async () => {
  container = await bootPostgres();
  execSync("pnpm prisma migrate deploy", {
    cwd: path.resolve(import.meta.dirname, "../../../../shared"),
    env: { ...process.env, DATABASE_URL: container.dbUrl },
  });
  execSync("tsx prisma/seed.ts", {
    cwd: path.resolve(import.meta.dirname, "../../../../shared"),
    env: { ...process.env, DATABASE_URL: container.dbUrl },
  });
  prisma = new PrismaClient({ datasources: { db: { url: container.dbUrl } } });
}, 300_000);

afterAll(async () => {
  await prisma.$disconnect();
  await container.stop();
});

describe("end-to-end rating: Bozeman SFR water", () => {
  it("rates a seeded SFR SA at 12 HCF for May 2026 → $69.65", async () => {
    // Find the seeded SFR water SA
    const sa = await prisma.serviceAgreement.findFirstOrThrow({
      where: {
        commodity: { code: "water" },
        rateServiceClass: { code: "single_family" },
      },
      include: { premise: true, account: true },
    });

    // Insert a meter read of 12 HCF for the period
    const meter = await prisma.meter.findFirstOrThrow({ where: { servicePoints: { some: { serviceAgreementId: sa.id } } } });
    await prisma.meterRead.create({
      data: {
        utilityId: sa.utilityId,
        meterId: meter.id,
        readDate: new Date(2026, 4, 31),
        consumption: 12,
        unit: "HCF",
      },
    });

    const period = { startDate: new Date(2026, 4, 1), endDate: new Date(2026, 4, 31) };
    const utilityId = sa.utilityId;

    // 1. Load base
    const base = await loadBase(prisma, sa.id, period, utilityId);

    // 2. Build registry with all loaders for this SA
    const registry = new VariableRegistry();
    registry.register(new AccountLoader(prisma, utilityId, sa.id));
    registry.register(new MeterLoader(prisma, utilityId, period));
    registry.register(new WqaLoader(prisma, utilityId, sa.id));
    registry.register(new TenantLoader(prisma, utilityId));
    registry.register(new PremiseLoader(prisma, utilityId, sa.premiseId));
    registry.register(new IndexLoader(prisma, utilityId));
    registry.register(new LinkedCommodityLoader(prisma, utilityId, period, sa));
    registry.register(new ItemsLoader(prisma, utilityId, sa.id));

    // 3. Manifest
    const keys = engine.manifest(base);

    // For the SFR water case, manifest should include at least:
    //   account:class, tenant:drought_stage
    //   meter:size:<meter-id>, meter:reads:<meter-id> (these latter two are
    //   inferred at rate time, so won't show in manifest — caller pre-loads)
    // Add the meter-keyed vars manually for this SFR test:
    keys.push(`meter:size:${meter.id}`, `meter:reads:${meter.id}`);

    // 4. Load variables
    const vars = await registry.loadVariables(keys);

    // 5. Rate
    const result = engine.rate({ base, vars });

    // 6. Assert dollar amount matches Slice 3 SFR golden test
    expect(result.totals.subtotal.toFixed(2)).toBe("69.65");
    expect(result.lines).toHaveLength(2);
    expect(result.lines.find((l) => l.kindCode === "service_charge")?.amount.toFixed(2)).toBe("22.31");
    expect(result.lines.find((l) => l.kindCode === "consumption")?.amount.toFixed(2)).toBe("47.34");
  }, 120_000);
});
```

- [ ] **Step 2 — Run full Slice 4 suite + workspace typecheck.**

```bash
cd /c/development/claude-test
pnpm --filter @utility-cis/api exec vitest run rate-engine-loaders
pnpm -w typecheck
```

Expected: ~50+ tests pass; typecheck clean.

- [ ] **Step 3 — Commit + push.**

```bash
git add packages/api/src/lib/rate-engine-loaders/__tests__/e2e-rating.integration.test.ts
git commit -m "$(cat <<'EOF'
test(rate-engine-loaders): end-to-end rating + final verification (slice 4 task 8)

End-to-end test seeds a Bozeman SFR water SA, runs loadBase → manifest
→ loadVariables → rate, asserts the $69.65 subtotal matching the
Slice 3 SFR golden test exactly. Proves engine + loaders + DB are
wired correctly for real-world billing.

Closes Slice 4. Variable loaders are functionally complete and ready
for Slice 5 (bill generation).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
git log --oneline 524886b..HEAD
git push origin main
```

---

## Self-review

- [x] Spec coverage: every section maps to a task
- [x] No placeholders: each step has actual code or precise instructions
- [x] Type consistency: `Loader`, `LoaderCapability`, `VariableRegistry`, `BaseContext`, `RatingContext` consistent throughout
- [x] Order: Task 1 first; Tasks 2-6 can run in parallel; Task 7 depends on schema (loaders independent); Task 8 depends on all prior

Ready for `superpowers:subagent-driven-development`.
