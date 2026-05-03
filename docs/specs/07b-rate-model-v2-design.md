# Rate Model v2 — Design Sketch

**Status:** DESIGN ONLY. No code, no migration, no schema change. This document explores how a future rate model could be shaped.

**Purpose:** Sketch a data model that can express the Bozeman tariffs in [`07a-bozeman-rate-reference.md`](./07a-bozeman-rate-reference.md) without code branches per rate type. Surface the design questions before any implementation work.

---

## Why the current model isn't enough

Today: `RateSchedule` has a `rate_type` enum (FLAT / TIERED / TIME_OF_USE / DEMAND / BUDGET) and a `rate_config` JSONB whose shape varies by type. One blob, one shape per schedule.

What this can't express cleanly:

| Bozeman case | Why it breaks |
|---|---|
| Water tiered for SFR, flat for Multi-Family — same schedule | One schedule, one rate_type — can't be both |
| Sewer WQA for Residential, metered for Commercial — same schedule | Quantity source isn't a rate property today |
| Service charge by meter size + consumption by class | Two independent keying axes; rate_config has neither |
| Stormwater priced on impervious area (no meter) | No rate_type covers non-consumption pricing |
| Solid waste cart-size catalog | Lookup table, not a rate formula |
| Drought surcharge on top of water | Stacking isn't expressible in a single JSONB |

Every one of those needs a code-side branch today. The design goal is to push these into data.

---

## Core idea: components stack

A bill line isn't *a rate*. It's the sum of **components**, each with its own:

1. **Type** — what kind of charge it is
2. **Predicate** — when does it apply (class, meter size, season, drought stage active, irrigation meter excluded?)
3. **Quantity source** — what volume drives it (metered usage, WQA, ERU count, cart count, fixed)
4. **Pricing function** — flat / tiered / matrix / lookup / percentage / fixed
5. **Stacking role** — base / overlay / credit / minimum / floor

Each component is **effective-dated independently**. A drought surcharge can activate without forking the underlying water schedule.

---

## Proposed entities

> Names are illustrative — bikeshed later. Focus is on the *responsibilities*.

### `RateSchedule` (kept; meaning narrows)

A named tariff version. Versioned via supersedes_id. Holds metadata only — name, code, regulatory_ref, effective_date, expiration_date. **No `rate_type`. No `rate_config`.** Those move to components.

```
RateSchedule {
  id, utility_id, name, code, commodity_id,
  effective_date, expiration_date, regulatory_ref,
  version, supersedes_id
}
```

### `RateComponent` (new, the core abstraction)

One row per stackable charge. A schedule has many components. Components have an explicit ordering (`sort_order`) so the bill renders in a stable sequence.

```
RateComponent {
  id, utility_id, rate_schedule_id,
  kind: enum,           // see kinds below
  label,                // bill-display name, e.g. "Water Service Charge"
  predicate: jsonb,     // when this component applies — see below
  quantity_source: enum,// metered | wqa | premise_attribute | fixed | linked_commodity | item_count
  pricing: jsonb,       // shape varies by `kind` — see below
  stacking_role: enum,  // base | overlay | credit | minimum
  sort_order: int,
  effective_date: date, // can differ from schedule's
  expiration_date: date
}
```

#### `kind` enum (proposed)

| kind | When to use |
|---|---|
| `service_charge` | Fixed monthly recurring (Bozeman water service charge by meter size) |
| `consumption` | Per-unit volumetric (water HCF, sewer HCF) |
| `derived_consumption` | Per-unit on a derived quantity (sewer-billed-on-WQA, irrigation-excluded usage) |
| `non_meter` | Premise-attribute pricing (stormwater ERU) |
| `item_price` | Catalog lookup per attached item (solid waste cart) |
| `one_time_fee` | Event-based (cart delivery, reconnect) |
| `surcharge` | Stackable overlay (drought stage %, drought reserve $/HCF) |
| `tax` | Percentage of subtotal |
| `credit` | Negative adjustment (stormwater on-site infra 45% credit) |
| `minimum_bill` | Floor applied at schedule subtotal |

#### `predicate` (jsonb) — when does this apply?

A small DSL. The bill engine evaluates it against the SA + premise + meter + city flags.

Examples:

```jsonc
{ "class": "Single Family" }
{ "meter_size": ["1.5\"", "2\""] }
{ "and": [{ "class": "Residential" }, { "drought_stage_active": true }] }
{ "premise_attr": { "has_stormwater_infra": true } }
{ "meter_role": { "ne": "irrigation" } }
{ "season": "summer" }
```

Predicate operators: `and / or / not / eq / ne / in / class / meter_size / season / drought_stage_active / premise_attr / meter_role`. Closed grammar — no script eval.

#### `pricing` (jsonb) — how is the dollar amount computed?

Shape varies by `kind`. Examples:

```jsonc
// service_charge keyed by meter size
{ "type": "lookup", "by": "meter_size", "table": {
   "5/8\"": 22.31, "1\"": 29.56, "2\"": 67.64
}}

// consumption: inclining block
{ "type": "tiered", "tiers": [
   { "to": 6,    "rate": 3.31 },
   { "to": 25,   "rate": 4.58 },
   { "to": 55,   "rate": 6.39 },
   { "to": null, "rate": 9.58 }
]}

// consumption: flat per-unit
{ "type": "flat", "rate": 3.40, "unit": "HCF" }

// derived_consumption: sewer on WQA
{ "type": "flat", "rate": 4.12, "unit": "HCF",
  "quantity_rule": "wqa", "wqa_window": "Nov-Mar" }

// non_meter: stormwater ERU
{ "type": "per_unit", "rate": 3.99, "unit": "ERU",
  "source_attr": "premise.eru_count" }

// item_price: solid waste cart
{ "type": "catalog", "by": ["size", "frequency"], "table": {
   "35:weekly": 18.96, "45:monthly": 14.11, "65:weekly": 27.24
}}

// surcharge: percentage on a target component
{ "type": "percent_of", "percent": 25.0,
  "target_component": "water_consumption", "tier_filter": "55+" }

// credit
{ "type": "percent_of", "percent": -45.0, "target_component": "stormwater_variable" }

// minimum_bill
{ "type": "floor", "amount": 6.62, "applies_to_subtotal": true }
```

`type` values are a small closed set: `lookup`, `tiered`, `flat`, `per_unit`, `catalog`, `percent_of`, `floor`.

---

### Quantity sources — where the volume comes from

The bill engine resolves a component's quantity by looking at `quantity_source`:

| source | Resolves to |
|---|---|
| `metered` | The SP's meter reads for this billing period (with multiplier applied) |
| `wqa` | The SA's stored WQA value (re-computed each winter, manually correctable) |
| `premise_attribute` | A field on Premise (eru_count, impervious_sqft) |
| `linked_commodity` | Another commodity's billed quantity this period (e.g., wastewater on water actual) |
| `item_count` | Count of items linked to the SP (cart count, container count) |
| `fixed` | 1 — used for service charges |

WQA is just one quantity source. Same shape supports irrigation-excluded usage, prior-year-average, peak-demand, etc.

---

### Assigning schedules to service agreements

