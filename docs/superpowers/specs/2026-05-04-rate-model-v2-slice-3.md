# Rate Model v2 — Slice 3: Rating Engine — Spec

**Date:** 2026-05-04
**Slice of:** Rate Model v2 (full design at [`docs/specs/07b-rate-model-v2-design.md`](../../specs/07b-rate-model-v2-design.md))
**Reference tariffs:** [Bozeman](../../specs/07a-bozeman-rate-reference.md), [NorthWestern Energy MT](../../specs/07c-northwestern-energy-rate-reference.md)
**Builds on:** Slice 1 ([`2026-05-02-rate-model-v2-slice-1.md`](./2026-05-02-rate-model-v2-slice-1.md), shipped at `8b9e38f`)
**Scope:** Pure rating engine. No variable loaders (Slice 4), no UI (Slice 2 reordered to come after), no bill persistence (Slice 5).

---

## 1. Goals and non-goals

### Goals

- Build a **pure function** `rate(ctx) → RatingResult` that evaluates rate components against a billing context and returns line items + totals + audit trace.
- Build a `manifest(base) → VariableKey[]` companion that declares what dynamic variables the active components require — without loading any.
- Implement evaluators for every entry in the closed grammar landed in Slice 1: 8 pricing types, 7 quantity sources, 9 transforms, 19 predicate operators, 9 selector ops.
- Implement topological sort over `percent_of` selectors so dependent components evaluate after their targets, with cycle detection at engine load time.
- **Prove the design works end-to-end** by passing tariff-level golden tests against all four Bozeman tariffs (water with drought / sewer with WQA + linked commodity / stormwater with ERU + credit / solid waste with catalog) plus the NWE multi-schedule electric (delivery + supply + USBC).

### Non-goals

- **Variable loaders.** Slice 4. The engine receives `vars: Map<VariableKey, VariableValue>` from the caller; it never fetches.
- **Bulk prefetch / scope-aware batching.** Slice 4 — the engine's contract is one SA per call.
- **Bill persistence.** Slice 5. Engine returns a `RatingResult`; the caller decides what to do with it.
- **Configurator UI.** Slice 2 (after this slice).
- **Effective-dating exclusion constraints.** Slice 2/3 boundary; deferred. Engine handles whatever assignment data the caller passes — overlap detection is not its job.
- **Rebill semantics.** Engine purity makes rebill trivial later (re-run with new vars and diff); not implemented in this slice.
- **`SAScheduleAssignment` overlap validation.** Application/UI concern.
- **Real-time pricing (RTP), CPP event days, NEM 3.0, power-factor full implementation.** All deferred to later slices when a customer needs them; the engine architecture supports them as additional named pricing types and transforms.

---

## 2. Architecture summary

The engine lives entirely in one new module: `packages/api/src/lib/rate-engine/`. It's a pure function library (no Fastify routes, no Prisma reads, no side effects). Tests run it against literal `RatingContext` values, asserting the resulting `LineItem[]` and totals.

The contract from `07b`:

```
                       BaseContext (sa, account, premise, period)
                                    │
                          engine.manifest(base)
                                    │
                                    ▼
                        VariableKey[] — what to fetch
                                    │
                                    │ (caller fetches; Slice 4 makes this turnkey)
                                    ▼
                          ctx = base + vars
                                    │
                          engine.rate(ctx)
                                    │
                                    ▼
                            RatingResult
                            ├─ lines: LineItem[]
                            ├─ totals: { subtotal, taxes, credits, total, minimum_floor_applied }
                            └─ trace: ComponentTrace[]
```

The engine runs **per SA, per period**. It walks all `SAScheduleAssignment` rows active in the period, pulls every active `RateComponent` from each assigned schedule, evaluates them in topological order, and emits one `LineItem` per fired component (skipping silent ones).

### Module structure (proposed)

