# Rate Model v2 — Slice 1: Schema Foundation — Spec

**Date:** 2026-05-02
**Slice of:** Rate Model v2 (full design at [`docs/specs/07b-rate-model-v2-design.md`](../../specs/07b-rate-model-v2-design.md))
**Reference tariffs:** [Bozeman](../../specs/07a-bozeman-rate-reference.md), [NorthWestern Energy MT](../../specs/07c-northwestern-energy-rate-reference.md)
**Scope:** Schema and API only. No rate engine, no configurator UI, no bill generation.

---

## 1. Goals and non-goals

### Goals

- Replace the legacy `rate_type` + `rate_config` JSONB on `RateSchedule` with a normalised, component-based schema that can express the Bozeman + NorthWestern reference tariffs without code branches.
- Add the supporting entities the v2 design requires: `RateComponent`, `RateComponentKind`, `SAScheduleAssignment`, `RateAssignmentRole`, `RateIndex`, `RateServiceClass`.
- Extend a few existing entities with attributes the new components consult (`Container.size/frequency/item_type`, `Premise.eru_count/impervious_sqft/has_stormwater_infra`).
- Rewrite seed data so dev DB has working v2-shaped tariffs from day one.
- Expose CRUD APIs for the new entities so the configurator (Slice 2) and engine (Slice 3) have a stable surface to build on.

### Non-goals

- **Rate engine.** Slice 3 builds the calculator. Slice 1 only stores data.
- **Visual configurator.** Slice 2. Slice 1 ships JSON-API-only CRUD; tenants edit via the API.
- **Variable loaders / variable registry.** Slice 4. Slice 1 doesn't run any rating, so no loaders needed.
- **Bill generation.** Slice 5. Slice 1 isn't on the bill path.
- **Backward compatibility.** No production users; we wipe and rebuild. No deprecation period, no compat shim.
- **Deep semantic validation of components.** Save-time validation is limited to schema-level Zod checks (kind enum, pricing.type enum, predicate operator enum). Cycle detection on `percent_of` selectors and richer cross-component validation is deferred (Slice 2 client-side, Slice 3 engine-side).
- **`SAScheduleAssignment` history APIs.** CRUD is enough; the engine in Slice 3 will read effective-dated assignments via simple WHERE clauses.

---

## 2. Architecture summary

This slice drops the legacy single-blob rate model and lands the four new entities the v2 design needs. After Slice 1, the database is shape-ready for everything that comes after, but nothing actually rates a bill yet.

Per the design doc: a `RateSchedule` becomes lightweight metadata. The pricing logic lives in a list of `RateComponent` rows hung off it (with `kindCode` referencing the `RateComponentKind` ref table). A service agreement can have **N** schedules attached via `SAScheduleAssignment` (each with a `roleCode` referencing the `RateAssignmentRole` ref table — primary / delivery / supply / rider / opt_in). Indexed pricing types reference values stored in `RateIndex`. Customer class lives in a per-commodity `RateServiceClass` ref table, with an FK on `ServiceAgreement`.

The migration is destructive: drop legacy columns and the existing rate-schedule rows, install new tables, regenerate seed data. There is no production data; this is safe.

---

## 3. Schema changes

### 3.1 Tables to drop

| Table / column | Why |
|---|---|
| `RateSchedule.rate_type` (column) | Replaced by per-component `kind` |
| `RateSchedule.rate_config` (column) | Replaced by `RateComponent` rows |
| `ServiceAgreement.rate_schedule_id` (column) | Replaced by `SAScheduleAssignment` join table |

The legacy data inside these columns is wiped (no dump, no migration). All existing `rate_schedule` rows in dev DB are deleted as part of the migration.

### 3.2 Tables to create

#### `RateComponent`