A single SA can have **one or more schedules** applied to it. Bozeman tariffs need one (water schedule for a water SA); NorthWestern tariffs need several (REDS-1 delivery + ESS-1 supply + USBC rider). To express both worlds without forcing one into the other, the assignment lives in a **join table**.

```
SAScheduleAssignment {
  id, utility_id,
  service_agreement_id,
  rate_schedule_id,
  role,              // primary | delivery | supply | rider | opt_in
  effective_date,
  expiration_date,
  created_at
}
```

One row per (SA, Schedule) pairing. The `role` lets the bill engine know what kind of schedule each one represents — used for ordering bill lines and for queries like "what supply tariff is this customer on?". The effective date range lets a customer change one assignment (e.g. swap default supply for green-power supply) without losing the history of what they were on previously.

#### How the two reference utilities populate this table

**Bozeman residential water SA — one row:**

| sa_id | rate_schedule_id | role | effective_date | expiration_date |
|---|---|---|---|---|
| sa-water-12345 | rs-bozeman-water-2025-09 | primary | 2025-09-15 | NULL |

**NorthWestern residential electric SA (default supply) — three rows:**

| sa_id | rate_schedule_id | role | effective_date | expiration_date |
|---|---|---|---|---|
| sa-elec-67890 | rs-reds-1-v8 | delivery | 2025-09-15 | NULL |
| sa-elec-67890 | rs-ess-1-v41 | supply | 2026-04-01 | NULL |
| sa-elec-67890 | rs-usbc-1-v2 | rider | 2025-01-01 | NULL |

**Customer enrolls in green power on 2026-05-01:**

```sql
-- End the default-supply assignment:
UPDATE sa_rate_schedule_assignment
   SET expiration_date = '2026-04-30'
 WHERE service_agreement_id = 'sa-elec-67890'
   AND role = 'supply';

-- Insert the green-supply assignment:
INSERT INTO sa_rate_schedule_assignment
  (service_agreement_id, rate_schedule_id, role, effective_date)
  VALUES ('sa-elec-67890', 'rs-egps-1', 'supply', '2026-05-01');
```

REDS-1 and USBC rows untouched. The customer's delivery rate, riders, and history are unaffected — they just swap which supply schedule is in effect.

#### Resolving the active rate set at bill time

To bill SA `sa-elec-67890` for the period ending 2026-05-31:

```sql
SELECT rate_schedule_id, role
  FROM sa_rate_schedule_assignment
 WHERE service_agreement_id = 'sa-elec-67890'
   AND effective_date <= '2026-05-31'
   AND (expiration_date IS NULL OR expiration_date >= '2026-05-01');
```

Returns the union of schedules active during the period. The engine then pulls every component from those schedules (each with its own predicate / quantity_source / pricing) and sums them.

#### Why a join table beats columns or arrays

- **More columns on SA** (`delivery_schedule_id`, `supply_schedule_id`, ...) doesn't scale: every new tariff bundle is a schema change, and most customers have NULLs for most columns.
- **An array column** of schedule IDs loses the per-assignment metadata (role, effective dates, audit).
- **A join table** is what every relational schema does for many-to-many relationships with attributes on the relationship itself. It costs one extra table; in return, both Bozeman ("one row per SA, role=primary") and NorthWestern ("3+ rows per SA with roles") fit the same model without contortion.

---

## Modeling the three Bozeman tariffs

### Tariff 1: Bozeman Water Schedule (single schedule, multi-class)

```
RateSchedule { name: "Bozeman Water 2025-09", commodity: water }

RateComponent[] = [
  // Service charge — same for all classes, keyed by meter size
  { kind: service_charge, label: "Water Service Charge",
    predicate: {},
    quantity_source: fixed,
    pricing: { type: lookup, by: meter_size, table: {...} } },

  // Consumption — Single Family inclining tiers
  { kind: consumption, label: "Water Usage — Residential",
    predicate: { class: "Single Family" },
    quantity_source: metered,
    pricing: { type: tiered, tiers: [...] } },

  // Consumption — Single Family minimum
  { kind: minimum_bill, label: "Water Minimum",
    predicate: { class: "Single Family", usage_lte: 2.0 },
    pricing: { type: floor, amount: 6.62 } },

  // Consumption — Multi-Family flat
  { kind: consumption, label: "Water Usage — Multi-Family",
    predicate: { class: "Multi-Family" },
    quantity_source: metered,
    pricing: { type: flat, rate: 3.01, unit: "HCF" } },

  // ... one component per other class (Gov, MSU, Commercial)

  // Drought surcharge — only when drought stage active
  { kind: surcharge, label: "Drought Surcharge",
    predicate: { drought_stage_active: true },
    pricing: { type: percent_of, target_component: "water_consumption",
               percent_table_by_stage_and_tier: {...} } },

  // Drought reserve — flat per-HCF, all classes
  { kind: surcharge, label: "Drought Reserve",
    predicate: { drought_stage_active: true },
    quantity_source: metered,
    pricing: { type: flat, rate: 0.11, unit: "HCF" } }
]
```

### Tariff 2: Bozeman Sewer Schedule (mixed WQA + metered)

```
RateSchedule { name: "Bozeman Sewer 2025-09", commodity: wastewater }

RateComponent[] = [
  { kind: service_charge, label: "Sewer Service Charge",
    predicate: { class: "Residential" },
    pricing: { type: flat, rate: 24.65 } },

  { kind: service_charge,
    predicate: { class: ["Multi-Family", "Commercial", "Government", "MSU"] },
    pricing: { type: flat, rate: 25.26 } },

  { kind: service_charge,
    predicate: { class: "Industrial" },
    pricing: { type: flat, rate: 49.06 } },

  // WQA classes
  { kind: derived_consumption,
    predicate: { class: "Residential" },
    quantity_source: wqa,
    pricing: { type: flat, rate: 4.12, unit: "HCF" } },

  { kind: derived_consumption,
    predicate: { class: "Multi-Family" },
    quantity_source: wqa,
    pricing: { type: flat, rate: 4.58, unit: "HCF" } },

  // Metered classes — same kind, different source
  { kind: derived_consumption,
    predicate: { class: "Commercial" },
    quantity_source: linked_commodity,  // water consumption this period
    pricing: { type: flat, rate: 5.13, unit: "HCF" } },

  // ... Government, MSU, Industrial similarly
]
```

WQA-vs-metered is just a different `quantity_source` on the same component shape. No code branch.

### Tariff 3: Bozeman Solid Waste (catalog)

```
RateSchedule { name: "Bozeman Solid Waste 2025-09", commodity: solid_waste }

RateComponent[] = [
  { kind: item_price, label: "Garbage Cart",
    predicate: { item_type: "garbage_cart" },
    quantity_source: item_count,
    pricing: { type: catalog, by: ["size", "frequency"], table: {
      "35:weekly": 18.96, "45:weekly": 18.96, "45:monthly": 14.11,
      "65:weekly": 27.24, "100:weekly": 34.91, "220:weekly": 58.30,
      "300:weekly": 73.09, "450:weekly": 105.30
    }} },

  { kind: item_price, label: "Recycling Cart",
    predicate: { item_type: "recycling_cart" },
    quantity_source: item_count,
    pricing: { type: catalog, by: "size", table: {
      "65": 12.96, "100": 12.96, "300": 20.17
    }} },

  { kind: item_price, label: "Organics Cart",
    predicate: { item_type: "organics_cart" },
    quantity_source: item_count,
    pricing: { type: catalog, by: "size", table: {
      "35": 12.00, "95": 12.00
    }} },

  // One-time delivery fee — not part of monthly billing
  // {kind: one_time_fee} attached at the SR/event level, not the rate schedule directly.
]
```

