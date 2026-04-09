# Special Assessments

**Module:** 16 — Special Assessments
**Status:** Stub (Phase 5)
**Entities:** AssessmentDistrict (planned), ParcelAssessment (planned), AssessmentInstallment (planned)

## Overview

The Special Assessments module manages property-based infrastructure assessments — charges levied against parcels within defined districts to fund capital improvements (water main replacement, sewer rehabilitation, stormwater infrastructure, etc.). Unlike metered utility billing, special assessments are tied to property parcels (not utility accounts), may be structured as multi-year installment plans with interest, and must handle ownership transfer when a property sells.

This is an entirely new domain that stands largely independent of the core CIS billing engine. It integrates with GIS for parcel identification and with SaaSLogic for assessment charge collection.

Primary users: finance administrators, engineering staff, city finance departments, utility managers.

## Planned Entities

### AssessmentDistrict (planned)

Defines a geographic or project-based district within which assessments are levied.

| Field | Type | Notes |
|-------|------|-------|
| id | UUID | PK |
| utility_id | UUID | Tenant scope |
| district_name | VARCHAR(255) | |
| district_code | VARCHAR(50) | Unique per utility |
| description | TEXT | Project description, ordinance reference |
| improvement_type | VARCHAR(100) | e.g. "Water Main Replacement", "Sewer Rehabilitation" |
| ordinance_number | VARCHAR(100) | Nullable: authorizing ordinance/resolution |
| total_project_cost | DECIMAL(15,2) | Total amount to be assessed |
| status | ENUM | DRAFT, ACTIVE, COMPLETED, SUNSET |
| assessment_method | ENUM | PER_PARCEL, PER_FRONT_FOOT, PER_SQUARE_FOOT, BENEFIT_UNIT, FORMULA |
| billing_frequency | ENUM | ANNUAL, SEMIANNUAL, QUARTERLY |
| installment_years | INTEGER | Number of years for installment plans |
| interest_rate | DECIMAL(5,4) | Annual interest rate (e.g. 0.0500 = 5%) |
| start_date | DATE | When assessments begin billing |
| end_date | DATE | Nullable: when district expires |
| gis_layer_id | VARCHAR(100) | Nullable: GIS layer or polygon ID defining district boundary |
| parcel_count | INTEGER | Computed: number of parcels in district |
| created_at | TIMESTAMPTZ | |
| updated_at | TIMESTAMPTZ | |

**Unique constraint:** `[utility_id, district_code]`

**Status transitions:** DRAFT → ACTIVE → COMPLETED | SUNSET

---

### ParcelAssessment (planned)

The individual assessment levied against a specific parcel within a district.

| Field | Type | Notes |
|-------|------|-------|
| id | UUID | PK |
| utility_id | UUID | Tenant scope |
| district_id | UUID | FK → AssessmentDistrict |
| parcel_id | VARCHAR(100) | Parcel number from GIS / county assessor |
| premise_id | UUID | Nullable FK → Premise (if parcel is in CIS) |
| gis_parcel_id | VARCHAR(100) | GIS system parcel identifier |
| owner_name | VARCHAR(255) | Property owner at time of assessment |
| owner_mailing_address | TEXT | For billing notices |
| assessment_basis | DECIMAL(10,4) | Measurement used (front footage, sq ft, benefit units, etc.) |
| assessment_rate | DECIMAL(10,4) | Rate applied to basis (from district assessment_method) |
| principal_amount | DECIMAL(12,2) | Total principal assessed against this parcel |
| status | ENUM | ACTIVE, PAID_IN_FULL, TRANSFERRED, APPEALED, WRITTEN_OFF |
| payment_type | ENUM | INSTALLMENT, LUMP_SUM |
| lump_sum_paid_at | TIMESTAMPTZ | Nullable: if paid in full upfront |
| lump_sum_discount | DECIMAL(10,2) | Nullable: early payoff discount applied |
| appeal_status | ENUM | Nullable: PENDING, UPHELD, OVERTURNED, WITHDRAWN |
| appeal_notes | TEXT | |
| override_reason | TEXT | Nullable: if assessment was manually overridden from formula |
| overridden_by | UUID | Nullable FK → User |
| created_at | TIMESTAMPTZ | |
| updated_at | TIMESTAMPTZ | |

**Indexes:** `[utility_id, district_id]`, `[utility_id, parcel_id]`, `[utility_id, premise_id]`

---

### AssessmentInstallment (planned)

Individual installment payment schedule entries for a parcel assessment. One row per installment period.