```
packages/api/src/lib/rate-engine/
├── index.ts                    # public exports (rate, manifest, types)
├── types.ts                    # RatingContext, RatingResult, LineItem, ComponentTrace, etc.
├── rate.ts                     # main rate(ctx) orchestrator
├── manifest.ts                 # manifest(base) extractor
├── evaluators/
│   ├── predicate.ts            # evaluatePredicate(predicate, ctx) → boolean
│   ├── quantity-source.ts      # resolveQuantity(source, ctx) → Decimal
│   ├── transforms.ts           # applyTransforms(transforms, qty, ctx) → Decimal
│   ├── pricing.ts              # applyPricing(pricing, qty, lines, ctx) → Decimal
│   ├── selectors.ts            # evaluateSelector(selector, lines) → LineItem[]
│   └── floor.ts                # apply minimum_bill components last
├── ordering/
│   ├── topo-sort.ts            # topological sort over percent_of selectors
│   └── cycle-detect.ts         # cycle detection (used at load time and in tests)
└── __tests__/
    ├── predicate.test.ts
    ├── quantity-source.test.ts
    ├── transforms.test.ts
    ├── pricing.test.ts
    ├── selectors.test.ts
    ├── ordering.test.ts
    ├── manifest.test.ts
    ├── rate.test.ts                          # unit-level orchestration
    └── tariff-golden/                        # tariff-level integration tests
        ├── bozeman-water-sfr.test.ts
        ├── bozeman-water-multi-family.test.ts
        ├── bozeman-sewer-wqa.test.ts
        ├── bozeman-sewer-linked.test.ts
        ├── bozeman-stormwater.test.ts
        ├── bozeman-solid-waste.test.ts
        └── nwe-residential-electric.test.ts
```

Why module structure matters: each evaluator is independently testable with literal inputs. The orchestrator just composes them. The tariff golden tests are the regression net — they assert that the engine produces correct dollar amounts for known tariffs against known consumption profiles.

---

## 3. Public API

### Types

```typescript
export interface RatingContext {
  base: BaseContext;
  vars: Map<VariableKey, VariableValue>;
}

export interface BaseContext {
  sa: ServiceAgreementSnapshot;
  account: AccountSnapshot;
  premise: PremiseSnapshot;
  period: { startDate: Date; endDate: Date };
  // assignments and components are loaded by the caller before invoking rate()
  assignments: ResolvedAssignment[];
}

export interface ResolvedAssignment {
  id: string;
  rateScheduleId: string;
  roleCode: string;
  effectiveDate: Date;
  expirationDate: Date | null;
  schedule: {
    id: string;
    name: string;
    code: string;
    version: number;
    components: RateComponentSnapshot[];
  };
}

export interface RateComponentSnapshot {
  id: string;
  rateScheduleId: string;
  kindCode: string;
  label: string;
  predicate: unknown;       // validated as PredicateSchema; passed through here
  quantitySource: unknown;
  pricing: unknown;
  sortOrder: number;
  effectiveDate: Date;
  expirationDate: Date | null;
}

export interface ServiceAgreementSnapshot {
  id: string;
  utilityId: string;
  accountId: string;
  premiseId: string;
  commodityId: string;
  rateServiceClassCode?: string;          // resolved by caller
}

export interface AccountSnapshot { /* fields TBD per AccountLoader needs */ }
export interface PremiseSnapshot {
  id: string;
  premiseType: string;
  eruCount: number | null;
  hasStormwaterInfra: boolean;
  // ... whatever else premise predicates need
}

export type VariableKey = string;          // e.g., "meter:reads:M-12345"
export type VariableValue = unknown;       // typed at the caller; engine inspects per-key

export interface RatingResult {
  lines: LineItem[];
  totals: {
    subtotal: Decimal;
    taxes: Decimal;
    credits: Decimal;
    minimumFloorApplied: boolean;
    total: Decimal;
  };
  trace: ComponentTrace[];
}

export interface LineItem {
  label: string;
  amount: Decimal;
  kindCode: string;
  sourceScheduleId: string;
  sourceComponentId: string;
  quantity?: Decimal;
  rate?: unknown;
}

export interface ComponentTrace {
  componentId: string;
  fired: boolean;
  skipReason?: "predicate_false" | "selector_empty" | "zero_amount" | "silent_minimum";
  evaluatedQuantity?: Decimal;
  evaluatedRate?: unknown;
  evaluatedAmount?: Decimal;
  variableKeysUsed?: VariableKey[];
}
```