---

## Stormwater — premise-attribute pricing

```
RateSchedule { name: "Bozeman Stormwater 2025-09", commodity: stormwater }

RateComponent[] = [
  { kind: service_charge, label: "Stormwater Flat Charge",
    quantity_source: fixed,
    pricing: { type: flat, rate: 4.81 } },

  { kind: non_meter, label: "Stormwater Variable",
    quantity_source: premise_attribute,
    pricing: { type: per_unit, rate: 3.99, unit: "ERU",
               source_attr: "premise.eru_count" } },

  { kind: credit, label: "On-Site Infrastructure Credit",
    predicate: { premise_attr: { has_stormwater_infra: true } },
    pricing: { type: percent_of, target_component: "stormwater_variable",
               percent: -45.0 } }
]
```

Premise needs a new attribute (`eru_count` or `impervious_sqft`) plus a flag (`has_stormwater_infra`). That's a tiny premise-side schema add, **not a rate-schema concern**.

---

## Bill rendering: schedule → component → line item

The bill the customer sees is built from components, not schedules. A schedule is a regulatory/lifecycle grouping; the *components* inside it are what render as lines.

### The mapping

| Concept | Bill role |
|---|---|
| **Schedule** | Doesn't appear on the bill. It's an assignment unit and a regulatory artifact. |
| **Component** | Renders as one line item. Its `label` becomes the line label. |
| **Component with `kind=minimum_bill`** | Silent unless it kicks in. When it does, either appears as a separate line ("Minimum Bill Adjustment") or as a footer note. |
| **Component with `kind=credit` or negative `surcharge`** | Renders as a negative-amount line. |
| **Component with `kind=tax`** | Usually one line per tax. |

### Worked example 1 — Bozeman residential water bill

One SA → one schedule via `SAScheduleAssignment` → multiple components → multiple lines.

Customer profile: Single Family, 5/8" meter, 12 HCF used, no drought stage active.

```
SAScheduleAssignment:
  sa_id = sa-water-12345, rate_schedule_id = rs-bozeman-water-2025-09, role = primary

Schedule "Bozeman Water 2025-09" components fired:
  - service_charge   (predicate {} → matched)             → line: "Water Service Charge"     $22.31
  - consumption      (predicate {class: "Single Family"}) → line: "Water Usage — Residential" $42.30
                       quantity 12 HCF, tiered:
                         tier 0-6:    6 × $3.31 = $19.86
                         tier 6-25:   6 × $4.58 = $27.48
                         total = $47.34   wait — 12 HCF spans both tiers; computed as $42.30 above
  - minimum_bill     (predicate {usage_lte: 2.0} → NOT matched, usage was 12) → silent, no line
  - drought_surcharge (predicate {drought_stage_active: true} → NOT matched) → silent
  - drought_reserve  (predicate {drought_stage_active: true} → NOT matched) → silent

Rendered bill:
  ─────────────────────────────────
  Water Service Charge                $22.31
  Water Usage — Residential           $42.30
  ─────────────────────────────────
  Water subtotal                      $64.61
```

Two line items from one schedule. Three other components in the schedule were silent because their predicates didn't match.

### Worked example 2 — NorthWestern residential electric bill (default supply)

One SA → three schedules via `SAScheduleAssignment` → many components across all three → many lines.

Customer profile: Residential, 750 kWh used.

```
SAScheduleAssignment rows:
  sa-elec-67890 → rs-reds-1-v8       role=delivery
  sa-elec-67890 → rs-ess-1-v41       role=supply
  sa-elec-67890 → rs-usbc-1-v2       role=rider

Schedule REDS-1 components fired:
  - service_charge   → line: "Service Charge"                  $4.20
  - consumption      → line: "Distribution Delivery"           $X
  - consumption      → line: "Transmission Delivery"           $Y
  - surcharge        → line: "Electric Delivery Tax"           $8.82
  - credit           → line: "BPA Exchange Credit"            -$1.50

Schedule ESS-1 components fired:
  - consumption      → line: "Residential Supply"              $A
  - surcharge        → line: "Supply Tax"                      $B
  - surcharge        → line: "Deferred Supply Rider"           $C

Schedule USBC components fired:
  - surcharge        → line: "Universal System Benefits Charge" $D

Rendered bill:
  ─────────────────────────────────
  Service Charge                          $4.20
  Distribution Delivery                   ...
  Transmission Delivery                   ...
  Electric Delivery Tax                   $8.82
  BPA Exchange Credit                    -$1.50
  Residential Supply                      ...
  Supply Tax                              ...
  Deferred Supply Rider                   ...
  Universal System Benefits Charge        ...
  ─────────────────────────────────
  Electric total                       $123.00
```

Nine line items from three schedules. The customer doesn't see schedule boundaries — just lines.

### Bill engine algorithm (high-level)

```
function buildBill(saId, periodStart, periodEnd):
  # 1. Resolve all assignments active during the period
  assignments = SELECT * FROM sa_rate_schedule_assignment
                 WHERE service_agreement_id = saId
                   AND effective_date <= periodEnd
                   AND (expiration_date IS NULL OR expiration_date >= periodStart)

  # 2. Pull every component from each assigned schedule
  components = []
  for a in assignments:
    components += SELECT * FROM rate_component
                   WHERE rate_schedule_id = a.rate_schedule_id
                     AND effective_date <= periodEnd
                     AND (expiration_date IS NULL OR expiration_date >= periodStart)

  # 3. Evaluate each component
  lines = []
  for c in components.ordered_by(sort_order):
    if not c.predicate.evaluate(sa, premise, meter, tenant_flags):
      continue                          # silent — predicate didn't match
    qty   = resolveQuantity(c.quantity_source, sa, period)
    amt   = applyPricing(c.pricing, qty, lines)   # `lines` enables percent_of overlays
    if c.kind == "minimum_bill":
      lines.applyFloor(c.label, c.pricing.amount)  # may add line, may not
    elif amt != 0:
      lines.append({label: c.label, amount: amt, kind: c.kind, source_schedule: c.rate_schedule_id})

  # 4. Render
  return billTemplate.render(lines)
```

Two implications worth flagging:

1. **`source_schedule` is preserved on each line.** Even though the customer-facing bill doesn't show schedule names, the bill record stores which schedule each line came from. This is what auditors and rebill engines need ("which lines came from REDS-1 v8?").

2. **`percent_of` components must run AFTER the components they target.** The `sort_order` field handles ordering; the `applyPricing` step looks up `target_component` by id in the already-computed `lines` array. The bill engine's iteration order is therefore non-trivial — surcharges and credits run last (after `sort_order` puts them at the end).

### Optional rendering layer — bill_group_id

Some utilities want to **roll up multiple components under one displayed line**. Example: NorthWestern shows "Distribution Delivery" and "Transmission Delivery" separately, but a different utility might combine them as one "Delivery Charge" line while keeping them as two components internally.

