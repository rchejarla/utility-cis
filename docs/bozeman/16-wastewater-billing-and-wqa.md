# 16 — Wastewater Billing & Winter Quarter Average (WQA)

**RFP commitment owner:** SaaSLogic Utilities — split between `packages/shared/prisma/schema.prisma` (`WastewaterBillingConfig` + `WqaSnapshot` tables; extensions to `Premise` for irrigation-meter linkage), `packages/api/src/services/wastewater/*` (WQA calculator, irrigation-exclusion engine, snapshot generator, no-history defaulter), and `packages/api/src/services/billing/charge-wastewater.ts` (the bill-calculation hook). Cross-cuts with [docs/specs/07-rate-management.md](../specs/07-rate-management.md) (rate engine plumbing — `RateSchedule.rateConfig` is where WQA params land), [docs/specs/09-billing.md](../specs/09-billing.md) (Module 09 owns the bill-calc step that consumes WQA), [01-audit-and-tamper-evidence.md](./01-audit-and-tamper-evidence.md) (`AUDIT_FINANCIAL` retention applies to WQA snapshots — they're financial inputs to bills), [12-corrections-and-reversals.md](./12-corrections-and-reversals.md) (rebill via reversal pattern when WQA is recomputed for a customer who disputes), and [05-customer-portal.md](./05-customer-portal.md) (portal shows the WQA basis for the customer's wastewater charge).
**Status:** Drafted — **no implementation.** No billing engine exists yet; Module 09 is a Phase 3 stub. `RateSchedule.rateConfig` (a JSON column per [docs/specs/07-rate-management.md](../specs/07-rate-management.md)) could store WQA parameters today, but no calculator reads them. There is no concept of "irrigation meter" linkage on Premise. There is no historical-usage-aggregation logic anywhere — meter reads are stored, but no service queries them as "the average winter usage for this customer over the past 3 years." This is greenfield work that lights up alongside Module 09.
**Effort estimate:** M (~3-4 weeks). The math is bounded — fixed-rate-period averaging plus three or four configurable parameters. The largest cost is the **irrigation-exclusion logic** (~1.5 weeks: separate-meter linkage AND threshold-based seasonal adjustment, both per-tenant configurable). Second is the **per-customer WQA derivation** (~1 week: queries N years of historical reads, applies the configured window, produces a single average — with a defaulter for customers who lack history). Third is the **no-history fallback** (class average, configurable per tenant). The doc is intentionally focused — covers Reqs 69-73 only. Larger billing-engine concerns live in [docs/specs/09-billing.md](../specs/09-billing.md).

---

## 1. RFP commitments (verbatim)

This doc covers **five Bozeman requirements** (Reqs 69-73 in the master cross-reference at [00-requirements-master.md](./00-requirements-master.md)):

> **Req 69.** System shall calculate wastewater charges as a 100% of water usage, except for WQA (Winter Quarter Average) billing.
>
> **Req 70.** System shall support caps, minimums, and maximums for wastewater billing, including WQA.
>
> **Req 71.** System supports configurable (e.g., the quarter is five months, daily calculations, etc.) WQA periods.
>
> **Req 72.** System shall support winter averaging for wastewater billing, based on City configuration and/or individual customer history.
>
> **Req 73.** System supports exclusion of irrigation or non-sewer usage from wastewater calculations.

These are tightly coupled — they describe a single coherent capability. Bozeman's wastewater rate is computed as a function of water usage, with a winter-averaging adjustment for residential customers (because their summer water consumption goes to lawns, not down the drain). The math has subtleties (window length, daily vs monthly aggregation, irrigation-exclusion mechanism, no-history fallback) that the City wants flexibility on.

**Why a paragraph-length proposal narrative for these five reqs:** WQA is **not** standard utility-CIS behavior. It's a Mountain-West / municipal practice driven by seasonal climate. Ratepayers and utility-commission staff scrutinize the math. The City needs to confirm we understand their WQA rules and can configure to match — including edge cases (new customers, mid-year ownership transfers, customers with no winter history, commercial customers exempted from WQA). This doc is the place to walk through the design.

---

## 2. Current state — what exists today

### 2.1 No billing engine ✗

**Status: Module 09 is a Phase 3 stub** (per [docs/specs/09-billing.md](../specs/09-billing.md)). No `BillingRecord` entity, no rate-engine evaluator, no charge-calculation pipeline. Wastewater charges aren't computed by any code today. The data exists (water meter reads in `MeterRead`, rate schedules in `RateSchedule`); the engine does not.

### 2.2 No WQA-specific infrastructure ✗

**Status: Not implemented.** A grep across the codebase for `WQA`, `winter_quarter`, `winter_average`, `wastewater_basis`, `irrigation` returns zero matches (not even comments). Nothing today knows that wastewater can be derived from a different denominator than the customer's current-cycle water usage.

### 2.3 No irrigation-meter concept ✗

**Status: Not implemented.** `Premise.commodityIds` is an array — a premise CAN have multiple commodities — but there's no semantic distinction between "domestic water" and "irrigation water." Two meters on a premise both feeding `WATER` commodity produce one consolidated wastewater calc today (if there were one).