Decimal arithmetic uses **`decimal.js`** (already in the workspace via Prisma's runtime — confirm import path during implementation). All money/quantity math goes through `Decimal` to avoid float drift.

### Functions

```typescript
export function manifest(base: BaseContext): VariableKey[];
export function rate(ctx: RatingContext): RatingResult;

// Optional helpers exposed for tests / configurator save-time validation:
export function detectCycles(components: RateComponentSnapshot[]): CycleReport | null;
export function topoSortComponents(components: RateComponentSnapshot[]): RateComponentSnapshot[];
```

Both `rate` and `manifest` are **pure**: same inputs → same outputs. No DB, no clock reads (the caller provides `period`), no environment variables.

---

## 4. Evaluator behaviors

### 4.1 Predicate

`evaluatePredicate(predicate, ctx) → boolean`

Each operator in the closed grammar (predicate.ts) gets a deterministic evaluator. Empty `{}` returns `true`. Unknown operators throw — they should have been caught by Zod at save time, so this is a defensive last-line.

Operators that consult `vars`:
- `qty_gte`, `qty_lte` — read `ctx.vars.get(predicate.qty_gte.var)` and compare
- `customer_attr` — read account-side variable
- `premise_attr` — read `ctx.base.premise[attr]` (premise is part of BaseContext, not vars)
- `class` / `class_in` — read `ctx.base.sa.rateServiceClassCode`
- `meter_size` / `meter_size_in` — read meter-size variable from vars
- `season` — derive from `ctx.base.period`
- `tou_window` — defer to Slice 5 (no Bozeman/NWE-residential tariff exercises this in Slice 3 golden tests; throw a documented "TOU evaluation not implemented" if encountered)
- `drought_stage_active` — read tenant flag from vars
- `meter_role` — read meter-role variable from vars
- `period` — compare `ctx.base.period` against operator's `from`/`to`

### 4.2 Quantity source + transforms

`resolveQuantity(quantitySource, ctx) → Decimal`

Walks the base + transforms chain:

```typescript
function resolveQuantity(qsource, ctx) {
  let qty = lookupBase(qsource.base, qsource, ctx);
  for (const t of qsource.transforms ?? []) {
    qty = applyTransform(t, qty, ctx);
  }
  return qty;
}
```

Bases:
- `metered` → variable lookup `meter:reads:<meter_id>`
- `wqa` → variable lookup `wqa:current:<sa_id>`
- `premise_attribute` → reads `ctx.base.premise[qsource.source_attr]` (e.g. `eruCount`)
- `linked_commodity` → variable lookup `linked:<commodity>:current_period`
- `item_count` → variable lookup `items:<sp_id>:<item_type>` (Slice 3 returns count via array length)
- `peak_demand` → variable lookup `meter:peak_demand:<meter_id>:current` (Bozeman/NWE residential don't exercise this in Slice 3 golden tests; throw if encountered)
- `fixed` → returns `Decimal(1)` — used for service charges

Transforms:
- `ratchet` → `max(qty, prior_peak * percent / 100)` (needs `meter:peak_demand:*:lookback_*` var)
- `clamp` → `clamp(qty, min, max)`
- `net` → `max(0, qty - subtract_var)` (subtract is a variable key)
- `prorate` → `qty * days_in_period / standard_days`
- `subtract_linked_commodity` → `qty - linked_commodity_qty`
- `tou_window_filter` — defer
- `power_factor`, `load_factor` — defer
- `floor` → `max(qty, min)` (numeric floor on quantity)

Slice 3 golden tests don't exercise ratchet, tou_window_filter, power_factor, or load_factor. Implement the supported ones; throw documented "not yet implemented" for the rest.

### 4.3 Pricing

`applyPricing(pricing, qty, lines, ctx) → Decimal`

Discriminated on `pricing.type`:

| Type | Logic |
|---|---|
| `flat` | `Decimal(rate) × qty` |
| `tiered` | Walk tiers, sum quantity × rate per bracket. Handles `to: null` for unbounded final tier. |
| `lookup` | Read `ctx.vars.get(...)` per `pricing.by` (e.g., `meter:size:<meter_id>`) → table[value] × qty |
| `catalog` | Multi-key lookup. Iterate items (from `items:*` variable) and sum table[joinKey] for each |
| `per_unit` | `Decimal(rate) × qty` (similar to flat but typically used with non-meter quantities like ERU) |
| `percent_of` | `evaluateSelector(selector, lines).sum(amount) × percent / 100` |
| `indexed` | `vars.get(index:<name>:<period>) × qty × multiplier` |
| `floor` | Special case — handled separately in Stage 5 (after all base lines computed) |

### 4.4 Selectors

`evaluateSelector(selector, lines) → LineItem[]`

Filters `lines` by the closed-grammar selector ops:
- `component_id` → matches one specific line
- `kind` / `kind_in` → matches by kindCode
- `exclude_kind` → matches everything NOT in the list
- `source_schedule_id` → matches lines from a specific schedule
- `source_schedule_role` → matches lines from schedules assigned with role X (engine knows roles via the assignments)
- `has_label_prefix` → string prefix match on label
- `and` / `or` → boolean composition

Returns the filtered LineItem subset. Caller (`applyPricing` for `percent_of`) sums `amount` field.

### 4.5 Topological ordering

`topoSortComponents(components) → RateComponentSnapshot[]`

Builds a DAG where component A depends on component B if A's pricing has `percent_of` selector matching B (by id, kind, role, etc.). Topologically sort; ties broken by `sortOrder`.

`detectCycles(components) → CycleReport | null` — runs same DAG; returns the offending cycle or `null` if acyclic. Used by configurator at save time (Slice 2) and by engine at rate time as a defensive check (should never fire in practice).

`minimum_bill` components are forced to the **end** of the order regardless of `sortOrder`.

### 4.6 Manifest extraction

`manifest(base) → VariableKey[]`

For each active assignment + active component:
- Walk predicate, quantitySource, pricing
- Collect every `{var: "..."}` reference plus implicit lookups (e.g. `metered` base implicitly references `meter:reads:<meter_id>`)
- Resolve template parameters (`<meter_id>` → real ID from `base.sa` or premise)
- Return distinct keys

The function does **not** emit the assignments / components / schedules themselves — those are part of `BaseContext`, loaded by the caller before `manifest` is called.

---

## 5. Test strategy

### 5.1 Unit tests (per evaluator)

For each evaluator file (predicate.ts, quantity-source.ts, transforms.ts, pricing.ts, selectors.ts, ordering.ts):

A test file with one positive case per branch + one negative/edge case where applicable. ~8-12 tests per file.

### 5.2 Tariff-level golden tests

The regression net. Each test file:
- Constructs a literal `RatingContext` (no DB, no API)
- Calls `rate(ctx)`
- Asserts the line items and totals match expected dollar amounts derived from the published rates

**Bozeman Water — SFR profile** (`bozeman-water-sfr.test.ts`):
- 5/8" meter, 12 HCF, no drought
- Expected: Service charge $22.31 + tier-walked usage at $42.30 = $64.61 subtotal, no minimum_bill triggered
- Tests: tier walking, service charge lookup, predicate gating (multi-family components silent)

**Bozeman Water — Multi-Family with drought stage 2 active** (`bozeman-water-multi-family.test.ts`):
- 1" meter, Multi-Family class, 50 HCF, drought_stage_active=true
- Expected: Service charge $29.56 + flat consumption $150.50 + drought reserve $5.50 + drought stage % surcharge 25% × $150.50 = $37.625 → total $223.18
- Tests: flat per-class consumption, drought predicate, percent_of selector with kind=consumption

**Bozeman Sewer — WQA Residential** (`bozeman-sewer-wqa.test.ts`):
- Residential class, WQA value 8 HCF (winter average)
- Expected: $24.65 + $32.96 = $57.61
- Tests: derived_consumption with quantitySource.base="wqa", reads from vars

**Bozeman Sewer — Linked Commercial** (`bozeman-sewer-linked.test.ts`):
- Commercial class, current-period water consumption 50 HCF
- Expected: $25.26 + $256.50 = $281.76
- Tests: derived_consumption with quantitySource.base="linked_commodity"

**Bozeman Stormwater** (`bozeman-stormwater.test.ts`):
- SFR property with 1 ERU + has_stormwater_infra=true
- Expected: $4.81 + $3.99 − $1.80 = $7.00
- Tests: non_meter pricing reading premise.eru_count, credit gated by premise_attr, percent_of with selector kind=non_meter

**Bozeman Solid Waste** (`bozeman-solid-waste.test.ts`):
- Property with 1 garbage cart (65-gal weekly), 1 recycling cart (65-gal), 1 organics cart (35-gal)
- Expected: $27.24 + $12.96 + $12.00 = $52.20
- Tests: item_price catalog lookup, multi-cart aggregation

**NWE Residential Electric** (`nwe-residential-electric.test.ts`):
- 750 kWh used, default supply, three-schedule assignment
- Expected: REDS-1 components ($4.20 + delivery + delivery tax) + ESS-1 indexed supply (using rate-index value 0.07000 × 750 = $52.50) + USBC ($1.80)
- Tests: multi-schedule assignment, indexed pricing, role-based selector (if any tariff exercises it)

### 5.3 Property-based tests

A small set of property assertions (`packages/api/src/lib/rate-engine/__tests__/properties.test.ts`):
- Total never negative
- Every kindCode=credit line has negative `amount`
- minimum_bill never reduces total below the floor
- `manifest(base)` returns distinct keys
- `manifest(base)` is deterministic (same base → same keys)

### 5.4 Coverage target

≥ 90% line coverage on `rate-engine/` excluding tests. Branch coverage ≥ 85%.

---

## 6. Risks and open issues

| Risk | Mitigation |
|---|---|
| **Decimal arithmetic edge cases.** Tier walking with non-integer breakpoints (e.g. 5.5 HCF), proration with fractional days, percent_of producing irrational results. | All math through `Decimal` from `decimal.js`. Round only at line-item display (not during intermediate calc). |
| **Silent target propagation.** Surcharge references a tier-4 line that didn't fire (predicate false). Engine should silently skip the surcharge rather than throw. | Documented in 07b; selector returns empty array, sum=0, line not emitted, trace records `skipReason: "selector_empty"`. |
| **Topological sort with multiple percent_of-of-percent_of.** State tax on subtotal, then city tax on (subtotal + state tax) — chain depth 2+. | DAG handles chains naturally. Test in unit suite + cascading-tax golden test. |
| **Cycle in `percent_of` references.** Configurator catches at save (Slice 2); engine should also detect at runtime. | `detectCycles` runs at engine load; if cycle found, throw with the cycle path documented. Slice 1 has no cycle scenarios in seeded data so this just guards future configurator bugs. |
| **Variable type mismatches.** Variable expected as Decimal but caller passed string. | Engine validates value types at consumption (Zod schemas in evaluators), throws clear errors. Slice 4's loaders will be the long-term fix. |
| **Performance.** Engine should run a 30-component bill in <50ms locally. | All in-memory; no I/O. Property tests can include perf assertion. |
| **TOU/peak_demand not implemented.** Some tariffs reference these in Slice 3 (Bozeman/NWE residential don't exercise them, but the seeded NWE-style schedule has consumption with `quantitySource.base = "metered"` not peak_demand, so this is fine). | Throw documented "not yet implemented" if encountered; tariff goldens don't exercise. |

---

## 7. What changes downstream

| Slice | Built on Slice 3 |
|---|---|
| Slice 4 (Variable Loaders) | Engine's `manifest` API + variable types are the loader contract. |
| Slice 2 (Configurator UI) | `detectCycles` + per-pricing-type Zod schemas drive configurator validation. |
| Slice 5 (Bill Generation) | `rate(ctx)` is the call. Bill is just `result.lines` plus persistence. |

---

## 8. Acceptance criteria

The slice is **done** when:

- [ ] `packages/api/src/lib/rate-engine/` module exists with the documented file structure
- [ ] `rate(ctx) → RatingResult` and `manifest(base) → VariableKey[]` exported from `index.ts`
- [ ] All 8 pricing types implemented and unit-tested
- [ ] All supported quantity sources (metered, wqa, premise_attribute, linked_commodity, item_count, fixed) implemented
- [ ] Supported transforms (clamp, net, prorate, subtract_linked_commodity, floor) implemented; deferred ones (ratchet, tou_window_filter, power_factor, load_factor) throw documented errors
- [ ] All 19 predicate operators implemented (with tou_window throwing documented error)
- [ ] All 9 selector ops implemented
- [ ] Topological sort + cycle detection implemented and tested
- [ ] `minimum_bill` runs last, applies floor correctly
- [ ] Component-level unit tests cover positive + negative branches per evaluator (~50-80 tests)
- [ ] All 7 tariff-level golden tests pass with documented expected dollar amounts
- [ ] Property tests pass (total non-negative, credits negative, manifest deterministic)
- [ ] Coverage ≥ 90% line, ≥ 85% branch
- [ ] Workspace typecheck clean
- [ ] Single git commit per task; commit messages reference Slice 3
- [ ] Slice 3 plan executed via subagent-driven-development

---

## 9. Out of scope (explicit)

- Variable loaders (Slice 4)
- Bulk prefetch (Slice 4)
- Configurator UI (Slice 2)
- Bill persistence + rendering (Slice 5)
- TOU window evaluation
- Peak demand quantity sources + ratchet transform
- Power factor and load factor transforms
- Real-time pricing, CPP event days, NEM 3.0
- API endpoints exposing the engine (Slice 5)
- Caching of rate results

---

## 10. Implementation note: grouping into tasks

Suggested 11-task breakdown for the writing-plans skill:

1. Engine module scaffold + types (RatingContext, RatingResult, LineItem, ComponentTrace, etc.) + `decimal.js` dependency wired up
2. Predicate evaluator + tests (~12 tests)
3. Quantity-source resolver + transforms + tests (~15 tests)
4. Pricing evaluators (flat / tiered / lookup / catalog / per_unit / per_unit / indexed / floor) + tests (~16 tests)
5. Selector evaluator + tests (~10 tests)
6. Topological sort + cycle detection + tests (~8 tests)
7. `rate(ctx)` orchestrator + unit tests
8. `manifest(base)` extractor + tests
9. Tariff goldens — Bozeman water (SFR + Multi-Family with drought)
10. Tariff goldens — Bozeman sewer (WQA + Linked) + stormwater + solid waste
11. Tariff goldens — NWE multi-schedule electric + property tests + final verification + push

Roughly 11 tasks. Order: 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9 → 10 → 11. Tasks 2-6 can run in parallel after Task 1 if the orchestrator (Task 7) is started after. Tasks 9-10 can run in parallel.
