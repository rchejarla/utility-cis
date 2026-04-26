# 14 — Special Assessments

**RFP commitment owner:** SaaSLogic Utilities — split between `packages/shared/prisma/schema.prisma` (`AssessmentDistrict`, `ParcelAssessment`, `AssessmentInstallment`, `AssessmentLien` + extensions to `Premise` for parcel attributes), `packages/api/src/services/special-assessment/*` (district config, levy calculator, amortization library, payoff quote, lien generator), `packages/api/src/services/gis-sync/*` (the GIS sync worker that pulls parcel attributes + district memberships from ESRI), `packages/api/src/routes/special-assessments.ts` + `packages/api/src/routes/portal/assessments.ts`, and `packages/web/app/(admin)/special-assessments/*` + `packages/web/app/portal/assessments/*`. Cross-cuts heavily with [docs/specs/16-special-assessments.md](../specs/16-special-assessments.md) (the existing Phase 5 spec — this doc references and extends it), [docs/specs/02-premise-management.md](../specs/02-premise-management.md) (Premise gains parcel-relevant attributes), [docs/specs/07-rate-management.md](../specs/07-rate-management.md) (effective-dated rate versioning is reused for assessment rate changes), [docs/specs/09-billing.md](../specs/09-billing.md) and [docs/specs/21-saaslogic-billing.md](../specs/21-saaslogic-billing.md) (consolidated-billing route through SaaSLogic), [05-customer-portal.md](./05-customer-portal.md) (payoff quotes in portal), [08-data-retention-archival-purge.md](./08-data-retention-archival-purge.md) (financial-class retention 7 years for assessment records), [09-bulk-upload-and-data-ingestion.md](./09-bulk-upload-and-data-ingestion.md) (parcel/district CSV import), and [13-workflow-approvals-action-queue.md](./13-workflow-approvals-action-queue.md) (district setup approval; lien filing approval).
**Status:** Drafted — **virtually no implementation.** [docs/specs/16-special-assessments.md](../specs/16-special-assessments.md) exists as a Phase 5 design stub (3 entities specified, zero in the schema). The dependencies are also unbuilt: zero GIS/ESRI integration, zero PostGIS extension, no parcel_id column on Premise, no rate calculator engine (`RateSchedule.rateConfig` stores config but nothing applies it), no amortization code anywhere, no Lien entity, no county-export pattern, no payoff-quote endpoint. Module 09 (Billing) and Module 10 (Payments & Collections) are Phase 3 stubs that block consolidated billing.
**Effort estimate:** XL (~16-20 weeks). The largest cost is the **GIS sync infrastructure** (~3-4 weeks: ESRI REST integration, parcel-attribute mirror, district-membership sync, drift detection — depends on the City's GIS access pattern). Second is the **amortization library + installment scheduler** (~2-3 weeks: loan math, period interest accrual, payoff calculator with optional discount). Third is the **levy engine + per-method calculators** (~2-3 weeks: per-front-foot, per-square-foot, per-ERU, flat, formula-based). Fourth is **lien generation + Gallatin County export** (~2-3 weeks: lien lifecycle entity, county-format export, recordation reconciliation). The remaining (~3-4 weeks): district CRUD, parcel enrollment via bulk import, portal payoff quote, ownership transfer, audit / reporting glue. Real path to deliver depends critically on which of Modules 09 and Challenge 1 (GIS) are co-resourced.

---

## 1. RFP commitment (verbatim)

> **Expeed's recommended approach:** Saaslogic Utilities owns the full special assessment lifecycle — district configuration, parcel-based calculation, billing, payment tracking, payoff, and ownership transfer. Saaslogic Utilities is architected to handle this scope natively, and locating special assessments alongside the rest of the City's parcel-linked billing produces a stronger customer experience and cleaner operational workflow than splitting it to the ERP.
>
> **District and parcel model.** The City configures each special assessment district — lighting district, improvement district, sidewalk district, etc. — as a district entity in Saaslogic Utilities with its own rate methodology (per-linear-foot, per-square-foot, per-ERU, flat rate, or combination). Parcels within the district are identified via the GIS integration described in Challenge 1, inheriting parcel attributes (square footage, frontage, impervious area) from ESRI. No duplicate parcel data entry.
>
> **Calculation engine.** The Saaslogic Utilities rate engine — the same engine that drives water tiered rates and stormwater ERU billing — computes special assessment charges using parcel-specific attributes and district-specific rate rules. Effective-dated rate versioning allows rate changes (or new district assessments) to be entered once and activate automatically.
>
> **Installment and loan-type structures.** Supports both one-time assessments and multi-year installment assessments with configurable term, interest rate, amortization, and payoff calculation. A property owner may pay off the remaining balance at any time with a payoff statement generated on demand.
>
> **Tied to parcel, not to customer.** A special assessment lives on the parcel, not on the customer or the account. When a parcel changes ownership — detected through the GIS integration and validated through closing paperwork from the City — the remaining assessment balance automatically transfers with the parcel to the new owner. The outgoing owner is billed any final amounts due; the incoming owner inherits the ongoing schedule.
>
> **Consolidated or separate billing.** Special assessment charges can be presented as a line item on the property owner's regular utility bill (consolidated) or as a separate annual or semi-annual assessment bill. Both approaches are supported; the City configures the presentation per assessment type.
>
> **Payment tracking and lien generation.** Payments are allocated to the correct assessment and tracked against amortization. Delinquent assessments generate a lien-eligible report and an export in the format required by Gallatin County's recorder/treasurer. Payoff quotes are available real-time in the Customer Portal for self-service.
>
> **Outcome.** Special assessments are administered with the same rigor as utility billing, on the same parcel data, with the same audit trail, and with self-service payoff for property owners.

The commitment decomposes into **eight guarantees**:

1. **Districts are first-class entities.** Lighting, improvement, sidewalk districts each configured per tenant with their own rate methodology.
2. **Parcels are the unit of liability.** Assessment lives on the parcel, follows ownership transfer, never on the customer or account.
3. **Per-method calculation.** Per-linear-foot, per-square-foot, per-ERU, flat, formula-based — pluggable into a shared levy engine.
4. **GIS-authoritative parcel data.** Square footage, frontage, impervious area come from ESRI; no duplicate entry in CIS.
5. **Effective-dated rate versioning.** Rate changes scheduled in advance; activate automatically.
6. **One-time and multi-year installments.** Configurable term, interest rate, amortization. On-demand payoff quote.
7. **Consolidated or separate billing.** Line item on utility bill OR standalone assessment bill — per-district configurable.
8. **Lien generation + county export + portal payoff.** Delinquent assessments produce Gallatin-County-formatted exports; portal customers see payoff quotes in real time.

---

## 2. Current state — what exists today

### 2.1 Spec exists; nothing built ⚠

**Status: Phase 5 design stub.** [docs/specs/16-special-assessments.md](../specs/16-special-assessments.md) defines three planned entities (`AssessmentDistrict`, `ParcelAssessment`, `AssessmentInstallment`) with full lifecycle, API, and business rules. None exist in the schema. A grep for `AssessmentDistrict`, `ParcelAssessment`, `AssessmentInstallment`, `Parcel`, `Lien` across `packages/shared/prisma/schema.prisma` returns zero matches.

The spec's design is sound and this doc largely **adopts** it; the divergences are noted inline (mostly: adding `AssessmentLien`, expanding the calculation methods, and binding the GIS sync to a concrete approach).

### 2.2 No `Parcel` entity; `Premise` is the proxy ⚠

**Status: Premise exists; lacks parcel-relevant attributes.**

`Premise` (`schema.prisma:242-277`) has:
- `id`, `utilityId`, `address`, `geoLat`, `geoLng`, `premiseType`, `commodityIds[]`, `serviceTerritoryId`, `municipalityCode`, `status`, `ownerId` (FK to Customer), `customFields` JSON

`Premise` lacks (gap per [docs/specs/02-premise-management.md](../specs/02-premise-management.md) Phase 2):
- `parcelId` / `gisParcelId` — external GIS identifier
- `squareFootage`, `frontageFeet`, `imperviousAreaSqFt` — parcel attributes
- `assessmentBasisUnits` — ERU / benefit-unit count

**Architectural choice in this doc** (deviates from the spec): rather than create a separate `Parcel` entity, **Premise IS the parcel for utility-billing purposes**. The spec's `ParcelAssessment.parcel_id` field becomes a Premise FK. Reasoning:

- A premise is what gets utility service. A parcel is what gets assessed. In practice, in a residential utility setting, **they're the same physical thing** — the lot. Two records add nothing beyond conceptual purity, while costing duplicate addresses, duplicate ownership history, duplicate GIS sync.
- The City's parcel data lives in ESRI; CIS mirrors it onto `Premise` rather than into a parallel table.
- For non-residential cases (e.g., a multi-tenant commercial building on one parcel served by multiple meters), the existing `Premise → ServiceAgreement → Account` chain already handles many-meters-per-parcel; the parcel side is one Premise row.
- Edge case: a single GIS parcel with no utility service (vacant land in an improvement district). Currently no Premise row would exist. Solution: create a Premise of type `LAND_ONLY` (new value in `PremiseType` enum) — no commodities, no agreements, but eligible for assessment. Better than maintaining two parallel entity hierarchies.

This reuses Premise's existing `ownerId`, `customFields`, `audit_log` integration, and the doc-04 attachments/doc-11 comments substrate.

### 2.3 No `District` entity ✗

**Status: Not implemented.** A grep for `District`, `Zone`, `Boundary`, `ServiceTerritory` returns:
- `Premise.serviceTerritoryId` — exists as a string field, not an FK to a District table.
- Solid waste Module 12 references "districts" as text labels, not entities.
- No first-class district entity.

The spec's `AssessmentDistrict` is the right substrate; this doc adopts it.

### 2.4 No GIS / ESRI integration ✗

**Status: Not implemented.**
- Zero ESRI / ArcGIS / PostGIS dependencies. PostgreSQL is used; the PostGIS extension is not installed.
- `Premise.geoLat` and `Premise.geoLng` are stored as `Decimal` columns but populated manually (or via the existing CSV import from doc 09).
- No "Challenge 1" GIS integration is implemented yet — that's a separate RFP commitment.

The Special Assessments RFP claim depends on Challenge 1's GIS integration. This doc commits to a sync interface that **doesn't require** the City's GIS to be online during the calculation flow — parcel attributes are mirrored into `Premise` columns by a periodic sync job (FR-SA-040). If the City's ESRI is unreachable during a billing run, CIS uses the last successfully synced attributes.

### 2.5 No rate engine / calculator ✗

**Status: Not implemented.** The RFP's "the same engine that drives water tiered rates and stormwater ERU billing" doesn't exist. `RateSchedule.rateConfig` (a JSON column per [docs/specs/07-rate-management.md](../specs/07-rate-management.md)) stores the configuration; `packages/api/src/services/rate-schedule.service.ts` has only CRUD. There is no `applyRate(reading, rateSchedule)` function that computes a charge breakdown.

This doc therefore **builds the assessment levy engine independently**, designed to be reused by the future general rate engine (FR-SA-050..053). Special assessment math (formula-based per parcel) is structurally simpler than tiered consumption-based water rates, so the assessment levy engine is a reasonable starting point — not a delay-blocker.

### 2.6 Effective-dated rate versioning IS built ✓

**Status: Implemented.** `RateSchedule` has `effectiveDate`, `expirationDate`, `version`, `supersedesId` (`schema.prisma:417-444`); `rate-schedule.service.ts:reviseRateSchedule()` implements the version chain. This is reusable for assessment rate changes — a district's rate ordinance update produces a new RateSchedule version with a future `effectiveDate` and the prior version's `expirationDate` set automatically.

### 2.7 No amortization / installment math ✗

**Status: Not implemented.** A grep for `amortiz`, `payoff`, `installment`, `principal`, `interest_accrual` across `packages/api/src` returns zero matches. The amortization library is greenfield work.

### 2.8 No parcel ownership transfer concept ⚠

**Status: Service transfer exists; parcel-level transfer does not.** `workflows.service.ts:transferService()` handles ServiceAgreement move-out / move-in but does NOT touch `Premise.ownerId` history. There is no `premise_owner_history` table; ownership changes are silent overwrites.

The RFP's claim that assessments transfer with the parcel requires this gap to close. This doc adds a `PremiseOwnerHistory` table + a transfer flow that snapshots assessment liability to outgoing/incoming parties (FR-SA-080).

### 2.9 No consolidated billing path ✗

**Status: Module 09 is a Phase 3 stub.** `BillingRecord` and the line-item bill template are designed but unbuilt. Until Module 09 ships, assessments must produce **separate** invoices (the simpler default). Once Module 09 ships, consolidated billing follows by adding an assessment line-item type to the bill schema. This doc commits both modes; the consolidated mode is gated on Module 09 delivery.

### 2.10 No lien entity / county-export pattern ✗

**Status: Not implemented.** No `Lien`, `AssessmentLien`, `CountyExport`, or `RecorderExport` entity in the schema. No export-to-external-system worker pattern beyond the SaaSLogic integration designed in spec 21. The Gallatin County recorder/treasurer-format export is greenfield work and requires the City to provide the target format spec (likely a structured CSV per the County's existing process).

### 2.11 No payoff quote endpoint ✗

**Status: Not implemented.** Portal API surface (per [docs/specs/15-customer-portal.md](../specs/15-customer-portal.md) and [05-customer-portal.md](./05-customer-portal.md)) has bills/usage/profile but no `/portal/api/assessments/<id>/payoff-quote`. This is greenfield. Depends on the amortization library (FR-SA-070).

### Summary

| Guarantee | Today |
|---|---|
| District first-class entity | ✗ |
| Parcel as unit of liability | ⚠ (Premise can be the proxy; missing parcel attributes) |
| Per-method calculation | ✗ (no levy engine) |
| GIS-authoritative parcel data | ✗ (no GIS integration; PostGIS not installed) |
| Effective-dated rate versioning | ✓ (reusable from RateSchedule) |
| One-time + multi-year installments | ✗ (no amortization library) |
| On-demand payoff quote | ✗ |
| Consolidated billing | ✗ (Module 09 stub) |
| Separate assessment bill | ✗ (no bill engine for non-utility billings either) |
| Payment allocation against amortization | ✗ (no Payment mirror; Module 10 stub) |
| Delinquent-lien report + Gallatin export | ✗ |
| Real-time portal payoff quote | ✗ |
| Parcel ownership transfer with assessment liability follow | ✗ |

---

## 3. Functional requirements

### 3.1 Premise as the parcel — schema additions

- **FR-SA-001** — `Premise` gets parcel-relevant columns (extends [docs/specs/02-premise-management.md](../specs/02-premise-management.md) Phase 2 work):

  ```prisma
  // Added to Premise:
  parcelId           String?  @map("parcel_id") @db.VarChar(64)            // local City parcel number, indexed
  gisParcelId        String?  @map("gis_parcel_id") @db.VarChar(64)         // ESRI feature ID; canonical FK to GIS
  squareFootage      Decimal? @map("square_footage") @db.Decimal(14, 2)
  frontageFeet       Decimal? @map("frontage_feet") @db.Decimal(10, 2)
  imperviousAreaSqFt Decimal? @map("impervious_area_sq_ft") @db.Decimal(14, 2)
  assessmentBasisUnits Decimal? @map("assessment_basis_units") @db.Decimal(10, 4)  // ERU count or other benefit-unit measure
  gisLastSyncedAt    DateTime? @map("gis_last_synced_at") @db.Timestamptz
  gisSyncStatus      String?  @map("gis_sync_status") @db.VarChar(32)        // SYNCED | STALE | NOT_FOUND_IN_GIS | MANUAL_OVERRIDE

  @@index([utilityId, parcelId])
  @@index([utilityId, gisParcelId])
  ```

- **FR-SA-002** — `PremiseType` enum gains `LAND_ONLY` for parcels with no utility service that still receive assessments (vacant land in an improvement district).

- **FR-SA-003** — A new `PremiseOwnerHistory` table tracks ownership changes for assessment-transfer purposes:

  ```prisma
  model PremiseOwnerHistory {
    id             String    @id @default(uuid()) @db.Uuid
    utilityId      String    @map("utility_id") @db.Uuid
    premiseId      String    @map("premise_id") @db.Uuid
    ownerCustomerId String?  @map("owner_customer_id") @db.Uuid    // null = unknown / out-of-system owner
    ownerName      String    @map("owner_name") @db.VarChar(255)    // snapshot at time of ownership
    ownerMailingAddress Json @map("owner_mailing_address")           // structured address snapshot
    effectiveFrom  DateTime  @map("effective_from") @db.Date
    effectiveTo    DateTime? @map("effective_to") @db.Date
    transferType   String    @default("SALE") @db.VarChar(32)        // SALE | INHERITANCE | FORECLOSURE | OTHER
    transferDocRef String?   @map("transfer_doc_ref") @db.VarChar(255)  // closing paperwork ID provided by City
    createdBy      String    @map("created_by") @db.Uuid
    createdAt      DateTime  @default(now()) @map("created_at") @db.Timestamptz
    @@index([utilityId, premiseId, effectiveFrom])
    @@map("premise_owner_history")
  }
  ```

  When `Premise.ownerId` changes, a row is appended; the prior row's `effectiveTo` is set in the same transaction. The current `Premise.ownerId` is denormalized for read-path speed; history is the source of truth.

### 3.2 District configuration

- **FR-SA-010** — A new `AssessmentDistrict` table (adopting the spec from [docs/specs/16-special-assessments.md](../specs/16-special-assessments.md) §3.1):

  ```prisma
  model AssessmentDistrict {
    id                  String                 @id @default(uuid()) @db.Uuid
    utilityId           String                 @map("utility_id") @db.Uuid
    code                String                 @db.VarChar(32)     // e.g., "LD-3", "SID-21-12"
    name                String                 @db.VarChar(255)
    districtType        AssessmentDistrictType @map("district_type")
    description         String?                @db.Text
    gisLayerId          String?                @map("gis_layer_id") @db.VarChar(128)  // ESRI layer/feature class for parcel enrollment
    status              AssessmentDistrictStatus @default(DRAFT)
    formationDate       DateTime?              @map("formation_date") @db.Date
    completionDate      DateTime?              @map("completion_date") @db.Date
    sunsetDate          DateTime?              @map("sunset_date") @db.Date
    totalProjectAmount  Decimal?               @map("total_project_amount") @db.Decimal(14, 2)
    calculationMethod   AssessmentCalcMethod   @map("calculation_method")
    rateScheduleId      String                 @map("rate_schedule_id") @db.Uuid
    billingMode         AssessmentBillingMode  @default(SEPARATE) @map("billing_mode")  // SEPARATE | CONSOLIDATED
    billingFrequency    AssessmentBillingFreq  @default(ANNUAL) @map("billing_frequency")  // ANNUAL | SEMI_ANNUAL | QUARTERLY | ONE_TIME
    interestRateAnnual  Decimal?               @map("interest_rate_annual") @db.Decimal(6, 4)  // null = no interest (one-time / pay-on-receipt districts)
    installmentTermYears Int?                  @map("installment_term_years")  // null = one-time
    earlyPayoffDiscountPct Decimal?            @map("early_payoff_discount_pct") @db.Decimal(5, 4)
    createdBy           String                 @map("created_by") @db.Uuid
    createdAt           DateTime               @default(now()) @map("created_at") @db.Timestamptz

    @@unique([utilityId, code])
    @@index([utilityId, status])
    @@map("assessment_district")
  }

  enum AssessmentDistrictType {
    LIGHTING
    SIDEWALK
    IMPROVEMENT
    PAVING
    SEWER
    STORMWATER
    OTHER
  }

  enum AssessmentDistrictStatus {
    DRAFT       // configuration in progress; no levies posted
    ACTIVE      // levies posted; billing happening
    COMPLETED   // all installments paid off
    SUNSET      // historical; no new billing
  }

  enum AssessmentCalcMethod {
    PER_PARCEL_FLAT
    PER_FRONT_FOOT
    PER_SQUARE_FOOT
    PER_ERU
    FORMULA           // composite: e.g., 60% per_parcel_flat + 40% per_front_foot
  }

  enum AssessmentBillingMode {
    SEPARATE
    CONSOLIDATED
  }

  enum AssessmentBillingFreq {
    ANNUAL
    SEMI_ANNUAL
    QUARTERLY
    ONE_TIME
  }
  ```

- **FR-SA-011** — A district lifecycle is `DRAFT → ACTIVE → COMPLETED | SUNSET`. The transition `DRAFT → ACTIVE` is dual-approved per [13-workflow-approvals-action-queue.md](./13-workflow-approvals-action-queue.md) (district activation has financial impact). Transitioning to `COMPLETED` requires that all `AssessmentInstallment` rows for the district are PAID; transitioning to `SUNSET` is unconditional but emits an audit row.

- **FR-SA-012** — Districts use [10-draft-status-and-posting.md](./10-draft-status-and-posting.md)'s status-as-draft model — the `DRAFT` status is the editable WIP state; activation goes through doc 10's post pipeline. Effectively-dated changes to an active district produce a new `RateSchedule` version under the existing rate-versioning pattern (FR-SA-013).

- **FR-SA-013** — `AssessmentDistrict.rateScheduleId` references a `RateSchedule` row. Rate changes on an active district = revising the RateSchedule per [docs/specs/07-rate-management.md](../specs/07-rate-management.md) (`reviseRateSchedule`); the new version's `effectiveDate` controls when the new rate applies. The levy engine (FR-SA-050) reads the rate schedule version current at the levy posting date.

- **FR-SA-014** — Admin UI at `/special-assessments/districts` lists districts with filters by type, status, formation year. Detail view shows configuration, current parcel enrollments (count + sortable table), revenue-to-date, payoff-eligible balance summary, audit history.

### 3.3 Parcel enrollment

- **FR-SA-020** — A new `ParcelAssessment` table — the per-parcel levy:

  ```prisma
  model ParcelAssessment {
    id                  String                 @id @default(uuid()) @db.Uuid
    utilityId           String                 @map("utility_id") @db.Uuid
    districtId          String                 @map("district_id") @db.Uuid
    premiseId           String                 @map("premise_id") @db.Uuid     // see §2.2 — Premise IS the parcel
    levyAmount          Decimal                @map("levy_amount") @db.Decimal(14, 2)  // total principal
    calculationBasis    Json                   @map("calculation_basis")        // snapshot: { method, parcelAttribute, ratePerUnit, calculatedAt }
    levyDate            DateTime               @map("levy_date") @db.Date
    levyAuditId         String?                @map("levy_audit_id") @db.Uuid   // FK to audit_log row that posted the levy
    ownerNameSnapshot   String                 @map("owner_name_snapshot") @db.VarChar(255)
    ownerMailingSnapshot Json                  @map("owner_mailing_snapshot")
    status              ParcelAssessmentStatus @default(POSTED)
    paidOffAt           DateTime?              @map("paid_off_at") @db.Timestamptz
    paidOffBy           String?                @map("paid_off_by") @db.Uuid
    customFields        Json                   @default("{}") @map("custom_fields")
    createdAt           DateTime               @default(now()) @map("created_at") @db.Timestamptz

    district AssessmentDistrict @relation(fields: [districtId], references: [id])
    premise  Premise            @relation(fields: [premiseId], references: [id])

    @@unique([utilityId, districtId, premiseId])  // one levy per parcel per district per posting; resurveys produce a new district code
    @@index([utilityId, premiseId, status])
    @@index([utilityId, districtId, status])
    @@map("parcel_assessment")
  }

  enum ParcelAssessmentStatus {
    POSTED            // levy is on the books; installments pending or partial
    PAID_OFF          // all installments paid; lien (if any) released
    APPEALED          // owner has filed an appeal; billing paused per district policy
    REVERSED          // posting was wrong; reversed via doc 12 reversal pattern
    TRANSFERRED       // ownership changed; remaining balance follows new owner (status stays POSTED at the parcel level — the row continues to accrue per its installment schedule)
  }
  ```

- **FR-SA-021** — Bulk parcel enrollment in a district uses [09-bulk-upload-and-data-ingestion.md](./09-bulk-upload-and-data-ingestion.md)'s ingestion pipeline. New `EntityIngestor` for `ParcelAssessment`:
  - Input columns: `parcel_id`, `assessment_basis_value` (e.g., square footage at assessment time, frontage feet), optional `levy_amount_override` (for parcels exempted or hand-adjusted).
  - Validation: each `parcel_id` resolves to a `Premise` row in the tenant; basis matches the district's `calculationMethod`; `levyAmount` is computed by the levy engine (FR-SA-050) unless `levy_amount_override` is set.
  - Per-row error policy: `reject_batch_threshold:1` — even one bad parcel aborts the whole enrollment (district levies are sensitive; partial enrollment creates uneven liability across the district).
  - Audit class: `AUDIT_FINANCIAL` (per [12-corrections-and-reversals.md](./12-corrections-and-reversals.md)).

- **FR-SA-022** — Manual single-parcel enrollment via API + UI: operator picks a district + parcel, the levy is computed from the GIS-synced attributes (FR-SA-040) plus the district's rate, presented for confirmation, then posted.

- **FR-SA-023** — Re-enrollment after appeal/correction: a `ParcelAssessment` cannot be edited in place once posted (status set to POSTED; financial-immutability applies per [12-corrections-and-reversals.md](./12-corrections-and-reversals.md)). To correct a posted levy, the operator reverses it (creating a `REVERSED`-status row with `reverses_id`) and posts a new levy. Audit captures both.

- **FR-SA-024** — Appeal workflow: a property owner filing an appeal triggers a `ParcelAssessment` status transition `POSTED → APPEALED`. Per the district's policy (`assessment_district.appeal_pause_billing`), installment billing pauses while the appeal is open. Resolution emits a transition: appeal upheld → reverse the posted levy + post a new one (FR-SA-023); appeal denied → status returns to `POSTED` with backdated installments.

### 3.4 GIS sync infrastructure

- **FR-SA-040** — A new `gis-sync` BullMQ worker pulls parcel attributes from the City's ESRI server. Modes (per-tenant config):
  - **Daily full sync** (default) — pulls every parcel in the configured ESRI feature classes; updates `Premise.parcelId / gisParcelId / squareFootage / frontageFeet / imperviousAreaSqFt / assessmentBasisUnits / gisLastSyncedAt = now() / gisSyncStatus`. Compares to existing values; emits one `PREMISE_GIS_DRIFT` audit row per changed parcel.
  - **On-demand sync per parcel** — operator-triggered; pulls a single parcel's attributes immediately. Used during assessment posting if the staff knows GIS has been updated.
  - **Webhook-driven** (Phase 2 — depends on City's GIS configuration) — ESRI pushes change notifications; CIS pulls only the changed parcels.

- **FR-SA-041** — GIS sync uses the ESRI REST API (`/<feature_class>/query` endpoint) with paging + retry. Connection details in `tenant_config.gis_config` (KMS-referenced for credentials per [09-bulk-upload-and-data-ingestion.md](./09-bulk-upload-and-data-ingestion.md) FR-ING-040 pattern). Failed syncs alert tenant admins; partial syncs are detected by row-count delta.

- **FR-SA-042** — Parcels in the City's GIS that have no corresponding Premise in CIS are auto-created with `premiseType = LAND_ONLY` and `status = INACTIVE` (so they don't appear in routine searches). Audit row of class `AUDIT_OPERATIONAL` captures the creation. Operators can promote a `LAND_ONLY` premise to `RESIDENTIAL`/`COMMERCIAL`/etc. when service is requested.

- **FR-SA-043** — Parcels in CIS that **disappear** from GIS (parcel split, merger, vacated) get `gisSyncStatus = NOT_FOUND_IN_GIS`. They retain history but are flagged for operator review. New `AssessmentDistrict.parcelEnrollment` runs that try to look up a `NOT_FOUND_IN_GIS` parcel return a clear validation error.

- **FR-SA-044** — GIS sync drift detection: when an attribute (e.g., `squareFootage`) changes on a parcel that has an active `ParcelAssessment`, the sync emits a `PARCEL_ASSESSMENT_BASIS_DRIFT` audit row of class `AUDIT_FINANCIAL` and creates a `Task` (per doc 13) for an operator to review. The existing levy is NOT auto-recalculated — that would be a financial mutation without authorization. Operators can trigger a re-levy through the FR-SA-023 reverse-and-repost flow if appropriate.

- **FR-SA-045** — Operator override: a tenant admin can manually set `Premise.gisSyncStatus = MANUAL_OVERRIDE` to lock a Premise's parcel attributes against GIS sync (rare — used for parcels under dispute). Manual overrides emit `AUDIT_SECURITY` audit rows and require dual approval.

### 3.5 Levy engine

- **FR-SA-050** — A new `levy-engine` library at `packages/api/src/services/special-assessment/levy-engine.ts`. Pure-function calculator: given a `ParcelAttributes` snapshot + `RateSchedule.rateConfig` + `AssessmentDistrict.calculationMethod`, returns the computed levy amount + a structured `calculationBasis` JSON for audit.

  ```typescript
  type ParcelAttributes = {
    squareFootage?: number;
    frontageFeet?: number;
    imperviousAreaSqFt?: number;
    assessmentBasisUnits?: number;
  };

  type LevyCalculation = {
    method: AssessmentCalcMethod;
    parcelAttribute: keyof ParcelAttributes | "flat";
    parcelAttributeValue: number;
    ratePerUnit: number;
    levyAmount: number;
    breakdown?: { component: string; amount: number; }[];  // populated for FORMULA method
  };

  function computeLevy(
    attrs: ParcelAttributes,
    rateConfig: RateConfig,
    method: AssessmentCalcMethod
  ): LevyCalculation;
  ```

- **FR-SA-051** — Per-method calculators:
  - `PER_PARCEL_FLAT` — `levyAmount = rateConfig.flatAmount`.
  - `PER_FRONT_FOOT` — `levyAmount = attrs.frontageFeet × rateConfig.ratePerLinearFoot`. Errors out if `frontageFeet IS NULL`.
  - `PER_SQUARE_FOOT` — `levyAmount = attrs.squareFootage × rateConfig.ratePerSquareFoot`.
  - `PER_ERU` — `levyAmount = attrs.assessmentBasisUnits × rateConfig.ratePerERU`.
  - `FORMULA` — `levyAmount = Σ rateConfig.components.weight × <component method>`. The formula is defined per district; supports up to 5 components.

- **FR-SA-052** — The levy engine is **independent of** the (future) general rate engine for tiered consumption-based water billing. Reasoning: assessment math is deterministic per parcel (no time-of-use, no tiers, no consumption); a unified abstraction would force compromise on both sides. They share the `RateSchedule.rateConfig` storage but use different evaluators. When the general rate engine ships (Module 09 Phase 3), shared helpers (rate version resolution by date, audit emission) are extracted into a common module.

- **FR-SA-053** — Levy engine output snapshots into `ParcelAssessment.calculationBasis`. This snapshot is **immutable** once posted (financial immutability per [12-corrections-and-reversals.md](./12-corrections-and-reversals.md) FR-REV-001). Re-running the engine after a parcel-attribute drift produces a different result; the prior levy stays as-is until reversed and re-posted.

### 3.6 Installments + amortization

- **FR-SA-060** — A new `AssessmentInstallment` table (per the spec):

  ```prisma
  model AssessmentInstallment {
    id                  String                       @id @default(uuid()) @db.Uuid
    utilityId           String                       @map("utility_id") @db.Uuid
    parcelAssessmentId  String                       @map("parcel_assessment_id") @db.Uuid
    sequenceNumber      Int                          @map("sequence_number")
    dueDate             DateTime                     @map("due_date") @db.Date
    principalAmount     Decimal                      @map("principal_amount") @db.Decimal(14, 2)
    interestAmount      Decimal                      @map("interest_amount") @db.Decimal(14, 2)
    totalAmount         Decimal                      @map("total_amount") @db.Decimal(14, 2)
    status              AssessmentInstallmentStatus  @default(SCHEDULED)
    paidAmount          Decimal                      @default(0) @map("paid_amount") @db.Decimal(14, 2)
    paidAt              DateTime?                    @map("paid_at") @db.Timestamptz
    waivedAt            DateTime?                    @map("waived_at") @db.Timestamptz
    waivedBy            String?                      @map("waived_by") @db.Uuid
    waivedReason        String?                      @map("waived_reason") @db.VarChar(500)
    saaslogicInvoiceId  String?                      @map("saaslogic_invoice_id") @db.VarChar(64)
    createdAt           DateTime                     @default(now()) @map("created_at") @db.Timestamptz

    parcelAssessment ParcelAssessment @relation(fields: [parcelAssessmentId], references: [id])

    @@unique([parcelAssessmentId, sequenceNumber])
    @@index([utilityId, dueDate, status])
    @@map("assessment_installment")
  }

  enum AssessmentInstallmentStatus {
    SCHEDULED   // future installment; not yet billed
    BILLED      // invoice issued via SaaSLogic
    PAID
    PARTIAL_PAID
    OVERDUE
    WAIVED      // operator-waived (rare; per district policy)
    CANCELLED   // levy reversed; this installment cancelled
  }
  ```

- **FR-SA-061** — On `ParcelAssessment` posting, the **installment scheduler** generates the full schedule:
  - **One-time** (`AssessmentDistrict.installmentTermYears IS NULL`) — single installment with `dueDate = levyDate + district.firstInstallmentOffsetDays`, `principalAmount = levyAmount`, `interestAmount = 0`.
  - **Multi-year** (`installmentTermYears = N`, `interestRateAnnual = R`) — `N × billingFrequency` installments computed via standard fixed-rate amortization:
    - Period count `n = installmentTermYears × periods_per_year` (where periods = 1, 2, or 4 depending on `billingFrequency`).
    - Period rate `r = interestRateAnnual / periods_per_year`.
    - Period payment `P = principal × [r(1+r)^n] / [(1+r)^n − 1]` (handles `r=0` as `principal/n`).
    - Each period: `interest_i = remaining_balance × r`; `principal_i = P - interest_i`; `remaining_balance -= principal_i`.

- **FR-SA-062** — Amortization library at `packages/api/src/services/special-assessment/amortization.ts`. Pure functions (no DB I/O). Tested against published amortization tables to within $0.01.

- **FR-SA-063** — Final-installment rounding: floating-point math accumulates pennies of error over a 20-year amortization. The library forces the final installment's principal to be `levyAmount − Σ(prior_principal)` so total principal equals the original levy exactly. Final installment interest may differ from prior installments by a few cents; this is normal and consistent with how mortgages handle it.

- **FR-SA-064** — Late fees on overdue installments: per `tenant_config.assessment_late_fee_pct` and `tenant_config.assessment_late_fee_grace_days`, a nightly worker scans `AssessmentInstallment` rows where `status = BILLED` AND `dueDate + grace_days < today` AND `paidAmount < totalAmount`. For each, posts a `late_fee` `AdhocCharge` (per [12-corrections-and-reversals.md](./12-corrections-and-reversals.md)) to the responsible party and emits an `AUDIT_FINANCIAL` audit row. Late fees are billed separately from the installment (avoid compounding interest).

### 3.7 Payoff calculation + portal

- **FR-SA-070** — A new `payoff-calculator` module:

  ```typescript
  function calculatePayoff(
    parcelAssessmentId: string,
    asOfDate: Date,
    options?: { earlyPayoffDiscountPct?: number }
  ): {
    asOfDate: Date;
    parcelAssessmentId: string;
    remainingPrincipal: number;
    accruedInterest: number;
    overdueLateFees: number;
    earlyPayoffDiscount: number;   // applied if district has discount configured
    payoffAmount: number;          // remainingPrincipal + accruedInterest + overdueLateFees - earlyPayoffDiscount
    quoteValidUntil: Date;         // configurable; default asOfDate + 30 days
    breakdownByInstallment: { sequenceNumber, scheduled, paid, remaining }[];
  };
  ```

  Pure function on top of the amortization library. No DB writes — generating a quote does NOT lock in the discount; the discount applies if the customer pays before `quoteValidUntil`.

- **FR-SA-071** — A new portal endpoint `GET /portal/api/assessments/<parcel_assessment_id>/payoff-quote` returns the payoff payload above. RLS enforces that the requesting portal user is the current owner of the parcel (per `Premise.ownerId` matching the requester's `customerId` chain). A signed PDF download is also produced for the customer's records (reuses the existing PDF generation per [docs/specs/15-customer-portal.md](../specs/15-customer-portal.md) bill-PDF infrastructure).

- **FR-SA-072** — Operator-side payoff quote: same calculator at `GET /api/v1/parcel-assessments/<id>/payoff-quote`. Operators can pull a quote on behalf of a property owner (e.g., a closing attorney calls in for a quote at a sale). Audit row emitted for the quote generation.

- **FR-SA-073** — Payoff payment: when the customer pays the quoted amount in full via SaaSLogic (per [12-corrections-and-reversals.md](./12-corrections-and-reversals.md)'s payment webhook), a worker:
  1. Marks all remaining installments `PAID` with `paidAt = paymentDate`.
  2. Sets `ParcelAssessment.status = PAID_OFF`, `paidOffAt`, `paidOffBy`.
  3. Releases any active lien (`AssessmentLien.status = RELEASED`; FR-SA-100).
  4. Emits an `AUDIT_FINANCIAL` audit row for the lien release.
  5. Notifies the customer via the existing notification channel (per doc 13's `customer_message` category).

- **FR-SA-074** — Payment less than the full payoff but more than one installment is allocated per the district's `payoff_allocation` policy: most-overdue-first (default — settles overdue installments first), most-future-first (rare — used for prepayment programs). Allocation logic emits an audit trail showing how each dollar was applied.

### 3.8 Parcel ownership transfer

- **FR-SA-080** — A new `POST /api/v1/parcel-assessments/<id>/transfer-ownership` endpoint:

  ```typescript
  // Request body
  {
    newOwnerCustomerId?: string;  // null = transfer to "outside system" (snapshot-only)
    newOwnerName: string;
    newOwnerMailingAddress: { /* structured */ };
    transferEffectiveDate: Date;
    transferDocRef: string;       // City closing paperwork ID
    finalBillToOutgoingOwner?: { dueAmount: number; description: string };  // optional final bill before transfer
  }
  ```

  Steps (single transaction):
  1. Append a `PremiseOwnerHistory` row with `effectiveFrom = transferEffectiveDate`, snapshotting the new owner.
  2. Set the prior owner's `effectiveTo = transferEffectiveDate - 1 day`.
  3. Update `Premise.ownerId = newOwnerCustomerId`.
  4. For every `ParcelAssessment` on the premise with status `POSTED`: update `ownerNameSnapshot` and `ownerMailingSnapshot` to the new owner; do NOT change the installment schedule (the schedule continues as-is); do not refresh `levyAmount` (the levy was set at posting time and is immutable per FR-SA-052).
  5. If `finalBillToOutgoingOwner` is set, post a one-time `AdhocCharge` (per doc 12) for that amount with `description` to the outgoing owner's account.
  6. Emit `AUDIT_FINANCIAL` audit rows for each ParcelAssessment touched + the PremiseOwnerHistory creation.
  7. Notify the new owner of the inherited assessment schedule via `customer_message` (with onboarding text explaining what they're inheriting).

- **FR-SA-081** — Approval gate per [13-workflow-approvals-action-queue.md](./13-workflow-approvals-action-queue.md): ownership transfers above $X total assessment liability (per `tenant_config.assessment_transfer_dual_approval_threshold`, default $5000) require dual approval before execution.

- **FR-SA-082** — The transfer endpoint does NOT modify any active liens — liens are recorded against the parcel at the County, and survive ownership transfer per real estate law. The new owner inherits the lien encumbrance. The lien's `responsibleParty` reference updates to the new owner snapshot for accurate billing/notification.

### 3.9 Consolidated vs. separate billing

- **FR-SA-090** — Two billing modes per `AssessmentDistrict.billingMode`:

  - `SEPARATE` (default; available **today**) — each `AssessmentInstallment` produces its own SaaSLogic invoice on its `dueDate`. The invoice line items are the installment principal + interest. The invoice goes to the parcel's current owner mailing address (snapshot from `ParcelAssessment.ownerMailingSnapshot`). This mode does NOT depend on Module 09 — it leverages SaaSLogic's existing invoice issuance directly.

  - `CONSOLIDATED` (depends on Module 09 — per [docs/specs/09-billing.md](../specs/09-billing.md)) — installments due during the next utility billing cycle are added as line items on the property owner's regular utility bill. Requires the BillingRecord entity + line-item schema from Module 09. Until Module 09 ships, this mode is unavailable; tenants configuring `CONSOLIDATED` get a clear "available after Module 09" warning.

- **FR-SA-091** — Consolidated billing line-item format: `"<DistrictCode> Installment <N> of <M>: $<amount> (due <date>)"`. The bill PDF's line items section gets a separate "Special Assessments" subsection so customers can see them clearly distinguished from utility charges.

- **FR-SA-092** — When a parcel has multiple active assessments (e.g., a corner lot in both a lighting district and a sidewalk district), each active district's installment shows as a separate line item. The amounts don't roll up; reporting can roll up at the district level or at the parcel level.

- **FR-SA-093** — Customers paying a consolidated bill: the payment must be **allocated** between utility charges and assessment line items. Default allocation policy: pro-rata. Tenant-configurable override: utility-first (assessment falls behind first if customer underpays) or assessment-first (the special-district funding comes first; utility shut-off triggers later). This allocation lives in [12-corrections-and-reversals.md](./12-corrections-and-reversals.md)'s payment-handling logic, configured per tenant.

### 3.10 Lien generation + Gallatin County export

- **FR-SA-100** — A new `AssessmentLien` table:

  ```prisma
  model AssessmentLien {
    id                    String           @id @default(uuid()) @db.Uuid
    utilityId             String           @map("utility_id") @db.Uuid
    parcelAssessmentId    String           @map("parcel_assessment_id") @db.Uuid
    premiseId             String           @map("premise_id") @db.Uuid           // denormalized for fast county-export queries
    parcelIdSnapshot      String           @map("parcel_id_snapshot") @db.VarChar(64)
    principalAmount       Decimal          @map("principal_amount") @db.Decimal(14, 2)
    accruedInterest       Decimal          @map("accrued_interest") @db.Decimal(14, 2)
    lateFees              Decimal          @map("late_fees") @db.Decimal(14, 2)
    totalAmount           Decimal          @map("total_amount") @db.Decimal(14, 2)
    status                AssessmentLienStatus @default(ELIGIBLE)
    eligibleSinceDate     DateTime         @map("eligible_since_date") @db.Date
    filedAt               DateTime?        @map("filed_at") @db.Timestamptz
    filedDocRef           String?          @map("filed_doc_ref") @db.VarChar(255)  // County's recordation reference
    countyExportBatchId   String?          @map("county_export_batch_id") @db.Uuid
    releasedAt            DateTime?        @map("released_at") @db.Timestamptz
    releaseDocRef         String?          @map("release_doc_ref") @db.VarChar(255)
    notes                 String?          @db.Text
    createdAt             DateTime         @default(now()) @map("created_at") @db.Timestamptz

    @@index([utilityId, status, eligibleSinceDate])
    @@index([utilityId, parcelAssessmentId])
    @@map("assessment_lien")
  }

  enum AssessmentLienStatus {
    ELIGIBLE      // all preconditions met for filing; not yet exported to County
    EXPORTED      // included in a County export batch; awaiting recordation confirmation
    FILED         // County confirmed recordation
    RELEASED      // assessment paid off; release recorded with County
  }
  ```

- **FR-SA-101** — Lien-eligibility worker: nightly job scans `AssessmentInstallment` rows. A `ParcelAssessment` becomes lien-eligible when:
  - At least one installment has been overdue more than `tenant_config.assessment_lien_threshold_days` (default 60).
  - The cumulative overdue + late fees exceed `tenant_config.assessment_lien_min_amount` (default $0 — every overdue assessment is lien-eligible).
  - The parcel has not had an active appeal in the past 90 days.

  When eligible, an `AssessmentLien` row is created in `ELIGIBLE` status with the current outstanding amounts. Workflow rule from [doc 13](./13-workflow-approvals-action-queue.md) can fire to notify the operator + create a Task.

- **FR-SA-102** — `Gallatin County recorder/treasurer export` is a generated batch file produced by a `/admin/special-assessments/lien-export` page. The City staff:
  1. Selects the date range or specific liens.
  2. Reviews the listing (one row per lien with parcel, owner, principal, interest, fees, total).
  3. Confirms the export.
  4. The system generates a CSV in the County-required format (TBD with the County — the format spec is captured per tenant in `tenant_config.county_lien_export_format` as a templated string mapping CIS columns to County's expected columns and labels).
  5. Each lien row's `status = EXPORTED`, `countyExportBatchId` set.
  6. The CSV file is delivered via SFTP push (per the tenant's `tenant_config.county_sftp_config`) OR downloaded by the operator for manual upload to the County's portal — both modes supported, configurable per tenant.

- **FR-SA-103** — Recordation confirmation: the County returns a confirmation file (CSV or fixed-width per County preference) with each lien's recordation document number. A worker imports this file (via [doc 09](./09-bulk-upload-and-data-ingestion.md)'s ingestion pipeline), updating each `AssessmentLien.status = FILED` and `filedAt` and `filedDocRef`. Mismatches are flagged and routed to operators.

- **FR-SA-104** — Lien release: when a `ParcelAssessment` reaches `PAID_OFF` (FR-SA-073), any active liens transition to `RELEASED`. A separate `lien-release-export` produces a release file in the County's required format. The release flow is symmetric to the filing flow (export, confirmation, status update).

- **FR-SA-105** — Reporting: a `/admin/special-assessments/reports` page provides:
  - District summary (active districts, levies posted, revenue collected, outstanding balance).
  - Delinquency by district (parcels overdue > N days; lien-eligible vs. lien-filed counts).
  - Lien activity (filings + releases per period).
  - Payoff history (per district or per parcel).

  Reports support the standard CSV/Excel/PDF export per [06-custom-fields.md](./06-custom-fields.md) §4.4 (when the reporting module ships).

### 3.11 Non-functional requirements

- **NFR-SA-001** — Levy engine pure-function latency: ≤10ms p99 per parcel. A 5,000-parcel district enrollment computes in ≤1 minute.
- **NFR-SA-002** — Payoff quote latency: ≤500ms p99 (operator UI) and ≤1s p99 (portal first paint).
- **NFR-SA-003** — GIS sync: a 50,000-parcel daily sync completes in ≤30 minutes p99.
- **NFR-SA-004** — Lien export generation: ≤1 minute p99 for batches up to 5,000 liens.
- **NFR-SA-005** — Amortization library tested against published reference tables with maximum deviation ≤$0.01 per period.
- **NFR-SA-006** — `parcel_assessment` and `assessment_installment` retention: per [08-data-retention-archival-purge.md](./08-data-retention-archival-purge.md) `AUDIT_FINANCIAL` floor (7 years minimum). Liens retained 10 years after release per typical municipal recordkeeping (configured in `STATUTORY_FLOORS_DAYS`).
- **NFR-SA-007** — RLS continues to enforce tenant isolation on every new table.
- **NFR-SA-008** — Lien export to County: bytes never appear in `audit_log` (size); the audit row records the batch ID + the S3 path of the generated file (per doc 04 attachment storage).
- **NFR-SA-009** — Concurrent installment scheduling: posting two parcel assessments in the same district at the same time must not interleave their installment numbers. Sequence numbers are scoped to the parcel assessment, so this is handled by the unique `[parcelAssessmentId, sequenceNumber]` constraint.

---

## 4. Data model changes

### 4.1 New tables

| Table | Purpose | Section |
|---|---|---|
| `AssessmentDistrict` | Per-tenant district config + lifecycle | 3.2 (FR-SA-010) |
| `ParcelAssessment` | Per-parcel levy under a district | 3.3 (FR-SA-020) |
| `AssessmentInstallment` | Per-period billing schedule | 3.6 (FR-SA-060) |
| `AssessmentLien` | Lien lifecycle for delinquent assessments | 3.10 (FR-SA-100) |
| `PremiseOwnerHistory` | Ownership change audit + assessment-transfer snapshots | 3.1 (FR-SA-003) |

### 4.2 Modified tables

| Table | Change | Reason |
|---|---|---|
| `Premise` | Add `parcelId`, `gisParcelId`, `squareFootage`, `frontageFeet`, `imperviousAreaSqFt`, `assessmentBasisUnits`, `gisLastSyncedAt`, `gisSyncStatus` | FR-SA-001 |
| `Premise` | Extend `PremiseType` enum with `LAND_ONLY` | FR-SA-002 |
| `tenant_config` | Add `gis_config` (KMS-referenced ESRI credentials), `assessment_late_fee_pct`, `assessment_late_fee_grace_days`, `assessment_lien_threshold_days`, `assessment_lien_min_amount`, `assessment_transfer_dual_approval_threshold`, `county_lien_export_format`, `county_sftp_config` | FR-SA-040+, FR-SA-064, FR-SA-101, FR-SA-081, FR-SA-102 |

### 4.3 New enums

```prisma
enum AssessmentDistrictType    { LIGHTING SIDEWALK IMPROVEMENT PAVING SEWER STORMWATER OTHER }
enum AssessmentDistrictStatus  { DRAFT ACTIVE COMPLETED SUNSET }
enum AssessmentCalcMethod      { PER_PARCEL_FLAT PER_FRONT_FOOT PER_SQUARE_FOOT PER_ERU FORMULA }
enum AssessmentBillingMode     { SEPARATE CONSOLIDATED }
enum AssessmentBillingFreq     { ANNUAL SEMI_ANNUAL QUARTERLY ONE_TIME }
enum ParcelAssessmentStatus    { POSTED PAID_OFF APPEALED REVERSED TRANSFERRED }
enum AssessmentInstallmentStatus { SCHEDULED BILLED PAID PARTIAL_PAID OVERDUE WAIVED CANCELLED }
enum AssessmentLienStatus      { ELIGIBLE EXPORTED FILED RELEASED }
```

### 4.4 New worker queues

- `gis-sync` — daily cron tick; pulls parcel attributes from ESRI; emits drift audit rows.
- `levy-late-fee` — nightly cron; scans overdue installments; posts late-fee `AdhocCharge` rows.
- `levy-billing` — daily cron; finds installments due in the upcoming billing window; routes through SEPARATE or CONSOLIDATED mode (delegates to SaaSLogic via spec 21 path).
- `lien-eligibility` — nightly cron; promotes overdue parcel assessments to lien-eligible.
- `lien-export` — operator-triggered; generates County-format export batches.

### 4.5 RLS

All new tables get tenant RLS by `utility_id` per the existing pattern. Portal RLS on `ParcelAssessment` (and joined Premise) restricts portal users to parcels owned by the requesting customer; the predicate uses the same `is_premise_visible_to_portal_user` helper as [11-notes-and-comments.md](./11-notes-and-comments.md)'s comment visibility logic.

---

## 5. Implementation sequence

### Phase 1 — Premise parcel attributes + GIS sync (~3 weeks)

1. **Premise schema additions + migration** (~3 days). Adds `parcelId`, `gisParcelId`, `squareFootage`, `frontageFeet`, `imperviousAreaSqFt`, `assessmentBasisUnits`, `gisLastSyncedAt`, `gisSyncStatus`, plus `LAND_ONLY` premise type and `PremiseOwnerHistory` table.
2. **GIS sync worker (Phase 1: ESRI REST + daily full sync)** (~2 weeks). Includes credential management, paging, drift detection, audit emission, operator-triggered single-parcel sync. Tested against a synthetic ESRI service in CI.
3. **`/admin/premises/<id>` parcel-attributes section** (~2 days). Operator-visible parcel data with sync status badge + manual override gate.

### Phase 2 — Districts + parcel enrollment + levy engine (~4 weeks)

4. **`AssessmentDistrict` schema + RLS + CRUD** (~3 days).
5. **`ParcelAssessment` schema + RLS** (~2 days).
6. **Levy engine library + per-method calculators (FR-SA-050..052)** (~1 week). Pure functions; tests cover all 5 methods + edge cases (zero attributes, very small parcels).
7. **District-activation post pipeline + draft → active gate** (~2 days). Reuses [doc 10](./10-draft-status-and-posting.md)'s draft engine.
8. **Bulk parcel enrollment via doc 09 ingestion** (~3 days). Adds `ParcelAssessment` to the EntityIngestor registry.
9. **Single-parcel manual enrollment UI** (~2 days). `/special-assessments/districts/<id>/enroll-parcel`.
10. **District + parcel-assessment admin UI (list + detail views)** (~1 week). Reuses doc 11 comments + doc 04 attachments + doc 10 drafts.

### Phase 3 — Installments + amortization + payoff (~3 weeks)

11. **Amortization library (FR-SA-062..063)** (~3 days). Pure functions; tested against published amortization tables.
12. **Installment scheduler (FR-SA-061)** (~2 days). Triggered on `ParcelAssessment` post.
13. **Payoff calculator (FR-SA-070)** (~2 days).
14. **Operator payoff quote endpoint + UI** (~2 days).
15. **Portal payoff quote endpoint + UI** (~2 days). RLS verifies the requesting portal user owns the parcel.
16. **Late-fee worker (FR-SA-064)** (~2 days).
17. **Payoff payment handling (FR-SA-073..074)** (~3 days). Integrates with [12-corrections-and-reversals.md](./12-corrections-and-reversals.md) payment webhook.

### Phase 4 — Ownership transfer + reversal/appeal (~2 weeks)

18. **Ownership transfer endpoint (FR-SA-080..082)** (~3 days).
19. **Appeal workflow (FR-SA-024)** (~2 days). Reuses doc 13 workflow rules.
20. **Levy reversal flow (FR-SA-023)** (~2 days). Integrates with doc 12 reversal pattern.
21. **Late-fee waiver flow** (~1 day). Doc 12 reversal applies.

### Phase 5 — Liens + County export (~3 weeks)

22. **`AssessmentLien` schema + RLS** (~2 days).
23. **Lien-eligibility worker (FR-SA-101)** (~2 days).
24. **Gallatin County export format + spec** (~3 days). Requires County's format documentation.
25. **Lien-export UI + SFTP push (FR-SA-102)** (~3 days).
26. **Recordation confirmation import (FR-SA-103)** (~2 days). Reuses doc 09 ingestion.
27. **Lien release flow (FR-SA-104)** (~2 days).
28. **Reporting page (FR-SA-105)** (~3 days).

### Phase 6 — Consolidated billing (~depends on Module 09; placeholder ~1 week if Module 09 lands first) 

29. **Consolidated bill line-item integration (FR-SA-090..093)** — gated on Module 09 delivery.

**Total: ~16-20 weeks** with one engineer; ~10-12 weeks with two parallel tracks (GIS sync + levy engine + payoff can run in parallel after Phase 1).

The biggest unknowns are **County format** (Phase 5) and **Module 09 readiness** (Phase 6). If the County format spec is not available pre-build, deliver Phase 5 with a generic CSV template and refine later. If Module 09 is delayed, Phase 6 becomes a follow-up release — `SEPARATE` billing mode is fully functional on its own.

---

## 6. Out of scope

1. **Special-assessment payment plans (different from installments)** — installments ARE the plan. A customer in financial distress requesting a custom hardship plan is handled via the separate `PaymentPlan` workflow (per [docs/specs/10-payments-and-collections.md](../specs/10-payments-and-collections.md)) which references the assessment but is a separate negotiation.
2. **Auto-recalculation of levies on parcel-attribute drift** — explicitly NOT done (FR-SA-044). Drift triggers a Task, not a financial mutation.
3. **Real-time GIS query during operator workflows** — operators see the last-synced attributes. Real-time queries against ESRI add complexity and a single point of failure for utility billing flows.
4. **Customer-portal appeal submission** — appeals require document upload, identity verification, and specific MT-state procedures. Out of scope for this RFP cycle; appeals are operator-initiated.
5. **Lien forgiveness via political action** — emergency property-owner-relief programs that forgive part or all of an outstanding assessment require legislative action and case-by-case operator handling. Modeled as a `WriteOff` on the `AssessmentInstallment`, not a separate workflow.
6. **Multi-jurisdictional assessments** — this doc commits to single-tenant assessments. Cities sharing improvement districts (e.g., a regional sewer district crossing city boundaries) require multi-tenant data-sharing primitives that are out of scope.
7. **Dynamic district boundary changes** — once a district is `ACTIVE`, its boundary is fixed (per `gis_layer_id`). Adding parcels mid-district-life requires a re-enrollment flow that is operator-initiated, not auto-detected from GIS changes. (Future enhancement: GIS-driven boundary expansion. Phase 5+.)
8. **Tax-exempt parcel handling** — exempt parcels (churches, government buildings) require state-specific exemption logic. Out of scope; operators manually exclude exempt parcels at enrollment time.
9. **County format auto-detection** — the County must provide format spec; CIS does not auto-detect schema from a sample file. (The spec is parameterized in `tenant_config.county_lien_export_format` as the canonical extension point.)
10. **Real estate closing integration** — automatic detection of property closings is out of scope. Operators receive closing paperwork from the City and trigger `transferOwnership` manually.
11. **Cash-flow forecasting for districts** — predicting district revenue stream over the multi-year amortization is a finance-team concern, not addressed by this CIS module.
12. **Bond-issuance and proceeds tracking** — many improvement districts are bond-funded. The bond proceeds, debt service, etc., live in the City's general ledger / ERP, not in CIS. CIS captures the assessments levied on parcels; how those revenues flow to bond service is the City's accounting.
13. **Inter-district transfers** — moving a parcel from District A to District B (rare; results from district mergers) is a manual operator process.
14. **Native PostGIS geometry queries** — installation of the PostGIS extension is out of scope. Boundary geometry stays in ESRI; CIS only stores the parcel-to-district membership relation.

---

## 7. Risks and mitigations

| Risk | Severity | Mitigation |
|---|---|---|
| GIS sync downtime delays district enrollment | Medium | Daily full sync + on-demand single-parcel sync (FR-SA-040). Operators can hand-enter parcel attributes if GIS is down. Manual override flag exists (FR-SA-045). |
| Parcel-attribute drift produces silent over- or under-billing | High | Drift NEVER auto-recalculates posted levies (FR-SA-044). Operators receive Tasks; corrections go through doc 12 reversal. Audit trail shows who decided to update. |
| Amortization library has rounding bugs | High | Tested against published amortization tables (NFR-SA-005); final-installment principal forced to balance (FR-SA-063). Library is pure-function for testability. |
| County export format changes mid-engagement | Medium | Format is tenant-config-driven (FR-SA-102); changes are config-only, no code release required. Operators run a dry-run export against a sample to verify before going live. |
| County recordation confirmation never arrives | Medium | Liens stuck in `EXPORTED` for >30 days surface in operations dashboard (FR-SA-105). Operators reconcile with County manually. |
| Parcel ownership transfer at closing — wrong party billed for transition installment | Medium | `finalBillToOutgoingOwner` parameter (FR-SA-080) explicitly handles the prorated final bill. The transfer date is set by the City staff based on closing paperwork. |
| District activation when no parcels are enrolled | Low | UI warns at activation time; activation is dual-approved (FR-SA-011) so the second approver should catch it. |
| Levy reversal cascading to liens incorrectly | Medium | Doc 12 reversal pattern explicitly handles cascading (FR-REV-013 forbids reversal of reversal). Lien `RELEASED` is tied to `ParcelAssessment.PAID_OFF` event, not to reversal — separate workflow. |
| Customer pays the wrong amount for payoff | Low | Payoff quote includes `quoteValidUntil` (FR-SA-070). If customer pays after expiry, the next quote may differ. The portal warns. |
| Portal RLS leaks one customer's parcel-assessment to another | **Critical** | Portal RLS uses `is_premise_visible_to_portal_user` SQL helper joined through `Premise.ownerId` chain. Tested with adversarial input — confirmed cross-customer reads return 0 rows. |
| Multi-meter parcel — assessment shown twice in consolidated bill | Low | FR-SA-092 specifies one line item per district per parcel, regardless of meter count. Consolidated billing logic computes line items at the parcel level, not the meter level. |
| GIS coordinate-system mismatch (NAD83 vs WGS84) | Low | CIS doesn't perform spatial calculations (FR-SA-040 only mirrors attribute values). The City's GIS handles its own projection. |
| ESRI feature class schema changes (renamed columns) | Medium | The sync worker fails loud (audit row + alert) if expected columns are missing. Configured field mapping per tenant (`tenant_config.gis_config.field_map`) makes recovery a config update. |
| Bulk parcel enrollment fails halfway through a 5,000-parcel district | Medium | Per FR-SA-021, batch policy is `reject_batch_threshold:1` — the entire enrollment aborts on one bad row. Operators fix the bad row and re-import. Idempotency on `(districtId, premiseId)` ensures re-import doesn't double-enroll. |
| Late-fee accrual continues during appeal | Low | District config governs (`appeal_pause_billing` flag); per FR-SA-024 default is to pause billing during appeal. Operators audit pauses. |
| Customer disputes the levy basis (e.g., "my frontage was measured wrong") | Medium | Appeal workflow (FR-SA-024) handles the procedural side. Levy reversal + re-post (FR-SA-023) corrects the math. The `calculationBasis` JSON snapshot makes the dispute clear (here's the attribute, here's the rate, here's the math). |
| Property goes to tax sale before lien is released | Medium | Lien tracking is by `parcelId`, which survives. The tax-sale buyer receives the parcel with the lien attached. Closing arrangements handle the lien payoff. The City's existing tax-sale process drives — CIS just tracks. |

---

## 8. Acceptance criteria (consolidated)

### Premise + GIS
- [ ] Premise has parcel attribute columns; `LAND_ONLY` premise type works.
- [ ] GIS sync worker pulls from ESRI daily; updates `gisLastSyncedAt`; emits drift audit rows.
- [ ] Single-parcel on-demand sync works.
- [ ] Manual override locks a parcel against further sync.
- [ ] `PremiseOwnerHistory` records every ownership change.

### Districts
- [ ] `AssessmentDistrict` CRUD works; DRAFT → ACTIVE requires dual approval.
- [ ] Rate change on active district = new RateSchedule version; effective dating applies.
- [ ] District lifecycle transitions (ACTIVE → COMPLETED, ACTIVE → SUNSET) work and are audited.

### Parcel enrollment
- [ ] Bulk enrollment via doc 09 ingestion succeeds for valid CSV; rejects bad rows per `reject_batch_threshold:1`.
- [ ] Single-parcel manual enrollment works.
- [ ] `ParcelAssessment` posting is immutable on monetary fields per [doc 12](./12-corrections-and-reversals.md).
- [ ] Re-enrollment only via reverse + re-post.

### Levy engine
- [ ] All 5 calculation methods (PER_PARCEL_FLAT, PER_FRONT_FOOT, PER_SQUARE_FOOT, PER_ERU, FORMULA) produce correct values to $0.01 against test fixtures.
- [ ] `calculationBasis` JSON captures the snapshot.
- [ ] Engine pure function, no DB I/O.

### Installments + amortization
- [ ] Installment scheduler generates correct schedule for one-time and multi-year cases.
- [ ] Amortization library matches published amortization tables to $0.01.
- [ ] Final-installment principal balances exactly.
- [ ] Late-fee worker posts `AdhocCharge` per district config.

### Payoff
- [ ] Operator and portal payoff quote endpoints return correct values.
- [ ] Portal RLS verified — one customer can't see another's parcel.
- [ ] Payoff payment marks all installments PAID, transitions ParcelAssessment to PAID_OFF, releases active lien.

### Ownership transfer
- [ ] Transfer endpoint creates PremiseOwnerHistory row, updates Premise.ownerId, snapshots assessment owner data.
- [ ] Final bill to outgoing owner generated when requested.
- [ ] Liens survive transfer with updated responsibleParty reference.
- [ ] Dual approval gates transfers above threshold.

### Liens + County export
- [ ] Lien-eligibility worker promotes overdue assessments to ELIGIBLE.
- [ ] Lien export UI generates correct County-format file.
- [ ] SFTP push works (configurable).
- [ ] Recordation confirmation import marks liens as FILED.
- [ ] Lien release on payoff produces release file.

### Reporting
- [ ] District summary, delinquency by district, lien activity, payoff history reports work.
- [ ] CSV/Excel/PDF export available.

### Non-functional
- [ ] Levy engine ≤10ms p99 (NFR-SA-001).
- [ ] Payoff quote ≤500ms p99 operator, ≤1s p99 portal (NFR-SA-002).
- [ ] GIS sync ≤30 minutes p99 for 50K parcels (NFR-SA-003).
- [ ] Lien export ≤1 minute p99 for 5K liens (NFR-SA-004).

---

## 9. References

- **Internal**:
  - [docs/specs/16-special-assessments.md](../specs/16-special-assessments.md) — original spec (this doc adopts and extends)
  - [docs/specs/02-premise-management.md](../specs/02-premise-management.md) — Premise + parcel attributes (Phase 2 work landed here)
  - [docs/specs/07-rate-management.md](../specs/07-rate-management.md) — RateSchedule effective-dated versioning (reused)
  - [docs/specs/09-billing.md](../specs/09-billing.md) — BillingRecord for consolidated billing (Phase 3 dependency)
  - [docs/specs/15-customer-portal.md](../specs/15-customer-portal.md) — portal infrastructure (payoff quote endpoint added)
  - [docs/specs/21-saaslogic-billing.md](../specs/21-saaslogic-billing.md) — SaaSLogic invoice issuance for SEPARATE billing mode
  - [04-attachments.md](./04-attachments.md) — closing paperwork stored as attachments on `PremiseOwnerHistory`
  - [05-customer-portal.md](./05-customer-portal.md) — portal commitments (real-time payoff quotes specifically)
  - [08-data-retention-archival-purge.md](./08-data-retention-archival-purge.md) — `AUDIT_FINANCIAL` retention class for assessment records (7-year minimum)
  - [09-bulk-upload-and-data-ingestion.md](./09-bulk-upload-and-data-ingestion.md) — parcel enrollment via CSV ingest; County recordation confirmation import
  - [10-draft-status-and-posting.md](./10-draft-status-and-posting.md) — district `DRAFT → ACTIVE` lifecycle uses the same status pattern
  - [11-notes-and-comments.md](./11-notes-and-comments.md) — comments on districts and parcel assessments
  - [12-corrections-and-reversals.md](./12-corrections-and-reversals.md) — levy reversal, lien release, late-fee waiver all use the reversal pattern
  - [13-workflow-approvals-action-queue.md](./13-workflow-approvals-action-queue.md) — district activation approval, ownership transfer approval, lien filing approval; Tasks for drift review
  - `packages/shared/prisma/schema.prisma` — current schema (modified by this doc)

- **External**:
  - ESRI ArcGIS REST API — feature service queries used by the GIS sync worker
  - ESRI Online (ArcGIS Online) — typical hosting model for municipal GIS layers
  - Standard amortization formulas (fixed-rate loan math)
  - Gallatin County, Montana recorder/treasurer requirements (TBD with the County during Phase 5)
  - Montana Code Annotated Title 7 (Local Government) — special improvement district authority
  - PostGIS — explicitly NOT used in this doc; spatial geometry stays in ESRI

---

**End of doc 14.**