```prisma
model RateComponent {
  id              String   @id @default(uuid()) @db.Uuid
  utilityId       String   @map("utility_id") @db.Uuid
  rateScheduleId  String   @map("rate_schedule_id") @db.Uuid
  kindCode        String   @map("kind_code") @db.VarChar(50)   // → rate_component_kind.code
  label           String   @map("label") @db.VarChar(255)
  predicate       Json     @map("predicate")          // closed-DSL — see 07b
  quantitySource  Json     @map("quantity_source")    // base + transforms — see 07b
  pricing         Json     @map("pricing")            // typed by kind — see 07b
  sortOrder       Int      @default(100) @map("sort_order")
  effectiveDate   DateTime @map("effective_date") @db.Date
  expirationDate  DateTime? @map("expiration_date") @db.Date
  createdAt       DateTime @default(now()) @map("created_at") @db.Timestamptz
  updatedAt       DateTime @updatedAt @map("updated_at") @db.Timestamptz

  rateSchedule    RateSchedule @relation(fields: [rateScheduleId], references: [id], onDelete: Cascade)

  @@index([rateScheduleId])
  @@index([utilityId, rateScheduleId, sortOrder])
  @@index([kindCode])
  @@map("rate_component")
}
```

`kindCode` is a string referencing `rate_component_kind.code` (see below). No FK constraint at the DB level — the validator at the API layer enforces that the value is one of the registered codes (the codebase has hardcoded behavior per code; see "Why no formula language" in `07b`). JSONB fields validated against Zod schemas. Schemas live in `@utility-cis/shared/validators/rate-component.ts`.

#### `RateComponentKind` (ref table)

```prisma
model RateComponentKind {
  id          String   @id @default(uuid()) @db.Uuid
  utilityId   String?  @map("utility_id") @db.Uuid     // NULL = global default; populated = tenant override
  code        String   @map("code") @db.VarChar(50)
  label       String   @map("label") @db.VarChar(100)
  description String?  @map("description") @db.Text
  sortOrder   Int      @default(100) @map("sort_order")
  isActive    Boolean  @default(true) @map("is_active")
  createdAt   DateTime @default(now()) @map("created_at") @db.Timestamptz
  updatedAt   DateTime @updatedAt @map("updated_at") @db.Timestamptz

  @@unique([utilityId, code])
  @@index([isActive, sortOrder])
  @@map("rate_component_kind")
}
```

Codebase-defined kinds (`service_charge`, `consumption`, …, `minimum_bill`) seeded as **globals** with `utility_id = NULL`. Tenants insert per-utility rows only when they want to relabel, disable, or reorder. Same pattern as `account_type_def` / `premise_type_def` in the existing schema.

The codebase has hardcoded behavior per code (evaluator + Zod schema + configurator editor). New codes require both a code-side registration and a corresponding global row inserted via migration.

#### `SAScheduleAssignment`

```prisma
model SAScheduleAssignment {
  id                  String   @id @default(uuid()) @db.Uuid
  utilityId           String   @map("utility_id") @db.Uuid
  serviceAgreementId  String   @map("service_agreement_id") @db.Uuid
  rateScheduleId      String   @map("rate_schedule_id") @db.Uuid
  roleCode            String   @map("role_code") @db.VarChar(50)   // → rate_assignment_role.code
  effectiveDate       DateTime @map("effective_date") @db.Date
  expirationDate      DateTime? @map("expiration_date") @db.Date
  createdAt           DateTime @default(now()) @map("created_at") @db.Timestamptz
  updatedAt           DateTime @updatedAt @map("updated_at") @db.Timestamptz

  serviceAgreement    ServiceAgreement @relation(fields: [serviceAgreementId], references: [id], onDelete: Cascade)
  rateSchedule        RateSchedule     @relation(fields: [rateScheduleId], references: [id], onDelete: Restrict)

  @@index([serviceAgreementId, effectiveDate])
  @@index([rateScheduleId])
  @@index([roleCode])
  @@map("sa_rate_schedule_assignment")
}
```

Effective-dated. A given (sa_id, role_code) can have multiple rows over time; the active one is the row whose effective range contains the current bill period.

`roleCode` references `rate_assignment_role.code`. Same enforcement model as `kindCode` — string validated by the API layer against registered codes.

A unique constraint enforcing "no overlapping assignments for the same (sa_id, role_code)" is **deferred to Slice 2/3** since enforcing it well requires range-overlap exclusion (similar to `no_overlapping_active_sa` we just dropped). For now, application code is responsible.

#### `RateAssignmentRole` (ref table)