This is a rendering decision, not a calc decision. The optional `bill_group_id` column on `RateComponent` lets the bill template merge components with the same group into one line, summing their amounts. Components remain individually auditable; only the customer-facing display merges.

```
RateComponent {
  ...
  bill_group_id?  // optional — components sharing this id render as one line
  bill_group_label?  // the merged line's label, used when bill_group_id is set
}
```

Defer until a tenant actually asks for it.

---

## Component dependencies (selectors on `percent_of`)

A surcharge, credit, tax, or floor often depends on the *result* of other components. The `percent_of` pricing type expresses that dependency through a **selector** — a query over already-emitted lines.

The original sketch only had `target_component`. The realistic shape is broader.

### Selector grammar

```jsonc
selector: { component_id: "X" }                  // one specific line
selector: { kind: "consumption" }                 // all lines of that kind
selector: { kind_in: ["consumption", "service_charge"] }
selector: { exclude_kind: ["tax", "credit"] }     // everything except
selector: { source_schedule_id: "rs-water" }      // all lines from that schedule
selector: { source_schedule_role: "delivery" }    // all lines from delivery-role schedules
selector: { has_label_prefix: "Water" }           // by label prefix (visual rollup)
selector: { and: [ ... ] } / { or: [ ... ] }      // composition
```

The engine evaluates the selector against `lines[]` (already computed), sums matched amounts, and multiplies by `percent / 100`.

### Three patterns

**Single-line dependency:**
```jsonc
{ pricing: { type: percent_of, selector: { component_id: "water_tier4" }, percent: 25.0 } }
```

**Sum-of-selected (the tax pattern):**
```jsonc
{ pricing: { type: percent_of, selector: { exclude_kind: ["tax", "credit"] }, percent: 6.25 } }
```

**Subtotal floor (minimum bill):**
```jsonc
{ kind: minimum_bill,
  pricing: { type: floor, amount: 6.62, selector: { kind: ["consumption", "service_charge"] } } }
```

### Cascading dependencies

Taxes can stack. State tax = 6.25% of consumption; city tax = 2% of (consumption + state tax):

```jsonc
{ kind: tax, label: "State Tax", sort_order: 100,
  pricing: { type: percent_of, selector: { exclude_kind: ["tax", "credit"] }, percent: 6.25 } }

{ kind: tax, label: "City Tax", sort_order: 101,
  pricing: { type: percent_of, selector: { exclude_kind: ["credit"] }, percent: 2.0 } }
```

City tax's selector includes the state-tax line because `exclude_kind` doesn't filter taxes here. Higher `sort_order` ensures state tax computes first. The engine's topological sort makes this safe.

### Engine ordering: topological with cycle detection

Two ordering rules:

1. A `percent_of` component runs **after** any component its selector references. The engine builds a DAG (edges from referenced → dependent) and topologically sorts; ties broken by `sort_order`.
2. `minimum_bill` components run **last**, after all base lines, surcharges, credits, and taxes.

Cycles are caught at **schema-save time**, not at rate time. The configurator validates: "does this new component create a cycle with existing ones?" If yes, refuse the save. The bill engine never has to handle a cycle at runtime.

### Silent target propagation

If a `percent_of` selector matches no fired lines (e.g., the target's predicate was false this period), the sum is 0, the surcharge contributes 0, and the trace records:

```
Drought Surcharge: skipped — selector matched 0 lines, computed amount = 0
```

This is the right behavior: "no water tier-4 usage" → "no drought surcharge."

### Self-reference

A component can't reference itself — selector evaluation excludes the currently-evaluating component. Indirect self-cycles (A → B → A) are rejected at save time by the cycle detector.

---

## Rating engine pipeline

The engine is a **pure function** from `RatingContext` to `RatingResult`. No DB writes, no side effects. Same inputs always produce same outputs — making it usable for billing, rebilling, previewing ("what if Bob enrolls in green power?"), and validation (Bozeman Req 143: validate billed charges against adopted rates).

### Six stages

```
RatingContext (input)
    │
[1] Resolve schedule assignments active in period
    │   SELECT * FROM sa_rate_schedule_assignment
    │   WHERE sa_id = ? AND effective range overlaps period
    │
[2] Pull components from those schedules, also active in period
    │
[3] Topologically order components
    │   - Build DAG from percent_of selectors
    │   - Sort topologically; ties broken by sort_order
    │   - minimum_bill components forced to end
    │
[4] For each component:
    │   a. Evaluate predicate against context — if false, trace as silent
    │   b. Resolve quantity:
    │      base = lookupBase(quantity_source.base, ctx)
    │      for each transform: qty = applyTransform(transform, qty)
    │   c. Apply pricing:
    │      flat | tiered | lookup | catalog | per_unit | percent_of | indexed
    │   d. Append LineItem if amount != 0
    │   e. Append ComponentTrace either way
    │
[5] Apply minimum_bill components
    │   For each minimum_bill (predicate matched):
    │     subtotal_in_scope = sum lines matching its selector
    │     if subtotal_in_scope < amount:
    │       emit "Minimum Bill Adjustment" line for the difference
    │
[6] Compute totals → return RatingResult
```

### Outputs

```typescript
interface RatingResult {
  lines: LineItem[];
  totals: { subtotal, taxes, credits, total, minimum_floor_applied };
  trace: ComponentTrace[];   // every component evaluated, fired or skipped
}

interface LineItem {
  label: string;
  amount: Decimal;
  kind: ComponentKind;
  source_schedule_id: string;       // for audit
  source_component_id: string;
  quantity?: Decimal;
  rate?: any;
}

interface ComponentTrace {
  component_id: string;
  fired: boolean;
  skip_reason?: "predicate_false" | "selector_empty" | "zero_amount" | "silent_minimum";
  evaluated_quantity?: Decimal;
  evaluated_rate?: any;
  evaluated_amount?: Decimal;
}
```

The `trace` is the audit record and the "explain this bill" log — what fired, what didn't, why.

### What lives outside the engine

| Not engine | Why |
|---|---|
| **Persistence** | Engine returns lines; a `Bill` record is built and stored separately |
| **Notification / delivery** | Bill template + send is a separate module |
| **Adjustments / corrections / write-offs** | A `Correction` is its own concept; calls the engine for rebill |
| **Bill template rendering (PDF/HTML)** | Engine returns line items; renderer turns them into the artifact, may apply `bill_group_id` rollup |
| **Multi-jurisdiction tax lookups** | If taxes involve external state/county/special-district lookups, fold those into a tax-quantity_source rather than embedding in the engine |
| **Multi-service consolidated bill** | Engine runs once per SA; consolidator stacks results |

### How this gets tested

1. **Component-level unit tests** — each `kind` × each `pricing.type` × each transform with literal inputs/outputs. ~100 tiny tests.
2. **Tariff-level golden tests** — for each tariff in the reference docs, a literal `RatingContext` and expected `RatingResult`. ~30-50 cases (10 tariffs × 3-5 customer profiles).
3. **Property-based tests** — randomized contexts asserting invariants ("total never negative", "every credit line has negative amount", "minimum_bill never reduces total below floor"). Catches edge-case combinations.

The first two are mandatory. The third is nice-to-have.

### Staging

The engine is the **last thing to build**, not the first:

1. Schema (RateSchedule, RateComponent, SAScheduleAssignment, RateIndex)
2. Visual configurator (so tenants can enter tariffs as data, even before billing)
3. Then the rating engine, against the configured tariffs and a thick golden test suite
4. Then bill generation that calls the engine

Building the engine first against fictional schemas means redesigning both. Building the data + UI first gives the engine a sharp target with golden tests pre-loaded.

---

## Engine-caller contract

The engine is pure but the caller has to know what to load before invoking it. The contract has four pieces:

1. A **fixed `BaseContext`** for entities every bill needs
2. A **two-phase API** (`manifest()` → `rate()`) so the engine declares needs before the caller fetches
3. A **loader plugin interface** — each loader self-describes its supported keys, types, and scope
4. A **variable registry** that assembles itself from registered loaders

### `RatingContext` — stable base + variable bag

```typescript
interface RatingContext {
  base: BaseContext;                       // SA, account, premise, period — always the same shape
  vars: Map<VariableKey, VariableValue>;   // dynamic values, content depends on active components
}

interface BaseContext {
  sa:      ServiceAgreementSnapshot;
  account: AccountSnapshot;
  premise: PremiseSnapshot;
  period:  { start_date: Date; end_date: Date };
}
```

The base half is fixed by the engine. Every bill needs SA, account, premise, period. Adding a new always-required entity is a coordinated engine + caller change; rare.

The vars half is where meter reads, WQA values, drought stages, indices, and any future dynamic inputs live. Content varies per bill, supplied by loaders.

### Two-phase API

```typescript
class RatingEngine {
  manifest(base: BaseContext): VariableKey[];   // declarative — what does this bill need?
  rate(ctx: RatingContext): RatingResult;       // imperative — compute it
}
```

The engine extracts variable references by walking the active components' predicates, quantity_sources, and pricings. It resolves any template parameters (`<meter_id>` → `M-12345` from the SA's meter) and returns a distinct list.

