# Billing

**Module:** 09 — Billing
**Status:** Stub (Phase 3)
**Entities:** BillingRecord (planned), BillDocument (planned), BillMessage (planned)

## Overview

The Billing module is the core revenue engine of the CIS. It executes billing cycles — gathering validated meter reads, applying rate schedules, calculating charges, generating bill documents, and handing off structured billing instructions to SaaSLogic for invoicing and payment processing.

**Key architectural principle:** CIS calculates what is owed and why. SaaSLogic owns the invoice, payment ledger, and financial records. The handoff is a structured billing instruction — a machine-readable charge breakdown per service agreement. This boundary is non-negotiable.

Primary users: billing administrators, finance staff, utility managers.

## Planned Entities

### BillingRecord (planned)

One record per service agreement per billing cycle execution. Represents the charge calculation produced by the CIS rate engine before handoff to SaaSLogic.

| Field | Type | Notes |
|-------|------|-------|
| id | UUID | PK |
| utility_id | UUID | Tenant scope |
| service_agreement_id | UUID | FK → ServiceAgreement |
| billing_cycle_id | UUID | FK → BillingCycle |
| billing_period_start | DATE | Start of billed period |
| billing_period_end | DATE | End of billed period |
| read_id_start | UUID | FK → MeterRead (opening read) |
| read_id_end | UUID | FK → MeterRead (closing read) |
| consumption | DECIMAL(12,4) | Billed consumption units |
| rate_schedule_id | UUID | FK → RateSchedule (version used) |
| charge_breakdown | JSONB | Itemized line items (see structure below) |
| total_amount | DECIMAL(10,2) | Sum of all charges |
| is_prorated | BOOLEAN | True if partial billing period |
| prorate_days | INTEGER | Nullable: actual days in period |
| prorate_full_days | INTEGER | Nullable: full cycle days for proration |
| status | ENUM | PENDING, SUBMITTED, ACCEPTED, REJECTED, HELD, REPRINTED |
| hold_reason | VARCHAR(500) | Nullable: why bill is on hold |
| saaslogic_invoice_id | UUID | Nullable: populated after SaaSLogic accepts |
| is_final_bill | BOOLEAN | True if associated with account closure |
| version | INTEGER | Default 1; increments on reprint/correction |
| replaces_id | UUID | Nullable self-reference: for reprints/corrections |
| created_at | TIMESTAMPTZ | |
| submitted_at | TIMESTAMPTZ | When sent to SaaSLogic |
| updated_at | TIMESTAMPTZ | |

**charge_breakdown JSONB structure:**
```json
{
  "lines": [
    { "type": "BASE_CHARGE",    "description": "Monthly base charge",        "amount": 8.50 },
    { "type": "CONSUMPTION",    "description": "2,450 gal @ $0.0033/gal",    "amount": 8.09 },
    { "type": "TIER_2",         "description": "450 gal @ $0.0047/gal",      "amount": 2.12 },
    { "type": "SURCHARGE",      "description": "State regulatory surcharge",  "amount": 0.75 },
    { "type": "TAX",            "description": "City franchise fee (2%)",     "amount": 0.39 },
    { "type": "WQA_CREDIT",     "description": "Winter usage adjustment",     "amount": -1.20 }
  ],
  "subtotal": 18.65,
  "taxes": 0.39,
  "total": 19.04
}
```

**Indexes:** `[utility_id, billing_cycle_id, status]`, `[utility_id, service_agreement_id, billing_period_end DESC]`

---

### BillDocument (planned)

Rendered bill artifact — PDF or structured data file — associated with a BillingRecord. Supports bill viewing, reprints, and print-vendor delivery.

| Field | Type | Notes |
|-------|------|-------|
| id | UUID | PK |
| utility_id | UUID | Tenant scope |
| billing_record_id | UUID | FK → BillingRecord |
| account_id | UUID | FK → Account |
| document_type | ENUM | PDF, PRINT_EXPORT, EMAIL_HTML |
| storage_url | VARCHAR(1000) | S3 or blob storage path |
| file_size_bytes | INTEGER | |
| generated_at | TIMESTAMPTZ | When rendered |
| delivery_channel | ENUM | EMAIL, MAIL, PORTAL, PRINT_VENDOR |
| delivered_at | TIMESTAMPTZ | Nullable |
| delivery_status | ENUM | PENDING, DELIVERED, FAILED, BOUNCED |
| is_paperless | BOOLEAN | Copy of Account.paperless_billing at time of generation |
| created_at | TIMESTAMPTZ | |

---

### BillMessage (planned)

Configurable messages that appear on bill documents, segmented by account type, commodity, or date range.

