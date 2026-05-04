# Rate Management

**Module:** 07 — Rate Management
**Status:** Built (v1) — Migrating to v2
**Entities:** RateSchedule, BillingCycle (v1) plus the v2 entities listed below

> **⚠️ v2 migration in progress.** The single-blob `rate_type` + `rate_config` model documented below is being replaced with a normalised component-based model. Work is split across 5 slices. The full v2 design is in [`07b-rate-model-v2-design.md`](./07b-rate-model-v2-design.md). The slice-1 schema additions (`rate_component_kind`, `rate_assignment_role`, plus more entities coming) are landing now; this doc will be rewritten when v2 is complete.
>
> v2 entities added so far:
> - `rate_component_kind` (slice 1) — closed-grammar codes for component kinds (service_charge, consumption, …)
> - `rate_assignment_role` (slice 1) — closed-grammar codes for SA→schedule assignment roles (primary, delivery, supply, rider, opt_in)

## Overview

The Rate Management module defines how a utility prices its services. It owns all pricing structures — flat, tiered, time-of-use, demand-based, and budget billing — and the billing cycle configuration that governs when reads and bills are generated. Rate schedules are effective-dated and versioned, allowing future rate ordinances to be entered and activated without rebilling or system disruption.

Primary users: utility rate administrators, finance staff, operations managers.

## Entities

### RateSchedule

Pricing rules for a single commodity. Effective-dated and versioned via a self-referencing version chain.

| Field | Type | Notes |
|-------|------|-------|
| id | UUID | PK |
| utility_id | UUID | Tenant scope (RLS enforced) |
| name | VARCHAR(255) | Human-readable name, e.g. "Residential Water Schedule A" |
| code | VARCHAR(50) | Short code, unique per utility per version |
| commodity_id | UUID | FK → Commodity |
| rate_type | ENUM | FLAT, TIERED, TIME_OF_USE, DEMAND, BUDGET |
| effective_date | DATE | When this schedule becomes active |
| expiration_date | DATE | Null = currently active. Set automatically when superseded |
| description | TEXT | Narrative description, shown on bills and in UI |
| regulatory_ref | VARCHAR(100) | Docket number or ordinance reference |
| rate_config | JSONB | Structure varies by rate_type (see below) |
| version | INTEGER | Default 1, increments on revision |
| supersedes_id | UUID | Nullable self-reference FK — points to the prior version |
| created_at | TIMESTAMPTZ | |

**Unique constraint:** `[utility_id, code, version]`

**Indexes:** `[utility_id, commodity_id, effective_date]`, `[utility_id, code]`

#### rate_config JSONB Structures by rate_type

**FLAT** — single price per unit of consumption:
```json
{
  "base_charge": 8.50,
  "per_unit_rate": 0.0042,
  "minimum_bill": 8.50
}
```

**TIERED** — block/step pricing, rate changes as consumption increases:
```json
{
  "base_charge": 8.50,
  "minimum_bill": 8.50,
  "tiers": [
    { "from": 0,    "to": 2000,  "rate": 0.0033 },
    { "from": 2001, "to": 5000,  "rate": 0.0047 },
    { "from": 5001, "to": null,  "rate": 0.0065 }
  ]
}
```
`to: null` means unbounded (final tier). Tiers must be contiguous and non-overlapping. Validated on save.

**TIME_OF_USE (TOU)** — rate varies by time window (primarily electric):
```json
{
  "base_charge": 12.00,
  "minimum_bill": 12.00,
  "periods": [
    { "name": "On-Peak",    "hours": "14:00-20:00", "days": "weekdays", "rate": 0.14 },
    { "name": "Off-Peak",   "hours": "20:00-14:00", "days": "weekdays", "rate": 0.07 },
    { "name": "Weekend",    "hours": "00:00-24:00", "days": "weekends", "rate": 0.08 }
  ]
}
```

**DEMAND** — includes a peak-demand charge component (kW or gpm):
```json
{
  "base_charge": 25.00,
  "minimum_bill": 25.00,
  "energy_rate": 0.065,
  "demand_charge_per_kw": 8.50,
  "demand_ratchet_percent": 85
}
```
`demand_ratchet_percent` establishes a minimum billable demand as a percentage of peak demand in the prior 12 months.