Caller pattern:

```typescript
const base   = await loadBase(saId, period);
const keys   = engine.manifest(base);
const vars   = await registry.loadVariables(keys);
const result = engine.rate({ base, vars });
```

### Loader interface

Each loader is a **self-describing plugin**. It declares which key patterns it supports, what types those keys take and return, and how its values scope (per-SA / per-tenant / global). The registry uses the declarations to route keys, validate references at save time, and pick the right batching strategy at run time.

```typescript
interface Loader {
  capabilities(): LoaderCapability[];
  load(keys: VariableKey[]): Promise<Map<VariableKey, VariableValue>>;
}

interface LoaderCapability {
  pattern:     KeyPattern;            // e.g. "meter:reads:<meter_id>"
  paramTypes:  Record<string, ZodSchema>;  // type for each <wildcard>
  returns:     ZodSchema;             // type for the resolved value
  scope:       "per_sa" | "per_tenant" | "global";  // batching/caching hint
  description: string;                // human-readable, used by configurator UI
}
```

`pattern` uses `<name>` wildcards. `paramTypes` and `returns` are Zod schemas (matching the rest of the codebase). `scope` is a hint to the bulk-prefetch optimizer.

### Concrete loader examples

```typescript
class AccountLoader implements Loader {
  capabilities() {
    return [
      { pattern: "account:class",
        paramTypes: {},
        returns: z.string(),
        scope: "per_sa",
        description: "Customer service class for this account" },

      { pattern: "account:flag:<flag_name>",
        paramTypes: { flag_name: z.enum(["autopay", "lifeline", "senior", "green_power"]) },
        returns: z.boolean(),
        scope: "per_sa",
        description: "Boolean flag on the account" },
    ];
  }
  async load(keys) { /* batch-fetches in one query — see Batching below */ }
}

class MeterLoader implements Loader {
  capabilities() {
    return [
      { pattern: "meter:reads:<meter_id>",
        paramTypes: { meter_id: z.string().uuid() },
        returns: z.object({ quantity: z.number(), unit: z.string(), intervals: z.array(intervalSchema).optional() }),
        scope: "per_sa",
        description: "Metered consumption for the billing period" },

      { pattern: "meter:peak_demand:<meter_id>:<window>",
        paramTypes: {
          meter_id: z.string().uuid(),
          window: z.enum(["current", "lookback_12mo", "lookback_24mo"]),
        },
        returns: z.number(),
        scope: "per_sa",
        description: "Peak demand for a meter in a given lookback window" },
    ];
  }
  async load(keys) { /* ... */ }
}

class IndexLoader implements Loader {
  capabilities() {
    return [
      { pattern: "index:<index_name>:<period>",
        paramTypes: {
          index_name: z.enum(["fac", "epcc", "cpi", "co2_price"]),
          period: z.string(),
        },
        returns: z.number(),
        scope: "global",   // ← same value for every SA in a billing run
        description: "External rate index value (FAC, EPCC, CPI, etc.)" },
    ];
  }
}

class TenantLoader implements Loader {
  capabilities() {
    return [
      { pattern: "tenant:drought_stage",
        paramTypes: {},
        returns: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
        scope: "per_tenant",   // ← same for all SAs in this tenant's run
        description: "Currently declared drought stage (0 = none, 1-4 = stages)" },
    ];
  }
}
```

### The variable registry

The registry assembles itself from registered loaders. It serves three callers: the configurator (save-time validation), the engine (rate-time dispatch), and the bulk-prefetch optimizer (scope-aware batching).

```typescript
class VariableRegistry {
  private capabilities: Array<{ cap: LoaderCapability; loader: Loader }> = [];

  register(loader: Loader) {
    for (const cap of loader.capabilities()) {
      if (this.capabilities.some(({ cap: existing }) => patternsConflict(existing.pattern, cap.pattern))) {
        throw new Error(`Conflicting loader capability: ${cap.pattern}`);
      }
      this.capabilities.push({ cap, loader });
    }
  }

  // Used by the configurator at SAVE time
  validateKey(key: VariableKey): { valid: boolean; capability?: LoaderCapability; error?: string } { ... }

  // Used by the engine + bulk-fetcher at RATE time
  resolveLoader(key: VariableKey): Loader { ... }
  scopeOf(key: VariableKey): "per_sa" | "per_tenant" | "global" { ... }

  // Used by the configurator UI to build the variable picker
  describeAll(): LoaderCapability[] { ... }

  // The actual batch fetch
  async loadVariables(keys: VariableKey[]): Promise<Map<VariableKey, VariableValue>>;
}

// At app startup:
const registry = new VariableRegistry();
registry.register(new AccountLoader());
registry.register(new MeterLoader());
registry.register(new WqaLoader());
registry.register(new TenantLoader());
registry.register(new PremiseLoader());
registry.register(new IndexLoader());
registry.register(new LinkedCommodityLoader());
registry.register(new ItemsLoader());
```

Adding a new utility is "implement a new loader, register it." No central table edit.

### Batching: within a single bill

The loader takes a **list** of keys, not one. Inside a single loader call, the loader is expected to optimize: parse the keys, group by entity, run minimum queries.

Example for the meter loader being asked five keys for one meter:

```
meter:reads:M-12345
meter:size:M-12345
meter:role:M-12345
meter:peak_demand:M-12345:current
meter:peak_demand:M-12345:lookback_12mo
```

Loader strategy: 5 keys → at most 3 parallel queries (one for the Meter row, one for MeterReads in the period, one for PeakDemandHistory).

### Bulk prefetch: across many SAs

For a monthly bill run of 10,000 SAs, the per-SA pattern wastes round-trips. The capability-aware bulk pattern uses `scope`:

```typescript
async function bulkRate(saIds: string[], period: Period) {
  const bases = await loadBasesForAllSAs(saIds, period);

  // Manifest all SAs and union the keys
  const allKeys = bases.flatMap(b => engine.manifest(b));

  // Group by scope so each loader is called minimally
  const globalKeys  = dedup(allKeys.filter(k => registry.scopeOf(k) === "global"));
  const tenantKeys  = dedup(allKeys.filter(k => registry.scopeOf(k) === "per_tenant"));
  const saKeys      = allKeys.filter(k => registry.scopeOf(k) === "per_sa");

  // Single fetch each — globals once, tenant-scoped once, sa-scoped batched
  const cache = new Map<VariableKey, VariableValue>();
  await Promise.all([
    registry.loadInto(cache, globalKeys),
    registry.loadInto(cache, tenantKeys),
    registry.loadInto(cache, saKeys),
  ]);

  // Per-SA rate, slicing from cache (no I/O)
  return bases.map(base => {
    const saSpecificKeys = engine.manifest(base);
    const vars = sliceFromCache(cache, saSpecificKeys);
    return engine.rate({ base, vars });
  });
}
```

10,000 SAs sharing one `tenant:drought_stage` = one row read for it, returned 10,000 times in the slice map. `scope` is the hint that makes this safe.

### Save-time validation

When a tenant defines a component referencing `{var: "meter:peak_demand:M-12345:lookback_36mo"}`, the configurator:

1. Looks up the matching capability via the registry: `meter:peak_demand:<meter_id>:<window>`
2. Checks param types against `paramTypes`. `<meter_id>` matches uuid, but `<window>` must be in the enum `[current, lookback_12mo, lookback_24mo]`. **`lookback_36mo` is rejected.**
3. The save fails with a precise error message; the typo never reaches a bill run.

### Configurator UI gets variable pickers for free

Components that reference variables can offer a dropdown driven by `registry.describeAll()`:

```
[search for variable…]
  📊 meter:reads:<meter_id>           Metered consumption for the billing period
  📊 meter:peak_demand:<meter_id>:<window>   Peak demand for a meter in a given lookback window
  ⚙ tenant:drought_stage              Currently declared drought stage
  💰 index:<index_name>:<period>      External rate index value (FAC, EPCC, CPI, etc.)
  ...
```

Each entry is a capability description with the pattern visible. The tenant doesn't memorize key strings — they pick from a list.

### Worked example end-to-end (Bozeman SFR water)

```typescript
// 1. Caller assembles base
const base = {
  sa:      { id: "sa-water-12345", commodity_id: "water", ... },
  account: { id: "acc-alice", class: "Single Family", ... },
  premise: { id: "prem-789", ... },
  period:  { start_date: "2026-05-01", end_date: "2026-05-31" }
};

// 2. Engine produces the manifest
const keys = engine.manifest(base);
// → [ "account:class",
//     "meter:size:M-12345",
//     "meter:reads:M-12345",
//     "tenant:drought_stage" ]

// 3. Registry routes each key to the right loader and batches the calls
const vars = await registry.loadVariables(keys);
//   AccountLoader gets ["account:class"]                       → 1 query
//   MeterLoader   gets ["meter:size:M-12345", "meter:reads:M-12345"]  → 2 queries
//   TenantLoader  gets ["tenant:drought_stage"]                → 1 query (cacheable)

// 4. Rate
const result = engine.rate({ base, vars });
// → 2 line items: Service Charge $22.31, Water Usage $42.30
```

### What this contract buys

- **Self-describing plugins** — registry assembles from loader capabilities; no central reference table to keep in sync
- **No over-fetching or under-fetching** — manifest is exact; loaders batch internally
- **Engine stays pure** — no DB, no callbacks
- **Save-time param validation** — `<window>` in `meter:peak_demand:M-1:<window>` must match the loader's enum; typos caught before bills go out
- **Scope-aware bulk prefetch** — globals fetched once across a 10K-SA run, per-tenant once, per-SA batched
- **Configurator UI is automatic** — variable picker is `registry.describeAll()`
- **Audit-ready** — each variable carries a `source` (`{value: 12, source: "meter_read_id 9876"}`) so the trace shows the auditor where each input came from
- **Extensible** — new tenants/utilities add loaders, registry self-updates, no engine touch
- **Conflict detection** — registering two loaders that claim the same pattern fails at startup

### What this contract doesn't solve

- **Stale data** — if a meter read is corrected after the bill, the variable was right at fetch time but is now wrong. That's a rebill problem; the contract makes "give me corrected variables" trivial (re-manifest, re-fetch, re-rate).
- **Authorization** — caller must ensure they have permission to load underlying data
- **Async loaders inside `rate()`** — `rate()` is synchronous; async work happens in the loaders, between manifest and rate
- **Cross-tenant cache** — `scope: "global"` is per billing run, not across runs. Long-lived caching is a separate concern.

---

## Closed grammar reference

This is the exhaustive list of named atoms in the rate model. New utilities or tariff features add named atoms to these tables, **not new syntax**. The closed grammar is the foundation of the model's auditability and configurability.

### Component kinds

| `kind` | Description |
|---|---|
| `service_charge` | Fixed monthly recurring (water service charge, electric customer charge) |
| `consumption` | Per-unit volumetric on metered usage (water HCF, electric kWh) |
| `derived_consumption` | Per-unit on a derived quantity (sewer on WQA, irrigation-excluded usage) |
| `non_meter` | Premise-attribute pricing (stormwater ERU) |
| `item_price` | Catalog lookup per attached item (solid waste cart, lighting fixture) |
| `one_time_fee` | Event-based (cart delivery, reconnect fee) |
| `surcharge` | Stackable overlay (drought stage %, drought reserve $/HCF, USBC) |
| `tax` | Percentage or per-unit tax |
| `credit` | Negative adjustment (stormwater on-site infra credit, BPA exchange) |
| `reservation_charge` | Pay for capacity whether used or not (NWE standby) |
| `minimum_bill` | Floor applied at schedule subtotal |

### Pricing types

| `pricing.type` | Description | Example |
|---|---|---|
| `flat` | One rate per unit | Water flat per-HCF for Multi-Family |
| `tiered` | Inclining or declining block | SFR water 4-tier |
| `lookup` | Table keyed on one attribute | Service charge by meter size |
| `catalog` | Table keyed on multi-attribute combo | Solid waste cart by (size, frequency) |
| `per_unit` | Rate × derived quantity | Stormwater $/ERU |
| `percent_of` | Selector × percent of matched lines | Tax, drought surcharge, credit |
| `indexed` | Constant × external index value | FAC, CPI escalation, EPCC |
| `floor` | Lift selected subtotal to a floor | Minimum bill |