| Field | Type | Notes |
|-------|------|-------|
| id | UUID | PK |
| utility_id | UUID | Tenant scope |
| message_text | TEXT | The message to display on the bill |
| account_type | ENUM | Nullable: RESIDENTIAL, COMMERCIAL, INDUSTRIAL, MUNICIPAL; null = all |
| commodity_id | UUID | Nullable FK → Commodity; null = all commodities |
| display_start | DATE | When to begin showing this message |
| display_end | DATE | Nullable: when to stop showing; null = indefinite |
| priority | INTEGER | Display order when multiple messages apply |
| is_active | BOOLEAN | |
| created_at | TIMESTAMPTZ | |
| updated_at | TIMESTAMPTZ | |

---

## API Endpoints

All endpoints are planned for Phase 3.

### Billing Cycle Execution

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/v1/billing/run` | Execute billing cycle: calculates charges, creates BillingRecords |
| GET | `/api/v1/billing/runs` | List billing cycle executions with status |
| GET | `/api/v1/billing/runs/:runId` | Get execution detail, counts, errors |
| POST | `/api/v1/billing/runs/:runId/submit` | Submit batch to SaaSLogic after review |

### Billing Records

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/billing-records` | List records (filterable by cycle, status, account) |
| GET | `/api/v1/billing-records/:id` | Get record detail with full charge_breakdown |
| POST | `/api/v1/billing-records/:id/hold` | Place billing hold with reason |
| POST | `/api/v1/billing-records/:id/release-hold` | Release hold |
| POST | `/api/v1/billing-records/:id/reprint` | Generate corrected bill (creates new version) |

### Bill Documents

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/billing-records/:id/document` | Retrieve or generate PDF for a billing record |
| POST | `/api/v1/billing-records/:id/resend` | Resend bill via original delivery channel |

### Bill Messages

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/bill-messages` | List bill messages |
| POST | `/api/v1/bill-messages` | Create bill message |
| PATCH | `/api/v1/bill-messages/:id` | Update message |
| DELETE | `/api/v1/bill-messages/:id` | Deactivate message |

## Business Rules

1. **Billing cycle execution prerequisites:** Before a billing cycle run begins, the system validates: (a) all meters in the cycle have a read for the billing period, (b) no reads in the period are in exception-pending state, (c) no active billing hold on the service agreement. Failures are reported per service agreement; the run continues for qualifying agreements.

2. **Rate engine application:** For each service agreement in the cycle, the system identifies the active RateSchedule as of the billing period end date, applies the `rate_config` to consumption, and produces a `charge_breakdown`. Rate type logic:
   - **FLAT:** `base_charge + (consumption × per_unit_rate)`
   - **TIERED:** `base_charge + sum of (units_in_tier × tier_rate)` per tier consumed
   - **TOU:** consumption split by time-of-use period, each rated at period rate
   - **DEMAND:** `base_charge + (consumption × energy_rate) + (peak_demand × demand_charge_per_kw)`, with ratchet applied if applicable
   - **BUDGET:** monthly budget amount; true-up in reconciliation month

3. **Minimum bill enforcement:** If total charges fall below `rate_config.minimum_bill`, the total is raised to the minimum with a MINIMUM_BILL line item.

4. **Proration:** Service agreements that started or ended mid-cycle receive prorated charges. Proration factor = `actual_days / full_cycle_days`. Applied to consumption-based charges; base charge may or may not be prorated based on tenant configuration.

5. **WQA (Wastewater Quality Adjustment):** Wastewater charges are calculated as a configurable percentage of the linked water service agreement's consumption for the period. Winter averaging uses the average of the 3 lowest monthly winter reads to set a WQA cap, protecting customers from high summer irrigation charges being applied to sewer. Irrigation meters are excluded (Bozeman Reqs 69–73).

6. **Bill holds:** A service agreement with `hold_reason` set cannot be submitted to SaaSLogic. Holds must be reviewed and released by authorized staff. Hold reasons are logged in AuditLog.

7. **Bill versioning / reprints:** A reprinted bill creates a new BillingRecord with `version = old.version + 1` and `replaces_id = old.id`. The SaaSLogic credit memo / adjustment process is triggered for the difference. The original record is retained for audit.

8. **SaaSLogic handoff:** Billing instructions are POSTed to the SaaSLogic REST API per service agreement. Each instruction includes: account reference, billing period, charge breakdown, due date. SaaSLogic returns an invoice ID stored in `saaslogic_invoice_id`.

9. **Final bill:** When a service agreement is terminated (status → FINAL), a final bill is generated for the period from the last regular bill to the final read date, prorated appropriately.

10. **Charge validation:** Before submission, total_amount is validated against the adopted rate schedule. Discrepancies above a configurable tolerance threshold trigger an exception requiring supervisor approval (Bozeman Req 140).

11. **Bill messages:** At bill render time, all active BillMessages matching the service agreement's account type and commodity (or global messages) are included, ordered by priority.