**BUDGET** — smoothed billing based on estimated annual consumption:
```json
{
  "base_charge": 0.00,
  "budget_months": 11,
  "true_up_month": 12,
  "smoothing_method": "ROLLING_AVERAGE",
  "reconciliation_threshold": 50.00
}
```
Budget billing calculates an average monthly payment. Month 12 (or configurable) reconciles actual vs. billed. Accounts opt in via `Account.budget_billing`.

---

### BillingCycle

Defines a read-and-bill schedule. All service agreements are assigned to exactly one billing cycle.

| Field | Type | Notes |
|-------|------|-------|
| id | UUID | PK |
| utility_id | UUID | Tenant scope |
| name | VARCHAR(255) | e.g. "Monthly Cycle A", "North District Quarterly" |
| cycle_code | VARCHAR(20) | Short code, unique per utility |
| read_day_of_month | INTEGER | 1–28: day meters are scheduled to be read |
| bill_day_of_month | INTEGER | 1–28: day bills are generated and sent |
| frequency | ENUM | MONTHLY, BIMONTHLY, QUARTERLY |
| active | BOOLEAN | Inactive cycles cannot accept new service agreements |

**Unique constraint:** `[utility_id, cycle_code]`

**Note:** Days are capped at 28 to avoid month-end ambiguity (e.g., February). If the read or bill day falls on a weekend or holiday, business logic advances to the next business day.

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/rate-schedules` | List rate schedules (paginated, filterable by commodity, rate_type, active) |
| POST | `/api/v1/rate-schedules` | Create a new rate schedule |
| GET | `/api/v1/rate-schedules/:id` | Get rate schedule detail including version history |
| POST | `/api/v1/rate-schedules/:id/revise` | Create a new version superseding this one |
| GET | `/api/v1/billing-cycles` | List billing cycles |
| POST | `/api/v1/billing-cycles` | Create a billing cycle |
| GET | `/api/v1/billing-cycles/:id` | Get billing cycle detail |
| PATCH | `/api/v1/billing-cycles/:id` | Update billing cycle (name, days, active flag) |

### Query Parameters (Rate Schedules)

- `commodity_id` — filter by commodity
- `rate_type` — FLAT | TIERED | TIME_OF_USE | DEMAND | BUDGET
- `active_on` — date (YYYY-MM-DD): returns schedules effective on that date
- `page`, `limit`, `sort`, `order`

### Revision Endpoint

`POST /api/v1/rate-schedules/:id/revise` accepts the same body as create. On success:
1. Sets `expiration_date` on the current version to `new_effective_date - 1 day`
2. Creates the new version with `version = old.version + 1` and `supersedes_id = old.id`
3. Wraps both operations in a `$transaction` to prevent partial state

## Business Rules

1. **Effective date ordering:** A new version's `effective_date` must be strictly after the current version's `effective_date`. Past-dated revisions are rejected.

2. **Expiration on supersede:** When a rate schedule is revised, the predecessor's `expiration_date` is automatically set to `new_effective_date - 1 day` in a single transaction. This is never set manually.

3. **Active schedule determination:** A schedule is active when `effective_date <= today` and (`expiration_date IS NULL` OR `expiration_date >= today`). At most one version of a given code can be active at any time (enforced by the revision transaction).

4. **Rate config validation:** `rate_config` is validated against a per-rate_type Zod schema at the API layer before persistence. Tier gaps or overlaps are rejected. TOU period hours must be parseable and non-overlapping.

5. **Assignment guard:** A rate schedule assigned to active service agreements cannot be deleted. Revise (create new version) instead.

6. **Tiered rate tier ordering:** Tiers must be ordered ascending by `from` value with no gaps between consecutive `to` and `from` values.

7. **Minimum bill:** If `minimum_bill` is set, the calculated bill is floored at that value regardless of consumption.

8. **Budget billing eligibility:** Only accounts with `budget_billing = true` and a rate schedule of type BUDGET are enrolled in budget billing. Assignment enforced at service agreement creation.

9. **Billing cycle read/bill day constraint:** `read_day_of_month` must precede `bill_day_of_month` within the same month to ensure reads are available before bills generate.

10. **Bozeman RFP Req 68:** Future-dated rate ordinances can be entered at any time and will activate automatically on `effective_date`. No rebilling of prior periods occurs unless explicitly triggered.

## UI Pages

### Rate Schedules List (`/rate-schedules`)

- Paginated table: name, code, commodity, rate_type, effective_date, expiration_date, status badge (Active/Expired/Future)
- Filters: commodity dropdown, rate_type chips, active/expired/all toggle
- "New Rate Schedule" button → create form

### Rate Schedule Detail (`/rate-schedules/:id`)

**Tabs:**

- **Overview:** All fields, formatted `rate_config` display (tier table for TIERED, period cards for TOU, etc.), regulatory reference, version badge
- **Version History:** Timeline of all versions in the chain, effective date ranges, diff view between versions
- **Actions:** "Revise" button opens revision form; "View Assignments" shows assigned service agreements

### Rate Schedule Create / Revise (`/rate-schedules/new`, modal on revise)

- Dynamic form: selecting `rate_type` renders the appropriate `rate_config` editor
- TIERED: interactive tier builder (add/remove rows, validates contiguity)
- TOU: period editor with time range pickers
- DEMAND: numeric inputs for demand charge and ratchet
- BUDGET: smoothing configuration
- Effective date DatePicker (blocked to future for revisions)
- Regulatory reference field
- HelpTooltip on all key fields referencing the applicable BR-RS rule (e.g., BR-RS-001 on effective date ordering, BR-RS-002 on expiration, BR-RS-004 on rate config validation)

### Billing Cycles (`/billing-cycles`)

- Table: name, code, frequency, read_day, bill_day, active status
- Inline edit for day values
- "New Cycle" button

### Billing Cycle Detail (`/billing-cycles/:id`)

- Overview fields with inline editing on all editable fields
- Deactivate button with confirmation dialog (sets `active = false`)
- Count of active service agreements assigned
- Calendar preview: next 12 read/bill dates based on frequency and day settings

## Phase Roadmap

- **Phase 1 (Complete):** RateSchedule entity, BillingCycle entity, all 8 endpoints, rate_config JSONB for all 5 rate types, effective dating, version chain (supersedes), tier builder UI, version history UI, active schedule filter.
- **Phase 2 (Built):** BillingCycle detail inline editing. BillingCycle Deactivate button with confirmation. HelpTooltip components on Rate Schedule create/revise form fields referencing BR-RS rules. DatePicker for effective date on rate schedule forms.

- **Phase 3:** Rate engine — the calculation component that applies a RateSchedule to a MeterRead and produces a charge breakdown. Rate eligibility by account type (Bozeman Req 67). Prorated tier thresholds for partial billing periods (Req 138). Validation that charges match adopted rates (Req 140).

- **Phase 3:** WQA (Water Quality Adjustment) — wastewater billed as a percentage of water consumption (Req 69), with winter averaging (Req 72), irrigation exclusions (Req 73), and configurable caps/mins/maxes (Req 70–71). Will extend `rate_config` for linked billing.

- **Phase 3:** Surcharges and taxes — `TaxRule` and `Surcharge` entities attached to rate schedules or account types (Reqs 63–64).

## Bozeman RFP Coverage

| Req | Requirement | Coverage |
|-----|-------------|----------|
| 65 | Meter multiplier/scaling factors | Meter.multiplier applied during consumption calculation |
| 66 | Multiple water rate structures | FLAT, TIERED, TIME_OF_USE, DEMAND, BUDGET types |
| 67 | Different rates by customer type | Partial — rate_schedule_id on ServiceAgreement; Phase 3 adds eligibility rules |
| 68 | Future-dated rate ordinances | effective_date / expiration_date with version chain |
| 74 | Minimum bills regardless of usage | minimum_bill field in rate_config |
| 135 | Multiple concurrent billing cycles | BillingCycle entity; unlimited cycles per tenant |
| 58 | Future-dated rate/policy changes (solid waste) | Same mechanism — effective dating applies to all commodities |
