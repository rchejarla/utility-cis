# Rate Model v2 — Slice 4: Variable Loaders — Spec

**Date:** 2026-05-04
**Slice of:** Rate Model v2 ([`docs/specs/07b-rate-model-v2-design.md`](../../specs/07b-rate-model-v2-design.md))
**Builds on:** Slice 1 schema (shipped) + Slice 3 engine (shipped at `524886b`)
**Scope:** The I/O layer that hydrates the engine's `RatingContext` from the database. After this slice, billing a real seeded SA produces correct dollar amounts end-to-end.

---

## 1. Goals and non-goals

### Goals

- Implement the **loader plugin interface** (`Loader.capabilities()` + `Loader.load(keys[])`) defined in `07b`.
- Build a **`VariableRegistry`** that assembles itself from registered loaders, validates references at save time, dispatches at rate time, exposes capabilities for configurator UI.
- Ship **8 concrete loaders** covering every namespace the engine reads:
  - `AccountLoader` — `account:class`, `account:flag:*`
  - `MeterLoader` — `meter:reads:*`, `meter:size:*`, `meter:role:*`, `meter:peak_demand:*:*` (last throws `UnsupportedInSlice4Error` since engine doesn't support it yet)
  - `WqaLoader` — `wqa:current:*`, `wqa:override:*`
  - `TenantLoader` — `tenant:drought_stage`, `tenant:flags:*`
  - `PremiseLoader` — `premise:attr:*`
  - `IndexLoader` — `index:*:*`
  - `LinkedCommodityLoader` — `linked:*:current_period`
  - `ItemsLoader` — `items:*:*`
- Build **`loadBase(saId, period)`** that hydrates the engine's `BaseContext` from Prisma: SA snapshot, account snapshot, premise snapshot, period, all active assignments with their schedules + components.
- Add **`WqaValue` Prisma model** + migration (deferred from Slice 1's open design questions).
- **End-to-end integration test**: seed a Bozeman SFR water customer, run `loadBase` → `manifest` → `loadVariables` → `rate` → assert exact dollar output matching the Slice 3 golden test.

### Non-goals

- **API endpoints** that expose rating to the wire (Slice 5).
- **Bill persistence** — `Bill` entity, monthly bill-run job (Slice 5).
- **Bill rendering** (PDF/HTML) — Slice 5.
- **Configurator UI** (Slice 2) — but the loader registry surfaces capabilities for it.
- **Bulk prefetch optimization** for batch billing — defer to Slice 5 once batch billing is in scope. Slice 4 ships single-SA loading; batch comes later.
- **Cache layer** (Redis-backed cache for index values etc.) — defer.
- **Auto-WQA computation job** — Slice 4 ships the storage table; the seasonal recompute job is later.
- **Refactor of `inferMeterId` heuristic in the engine.** Track as a tech debt note. The engine still infers meter IDs from `meter:reads:*` keys; Slice 5 may revisit by adding meter snapshots to `BaseContext`.

---

## 2. Architecture summary

The loader system lives in `packages/api/src/lib/rate-engine-loaders/` (sibling to `rate-engine/`). The engine itself doesn't change — it still consumes `RatingContext` purely. The loader system is what fills the `RatingContext` from Prisma.

Module structure:

```
packages/api/src/lib/rate-engine-loaders/
├── index.ts                          # public exports
├── types.ts                          # Loader, LoaderCapability, VariableRegistry types
├── registry.ts                       # VariableRegistry class
├── load-base.ts                      # loadBase(saId, period) → BaseContext
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
    └── e2e-rating.integration.test.ts   # the proof
```

---

## 3. Public API

### Loader interface

```typescript
export interface Loader {
  capabilities(): LoaderCapability[];
  load(keys: VariableKey[]): Promise<Map<VariableKey, VariableValue>>;
}

export interface LoaderCapability {
  pattern: string;                     // "meter:reads:<meter_id>"
  paramTypes?: Record<string, ZodSchema>; // typed wildcards
  returns?: ZodSchema;                 // optional runtime validation of the value
  scope: "per_sa" | "per_tenant" | "global";
  description: string;                 // human-readable, used by configurator picker
}
```

### Variable registry

```typescript
export class VariableRegistry {
  register(loader: Loader): void;
  validateKey(key: VariableKey): { valid: boolean; capability?: LoaderCapability; error?: string };
  resolveLoader(key: VariableKey): Loader;
  scopeOf(key: VariableKey): "per_sa" | "per_tenant" | "global";
  describeAll(): LoaderCapability[];
  loadVariables(keys: VariableKey[]): Promise<Map<VariableKey, VariableValue>>;
}
```

The registry's `register` rejects loaders whose patterns conflict with already-registered patterns. Each pattern uses `<name>` placeholders for wildcards.

### `loadBase`

```typescript
export async function loadBase(
  saId: string,
  period: { startDate: Date; endDate: Date },
  utilityId: string,
): Promise<BaseContext>;
```

Hydrates the full engine context from Prisma:
- The SA + its account + its premise (snapshots in the shape the engine expects)
- The period
- All `SAScheduleAssignment`s active in the period, with their `RateSchedule` + `RateComponent[]` joined

Returns `BaseContext` ready to feed `engine.manifest()` and (after `loadVariables`) `engine.rate()`.

---

## 4. WQA storage

New Prisma model:

```prisma
model WqaValue {
  id                  String   @id @default(uuid()) @db.Uuid
  utilityId           String   @map("utility_id") @db.Uuid
  serviceAgreementId  String   @map("service_agreement_id") @db.Uuid
  waterYear           Int      @map("water_year")           // e.g. 2026 (the year ending in winter sample)
  computedAt          DateTime @map("computed_at") @db.Timestamptz
  sourceWindowStart   DateTime @map("source_window_start") @db.Date
  sourceWindowEnd     DateTime @map("source_window_end") @db.Date
  computedAvg         Decimal  @map("computed_avg") @db.Decimal(10, 4)
  overrideValue       Decimal? @map("override_value") @db.Decimal(10, 4)
  overrideReason      String?  @map("override_reason") @db.Text
  overrideBy          String?  @map("override_by") @db.Uuid
  overrideAt          DateTime? @map("override_at") @db.Timestamptz
  createdAt           DateTime @default(now()) @map("created_at") @db.Timestamptz
  updatedAt           DateTime @updatedAt @map("updated_at") @db.Timestamptz

  serviceAgreement    ServiceAgreement @relation(fields: [serviceAgreementId], references: [id], onDelete: Cascade)

  @@unique([utilityId, serviceAgreementId, waterYear])
  @@index([utilityId, serviceAgreementId])
  @@map("wqa_value")
}
```

Add back-relation `wqaValues WqaValue[]` on `ServiceAgreement`.

The `WqaLoader.load(keys)` reads the latest active row per SA (latest waterYear, with override winning). For Slice 4 we manually populate seed rows for SAs that need WQA-driven sewer billing; auto-computation comes later.

---

## 5. Loader-by-loader behavior

### AccountLoader

- `account:class` → looks up `serviceAgreement.rateServiceClass.code` for each SA in scope. Returns the class string. Scope: `per_sa`.
- `account:flag:<flag_name>` → looks up `account.flags[flag_name]` JSON column. Returns boolean. Scope: `per_sa`.

### MeterLoader

- `meter:reads:<meter_id>` → reads `meter_read` table for the given meter, filters by period (passed via the load context), aggregates to total consumption. Returns `{ quantity: Decimal, unit: string, intervals?: any[] }`. Scope: `per_sa`.
- `meter:size:<meter_id>` → reads `meter.size` column. Scope: `per_sa`.
- `meter:role:<meter_id>` → reads `meter.role` (nullable). Scope: `per_sa`.
- `meter:peak_demand:*` → throws `UnsupportedInSlice4Error` (engine throws too).

### WqaLoader

- `wqa:current:<sa_id>` → reads latest `wqa_value` row for the SA. If `overrideValue` is set, returns that; else `computedAvg`. Returns Decimal. Scope: `per_sa`.
- `wqa:override:<sa_id>` → returns the override-only value (Decimal or null). Used by admin UIs (Slice 5).

### TenantLoader

- `tenant:drought_stage` → reads tenant-level setting (a row in `tenant_setting` keyed by name, or fall back to `0` if not set). Returns integer 0-4. Scope: `per_tenant` — value is the same for every SA in a billing run, so the registry's bulk-prefetch path can dedup.
- `tenant:flags:<flag_name>` → similar, returns boolean.

For Slice 4, since we don't have a `tenant_setting` table yet, the `TenantLoader` reads from a small new table or uses environment variables. **Decision**: add `tenant_setting` table now (small, generic key→value). It's needed for drought stage anyway.

### PremiseLoader

- `premise:attr:<attr_name>` → reads `premise.<attr>` column. Common attrs: `eruCount`, `impervioussSqft`, `hasStormwaterInfra`, `premiseType`. Returns whatever type the column has. Scope: `per_sa`.

### IndexLoader

- `index:<index_name>:<period>` → reads `rate_index` table where `name = <index_name>` and `period = <period>`. Returns `Decimal` (the value column). Scope: `global` — same for every SA in a billing run.

### LinkedCommodityLoader

- `linked:<commodity_id>:current_period` → for each SA, finds the SA's other commodity assignments (e.g., wastewater linked to water). Resolves the linked SA, runs `meter:reads:*` aggregation for that SA. Returns Decimal. Scope: `per_sa`.

This loader is the most complex because it requires a recursive lookup. For Slice 4 we keep it simple: find sibling SAs on the same account+premise via Prisma, sum their `meter_read` quantities for the period. Edge cases (multiple sibling SAs, no sibling) → throw with clear messages.

### ItemsLoader

- `items:<sp_id>:<item_type>` → reads `container` table where `serviceAgreementId = SA's id` (containers are linked to SAs in the schema). Filter by item_type. Returns `Container[]`. Scope: `per_sa`.

The variable key is shaped around `<sp_id>` (service point) but containers in the schema link to SAs directly. Adapt: the loader reads containers by SA id, optionally filters by item_type from the key.

---

## 6. Test strategy

### 6.1 Per-loader unit tests

Each loader has a test file using `bootPostgres` (existing test infrastructure from `_effective-dating-fixtures.ts`). Each test:
1. Spins up a Postgres testcontainer
2. Seeds the necessary rows (account, meter, etc.)
3. Calls the loader with literal keys
4. Asserts the returned `Map<VariableKey, VariableValue>` matches expected values

~5-8 tests per loader, including:
- Happy path: key resolves to value
- Multiple keys batched: single query produces multiple results
- Missing data: loader either throws (for required vars) or returns empty (for optional)
- RLS: tenant isolation honored

### 6.2 Registry tests

`__tests__/registry.test.ts` (no DB needed):
- Register a loader; `validateKey` returns capability
- Register two loaders with conflicting patterns; second throws
- `validateKey` rejects unknown keys
- `validateKey` rejects keys with wrong wildcard types
- `loadVariables` dispatches to correct loaders
- `loadVariables` batches keys per loader
- `describeAll` returns all registered capabilities

### 6.3 `loadBase` test

`__tests__/load-base.test.ts`: seed an SA + assignment + schedule + components. Call `loadBase`. Assert returned `BaseContext` has the right shape — assignments populated, schedule.components ordered, premise + account snapshots correct.

### 6.4 End-to-end integration test

`__tests__/e2e-rating.integration.test.ts`: the proof that everything works together.

```
1. Seed: Bozeman SFR water customer with full Bozeman Water schedule + a meter_read of 12 HCF
2. base = await loadBase(saId, period, utilityId)
3. keys = engine.manifest(base)        // ~5 keys for SFR water
4. vars = await registry.loadVariables(keys)
5. result = engine.rate({ base, vars })
6. assert result.totals.subtotal.toFixed(2) === "69.65"  (matches Slice 3 SFR golden test)
```

If this test passes, the engine + loaders + DB are wired correctly end-to-end.

---

## 7. Risks and open issues

| Risk | Mitigation |
|---|---|
| **Variable key parameter resolution.** The engine's `meter:reads:M-1` references a meter ID that the loader needs to look up. How does the loader know which SA's meter to read? | The loader's `load(keys)` accepts the keys directly and parses meter ID from the pattern. The engine doesn't change. |
| **WQA storage shape may evolve.** | Slice 4 ships the basic table; Slice 5+ may add winter-sample-window config, exception flagging. The current shape covers Slice 3 + 4 needs. |
| **Tenant flag storage.** No `tenant_setting` table exists. Slice 4 adds one. | Small generic key-value table, scoped per-tenant. |
| **LinkedCommodityLoader complexity.** | Keep the slice 4 implementation simple: same-account same-premise sibling SA. Edge cases throw documented errors; Slice 5 can refine. |
| **Items loader's `<sp_id>` mismatch with current Container model.** Container links to SA, not SP. | Loader interprets `items:<sp_id>:<item_type>` by reading containers for SA where `serviceAgreementId = sa.id` and matching `item_type`. The `sp_id` portion is treated as a placeholder for now; Slice 5 may add SP linkage. |
| **Test container startup time.** Each loader test boots Postgres, taking 30-60s. | Use shared `bootPostgres` infrastructure; load all loaders into a single integration suite where it makes sense. |
| **Decimal precision through Prisma.** Prisma returns `Decimal` (Prisma.Decimal class) from queries; loaders must wrap in `decimal.js` Decimal for engine consumption. | Use `toDecimal` helper from rate-engine. |

---

## 8. What changes downstream

| Slice | Built on Slice 4 |
|---|---|
| Slice 5 (Bill Generation) | `loadBase` + registry + engine compose into the bill-generation function. |
| Slice 2 (Configurator UI) | `registry.describeAll()` drives the variable picker in the configurator. |

---

## 9. Acceptance criteria

The slice is **done** when:

- [ ] `packages/api/src/lib/rate-engine-loaders/` module exists with documented file structure
- [ ] `Loader` interface + `LoaderCapability` type defined
- [ ] `VariableRegistry` class with all 6 documented methods + conflict detection
- [ ] All 8 loaders implemented with at least the documented capabilities
- [ ] `loadBase` hydrates a `BaseContext` from Prisma
- [ ] `WqaValue` Prisma model + migration applied
- [ ] `tenant_setting` Prisma model + migration applied (or alternative — see Task 4)
- [ ] Per-loader unit tests pass (~40-60 tests total)
- [ ] Registry tests pass
- [ ] `loadBase` test passes
- [ ] End-to-end test passes — seeded SA produces engine output matching Slice 3 golden test ($69.65 for Bozeman SFR water 12 HCF)
- [ ] Workspace typecheck clean
- [ ] One git commit per task; commit messages reference Slice 4
- [ ] Slice 4 plan executed via subagent-driven-development

---

## 10. Out of scope (explicit)

- API endpoints exposing rating (Slice 5)
- Bill persistence + rendering (Slice 5)
- Bulk prefetch optimization for batch billing (Slice 5)
- Cache layer (defer)
- Configurator UI (Slice 2)
- Auto-WQA winter computation job (later — Slice 5 or beyond)

---

## 11. Implementation note: grouping into tasks

Suggested 8-task breakdown:

1. Loader interface + VariableRegistry + tests
2. AccountLoader + tests
3. MeterLoader + tests (most complex — multiple key patterns, period aggregation)
4. TenantLoader + IndexLoader + PremiseLoader (group — small loaders)
5. WqaValue model + migration + WqaLoader + tests
6. LinkedCommodityLoader + ItemsLoader + tests
7. `loadBase(saId, period)` helper + tests
8. End-to-end integration test + final verification + push

Order: 1 → 2/3/4/5/6 (parallel after 1) → 7 → 8.