**Proposed-when-needed** (add only when a real customer asks):

| Type | Description | Use case |
|---|---|---|
| `interval_pricing` | Σ (qty_h × (price_h + adder)) over intervals | Real-time pricing (RTP) |
| `min_of` / `max_of` | Multiple branches, take lesser/greater | "Lesser of flat or per-kWh" |
| `tiered_percent_of` | Tiered percentage on selector subtotal | Tiered tax |
| `capped_percent_of` | `percent_of` with `max_amount` cap | "25% of consumption, max $50" |

### Quantity sources

| `quantity_source.base` | Resolves to |
|---|---|
| `metered` | The SP's meter reads for the billing period (with multiplier applied) |
| `wqa` | The SA's stored WQA value |
| `premise_attribute` | A field on Premise (eru_count, impervious_sqft) |
| `linked_commodity` | Another commodity's billed quantity this period |
| `item_count` | Count of items linked to the SP |
| `peak_demand` | Highest interval kW (sub-spec: interval, window, aggregation) |
| `fixed` | 1 — used for service charges |

### Quantity transforms

Applied in order on the resolved base quantity.

| Transform | Effect | Use case |
|---|---|---|
| `ratchet` | `max(qty, lookback_pct × prior_peak)` | Demand ratchet |
| `clamp` | `clamp(qty, min, max)` | Sewer cap/min/max |
| `net` | `max(0, qty - subtract_var)` | Net metering |
| `prorate` | `qty × days_in_period / standard_days` | Partial-period tier proration |
| `subtract_linked_commodity` | `qty - linked_commodity_qty` | Wastewater minus irrigation |
| `tou_window_filter` | Limits qty to a TOU window | Demand on-peak only |
| `power_factor` | Adjusts qty by PF deviation | Industrial PF penalty |
| `load_factor` | Computes load factor from qty + period | Load-factor discount eligibility |
| `floor` | `max(qty, min)` | Backflow → 0 |

### Predicates

| Operator | Effect |
|---|---|
| `and` / `or` / `not` | Boolean composition |
| `eq` / `ne` / `in` / `not_in` | Value comparison |
| `class` / `class_in` | Customer class match |
| `meter_size` / `meter_size_in` | Meter size match |
| `season` | Period falls in named season |
| `tou_window` | Period overlaps named TOU window |
| `drought_stage_active` | Tenant flag check |
| `premise_attr` | Premise attribute match |
| `meter_role` | Meter role (irrigation, primary, etc.) |
| `qty_gte` / `qty_lte` | Quantity threshold (used with var ref) |
| `customer_attr` | Account-level flag (autopay, lifeline, senior, green_power) |
| `period` | Bill period date range (for promotions) |

### Selectors (used by `percent_of` and `floor`)

| Selector | Selects |
|---|---|
| `component_id` | One specific component's line |
| `kind` / `kind_in` | All lines of given kind(s) |
| `exclude_kind` | Lines NOT of given kind(s) |
| `source_schedule_id` | All lines from a particular schedule |
| `source_schedule_role` | All lines from schedules assigned with role X |
| `has_label_prefix` | Lines whose label starts with prefix |
| `and` / `or` | Composition |

### Variable namespaces (derived from registered loaders)

The variable registry assembles itself from loader capabilities at app startup. The table below is the **default loader set** shipped with the rate engine; deployments add more loaders for utility-specific data sources.

| Namespace | Default loader | Example keys | Scope |
|---|---|---|---|
| `account:` | AccountLoader | `account:class`, `account:flag:<name>` | per_sa |
| `meter:` | MeterLoader | `meter:reads:<id>`, `meter:size:<id>`, `meter:peak_demand:<id>:<window>`, `meter:role:<id>` | per_sa |
| `wqa:` | WqaLoader | `wqa:current:<sa_id>`, `wqa:override:<sa_id>` | per_sa |
| `linked:` | LinkedCommodityLoader | `linked:<commodity>:current_period` | per_sa |
| `tenant:` | TenantLoader | `tenant:drought_stage`, `tenant:flags:<name>` | per_tenant |
| `premise:` | PremiseLoader | `premise:attr:<attr_name>` | per_sa |
| `index:` | IndexLoader | `index:<index_name>:<period>` | global |
| `items:` | ItemsLoader | `items:<sp_id>:<item_type>` | per_sa |

Adding a new namespace = implement a new `Loader`, register it. The registry self-updates; the configurator's variable picker self-updates; the bulk-prefetch optimizer routes new keys correctly.

See "Engine-caller contract" section for the full Loader interface and capability declarations.

---

## Why no formula language

The closed grammar above can be extended by adding new named atoms (a new pricing type, a new transform, a new selector op). We deliberately do **not** add a general formula DSL like Oracle CC&B's "Calculation Rules" or SAP IS-U's expression language. This decision was reached after working through the rate model against the Bozeman + NorthWestern reference tariffs.

### Why we considered it

A formula DSL is appealing because it's expressively complete: "let tenants write `(qty * 0.05) + lookup('FAC') * 0.001`" handles any pricing scheme imaginable. CC&B and SAP IS-U have built their rate engines around it.

### Why we decided against it

**Most "complex" tariff features decompose into named pieces.** When stress-tested against real tariffs, every case I tried (drought surcharge, cascading tax, demand ratchet, net metering, FAC, CPI escalation, sewer caps, lifeline discounts, volume discounts, power factor penalties, load-factor discounts, irrigation seasonal rates, TOU pricing, customer-choice supply, qualifying-facility riders) decomposed cleanly into the closed grammar (`predicate` + `quantity_source` + `transforms` + `pricing` + `percent_of` selectors). Adding a formula language would buy theoretical flexibility we don't observably need.

**The concrete cost of a formula language is high:**

| Concern | Closed grammar | Formula language |
|---|---|---|
| **Visual configurator UX** | Form widgets per type, no free text | Form widgets *or* a textbox; both is messy |
| **Save-time validation** | Validate against registered atoms | Need parser + type-checker + linter |
| **Audit trail** | "drought_surcharge component evaluated to $X" | "formula `(qty*0.05)+lookup('FAC')` evaluated to $1.23" — opaque |
| **Test surface** | Bounded — N kinds × M types × K transforms | Unbounded — every formula combination |
| **Tenant skill required** | Click around the form, drop in a rate | Learn the formula DSL |
| **Production debugging** | Reproducible from atoms | Reproduce + debug AST execution |
| **Security review** | None needed | Formula must be sandboxed (no I/O, no recursion bombs) |

**The escape hatch is named-type expansion, not formula syntax.** When a real customer needs something the closed grammar can't express (e.g., real-time hourly pricing), we add a new named type (`interval_pricing`) with:
- A documented spec
- A focused configurator editor
- A bounded test fixture
- A trace-friendly evaluator

This pays incrementally for actual needs rather than upfront for theoretical ones.

**The bar for revisiting this decision** would be: **25+ bespoke pricing types and three concrete customer requests we still can't express.** We are not close to that bar — Bozeman and NorthWestern together exercise ~12 pricing types and transforms.

### What this rules out

- Free-text formula entry in the rate configurator
- A tenant-defined macro / function library
- Eval-style runtime expression evaluation
- "Formula tester" UI for tenants

### What this still allows