```prisma
model RateAssignmentRole {
  id          String   @id @default(uuid()) @db.Uuid
  utilityId   String?  @map("utility_id") @db.Uuid     // NULL = global default; populated = tenant override
  code        String   @map("code") @db.VarChar(50)
  label       String   @map("label") @db.VarChar(100)
  description String?  @map("description") @db.Text
  sortOrder   Int      @default(100) @map("sort_order")
  isActive    Boolean  @default(true) @map("is_active")
  createdAt   DateTime @default(now()) @map("created_at") @db.Timestamptz
  updatedAt   DateTime @updatedAt @map("updated_at") @db.Timestamptz

  @@unique([utilityId, code])
  @@index([isActive, sortOrder])
  @@map("rate_assignment_role")
}
```

Codebase-defined roles (`primary`, `delivery`, `supply`, `rider`, `opt_in`) seeded as globals with `utility_id = NULL`. Same global-with-overrides pattern as `RateComponentKind`.

#### `RateIndex`

```prisma
model RateIndex {
  id              String   @id @default(uuid()) @db.Uuid
  utilityId       String   @map("utility_id") @db.Uuid
  name            String   @map("name") @db.VarChar(50)        // "fac", "epcc", "cpi", "co2_price"
  period          String   @map("period") @db.VarChar(20)      // "2026-Q2", "2026-current", "2026-05"
  value           Decimal  @map("value") @db.Decimal(18, 8)
  effectiveDate   DateTime @map("effective_date") @db.Date
  expirationDate  DateTime? @map("expiration_date") @db.Date
  description     String?  @map("description") @db.Text
  createdAt       DateTime @default(now()) @map("created_at") @db.Timestamptz
  updatedAt       DateTime @updatedAt @map("updated_at") @db.Timestamptz

  @@unique([utilityId, name, period])
  @@index([utilityId, name, effectiveDate])
  @@map("rate_index")
}
```

Backs `pricing.type = "indexed"`. Tenants edit these rows independently of the components that reference them — quarterly FAC updates don't fork rate schedules.

#### `RateServiceClass`

```prisma
model RateServiceClass {
  id           String   @id @default(uuid()) @db.Uuid
  utilityId    String   @map("utility_id") @db.Uuid
  commodityId  String   @map("commodity_id") @db.Uuid
  code         String   @map("code") @db.VarChar(50)
  label        String   @map("label") @db.VarChar(100)
  sortOrder    Int      @default(100) @map("sort_order")
  isActive     Boolean  @default(true) @map("is_active")
  createdAt    DateTime @default(now()) @map("created_at") @db.Timestamptz
  updatedAt    DateTime @updatedAt @map("updated_at") @db.Timestamptz

  commodity         Commodity         @relation(fields: [commodityId], references: [id], onDelete: Restrict)
  serviceAgreements ServiceAgreement[]

  @@unique([utilityId, commodityId, code])
  @@index([utilityId, commodityId, isActive, sortOrder])
  @@map("rate_service_class")
}
```

Per-commodity, per-tenant. Unlike `RateComponentKind` and `RateAssignmentRole`, there are no globals — each utility's class set is genuinely tenant-specific (Bozeman has `MSU`; another muni doesn't). The same physical premise can be `single_family` for water and `residential` for electric, which is why class is per-(SA, commodity), not per-account.

This is distinct from `Premise.premiseType`, which classifies the property physically. `rate_service_class` is the *billing* classification used by rate components — a SFR home owned by a corporation might be `single_family` physically but billed as `commercial`. See section 3.3 for the columns added to `ServiceAgreement`.

### 3.3 Tables to modify

#### `ServiceAgreement` — add rate service class FK

```prisma
model ServiceAgreement {
  // ... existing fields ...

  rateServiceClassId String? @map("rate_service_class_id") @db.Uuid
  rateServiceClass   RateServiceClass? @relation(fields: [rateServiceClassId], references: [id], onDelete: SetNull)

  // DROP: rateScheduleId, rateSchedule relation

  // NEW reverse relation
  rateScheduleAssignments SAScheduleAssignment[]

  @@index([rateServiceClassId])
}
```

`rateServiceClassId` is **nullable** for backward-data-shape reasons during migration but conceptually required. Seed sets it on every SA. A future slice can tighten to NOT NULL.

#### `Container` — add catalog attributes

```prisma
model Container {
  // ... existing fields ...

  size        String? @map("size") @db.VarChar(20)        // "35-gal", "65-gal", "95-gal", etc.
  frequency   String? @map("frequency") @db.VarChar(20)   // "weekly", "monthly", "biweekly"
  itemType    String? @map("item_type") @db.VarChar(50)   // "garbage_cart", "recycling_cart", "organics_cart", "lighting_fixture"
}
```