12. **PDF generation:** Bill documents are rendered server-side using a configurable bill template. PDFs are stored in blob storage; the `storage_url` provides access. Paperless customers receive the PDF via email; others receive a print-vendor export file (Bozeman Reqs 130–131).

## UI Pages

All pages are planned for Phase 3.

### Billing Dashboard (`/billing`)

- Summary cards: accounts ready to bill, bills on hold, pending SaaSLogic submission, this cycle's total revenue
- Aging dashboard widget linking to Module 10 (Bozeman Reqs 149–150)
- "Run Billing Cycle" action: select cycle, preview impacted accounts, confirm

### Billing Run Detail (`/billing/runs/:runId`)

- Run metadata: cycle, execution timestamp, user who triggered
- Status breakdown table: PENDING / SUBMITTED / HELD / REJECTED counts
- Per-agreement results: expandable rows with charge summaries and any errors
- Bulk actions: submit all PENDING, release all holds
- Download: CSV export of run results

### Billing Record Detail (`/billing-records/:id`)

- Full charge breakdown rendered as itemized table
- Proration details if applicable
- WQA calculation breakdown if applicable
- PDF preview / download button
- Status badge and SaaSLogic invoice link
- Hold management: add/release hold with reason
- Version history: if this is a reprint, shows full chain
- Reprint action (supervisor-only)
- Audit log entries for this record

### Bill Messages (`/billing/messages`)

- Table of active/inactive messages with date ranges and targeting
- Create/edit form: rich text, account type filter, commodity filter, date range
- Preview: shows how message renders on a sample bill

## Phase Roadmap

- **Phase 1 (Complete):** RateSchedule and BillingCycle entities defined. No billing execution.

- **Phase 2 (Planned):** MeterRead CRUD (prerequisite — Module 08). Consumption calculation finalized. Read freeze mechanism.

- **Phase 3 (Planned):**
  - BillingRecord entity + rate engine for all 5 rate types
  - Billing cycle execution (batch run)
  - Proration logic
  - WQA (wastewater as % of water, winter averaging, irrigation exclusions)
  - Bill holds
  - SaaSLogic integration (billing instruction POST, invoice ID storage)
  - BillDocument entity + PDF generation
  - Print vendor export
  - BillMessage entity + bill message UI
  - Bill reprints and versioning
  - Final bill generation on account closure
  - Charge validation against adopted rates
  - Tax and surcharge line items (TaxRule, Surcharge from Module 07)

- **Phase 4 (Planned):** Bill viewing in customer portal (Module 15). Multi-account billing views.

## Bozeman RFP Coverage

| Req | Requirement | Coverage |
|-----|-------------|----------|
| 61 | Consolidated bill with service-level accounting | Phase 3: charge_breakdown per service agreement, consolidated by SaaSLogic |
| 62 | Effective-dated enrollment with proration | Phase 3: proration logic in rate engine |
| 63 | Regulatory fees and surcharges | Phase 3: Surcharge entity in charge_breakdown |
| 64 | Configurable taxes and franchise fees | Phase 3: TaxRule entity |
| 69 | Wastewater = % of water usage | Phase 3: WQA linked billing calculation |
| 70 | Caps, mins, maxes for wastewater/WQA | Phase 3: rate_config extensions |
| 71 | Configurable WQA calculations | Phase 3: WQA calculation module |
| 72 | Winter averaging for wastewater | Phase 3: part of WQA module |
| 73 | Exclude irrigation from wastewater | Phase 3: meter-type exclusion in WQA |
| 74 | Minimum bills regardless of usage | minimum_bill enforcement in rate engine |
| 101–105 | Interval aggregation, partial periods, rebilling, reconciliation | Phase 3: rate engine scope |
| 130 | PDF bill generation, historical images | Phase 3: BillDocument entity + PDF renderer |
| 131 | Print vendor integration | Phase 3: print export file delivery |
| 133 | Bill reprints, corrected bills with versioning | Phase 3: BillingRecord versioning with replaces_id |
| 134 | Final bill at account closure | Phase 3: FINAL billing trigger |
| 136 | Bill holds | Phase 3: hold_reason on BillingRecord |
| 137 | Configurable bill messages by account type/service | Phase 3: BillMessage entity |
| 138 | Prorate tier thresholds for partial periods | Phase 3: proration in rate engine |
| 139 | Itemized charges on bills | charge_breakdown JSONB with line items |
| 140 | Validate charges against adopted rates | Phase 3: charge validation before submission |
| 141 | Reconciliation: water usage vs wastewater billing | Phase 3: WQA-related |
| 142 | Rebill on read corrections | Phase 3: CORRECTED read → reprint flow |
| 149–150 | Aging dashboard (real-time) | Phase 3: AR aging query surfaced in billing dashboard |
| 157–164 | Payment processing (PCI, ACH, posting, reversals) | Phase 3: delegated to SaaSLogic |