| Field | Type | Notes |
|-------|------|-------|
| id | UUID | PK |
| utility_id | UUID | Tenant scope |
| parcel_assessment_id | UUID | FK → ParcelAssessment |
| installment_number | INTEGER | 1-based sequence |
| due_date | DATE | |
| principal_amount | DECIMAL(10,2) | Principal portion of this installment |
| interest_amount | DECIMAL(10,2) | Interest portion |
| total_due | DECIMAL(10,2) | principal + interest |
| late_fee | DECIMAL(10,2) | Default 0; applied if paid after due_date |
| status | ENUM | SCHEDULED, BILLED, PAID, OVERDUE, WAIVED, CANCELLED |
| billed_at | TIMESTAMPTZ | Nullable: when submitted to SaaSLogic |
| paid_at | TIMESTAMPTZ | Nullable: when payment confirmed |
| saaslogic_invoice_id | UUID | Nullable: SaaSLogic invoice reference |
| saaslogic_payment_id | UUID | Nullable: SaaSLogic payment reference |
| created_at | TIMESTAMPTZ | |
| updated_at | TIMESTAMPTZ | |

**Unique constraint:** `[parcel_assessment_id, installment_number]`

---

## API Endpoints

All endpoints are planned for Phase 5.

### Assessment Districts

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/assessment-districts` | List districts |
| POST | `/api/v1/assessment-districts` | Create district |
| GET | `/api/v1/assessment-districts/:id` | Get district detail |
| PATCH | `/api/v1/assessment-districts/:id` | Update district |
| POST | `/api/v1/assessment-districts/:id/activate` | Transition DRAFT → ACTIVE |
| POST | `/api/v1/assessment-districts/:id/sunset` | Mark district as SUNSET |
| GET | `/api/v1/assessment-districts/:id/parcels` | All parcel assessments in district |

### Parcel Assessments

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/parcel-assessments` | List parcel assessments (filterable by district, status) |
| POST | `/api/v1/parcel-assessments` | Create parcel assessment (single) |
| POST | `/api/v1/parcel-assessments/import` | Bulk import parcels from GIS/CSV |
| GET | `/api/v1/parcel-assessments/:id` | Get assessment detail with installment schedule |
| PATCH | `/api/v1/parcel-assessments/:id` | Update assessment (pre-active only; after activation, override with reason) |
| POST | `/api/v1/parcel-assessments/:id/transfer-ownership` | Record ownership transfer |
| POST | `/api/v1/parcel-assessments/:id/early-payoff` | Calculate and apply early payoff |

### Installments

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/parcel-assessments/:id/installments` | List installment schedule |
| POST | `/api/v1/assessment-districts/:id/bill` | Run billing for a district (generate invoices for due installments) |
| GET | `/api/v1/assessment-installments/:id` | Get installment detail |
| POST | `/api/v1/assessment-installments/:id/waive` | Waive an installment (supervisor) |

### Reporting

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/assessment-districts/:id/report` | District summary: collected, outstanding, paid in full count |

## Business Rules

1. **Assessment formula:** The `principal_amount` for each parcel is calculated from: `assessment_basis × assessment_rate`. The basis depends on `assessment_method`:
   - PER_PARCEL: all parcels get equal share; `assessment_basis = 1`
   - PER_FRONT_FOOT: `assessment_basis` is the parcel's street frontage in feet
   - PER_SQUARE_FOOT: `assessment_basis` is the parcel's lot area in sq ft
   - BENEFIT_UNIT: `assessment_basis` is assigned benefit units (e.g., 1.0 for residential, 2.5 for commercial)
   - FORMULA: `assessment_basis` is computed by a custom formula (configured per district)

2. **Installment schedule generation:** When a ParcelAssessment is activated, the installment schedule is auto-generated based on `district.installment_years` and `district.billing_frequency`. Interest is computed using amortization on the outstanding principal balance. Late fees are applied by a nightly job after the due date passes without payment.

3. **Early payoff:** A customer can pay off the remaining principal plus any accrued interest at any time. A `lump_sum_discount` (configurable per district) may reduce the remaining interest. The remaining SCHEDULED installments are cancelled and replaced with a single PAID entry.

4. **Ownership transfer:** When a property sells, the outstanding assessment balance follows the property (liens are typically recorded against the parcel, not the person). `POST /:id/transfer-ownership` updates `owner_name` and `owner_mailing_address` and creates an AuditLog entry. The installment schedule continues unchanged. CIS does not automatically pull ownership changes — staff must record them manually or via GIS sync.

5. **Multiple districts per parcel:** A parcel can be in multiple assessment districts simultaneously (e.g., water main district AND stormwater district). Each is a separate ParcelAssessment record with separate installment schedules.