Nullable to avoid breaking existing solid-waste records; seed populates them.

#### `Premise` — add stormwater attributes

```prisma
model Premise {
  // ... existing fields ...

  eruCount             Decimal? @map("eru_count") @db.Decimal(8, 2)        // computed or manually set
  impervioussSqft      Int?     @map("impervious_sqft")                    // basis for ERU when present
  hasStormwaterInfra   Boolean  @default(false) @map("has_stormwater_infra")
}
```

Nullable. Seed sets sensible defaults (1 ERU for SFR, computed for commercial).

### 3.4 Migration order

The legacy `rate_type`/`rate_config` and `rate_schedule_id` are referenced by routes and services that we're rewriting in this slice. Order matters:

1. Add new ref tables (`rate_component_kind`, `rate_assignment_role`) + insert globals.
2. Add new entity tables (`rate_service_class`, `rate_component`, `sa_rate_schedule_assignment`, `rate_index`).
3. Add new columns on existing tables (`ServiceAgreement.rate_service_class_id`, `Container.size/frequency/item_type`, `Premise.eru_count/impervious_sqft/has_stormwater_infra`).
4. Drop legacy columns (`RateSchedule.rate_type`, `rate_config`; `ServiceAgreement.rate_schedule_id`).
5. **Wipe rate-schedule rows** (DELETE FROM rate_schedule). They're dev-only; no production rows.
6. Update Prisma schema in tandem; regenerate client.
7. Update existing services/routes that referenced legacy columns.
8. Rewrite seed.

The migration is one big `.sql` file. No multi-step deploy.

---

## 4. API surface

### 4.1 New endpoints

#### `/api/v1/rate-service-classes`

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/v1/rate-service-classes` | List, filterable by `commodityId` |
| `GET` | `/api/v1/rate-service-classes/:id` | Get one |
| `POST` | `/api/v1/rate-service-classes` | Create |
| `PATCH` | `/api/v1/rate-service-classes/:id` | Update |
| `DELETE` | `/api/v1/rate-service-classes/:id` | Soft-delete (sets `is_active = false`) |

#### `/api/v1/rate-component-kinds`

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/v1/rate-component-kinds` | List globals + tenant overrides; configurator uses this for kind picker labels |
| `GET` | `/api/v1/rate-component-kinds/:id` | Get one |
| `POST` | `/api/v1/rate-component-kinds` | Create tenant override (must reference a known global code) |
| `PATCH` | `/api/v1/rate-component-kinds/:id` | Update tenant override (label, sort_order, is_active) |
| `DELETE` | `/api/v1/rate-component-kinds/:id` | Hard-delete tenant override (global rows are protected) |

The list endpoint returns the **resolved** view: globals merged with tenant overrides, override winning where both exist. POST is restricted to tenant rows only — globals are seeded by migration.

#### `/api/v1/rate-assignment-roles`

Same shape as `/api/v1/rate-component-kinds`. Globals seeded as `primary`, `delivery`, `supply`, `rider`, `opt_in`. Tenants override only to relabel or disable.

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/v1/rate-assignment-roles` | List globals + tenant overrides |
| `GET` | `/api/v1/rate-assignment-roles/:id` | Get one |
| `POST` | `/api/v1/rate-assignment-roles` | Create tenant override |
| `PATCH` | `/api/v1/rate-assignment-roles/:id` | Update tenant override |
| `DELETE` | `/api/v1/rate-assignment-roles/:id` | Hard-delete tenant override |

#### `/api/v1/rate-schedules` (rewritten)

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/v1/rate-schedules` | List schedules (no nested components) |
| `GET` | `/api/v1/rate-schedules/:id` | Get schedule + included components in `sort_order` |
| `POST` | `/api/v1/rate-schedules` | Create schedule (metadata only; components added separately) |
| `PATCH` | `/api/v1/rate-schedules/:id` | Update schedule metadata |
| `POST` | `/api/v1/rate-schedules/:id/revise` | Existing — keeps the supersedes-chain semantic |

The list/get response shape changes (component-shaped). All callers of these routes need updating in the same slice.