### 2.4 No historical-usage aggregation ✗

**Status: Not implemented.** Meter reads are stored in `MeterRead` but no service exposes "average usage over period X for customer Y." The reads exist; the aggregation does not.

### 2.5 `RateSchedule.rateConfig` could carry WQA params

**Status: Storage available; nothing reads it.** Per [docs/specs/07-rate-management.md](../specs/07-rate-management.md), `RateSchedule.rateConfig` is a JSON column free-form per `rateType`. WQA parameters could live there once the schema for them is defined. But no evaluator reads them.

### Summary

| Capability | Today |
|---|---|
| Wastewater charge calculation | ✗ (Module 09 stub) |
| 100% of water usage as default | ✗ |
| WQA winter-averaging logic | ✗ |
| Per-customer WQA derivation from historical reads | ✗ |
| Configurable window (5-month vs 3-month, daily vs monthly) | ✗ |
| Irrigation-meter exclusion | ✗ |
| Threshold-based irrigation exclusion (no separate meter) | ✗ |
| Caps / minimums / maximums | ✗ |
| No-history fallback (class average) | ✗ |
| Customer portal WQA-basis transparency | ✗ |

---

## 3. Functional requirements

### 3.1 Wastewater calculation model — three modes

- **FR-WW-001** — Wastewater charges are computed per agreement per cycle via one of three modes, configured per `(tenant, premiseType, commodityId)`:

  | Mode | Description | Use case |
  |---|---|---|
  | `DIRECT` | Wastewater volume = current-cycle water volume × `volumetric_factor` (default 1.00 for Req 69's "100%"). | Commercial customers, customers without seasonal usage variance, year-round flat-pattern accounts. |
  | `WQA` | Wastewater volume = the customer's pre-computed WQA (per FR-WW-020) for the cycle's billing year, capped by the rules in FR-WW-040. | Residential customers in regions with seasonal irrigation. **Bozeman's primary mode.** |
  | `MEASURED` | Wastewater volume = reading from a dedicated wastewater meter (rare; only for industrial customers with sewer-flow meters). | Industrial / large commercial. |

  The mode is set at the `service_territory_rate` row from [15-gis-driven-defaults-and-effective-dating.md](./15-gis-driven-defaults-and-effective-dating.md) FR-EFF-040 — wastewater rate per `(territory, commodity, premiseType)` carries a `wastewater_basis_mode` enum. A residential premise in zone NW gets `WQA`; a commercial premise gets `DIRECT`; an industrial customer with their own sewer meter gets `MEASURED`.

- **FR-WW-002** — `WastewaterBillingConfig` is a per-tenant config table holding the mode-specific parameters:

  ```prisma
  model WastewaterBillingConfig {
    id                       String   @id @default(uuid()) @db.Uuid
    utilityId                String   @map("utility_id") @db.Uuid
    name                     String   @db.VarChar(100)             // e.g., "Bozeman residential WQA 2027"
    mode                     WastewaterBasisMode @map("mode")       // DIRECT | WQA | MEASURED

    // DIRECT mode
    volumetricFactor         Decimal? @map("volumetric_factor") @db.Decimal(5, 4)  // default 1.0000

    // WQA mode
    wqaWindowMonths          Int?     @map("wqa_window_months")     // 3, 4, 5; default 4
    wqaWindowStartMonth      Int?     @map("wqa_window_start_month")  // 1=Jan; default 12 (Dec)
    wqaAggregation           String?  @map("wqa_aggregation") @db.VarChar(16)  // "average" | "median" | "min"; default "average"
    wqaApplicationStartMonth Int?     @map("wqa_application_start_month")  // when in the year does WQA take effect; default 5 (May)
    wqaApplicationEndMonth   Int?     @map("wqa_application_end_month")    // when does WQA stop applying; default 10 (Oct); outside window falls back to DIRECT
    wqaHistoryYears          Int?     @map("wqa_history_years")     // how many prior winters to consider; 1, 2, or 3; default 2

    // Caps + minimums + maximums (FR-WW-040)
    capPctOfDirect           Decimal? @map("cap_pct_of_direct") @db.Decimal(5, 4)  // null = uncapped
    minVolume                Decimal? @map("min_volume") @db.Decimal(12, 4)        // hard floor in CCF or gallons (null = no floor)
    maxVolume                Decimal? @map("max_volume") @db.Decimal(12, 4)        // hard ceiling
    minBillAmount            Decimal? @map("min_bill_amount") @db.Decimal(10, 2)   // minimum dollar amount per cycle

    // No-history fallback (FR-WW-050)
    noHistoryStrategy        String?  @map("no_history_strategy") @db.VarChar(32)  // "class_average" | "fixed_volume" | "current_usage"
    noHistoryFallbackVolume  Decimal? @map("no_history_fallback_volume") @db.Decimal(12, 4)
    noHistoryClassAverageWindowYears Int? @map("no_history_class_average_window_years")  // 1-5; default 3

    // Irrigation exclusion (FR-WW-060..065)
    irrigationExclusionMode  String?  @map("irrigation_exclusion_mode") @db.VarChar(32)  // "separate_meter" | "threshold" | "off"
    irrigationThresholdPct   Decimal? @map("irrigation_threshold_pct") @db.Decimal(5, 4)  // for threshold mode

    effectiveFrom            DateTime @map("effective_from") @db.Date
    effectiveTo              DateTime? @map("effective_to") @db.Date
    createdBy                String   @map("created_by") @db.Uuid
    createdAt                DateTime @default(now()) @map("created_at") @db.Timestamptz

    @@unique([utilityId, name, effectiveFrom])
    @@index([utilityId, mode, effectiveFrom])
    @@map("wastewater_billing_config")
  }

  enum WastewaterBasisMode { DIRECT  WQA  MEASURED }
  ```

  Reference rows are produced per (tenant, premise type) and tied to the relevant `service_territory_rate` rows. Effective-dated — a rate ordinance change that bumps the WQA window from 4 months to 5 produces a new `WastewaterBillingConfig` version with a future `effectiveFrom`; the prior version's `effectiveTo` is set automatically (per [docs/specs/07-rate-management.md](../specs/07-rate-management.md) revision pattern).

### 3.2 WQA calculation — per customer, per billing year

- **FR-WW-020** — A customer's WQA is **computed once per billing year** based on the configured window (default Dec-Mar of the prior winter) and stored as a `WqaSnapshot` row. The bill-calculation engine reads the snapshot, not the underlying reads — so WQA for a given bill is reproducible from the snapshot even if reads are later corrected.

  ```prisma
  model WqaSnapshot {
    id                       String   @id @default(uuid()) @db.Uuid
    utilityId                String   @map("utility_id") @db.Uuid
    serviceAgreementId       String   @map("service_agreement_id") @db.Uuid
    configId                 String   @map("config_id") @db.Uuid              // FK to WastewaterBillingConfig version
    billingYear              Int      @map("billing_year")                    // e.g., 2027 (the year the WQA applies to)
    windowStart              DateTime @map("window_start") @db.Date
    windowEnd                DateTime @map("window_end") @db.Date
    aggregationMethod        String   @map("aggregation_method") @db.VarChar(16)
    rawWindowVolume          Decimal  @map("raw_window_volume") @db.Decimal(14, 4)  // sum of reads in window
    aggregatedVolume         Decimal  @map("aggregated_volume") @db.Decimal(12, 4)  // average / median / min per cycle equivalent
    cappedVolume             Decimal  @map("capped_volume") @db.Decimal(12, 4)      // post caps/min/max
    irrigationExcludedVolume Decimal? @map("irrigation_excluded_volume") @db.Decimal(12, 4)  // volume removed by FR-WW-060+
    finalWqaVolumePerCycle   Decimal  @map("final_wqa_volume_per_cycle") @db.Decimal(12, 4)  // the value the bill engine reads
    derivationMethod         String   @map("derivation_method") @db.VarChar(32)  // "computed" | "no_history_class_average" | "no_history_fixed" | "operator_override"
    operatorOverrideReason   String?  @map("operator_override_reason") @db.Text
    derivationDetails        Json     @map("derivation_details")  // full audit trail: which reads, which exclusions, the math
    computedAt               DateTime @default(now()) @map("computed_at") @db.Timestamptz
    computedBy               String   @map("computed_by") @db.Uuid

    @@unique([utilityId, serviceAgreementId, billingYear])
    @@index([utilityId, billingYear])
    @@map("wqa_snapshot")
  }
  ```

  The snapshot is **immutable once generated** (per [12-corrections-and-reversals.md](./12-corrections-and-reversals.md) FR-REV-001 — financial-input rows are frozen). Changes to a customer's WQA require generating a new snapshot for the same `(serviceAgreementId, billingYear)` via the operator-override path (FR-WW-024).

- **FR-WW-021** — A `wqa-snapshot-builder` worker runs on a configurable schedule (default: April 1 of each year, after the winter window has closed). For each `(tenant, serviceAgreementId)` with `wastewater_basis_mode = WQA`:
  1. Looks up the active `WastewaterBillingConfig` version for the new billing year.
  2. Computes the window dates: `windowStart = year-1 + windowStartMonth - 1`, `windowEnd = windowStart + windowMonths`.
  3. Queries `MeterRead` for the agreement's water meter(s) in the window. Aggregates per the configured method (FR-WW-022).
  4. Applies irrigation exclusion (FR-WW-060+).
  5. Applies caps/minimums/maximums (FR-WW-040).
  6. Writes the `WqaSnapshot` row. Emits `AUDIT_FINANCIAL` audit row.
  7. If history is insufficient (FR-WW-050), routes to the no-history fallback path.
  8. On any failure, surfaces a `Task` per [13-workflow-approvals-action-queue.md](./13-workflow-approvals-action-queue.md) for an operator to investigate — not a silent default.

- **FR-WW-022** — Three aggregation methods supported:
  - `average` — `rawWindowVolume / windowMonths` (the standard WQA — averages monthly volume over the window). Default.
  - `median` — picks the middle month's volume. Used when one month is anomalous (frozen pipe leak) and shouldn't drag the average.
  - `min` — picks the lowest-volume month. Most customer-friendly; used by some utilities to give the benefit of doubt to customers.

  All three produce a "per-month equivalent volume." For monthly billing this is the WQA volume for each cycle; for bimonthly, the bill engine multiplies by 2; for quarterly, by 3.

- **FR-WW-023** — Daily aggregation option: when `wqa_aggregation = "average"` AND the underlying reads are interval reads (per [docs/specs/08-meter-reading.md](../specs/08-meter-reading.md)), the worker can compute `rawWindowVolume / actual_days_in_window` and produce a per-day rate, then multiply by the bill cycle's days. This is more accurate for partial-month windows or leap-year edges. Toggled via `wqa_window_months = NULL AND wqa_window_days = N` in the config (an alternate parameterization).

- **FR-WW-024** — Operator override: a CSR can set a customer's WQA manually via `POST /api/v1/wastewater/wqa-snapshots/<saId>/override` with `{ billingYear, finalWqaVolumePerCycle, reason }`. Requires `wastewater.override_wqa` permission + dual approval per [13-workflow-approvals-action-queue.md](./13-workflow-approvals-action-queue.md). Writes a new `WqaSnapshot` with `derivationMethod = "operator_override"`. The previous snapshot stays in place but is marked superseded — both visible in audit. Used for customers on hardship plans, customers who legitimately changed lawn-watering habits, etc.

### 3.3 Configurable WQA windows (Req 71)

- **FR-WW-030** — Per-tenant configuration of the WQA window. Default: Dec 1 - Mar 31 of the prior winter (4-month window, Bozeman-typical). Configurable to:
  - 3 months (Jan-Mar)
  - 4 months (Dec-Mar) — default
  - 5 months (Nov-Mar)
  - Per the RFP's literal "the quarter is five months" framing — Bozeman's WQA window is colloquially called a "quarter" but is actually 4-5 calendar months.
- **FR-WW-031** — Custom window start: tenants in non-Mountain-West climates can shift the window. A southern utility might use Jul-Oct (their summer indoor-only period). Configurable per tenant via `wqa_window_start_month`.
- **FR-WW-032** — Per-class window: a tenant can have different windows per `premiseType`. E.g., residential = Dec-Mar; small commercial with seasonal storefronts = year-round (mode `DIRECT` not `WQA`). Modeled as separate `WastewaterBillingConfig` rows tied to different `service_territory_rate` rows.

### 3.4 Caps, minimums, maximums (Req 70)

- **FR-WW-040** — Four optional ceiling/floor parameters, applied in order after aggregation:
  1. **Cap as percent of direct usage** (`capPctOfDirect`): if WQA would yield a wastewater volume greater than `direct_water_usage × capPctOfDirect`, clamp to the cap. Bozeman-typical value: 1.00 (the WQA-based wastewater volume cannot exceed the customer's actual current-cycle water usage). This protects against the edge case where a customer increased irrigation but their winter average is high — they shouldn't pay wastewater on more water than they used.
  2. **Hard min volume** (`minVolume`): floor on the per-cycle wastewater volume. Used to ensure a baseline contribution to sewer-system funding.
  3. **Hard max volume** (`maxVolume`): ceiling. Rarely used; primarily for legal/regulatory limits.
  4. **Min bill amount** (`minBillAmount`): a dollar floor on the final wastewater charge after rate is applied. Distinct from `minVolume`; used for utilities with tiered rates where a small volume could yield a tiny dollar amount.

  All four are independent — a tenant can set one, all four, or none. Order of application is fixed (% cap → volume floor → volume ceiling → dollar floor).

### 3.5 No-history fallback (new customers / new SAs)

- **FR-WW-050** — When a service agreement has insufficient winter-window history (less than `wqaHistoryYears × 0.5` of expected reads in the window — typically a brand-new customer who moved in after the winter window closed), the no-history strategy applies:
  - `class_average` (default): use the average WQA across all `(territory, premiseType)`-matching agreements with sufficient history. Computed annually by the same worker; cached in `WastewaterBillingConfig.noHistoryClassAverageVolume`. The customer pays the class average until their first full winter generates real history.
  - `fixed_volume`: use `noHistoryFallbackVolume` from the config (a hard-coded default, e.g., 6 CCF/cycle).
  - `current_usage`: fall back to `DIRECT` mode for this customer until they have history (i.e., new customer pays 100% of water usage as wastewater their first year — the most conservative for utility revenue).

  The `WqaSnapshot.derivationMethod` records which strategy was used; the snapshot's `derivationDetails` JSON includes the class-average computation if applicable. Customer portal surfaces this clearly: *"Wastewater for this cycle was based on the typical winter usage for residential customers in your zone, because your account is too new to have winter usage history."*

- **FR-WW-051** — Mid-year ownership transfers: when a parcel's responsible party changes mid-year (per [15-gis-driven-defaults-and-effective-dating.md](./15-gis-driven-defaults-and-effective-dating.md) `transferService` workflow), the WQA snapshot **transfers with the parcel** rather than with the customer. The new SA inherits the prior SA's WQA (same `WqaSnapshot.serviceAgreementId` lookup is replaced; the snapshot itself is keyed on a new SA id but `derivationDetails` notes "inherited from prior SA <id> at parcel <premiseId> on <date>"). Reasoning: the WQA is a property of how much sewer the lot uses; ownership doesn't change the water-usage pattern in the prior winter. This avoids new owners being billed at class-average when there's a perfectly good per-parcel history available.

### 3.6 Irrigation / non-sewer usage exclusion (Req 73)

- **FR-WW-060** — Two mechanisms supported, controlled by `WastewaterBillingConfig.irrigationExclusionMode`:
  - `separate_meter` — premise has a dedicated irrigation meter on the same `Commodity` (or a separate `WATER_IRRIGATION` commodity) that's flagged not contributing to wastewater. The wastewater calc reads only from the non-irrigation meter.
  - `threshold` — no separate meter; an inferred summer-vs-winter comparison subtracts presumed-irrigation usage. Per FR-WW-061.
  - `off` — no exclusion (commercial / industrial typically).

- **FR-WW-061** — Threshold-based irrigation exclusion (no separate meter):
  - For each cycle in the irrigation season (per `wqaApplicationStartMonth` to `wqaApplicationEndMonth`), the wastewater calc compares current-cycle water usage to the customer's WQA.
  - If `current > WQA × (1 + irrigationThresholdPct)`, the excess is presumed irrigation and excluded from the wastewater basis.
  - Example: WQA = 5 CCF/cycle, threshold = 0.20 (20%), current cycle = 12 CCF → presumed irrigation = `12 - 5 × 1.20 = 6 CCF`; wastewater volume = `12 - 6 = 6 CCF`.
  - The threshold is per-tenant configurable; default 0.00 (no buffer; any excess over WQA is presumed irrigation). A tenant can set 0.20 (20% buffer for legitimate seasonal variance not explained by irrigation).

- **FR-WW-062** — Either mechanism produces `WqaSnapshot.irrigationExcludedVolume` populated for traceability. Customer portal surfaces this so the customer can see their wastewater calculation transparently: *"Cycle water usage: 12 CCF. Estimated irrigation (excluded): 6 CCF. Wastewater basis: 6 CCF."*

- **FR-WW-063** — Separate-meter mode requires `Premise` to have at least one meter flagged `is_irrigation = true` (a new boolean column on `service_agreement_meter` per FR-WW-070). No flagged meter → fall back to threshold mode if configured, otherwise no exclusion.

- **FR-WW-064** — Customers with mixed sewer/non-sewer indoor usage (e.g., commercial customers with cooling-tower evaporation) need a separate exclusion mechanism — typically a customer-declared deduction percentage. **Out of scope** for this doc; addressed via customer-specific `WastewaterBillingConfig` overrides if Bozeman has commercial customers with this pattern.

- **FR-WW-065** — The threshold-based mode is **best-effort, not exact** — it estimates irrigation rather than measuring it. Customers with summer indoor swimming pools, summer house guests, etc., may have legitimately higher summer usage that gets misclassified as irrigation. The operator-override path (FR-WW-024) is the escape valve for these cases. Customer portal explains the methodology so disputes can be informed.

### 3.7 Schema additions

- **FR-WW-070** — `service_agreement_meter` gets a new column `is_irrigation Boolean @default(false)`. Set when the operator assigns a meter that feeds an irrigation system (separate from domestic). The wastewater calc filters by `is_irrigation = false` when summing water usage for the wastewater basis.
- **FR-WW-071** — `Premise` gets `wqaPolicyOverride String?` — a free-text reference to a different `WastewaterBillingConfig.id` than the territory default would resolve to. Used for hardship cases or customer-specific carve-outs. Override emits `AUDIT_FINANCIAL` row + dual approval per doc 13.

### 3.8 Bill-engine integration

- **FR-WW-080** — Module 09's bill calculator (when it ships) calls the wastewater calc as a sub-step:
  1. Read `service_territory_rate` for the agreement's `(territory, commodity, premiseType)` to get the wastewater rate schedule.
  2. Look up the `WastewaterBillingConfig` for the agreement's billing year.
  3. Branch on mode:
     - `DIRECT` → wastewater volume = current-cycle water volume × `volumetricFactor` (after irrigation exclusion).
     - `WQA` → look up the agreement's `WqaSnapshot` for the billing year; use `finalWqaVolumePerCycle`.
     - `MEASURED` → read from the dedicated wastewater meter directly.
  4. Apply caps/minimums/maximums (FR-WW-040).
  5. Apply the rate from the rate schedule.
  6. Produce the wastewater line item with full provenance: which mode, which WQA snapshot, which rate version. Stored on the bill row's `charge_breakdown` JSON.

- **FR-WW-081** — Bill regeneration on read corrections: if a winter-window read is corrected after the WQA snapshot was generated (per [docs/specs/08-meter-reading.md](../specs/08-meter-reading.md) read-correction flow), an operator-initiated rebuild of the WQA snapshot is required. The new snapshot supersedes the old; bills already issued on the old snapshot are NOT auto-rebilled — operators decide whether to rebill via [12-corrections-and-reversals.md](./12-corrections-and-reversals.md) FR-REV-010 reversal pattern. Audit trail shows the chain.

### 3.9 Customer portal — WQA transparency

- **FR-WW-090** — The portal's bill detail page shows the WQA basis for every wastewater line item:
  - Which mode (DIRECT / WQA / MEASURED)
  - For WQA: the snapshot id, the window dates, the aggregated volume, what was excluded (irrigation), what was capped (if applicable), and the final per-cycle volume used
  - A "How is my wastewater calculated?" help link explaining WQA in plain English
  - For new customers using `class_average`: clear explanation that the bill is based on typical usage until their winter history accumulates

- **FR-WW-091** — A "WQA history" view shows the customer their last 5 years of WQA snapshots so they can see trends (used water less last winter? next year's WQA reflects it).

- **FR-WW-092** — A "Request WQA review" portal action: customers can ask the utility to recompute their WQA (e.g., they had a one-time winter leak that inflated the average). Generates a `Task` per doc 13 routed to the wastewater team. The task carries the customer's stated reason; the team can use the operator-override path (FR-WW-024) if warranted.

### 3.10 Non-functional requirements

- **NFR-WW-001** — Annual WQA snapshot worker run: ≤2 hours p99 for tenants with up to 50K residential agreements (one snapshot per agreement, ~150ms per snapshot dominated by historical-usage query).
- **NFR-WW-002** — Per-bill wastewater calc: ≤30ms p99 (dominated by snapshot lookup, which is keyed on `(serviceAgreementId, billingYear)`).
- **NFR-WW-003** — `WqaSnapshot` retention: per [08-data-retention-archival-purge.md](./08-data-retention-archival-purge.md) `AUDIT_FINANCIAL` class — 7-year statutory floor. Snapshots are financial inputs to bills; they must remain queryable for the same period bills do.
- **NFR-WW-004** — RLS continues to enforce tenant isolation on `WqaSnapshot` and `WastewaterBillingConfig`. Worker context-switches `app.current_utility_id` per tenant per snapshot batch.
- **NFR-WW-005** — All audit emission (snapshot creation, override, regeneration) stays in-transaction with the entity write (no outbox).

---

## 4. Data model changes

### 4.1 New tables

| Table | Purpose | Section |
|---|---|---|
| `WastewaterBillingConfig` | Per-tenant per-class WW basis configuration (mode + WQA params + caps + irrigation rules) | 3.1 |
| `WqaSnapshot` | Per-(SA, billing year) immutable WQA value with full derivation audit | 3.2 |

### 4.2 Modified tables

| Table | Change | Section |
|---|---|---|
| `service_agreement_meter` | Add `is_irrigation Boolean @default(false)` | 3.6 |
| `premise` | Add `wqa_policy_override String?` (FK to WastewaterBillingConfig.id) | 3.7 |
| `service_territory_rate` (from doc 15) | Add `wastewater_basis_config_id` FK | 3.1 |

### 4.3 New worker queue

- `wqa-snapshot-builder` — annual cron (default April 1 12:00 tenant TZ); per-tenant fan-out; per-SA snapshot generation.

### 4.4 New permissions

- `wastewater.override_wqa` — for operator overrides (FR-WW-024).
- `wastewater.config.write` — for editing `WastewaterBillingConfig`.

### 4.5 RLS

All new tables get tenant RLS by `utility_id` per the existing pattern. `WqaSnapshot` is also visible to portal customers via the same `is_premise_visible_to_portal_user` predicate from [11-notes-and-comments.md](./11-notes-and-comments.md) (a customer sees their own SA's snapshots).

---

## 5. Implementation sequence

**Hard dependency:** Module 09 (Billing) must be far enough along to have the bill-calculation hook where WW is computed. This doc's implementation can land in parallel with Module 09 development; the bill engine consumes WW output.

### Phase 1 — Schema + config (~1 week)

1. Schema migrations for `WastewaterBillingConfig` + `WqaSnapshot` + the column additions + RLS.
2. CRUD service for `WastewaterBillingConfig` + admin UI at `/settings/wastewater-billing`.
3. Tenant-level seeding: a default Bozeman residential WQA config (4-month Dec-Mar window, average aggregation, 1.0× cap, separate-meter exclusion mode).

### Phase 2 — WQA snapshot builder (~1.5 weeks)

4. `wqa-snapshot-builder` worker (BullMQ scheduled job).
5. Historical-usage aggregation queries (against `MeterRead`).
6. Aggregation methods (average / median / min).
7. Caps/minimums/maximums application.
8. No-history fallback paths (class average, fixed, current-usage).
9. Operator override endpoint + dual approval integration.

### Phase 3 — Irrigation exclusion (~1 week)

10. `is_irrigation` column + migration; UI to flag a meter as irrigation.
11. Separate-meter exclusion logic.
12. Threshold-based exclusion logic.
13. Customer portal "Request WQA review" task creation.

### Phase 4 — Bill-engine integration (~3 days)

14. The wastewater-calc hook that Module 09's bill calculator calls.
15. Bill detail provenance (which mode, which snapshot, what was excluded).

### Phase 5 — Portal transparency (~3 days)

16. Bill detail page shows WQA basis.
17. WQA history view.
18. Plain-English explainer page.

**Total: ~3.5-4 weeks** with one engineer; ~2.5 weeks with two parallel tracks (Phase 2 snapshot builder + Phase 3 irrigation exclusion can overlap).

---

## 6. Out of scope

1. **Mid-cycle WQA recomputation** — WQA is computed annually, not per-bill. A customer's WQA for billing year 2027 is fixed once the snapshot is generated in April 2027. Re-running the snapshot mid-year is the operator-override path (FR-WW-024), not an automatic process.
2. **Predictive WQA** — no machine learning to predict next year's WQA from current trends. Snapshot is computed from observed past usage only.
3. **Cross-tenant class averages** — class average is computed per-tenant, not across all SaaSLogic customers. Each tenant's residential class average reflects their local usage patterns.
4. **Cooling-tower / commercial deduction percentages** — non-irrigation non-sewer water exclusions for commercial customers (cooling towers, evaporative HVAC, manufacturing process water) are a separate workflow. Per FR-WW-064, addressed via customer-specific `WastewaterBillingConfig` overrides if needed; the standard threshold mode does not target these.
5. **Sub-meter aggregation for multi-tenant commercial buildings** — buildings with one master meter and multiple tenant sub-meters require a different billing model. Addressed in [docs/specs/03-meter-management.md](../specs/03-meter-management.md) master/sub-meter design; not in this doc.
6. **Historical-rate WQA for retroactive bill correction** — when a customer disputes a year-old bill, the WQA snapshot from that period is used as-is (immutability per FR-WW-020). The dispute flow uses [12-corrections-and-reversals.md](./12-corrections-and-reversals.md) reversal patterns; this doc doesn't cover the dispute math itself.
7. **Tax computation on wastewater charges** — taxes are downstream of the volume calculation; SaaSLogic Billing handles per [docs/specs/21-saaslogic-billing.md](../specs/21-saaslogic-billing.md). The WW volume is the input; tax is applied per the rate schedule.
8. **Real-time consumption alerts driven off WQA threshold** — "your usage is X% above your WQA" customer alerts are a portal/notification feature, not a billing one. Could ride on top of the snapshot but out of scope here.
9. **Inter-utility WQA portability** — a customer who moves between utilities doesn't carry their WQA with them. Each utility computes from its own meter data.
10. **WQA-driven conservation incentives** — pricing models that reward customers whose summer usage stays close to their WQA are a rate-design question for the City and Bozeman's utility commission. Out of scope.

---

## 7. Risks and mitigations

| Risk | Severity | Mitigation |
|---|---|---|
| Customer disputes WQA basis | **High** | Customer portal shows full derivation (FR-WW-090); operator-override path (FR-WW-024) handles legitimate appeals; dual approval ensures consistency. |
| Winter window misconfigured (e.g., includes November when irrigation still happens in unusually warm year) | Medium | Tenant-configurable per `WastewaterBillingConfig`; operations dashboard surfaces the average WQA deviation year-over-year; outliers trigger review. |
| New-customer class-average is too high (penalizes new movers) or too low (under-charges) | Medium | Class-average computed per-territory per-premise-type per-year using only customers with sufficient history; operations dashboard shows the value before annual snapshot generation; operators can review/override the class average before it propagates. |
| Threshold-based irrigation exclusion misclassifies summer indoor usage | Medium | Threshold is per-tenant configurable (`irrigationThresholdPct`); operator override available for individual customers (FR-WW-024); customer portal shows the exclusion math so disputes can be informed. |
| Snapshot generated against meter reads that are later corrected | Medium | Snapshot is immutable; rebuild requires operator action via override (FR-WW-024); previously-issued bills are not auto-rebilled — operators decide via doc 12 reversal pattern. |
| Worker fails partway through annual snapshot generation | Medium | Per-SA atomic; SAs that succeed have snapshots; SAs that fail get retried on next worker tick; `Task` created per doc 13 for SAs that fail repeatedly. |
| Mid-year SA transfer loses WQA history | Low | Per FR-WW-051, WQA transfers with the parcel (not the customer). New owner inherits prior owner's snapshot; documented in customer portal. |
| Tenant configures aggressive caps that effectively zero out WQA | Low | UI surfaces a preview of "average customer wastewater impact" before saving config; configuration changes go through doc 10's draft-and-post pipeline with optional approval per doc 13. |
| Performance: per-SA historical query is slow | Medium | NFR-WW-001 targets 2h for 50K SAs (~150ms each). Queries hit `(meter_id, read_datetime)` index already established in [docs/specs/08-meter-reading.md](../specs/08-meter-reading.md). Snapshot worker batches by 100 SAs per transaction. |
| `service_agreement_meter.is_irrigation` not set, so separate-meter mode silently does nothing | Medium | Validation at SA creation: if `wastewater_basis_mode = WQA` AND `irrigationExclusionMode = separate_meter` AND no irrigation-flagged meter exists, surface a warning. Tenant operator confirms before save. |
| Caps misordered (volume cap applied before irrigation exclusion would have brought volume under cap anyway) | Low | Order of operations is fixed (FR-WW-040); documented; tested with edge-case fixtures. |
| WQA snapshots accumulate unboundedly | Low | Per-(SA, year) unique constraint means at most one snapshot per agreement per year. Retention per doc 08 `AUDIT_FINANCIAL` 7-year floor; old snapshots are archived to Parquet not purged. |
| Operator overrides become routine | Medium | Operations dashboard tracks override frequency per operator + per territory; quarterly compliance review surfaces outliers. Override emits `AUDIT_FINANCIAL` for traceability. |

---

## 8. Acceptance criteria

### Schema + config
- [ ] `WastewaterBillingConfig` and `WqaSnapshot` tables exist with RLS.
- [ ] `service_agreement_meter.is_irrigation` column exists.
- [ ] `service_territory_rate.wastewater_basis_config_id` FK exists.

### WQA computation
- [ ] WQA snapshot worker runs annually; produces one snapshot per active residential SA per billing year.
- [ ] Three aggregation methods (average / median / min) produce expected values against fixture data.
- [ ] Configurable window (3, 4, 5 months; arbitrary start month) works.
- [ ] No-history fallback (class_average / fixed_volume / current_usage) produces correct values.
- [ ] Operator override creates a new snapshot superseding the prior one; both visible in audit.
- [ ] Mid-year SA transfer carries the parcel's WQA forward.

### Caps + minimums + maximums
- [ ] All four cap/min/max parameters (capPctOfDirect, minVolume, maxVolume, minBillAmount) apply in correct order.
- [ ] Individual params can be null (unconstrained).

### Irrigation exclusion
- [ ] `separate_meter` mode excludes is_irrigation=true meters from the wastewater basis.
- [ ] `threshold` mode excludes excess summer usage above WQA × (1 + threshold).
- [ ] `off` mode applies no exclusion.
- [ ] Excluded volume is captured in `WqaSnapshot.irrigationExcludedVolume` and shown to the customer.

### Bill-engine integration
- [ ] When Module 09's bill calculator runs for a residential WW agreement, it reads the customer's WQA snapshot and applies it correctly.
- [ ] Bill detail's `charge_breakdown` JSON shows the WQA basis with full provenance.
- [ ] Read corrections in the winter window flag the snapshot as candidate-for-rebuild; operator decides.

### Portal transparency
- [ ] Customer portal bill detail shows: mode used, snapshot ID, window dates, aggregated volume, irrigation excluded, capped (if applicable), final per-cycle volume.
- [ ] WQA history view shows last 5 years of snapshots.
- [ ] "Request WQA review" portal action creates a `Task` per doc 13.

### Non-functional
- [ ] Annual snapshot worker ≤2h p99 for 50K residential SAs (NFR-WW-001).
- [ ] Per-bill wastewater calc ≤30ms p99 (NFR-WW-002).
- [ ] Snapshot retention follows AUDIT_FINANCIAL class (7-year floor; NFR-WW-003).

---

## 9. References

- **Internal**:
  - [docs/specs/07-rate-management.md](../specs/07-rate-management.md) — `RateSchedule` versioning pattern reused for `WastewaterBillingConfig`
  - [docs/specs/08-meter-reading.md](../specs/08-meter-reading.md) — `MeterRead` queried by snapshot worker; read-correction flow
  - [docs/specs/09-billing.md](../specs/09-billing.md) — Module 09 bill calculator consumes `WqaSnapshot` (hard dependency)
  - [docs/specs/03-meter-management.md](../specs/03-meter-management.md) — `service_agreement_meter` extended with `is_irrigation`
  - [01-audit-and-tamper-evidence.md](./01-audit-and-tamper-evidence.md) — `AUDIT_FINANCIAL` event class for snapshot creation + override
  - [05-customer-portal.md](./05-customer-portal.md) — portal bill detail extended with WQA provenance
  - [08-data-retention-archival-purge.md](./08-data-retention-archival-purge.md) — `AUDIT_FINANCIAL` retention class for snapshots
  - [10-draft-status-and-posting.md](./10-draft-status-and-posting.md) — `WastewaterBillingConfig` edits use the draft-and-post pipeline
  - [12-corrections-and-reversals.md](./12-corrections-and-reversals.md) — bill rebill via reversal pattern when WQA is recomputed mid-year
  - [13-workflow-approvals-action-queue.md](./13-workflow-approvals-action-queue.md) — Tasks for "Request WQA review", dual approval on overrides, snapshot-builder failure tasks
  - [15-gis-driven-defaults-and-effective-dating.md](./15-gis-driven-defaults-and-effective-dating.md) — `service_territory_rate` extended with `wastewater_basis_config_id`

- **External**:
  - Bozeman wastewater rate ordinance (most recent revision) — to be referenced in proposal appendix
  - Mountain-West WQA practice — utility-industry standard for seasonal wastewater billing
  - Montana Public Service Commission rules — drive cap/min/max limits

---

**End of doc 16.**