6. **GIS integration:** Districts are defined by GIS polygon boundaries. Parcel enrollment (which parcels fall within a district) is determined by GIS spatial intersection. Bulk import (`POST /parcel-assessments/import`) accepts a GIS export file mapping parcel IDs to assessment basis values.

7. **Appeals:** Property owners can appeal their assessment. The `appeal_status` field tracks the appeal lifecycle. During an active appeal, installment billing may be stayed (configurable). If overturned, a credit is applied to any amounts already collected.

8. **Manual overrides:** Assessments calculated by formula can be manually overridden by an authorized administrator. Override requires a `override_reason` and is logged in AuditLog with the before/after amounts.

9. **Separate balance tracking:** Assessment balances are tracked separately from regular utility billing balances. They appear as a distinct section on the customer account and, optionally, on the regular utility bill (configurable: separate notice or combined).

10. **Late fees:** Overdue installments accrue late fees per a configurable penalty rate (separate from the utility's regular penalty rules in Module 10). Applied by nightly job.

11. **SaaSLogic integration:** Assessment installment invoices are submitted to SaaSLogic as a distinct invoice type. Payment events are received via webhook. Assessment accounts in SaaSLogic are linked to the same utility customer account but tracked in a separate billing category.

12. **Sunset:** When all parcels in a district have paid in full (or been written off), the district can be SUNSET. Sunsetting is a manual administrative action, not automatic.

## UI Pages

All pages are planned for Phase 5.

### Assessment Districts (`/assessments`)

- Table: district name, code, improvement type, parcel count, status, start/end dates, total project cost
- "New District" → creation form with formula configuration
- Status filtering

### District Detail (`/assessments/:id`)

- District overview with ordinance reference and GIS layer link
- Progress summary: total assessed, collected, outstanding, paid in full
- Parcel list: paginated table with per-parcel status
- "Import Parcels" → bulk upload from GIS export
- "Run Billing" → generate invoices for this cycle's due installments
- Activate / Sunset actions

### Parcel Assessment Detail (`/assessments/parcels/:id`)

- Owner info, parcel ID, GIS reference
- Principal amount and calculation basis
- Installment schedule: table of all installments with status, due date, amounts
- Appeal section
- Ownership transfer history
- Early payoff calculator: shows remaining balance + discount if applicable
- "Record Ownership Transfer" action
- "Early Payoff" action

### Property Lookup

- Search by parcel ID or address
- Shows all active assessment districts and outstanding balances for the parcel

## Phase Roadmap

- **Phase 1-4 (Complete/Planned):** No special assessment functionality.

- **Phase 5 (Planned):**
  - AssessmentDistrict entity + CRUD + activation workflow
  - ParcelAssessment entity + bulk GIS import + formula calculation
  - AssessmentInstallment entity + amortization schedule generation
  - Early payoff calculation
  - Ownership transfer workflow
  - Appeals management
  - Nightly installment billing run + late fee application
  - SaaSLogic integration for assessment invoice submission
  - Assessment-specific reporting (collections, delinquency by district)
  - Portal: parcel assessment viewing and installment payment (Phase 5)

## Bozeman RFP Coverage

| Req | Requirement | Coverage |
|-----|-------------|----------|
| 165 | Assessment district CRUD | Phase 5: AssessmentDistrict entity |
| 166 | Multi-district support | Phase 5: multiple ParcelAssessments per parcel |
| 167 | Activate/sunset districts | Phase 5: status machine DRAFT → ACTIVE → COMPLETED/SUNSET |
| 168 | Parcel-based billing | Phase 5: ParcelAssessment with GIS parcel ID |
| 169 | GIS integration for parcels | Phase 5: bulk GIS import, gis_parcel_id field |
| 170 | Ownership transfer | Phase 5: transfer-ownership endpoint + history |
| 171 | Manual assessment overrides | Phase 5: override_reason with audit log |
| 172 | Configurable assessment formulas | Phase 5: assessment_method ENUM + formula support |
| 173 | Recurring installment billing | Phase 5: AssessmentInstallment + nightly billing job |
| 174 | Separate balance tracking | Phase 5: distinct SaaSLogic billing category |
| 175 | Late fees on overdue installments | Phase 5: nightly late fee job |
| 176 | Installment/loan billing with interest | Phase 5: amortization schedule in AssessmentInstallment |
| 177 | Early payoff | Phase 5: early-payoff endpoint with discount |
| 178 | Audit trail for assessments | Phase 5: AuditLog for all changes + overrides |
| 179 | Assessment reporting | Phase 5: district summary report, delinquency by district |