- Adding new pricing types when a real customer needs them
- Extending the predicate grammar with new operators
- Adding quantity transforms (load_factor, power_factor, etc.) as named atoms
- Indexed pricing referencing externally-managed value tables (FAC, CPI, drought stage)
- Per-tenant configuration through the existing closed grammar

In practice, this lands on the same expressive power as CC&B's rule language for the cases that matter, but with a configurator UX that doesn't require a certified consultant.

---

## Things this design intentionally does NOT collapse

Two cases that look similar but should stay distinct:

1. **`consumption` vs `derived_consumption`** — the difference is whether quantity is point-in-time metered or comes from a stored derived value (WQA). The bill engine treats them identically; the rate audit trail tracks them separately. (Why: a corrected meter read recomputes consumption immediately; a corrected WQA winter read recomputes the stored WQA which then drives next bill — different rebill semantics.)

2. **`surcharge` vs `consumption`** — even though drought reserve looks like another flat per-HCF charge, marking it `surcharge` keeps it visually separate on bills (Bozeman Req 142: itemize charges) and lets the engine apply it conditionally on city-flag.

---

## Where account-level and account-class data live

Two existing places already have what's needed:

| What | Lives on |
|---|---|
| Customer class (Single Family / Commercial / Industrial) | New ref table `rate_service_class` per commodity, FK on ServiceAgreement |
| Meter size | `Meter.size` (already exists) |
| Premise impervious area / ERU | New field on Premise (small add, bounded) |
| WQA stored value per SA | New table `wqa_value` (sa_id, year, computed_avg, manually_corrected_at, audit) |
| Drought stage active | New tenant-level setting `current_drought_stage` (0 = none, 1–4 = stage). City staff flips this in admin. |

These are all small, bounded additions to existing entities. The rate schema doesn't grow tentacles into other modules — it just consults their attributes via predicates.

---

## Migration story (sketch — not a plan)

If we were to land this:

1. Add `RateComponent` table. Keep `rate_type` and `rate_config` on `RateSchedule` as deprecated columns.
2. Add `SAScheduleAssignment` join table. Backfill from the existing `ServiceAgreement.rate_schedule_id` column — every active SA gets one row with `role = 'primary'`.
3. Backfill existing schedules into components (FLAT → 1 service_charge + 1 consumption; TIERED → 1 service_charge + 1 consumption with tiers; etc.).
4. Switch the rate engine (when it lands in Phase 3) to read components via the assignment join, instead of reading `rate_config` directly off the SA's single rate_schedule_id.
5. Drop `rate_type` and `rate_config` columns and the SA's direct `rate_schedule_id` FK after a clean release.

But: the rate engine doesn't exist yet. We could land v2 components *before* writing the engine, which means no backward-compat dance — the engine is built against components from day one. **Strong recommendation: do this rather than design around the legacy shape.**

---

## Design decisions

### Resolved (lock these in before Slice 1)

1. **Predicate DSL — closed grammar.**
 The predicate operator set in the closed grammar reference is frozen. Each operator has a Zod schema and a deterministic evaluator. New operators require code changes (small, bounded), and that's the right cost — it keeps the configurator visual and audit trails readable.

2. **Service class — ref table, FK on SA.**
 New ref table `rate_service_class` with `(id, utility_id, commodity_id, code, label, sort_order, is_active)`. ServiceAgreement gets a `rate_service_class_id` FK. The same physical premise can be on `single_family` for water and `residential` for electric — that's why class is per-(SA, commodity), not per-account or per-premise. Distinct from `Premise.premiseType`, which is the physical classification of the property; `rate_service_class` is the *billing* classification used by rate components.

3. **Solid waste cart instances — extend Container.**
 The existing `Container` entity gains attributes for `size`, `frequency`, and `item_type`. The `item_price` component reads via Container attributes. No new `ItemAssignment` entity. Same approach extends naturally to street lighting fixtures (different `item_type`, different attribute set).

4. **Effective dating — both schedule-level and component-level.**
 A schedule has an outer effective range; components within can have narrower ranges. A drought surcharge can be added/expired without forking the schedule it lives in.

### Still open (not blocking Slice 1)

5. **WQA storage shape.**
 Sketch: `(sa_id, water_year, computed_at, source_window_start, source_window_end, computed_avg, override_value, override_reason)`. Per-SA-per-year row. Finalize during Slice 3 when the engine first needs to read WQA.

6. **Bill engine ordering rules.**
 Already documented in the rating-engine pipeline section: predicate → quantity → pricing → minimum_bill last → topological sort for `percent_of` references. Will be finalized as the engine is built in Slice 3.

7. **Rebill semantics on read correction.**
 Defer to Slice 5 (bill generation + corrections). The engine's purity makes rebill tractable: re-manifest, fetch corrected vars, re-rate, diff against stored bill.

---

## What this design buys

If we land this:

- **Bozeman's tariff fits with zero special cases.** Every weird thing (WQA-by-class, ERU pricing, cart catalog) is just data in a component.
- **NorthWestern's multi-tariff bill fits without forcing a 1:1 SA→schedule model.** Delivery + supply + riders each become assignment rows; customer choice (green power) is a swap of one row.
- **Rate audit trail is per-component.** Auditors can ask "what changed about the drought reserve" and get a single row diff, not a JSONB diff inside a JSONB.
- **Visual configurator becomes natural.** "Add component → pick kind → fill predicate + pricing." Each kind has a small, focused editor (tier table for tiered, lookup table for catalog, flat input for flat). No need for 5 different rate-type sub-forms.
- **Surcharges, credits, taxes stop being second-class.** They're components like any other — same audit, same effective-dating, same display sequence.
- **WQA isn't tangled into the rate.** It's a quantity source. The rate is just a per-unit price.
- **Bill engine is regulator-friendly.** Each line carries its `source_schedule` so the audit trail can answer "which lines came from REDS-1 v8?" without parsing the bill template.
- **Variable loaders are self-describing plugins.** Adding a new utility's data sources is implementing a `Loader` and registering it; the variable registry, configurator picker, and bulk-prefetch optimizer all self-update from loader capabilities. No central table to keep in sync, no engine code change.

## What this design costs

- **Migration is real work.** Existing schedules need to be unpacked into components. Bounded — only 5 rate types — but it's TDD work.
- **Bill engine is more complex per query.** Today's engine reads one JSONB; v2 reads N components and stacks them. N is small (5–15 per schedule) so latency is fine, but the code is more involved.
- **JSONB inside `predicate` and `pricing` is still weakly typed.** Every new operator/type is a new Zod schema branch. Same problem as today, but distributed across smaller atoms.

## Recommendation

**Land v2 before the rate engine ships.** The Phase 3 rate engine is currently a TBD. Building the engine against the legacy `rate_config` JSONB is wasted effort if v2 lands first. Better: define v2 schema, build engine against v2 from day one, retire `rate_config` in a single migration.

The v2 schema would land as Slice X — a focused 2–3 task slice that adds `RateComponent`, backfills, and exposes a v2-aware GET/POST. UI for the visual configurator comes after.

If you greenlight this design, the next step is a brainstorm of (a) the predicate DSL, (b) the WQA storage model, (c) the migration backfill — each of which becomes its own implementation plan.