#### `/api/v1/rate-schedules/:scheduleId/components`

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/v1/rate-schedules/:scheduleId/components` | List components for a schedule |
| `POST` | `/api/v1/rate-schedules/:scheduleId/components` | Create component on schedule |
| `GET` | `/api/v1/rate-components/:id` | Get one component |
| `PATCH` | `/api/v1/rate-components/:id` | Update component |
| `DELETE` | `/api/v1/rate-components/:id` | Hard-delete (no audit trail need yet) |

Components are scoped to schedules. The component CRUD is straightforward Zod-validated JSON; richer save-time validation (cycle detection) defers to Slice 2/3.

#### `/api/v1/sa-rate-schedule-assignments`

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/v1/sa-rate-schedule-assignments?serviceAgreementId=...` | List assignments for an SA |
| `POST` | `/api/v1/sa-rate-schedule-assignments` | Create assignment (sa_id, schedule_id, role, dates) |
| `PATCH` | `/api/v1/sa-rate-schedule-assignments/:id` | Update (typically expiration_date for end-dating) |
| `DELETE` | `/api/v1/sa-rate-schedule-assignments/:id` | Hard-delete (only if it never went into effect) |

Embedded in the SA detail response too (similar to how meters embed in SA detail today).

#### `/api/v1/rate-indices`

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/v1/rate-indices?name=...` | List, filterable by index name |
| `POST` | `/api/v1/rate-indices` | Create a new (name, period, value) row |
| `PATCH` | `/api/v1/rate-indices/:id` | Update value or effective_date |
| `DELETE` | `/api/v1/rate-indices/:id` | Hard-delete |

### 4.2 Modified endpoints

#### `/api/v1/service-agreements/:id` — response shape change

Existing detail response embeds `rateSchedule`. After this slice, embed `rateScheduleAssignments` instead, each with the resolved schedule + active components:

```jsonc
{
  id: "...",
  agreementNumber: "...",
  rateServiceClassId: "...",
  rateServiceClass: { code: "single_family", label: "Single Family" },
  // ... other fields ...
  rateScheduleAssignments: [
    {
      id: "...",
      roleCode: "primary",
      effectiveDate: "...",
      expirationDate: null,
      rateSchedule: {
        id: "...",
        name: "Bozeman Water 2025-09",
        components: [/* sorted by sort_order */]
      }
    }
  ]
}
```

The web SA detail page consumes this shape; one or two pages need touch-ups since they currently read `sa.rateSchedule.X`.

### 4.3 Validators (shared package)

New Zod schemas in `packages/shared/src/validators/`:
- `rate-service-class.ts` — `createRateServiceClassSchema`, `updateRateServiceClassSchema`, `rateServiceClassQuerySchema`
- `rate-component-kind.ts` — `createRateComponentKindSchema`, `updateRateComponentKindSchema`, query
- `rate-assignment-role.ts` — `createRateAssignmentRoleSchema`, `updateRateAssignmentRoleSchema`, query
- `rate-component.ts` — `createRateComponentSchema`, `updateRateComponentSchema`, plus the closed-grammar Zod definitions for `predicate`, `quantitySource`, and `pricing` JSON shapes
- `sa-rate-schedule-assignment.ts` — `create…`, `update…`, query
- `rate-index.ts` — `create…`, `update…`, `rateIndexQuerySchema`

Existing `rate-schedule.ts` validators get pruned: drop the `createRateScheduleSchema`'s `rateType` + `rateConfig` fields; keep only metadata. The `reviseRateScheduleSchema` we just added stays.

The component validator is the meatiest. It needs:

- `kindCode` validated against the registered codes (closed grammar: `service_charge`, `consumption`, …, `minimum_bill`)
- `predicate` validated against the closed-grammar operator schema (covering all operators in 07b's predicate list)
- `quantitySource` validated against the base + transforms grammar
- `pricing` validated against the type-specific schema (different shape for `flat` vs `tiered` vs `lookup` vs `catalog` vs `per_unit` vs `percent_of` vs `indexed` vs `floor`), with valid pricing types narrowed by `kindCode`

The `roleCode` field on `SAScheduleAssignment` validates similarly against the registered role codes.

This pair (the component + assignment validators) is Slice 1's biggest piece of code. Plan accordingly.

---

## 5. Seed data

The seed produces three working tariffs covering the Bozeman commodities (using the actual published rates) plus a small NWE-style electric tariff for forcing-function coverage of TOU + demand. Plus the global ref-table rows that the codebase ships with.

### 5.1 Global ref-table rows (utility_id = NULL)

Seeded **once** for the database, visible to every tenant:

**`rate_component_kind`** — 11 globals:
`service_charge`, `consumption`, `derived_consumption`, `non_meter`, `item_price`, `one_time_fee`, `surcharge`, `tax`, `credit`, `reservation_charge`, `minimum_bill`. Each row has a default label (e.g. `service_charge` → "Service Charge") and a `sort_order` matching configurator picker convention.

**`rate_assignment_role`** — 5 globals:
`primary`, `delivery`, `supply`, `rider`, `opt_in`. Default labels match (e.g. `delivery` → "Delivery").

### 5.2 Per-tenant rate service classes

Seeded per commodity for the dev-tenant from the reference docs:

- Water: `single_family`, `multi_family`, `government`, `msu`, `commercial`
- Wastewater: `residential`, `multi_family`, `commercial`, `government`, `msu`, `industrial`
- Stormwater: `residential`, `commercial` (drives credit eligibility but not pricing)
- Solid Waste: `residential`, `commercial`
- Electric (for NWE-style example): `residential`, `small_commercial`, `large_commercial`, `irrigation`, `lighting`

(Codes are lowercased; labels match the published reference docs — "Single Family", "Multi-Family", etc.)

### 5.3 Rate schedules + components

Three tariffs seeded as full component sets:

#### Bozeman Water 2025-09

- 1 `service_charge` component with `pricing.type = lookup` keyed by meter size (8 entries)
- 5 `consumption` components (one per class) — Single Family is `tiered`, others are `flat`
- 1 `minimum_bill` for Single Family (≤ 2 HCF, $6.62 floor)
- 1 `surcharge` for drought reserve ($0.11/HCF, predicate `drought_stage_active`)
- 1 `surcharge` for drought stage % adder (target: water consumption, percent table; predicate `drought_stage_active`)

≈ 9 components total.

#### Bozeman Sewer 2025-09

- 3 `service_charge` components (Residential / mid-class / Industrial — different rates)
- 6 `derived_consumption` components — 2 with `quantitySource.base = wqa` (Residential, Multi-Family), 4 with `quantitySource.base = linked_commodity` referencing water (Commercial, Government, MSU, Industrial)

≈ 9 components total.

#### Bozeman Stormwater 2025-09

- 1 `service_charge` (flat $4.81)
- 1 `non_meter` component (per-ERU, source: `premise:attr:eru_count`)
- 1 `credit` (45% of variable, predicate `premise.has_stormwater_infra = true`)

3 components total.

#### Bozeman Solid Waste 2025-09

- 3 `item_price` components (one per item_type: garbage / recycling / organics), each with a catalog table

3 components total.

#### NWE-style Residential Electric — three schedules to demonstrate multi-assignment

- **Schedule A: REDS-1-style "Residential Delivery"** with `service_charge` ($4.20) + `consumption` (per-kWh delivery rate) + `surcharge` (delivery tax 0.0117650/kWh)
- **Schedule B: ESS-1-style "Default Supply"** with `consumption` (per-kWh supply rate, `pricing.type = indexed` referencing a `RateIndex` row)
- **Schedule C: USBC-style "Universal System Benefits Charge"** with `surcharge` ($0.0024/kWh, predicate-free)

These three schedules are then attached to one seed SA via three `SAScheduleAssignment` rows with `roleCode` values `delivery`, `supply`, `rider`.

### 5.4 Rate indices

Seeded rows:
- `(name: "fac", period: "2026-Q2", value: 0.00125)`
- `(name: "epcc", period: "2026-current", value: 0.00050)`
- `(name: "supply_residential", period: "2026-Q2", value: 0.07000)` — referenced by NWE Schedule B's indexed pricing

### 5.5 SA assignments

Existing seed SAs get `SAScheduleAssignment` rows pointing at the seeded schedules. At least one SA gets the multi-schedule electric setup to exercise N-schedules-per-SA.

### 5.6 Container attributes

Existing seed containers (solid-waste carts) get populated `size`, `frequency`, `item_type` matching the catalog keys in the Solid Waste schedule's components.

### 5.7 Premise attributes

Seed premises get `eru_count` (1 for SFR, computed at 1 ERU per 2,700 sqft for commercial), `has_stormwater_infra` (`true` on a couple of seed premises to exercise the credit).

---

## 6. Test strategy

### 6.1 Unit tests — Zod validators

New test file per validator. For the component validator specifically, test each `kind` × each `pricing.type` combination as a positive case and at least one negative case per branch (wrong pricing type for kind, missing required field in predicate, unknown operator, etc.).

≈ 40-60 tests in `packages/shared/src/validators/__tests__/rate-component.test.ts`.

### 6.2 Integration tests — API routes

For each new endpoint family (rate-service-classes, rate-component-kinds, rate-assignment-roles, rate-components, sa-rate-schedule-assignments, rate-indices):

- Create + read round-trip
- List with filters
- Update
- Delete (where defined)
- Tenant isolation (RLS holds)
- Authorization (correct module/permission gates)

Existing `rate-schedules` integration tests get rewritten to match the new shape.

≈ 30-40 integration tests in `packages/api/src/__tests__/integration/`.

### 6.3 End-to-end shape tests

A few tests that stand up a complete tariff via the API and read it back:

- Create Bozeman Water schedule (1 schedule + 9 components + drought-related surcharges) via API
- Create an SA with `rate_service_class_id` set, attach the water schedule via assignment, fetch SA detail and assert the embedded shape
- Create three NWE-style schedules and attach all three to one SA, fetch SA detail and assert three assignments

These verify the API surface holds together end-to-end without any rate-engine logic.

≈ 5-8 tests.

### 6.4 Seed sanity test

After running the seed, query:
- All seeded schedules have at least one component
- All seeded SAs have at least one `SAScheduleAssignment`
- Component JSON validates against current Zod schemas (catches drift between seed and validator)
- All seeded rate service classes have unique `(utility_id, commodity_id, code)`
- Globals in `rate_component_kind` and `rate_assignment_role` exist with `utility_id IS NULL` and the expected codes

This is one integration test that loads the seed and walks the result.

### 6.5 Type-check + dev-DB migration smoke

- `pnpm -w typecheck` clean
- `prisma migrate deploy` applies cleanly to a freshly-reset dev DB
- `seed_db.bat` populates without errors
- The dev API server starts and serves the new endpoints

---

## 7. Risks and open issues

| Risk | Mitigation |
|---|---|
| **Rate-component validator is large.** Closed grammar covers ~10 kinds, ~8 pricing types, ~10 predicate operators, ~9 quantity transforms, ~7 selector ops. Zod schemas for the discriminated unions can get sprawling. | Keep each grammar piece in its own file under `validators/rate-grammar/`. Compose into the master schema. Refactor only if it gets unwieldy. |
| **Seed data maintenance.** Seeded tariffs must validate against the shipped Zod schemas; drift breaks dev. | Seed sanity test (6.4) catches drift. Run on every CI build. |
| **Component sort_order conflicts.** Two components with the same sort_order is technically allowed but ambiguous when `percent_of` ordering is computed. | For now: stable sort — ties broken by `id` ascending. Document. Slice 3 may add a uniqueness constraint. |
| **`SAScheduleAssignment` with overlapping ranges per (sa_id, role_code).** No DB constraint enforces uniqueness; bad data possible. | Application-level check on POST/PATCH. Add the exclusion constraint in a follow-up slice once the multi-SP-per-SA UX shapes things. |
| **Ref-table sync with code.** `rate_component_kind` and `rate_assignment_role` globals must stay in sync with the codebase's hardcoded per-code behavior. A code-side registration without a global row (or vice versa) breaks the configurator picker or save-time validation. | Single registration helper at app startup that emits both the code-side registration AND the global row (idempotent). Smoke test asserts `registered_codes == globals_in_db` for both tables. |
| **Web pages still calling `sa.rateSchedule`.** A few customer-facing and admin pages embed rate schedule details. | Inventory all reads of `sa.rateSchedule` during implementation and update in the same slice. Same dance as the SP migration's Slice 2. |
| **No engine means no smoke-test that the seeded tariffs are *correct*.** A typo in a seeded component could go unnoticed until Slice 3. | Tariff golden tests come in Slice 3; for now, seed sanity (validator pass) + manual review of seed data is the bar. |

---

## 8. What changes downstream of this slice

| Slice | Depends on | Changes after Slice 1 |
|---|---|---|
| Slice 2 (configurator UI) | Component CRUD endpoints, RateServiceClass list, RateIndex list, RateComponentKind list, RateAssignmentRole list | UI built against the shipped APIs |
| Slice 3 (rating engine) | All new entities + Container/Premise extensions + seeded tariffs | Engine reads them via Prisma |
| Slice 4 (variable loaders) | ServiceAgreement.rateServiceClassId (for AccountLoader), Premise.eru_count (for PremiseLoader) | Loaders fetch from the v2 columns |
| Slice 5 (bill generation) | Slice 4 + Module 9 | — |

---

## 9. Acceptance criteria

The slice is **done** when:

- [ ] All six new tables (`rate_component`, `rate_component_kind`, `sa_rate_schedule_assignment`, `rate_assignment_role`, `rate_index`, `rate_service_class`) exist in dev DB with the documented schemas
- [ ] `rate_type`, `rate_config`, `rate_schedule_id` columns are gone
- [ ] `Container` has `size`, `frequency`, `item_type`; `Premise` has `eru_count`, `impervious_sqft`, `has_stormwater_infra`; `ServiceAgreement` has `rate_service_class_id`
- [ ] Globals in `rate_component_kind` (11 codes) and `rate_assignment_role` (5 codes) are present and match the codebase's registered set
- [ ] All new CRUD APIs respond and round-trip cleanly
- [ ] `service-agreements/:id` detail returns the new shape (assignments embedded, no top-level rateSchedule)
- [ ] Seed produces working v2 tariffs for water/sewer/stormwater/solid-waste plus NWE-style residential electric
- [ ] Seed sanity test passes
- [ ] All Zod validators have unit-test coverage per the closed grammar
- [ ] `pnpm -w typecheck` clean
- [ ] All integration tests pass
- [ ] Web pages that previously read `sa.rateSchedule` are updated
- [ ] Single git commit per task; commit messages reference Slice 1
- [ ] Slice 1 plan executed via subagent-driven-development with two-stage review per task

---

## 10. Out of scope (explicit)

To keep the slice tight, deferred to later:

- Visual configurator UI
- Save-time cycle detection for `percent_of` selectors
- Rate engine and any quantity computation
- Variable loaders, registry, bulk prefetch
- Bill generation, line-item rendering, PDF
- WQA computation and storage table (the `quantitySource.base = "wqa"` references are seedable as JSON; Slice 3 wires the actual lookup)
- Per-tenant ordering/scheduling of bill runs
- Effective-dating exclusion constraint on `SAScheduleAssignment` (cycle/overlap)
- Prisma Studio fixtures for the configurator (Slice 2 concern)

---

## 11. Implementation note: grouping into tasks

A reasonable task breakdown for the writing-plans skill (each task is self-contained, ~1-3 files, with TDD):

1. Add `RateComponentKind` + `RateAssignmentRole` ref tables + globals seed + CRUD APIs + tests
2. Add `RateServiceClass` model + tenant seed + CRUD API + tests
3. Drop legacy columns (`rate_type`, `rate_config` from RateSchedule; `rate_schedule_id` from SA) + wipe rate_schedule rows
4. Add `RateComponent` model + Zod validators (component, predicate, quantity_source, pricing) + tests for validators
5. Add `RateComponent` CRUD API + integration tests
6. Add `SAScheduleAssignment` model + CRUD API + tests
7. Add `RateIndex` model + CRUD API + tests
8. Extend `Container` (size/frequency/item_type), `Premise` (eru_count/impervious_sqft/has_stormwater_infra), `ServiceAgreement` (rate_service_class_id)
9. Update `ServiceAgreement` detail API to embed `rateScheduleAssignments` + update web pages reading `sa.rateSchedule`
10. Rewrite seed data (water, sewer, stormwater, solid waste, NWE-style electric) + seed sanity test
11. Final verification — `pnpm -w typecheck`, full integration suite, smoke psql, push

Roughly 11 tasks. Suggested order: 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9 → 10 → 11. Tasks 6 and 7 can run in parallel after 5 if convenient. Task 1 must come before tasks 4 and 6 because the component validator and assignment validator both validate against the seeded ref-table codes.
