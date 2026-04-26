# 15 — GIS-Driven Defaults & Effective-Dated Account-to-Property Relationships

**RFP commitment owner:** SaaSLogic Utilities — split between `packages/shared/prisma/schema.prisma` (`ServiceTerritory` + `ServiceTerritoryRate` tables; btree_gist exclusion constraints on `ServiceAgreement` and `ServiceAgreementMeter`; extensions to `Premise` for sync-source markers), `packages/api/src/services/effective-dating/*` (overlap validation, point-in-time query helpers), `packages/api/src/services/territory/*` (zone-to-rate resolution, service-availability lookup), `packages/api/src/services/gis-override/*` (override endpoint, permission gates, audit class), and `packages/web/app/(admin)/premises/<id>/*` (GIS override UI). Cross-cuts heavily with [14-special-assessments.md](./14-special-assessments.md) (uses doc 14's GIS sync infrastructure + `gisSyncStatus` enum; doc 14's FR-SA-045 manual-override pattern is generalized here to cover all GIS-sourced fields), [01-audit-and-tamper-evidence.md](./01-audit-and-tamper-evidence.md) (`event_class = AUDIT_SECURITY` for overrides), [13-workflow-approvals-action-queue.md](./13-workflow-approvals-action-queue.md) (`pending_administrative_change` for dual approval on overrides; org-chart for service-territory authorization), [docs/specs/07-rate-management.md](../specs/07-rate-management.md) (rate selection plumbing), and the existing `service_agreement` + `service_agreement_meter` schema.
**Status:** Drafted — partial implementation of substrate, no implementation of the three claims. The schema's date-range columns exist (`ServiceAgreement.startDate/endDate`, `ServiceAgreementMeter.addedDate/removedDate`) but **no overlap prevention** — two operators can create overlapping active SAs on the same (account, premise, commodity) without error. **No point-in-time query helper** ("who was responsible for this premise on 2024-03-15?" requires manual SQL today). `Premise.serviceTerritoryId` is a freeform string column with **no `ServiceTerritory` entity behind it**, so there's no zone-to-rate or zone-to-availability mapping. Rate selection at SA creation is a manual operator pick. Generic `PATCH /premises/:id` allows anyone with `premise.write` to edit any field — there's no granular GIS-override gate or override-specific audit class.
**Effort estimate:** L (~6-8 weeks). The largest cost is the **`ServiceTerritory` entity + zone-to-rate mapping + service-availability gate** (~2-3 weeks: schema, effective-dated mapping, default-resolution service, validation hooks at SA creation). Second is **overlap prevention via btree_gist exclusion + point-in-time query helpers + tightened lifecycle workflows** (~2-3 weeks). Third is the **override workflow** (~1-2 weeks: separate endpoint, granular permission, dual-approval integration via doc 13, audit class via doc 01). Builds on but does not duplicate doc 14.

---

## 1. RFP commitments (verbatim)

This doc covers **three bundled claims**:

> **1.** System shall support effective-dated account-to-property relationships.

> **2.** System shall use GIS attributes to determine default rates and service availability.

> **3.** System shall restrict manual overrides of GIS-sourced attributes to authorized users with audit logging.

The three are bundled because they share substrate: GIS-sourced parcel data (from doc 14's sync infrastructure) drives both the rate-default + availability decisions in claim 2 AND the override-control workflow in claim 3, and the effective-dating story in claim 1 lives at the same intersection (the date a meter is assigned to an account, the date a service territory's rate methodology changes, the date a GIS override took effect).

**Two layers of effective-dating** apply (per the conversation establishing this doc):

- **ServiceAgreement layer** — when does an account start/stop being responsible for service at a premise (`startDate`/`endDate`/`status`).
- **ServiceAgreementMeter layer** — when does a specific physical meter start/stop being on a particular SA (`addedDate`/`removedDate`).

This doc commits both. The "property" half of "account-to-property" is, operationally, the meter (the revenue-bearing service point), but premise-level dating is also captured because closing an SA must close all its meter assignments atomically.

---

## 2. Current state — what exists today

### 2.1 ServiceAgreement effective-dating columns ✓ (loose validation)

**Status: Columns exist; validation is incomplete.**

`ServiceAgreement` (`schema.prisma:358-396`) has:
- `startDate DateTime @db.Date`
- `endDate DateTime? @db.Date`
- `status: PENDING | ACTIVE | FINAL | CLOSED`

`createServiceAgreement()` and `updateServiceAgreement()` accept these as inputs. There is:
- **No CHECK constraint** that `endDate >= startDate`.
- **No exclusion constraint** preventing two ACTIVE SAs for the same `(accountId, premiseId, commodityId)` from overlapping in time.
- **No validation** that `endDate` cannot be set in the past unless `status` is being moved to `FINAL` or `CLOSED` simultaneously.

The cleanest existing transition path is `workflows.service.transferService()` — closes the source SA with `status: "FINAL", endDate: transferDate` and creates the new SA with `status: "ACTIVE", startDate: transferDate` in a single transaction. That pattern works. But every other write path (manual PATCH, `moveIn`, `moveOut`, ad-hoc service code) can produce inconsistent state.

### 2.2 ServiceAgreementMeter effective-dating columns ✓ (loose validation)

**Status: Columns exist; validation is incomplete.**

`ServiceAgreementMeter` (`schema.prisma:399-415`) has:
- `addedDate DateTime @db.Date`
- `removedDate DateTime? @db.Date`
- `isPrimary Boolean @default(true)`

`addMeterToAgreement()` (`service-agreement.service.ts:143-183`) checks meter uniqueness per commodity across active agreements (a meter can be on only one active agreement at a time per commodity), but:
- **No CHECK constraint** that `removedDate >= addedDate`.
- **No exclusion constraint** preventing overlapping `(meter_id)` ranges across SAs (the application-layer check is best-effort and racy under concurrent writes).
- **No automatic cascade**: closing a `ServiceAgreement` (setting status FINAL + endDate) does NOT auto-close child `ServiceAgreementMeter` rows. Operators must manually set `removedDate` on each meter assignment, or the data ends up with closed SAs whose meter assignments remain open indefinitely.

### 2.3 No point-in-time query helper ✗

**Status: Not implemented.** Reconstructing "who was responsible for premise X on date Y?" requires a manual SQL query joining `service_agreement` filtered by `startDate <= Y AND (endDate IS NULL OR endDate >= Y)` — operators run this ad hoc when needed. There is no service function exposed via the API, and there is no time-travel UI.

The audit log captures all transitions (per [01-audit-and-tamper-evidence.md](./01-audit-and-tamper-evidence.md)) so the data is technically reconstructible from history alone, but in practice operators query the live tables.

### 2.4 No `ServiceTerritory` entity ✗

**Status: Stub column, no entity.**

`Premise.serviceTerritoryId String? @db.VarChar(64)` exists as a freeform identifier. It is:
- Not a foreign key.
- Not validated against any reference table (a typo creates a new "territory" silently).
- Used as a filter parameter in `listPremises()` but never consulted at SA creation, rate selection, or service availability checks.
- Documented in [docs/specs/02-premise-management.md](../specs/02-premise-management.md) as a Phase 2 placeholder.

### 2.5 No GIS-driven default rate selection ✗

**Status: Not implemented.**

`createServiceAgreement()` (`service-agreement.service.ts:53-141`) accepts `rateScheduleId` as a **required** payload field. The caller (UI form, API client, integration) supplies it. There is:
- No `selectDefaultRateSchedule(premiseId, commodityId, asOfDate)` function.
- No mapping table from `(serviceTerritoryId, commodityId)` to `rateScheduleId`.
- No use of premise's parcel attributes in rate resolution (parcel attributes themselves don't exist yet — see doc 14 §2.2).

The web form's rate-schedule dropdown shows all active rates for the commodity; the operator picks one. Two operators creating SAs for adjacent residential premises in the same territory might select different rates without anyone catching the drift.

### 2.6 No service-availability concept ✗

**Status: Not implemented.**

A grep across the schema for `serviceAvailable`, `service_available`, `availability_status`, `serviceEligibility` returns zero matches. `Premise.status` (`ACTIVE | INACTIVE | CONDEMNED`) is the closest analog, but it's a per-premise state, not a per-zone-per-commodity availability rule.

There is no validation that prevents creating an SA for "water service" on a premise in a zone that has no water-service eligibility (e.g., a parcel outside the city limits). Today, an operator can create an SA for any commodity on any premise — bad data is caught at the meter-installation step or never.

### 2.7 Generic PATCH allows GIS field edits ⚠

**Status: All-or-nothing permission.**

`PATCH /api/v1/premises/:id` (handled by `updatePremise()` in `premise.service.ts:152-179`) accepts the `UpdatePremiseInput` Zod schema, which permits any non-system field including `geoLat`, `geoLng`, `addressLine1`, `status`, `ownerId`. Any user with the `premise.write` permission can edit any field; there's no field-level RBAC.

Doc 14 commits to adding parcel-attribute columns (`squareFootage`, `frontageFeet`, `imperviousAreaSqFt`, `assessmentBasisUnits`, `gisLastSyncedAt`, `gisSyncStatus`) — but **none exist today**. Once they land per doc 14 FR-SA-001, the same generic PATCH allows them to be edited too, unless this doc's claim 3 work lands in parallel.

Doc 14 FR-SA-045 commits an override flow with `gisSyncStatus = MANUAL_OVERRIDE` + dual approval + `AUDIT_SECURITY` audit class. **Unbuilt**, and the `event_class` audit column itself is also unbuilt (per doc 01 FR-AUDIT-032).

### 2.8 No granular GIS override permission ✗

**Status: Only `premise.write` exists.** A grep for `gis.override`, `gis_override`, `manual_override` across `packages/api/src/lib/permissions.ts` returns nothing. Roles can grant or deny `premise.write` whole, with no way to allow address edits while disallowing GIS-attribute overrides.

### Summary

| Guarantee | Today |
|---|---|
| Effective-dating columns on `ServiceAgreement` | ✓ |
| Effective-dating columns on `ServiceAgreementMeter` | ✓ |
| Overlap prevention via DB constraint | ✗ |
| `endDate >= startDate` enforcement | ✗ |
| Closing SA cascades to meter assignments | ✗ |
| Point-in-time query helper | ✗ |
| `ServiceTerritory` entity | ✗ (stub column only) |
| GIS-driven default rate selection | ✗ |
| Service availability gate at SA creation | ✗ |
| Field-level RBAC for GIS attributes | ✗ |
| Override-specific audit class | ✗ (doc 01 commits but unbuilt) |
| Override-specific dual approval | ✗ (doc 13 commits but unbuilt) |

---

## 3. Functional requirements

### 3.1 Effective-dating — ServiceAgreement layer

- **FR-EFF-001** — A `tstzrange`-based **exclusion constraint** prevents overlapping active SAs for the same `(account_id, premise_id, commodity_id)`. Concretely:

  ```sql
  CREATE EXTENSION IF NOT EXISTS btree_gist;

  ALTER TABLE service_agreement
    ADD COLUMN effective_range tstzrange GENERATED ALWAYS AS (
      tstzrange(
        start_date::timestamptz,
        COALESCE(end_date, 'infinity'::timestamptz)::timestamptz,
        '[)'
      )
    ) STORED;

  ALTER TABLE service_agreement
    ADD CONSTRAINT no_overlapping_active_sa EXCLUDE USING gist (
      utility_id WITH =,
      account_id WITH =,
      premise_id WITH =,
      commodity_id WITH =,
      effective_range WITH &&
    ) WHERE (status IN ('PENDING', 'ACTIVE'));
  ```

  Two operators racing to create overlapping ACTIVE SAs trigger a unique-violation-style error at commit time; the second commit fails. The application layer surfaces a clear error: *"Account A already has an active service agreement for water at premise P from 2026-01-01 onward. Close the existing agreement before creating a new one, or use the transfer-service workflow to do both atomically."*

- **FR-EFF-002** — CHECK constraint enforcing `end_date IS NULL OR end_date >= start_date` on `service_agreement`. Trivial guard against fat-fingered date inputs.

- **FR-EFF-003** — Lifecycle invariant: setting `status = FINAL` or `status = CLOSED` requires `end_date IS NOT NULL`. Setting `end_date IS NOT NULL` while `status IN ('PENDING', 'ACTIVE')` requires the end date to be ≥ today (cannot retroactively close an active SA without also moving to FINAL/CLOSED). Enforced via a `BEFORE INSERT OR UPDATE` trigger.

- **FR-EFF-004** — Closing an SA (transition to `FINAL` or `CLOSED`) **cascades** to all child `service_agreement_meter` rows: any row with `removedDate IS NULL` gets `removedDate = service_agreement.end_date` in the same transaction. Implementation: a new service-layer helper `closeServiceAgreement(saId, endDate, status, reason)` performs both updates atomically; the existing `transferService` is refactored to call it.

- **FR-EFF-005** — Lifecycle workflows tightened:
  - `transferService` (already clean) — no change.
  - `moveOut` — explicitly closes the source SA via FR-EFF-004 (closes meter assignments too); does NOT create a new SA. Must complete cleanly.
  - `moveIn` — creates a new SA on the target account; rejects if any active SA already covers the same `(account_id, premise_id, commodity_id)` (the FR-EFF-001 constraint will reject anyway, but an explicit pre-check returns a clearer error).

- **FR-EFF-006** — Generic `PATCH /api/v1/service-agreements/:id` is **deprecated for date and status fields.** The PATCH endpoint accepts only narrow non-lifecycle fields (notes, customFields, billing routing). Lifecycle changes (start/end/status) go through dedicated endpoints (`/transition`, `/transfer`, `/move-in`, `/move-out`) that enforce the workflow invariants. Existing direct-PATCH callers are migrated; the migration emits a one-time deprecation warning per (tenant, caller) pair so we know who to chase.

### 3.2 Effective-dating — ServiceAgreementMeter layer

- **FR-EFF-010** — Exclusion constraint preventing the same physical meter from being on two SAs at the same time:

  ```sql
  ALTER TABLE service_agreement_meter
    ADD COLUMN effective_range tstzrange GENERATED ALWAYS AS (
      tstzrange(
        added_date::timestamptz,
        COALESCE(removed_date, 'infinity'::timestamptz)::timestamptz,
        '[)'
      )
    ) STORED;

  ALTER TABLE service_agreement_meter
    ADD CONSTRAINT no_double_assigned_meter EXCLUDE USING gist (
      utility_id WITH =,
      meter_id WITH =,
      effective_range WITH &&
    ) WHERE (removed_date IS NULL OR removed_date >= now()::date);
  ```

  Note the WHERE clause — historical removed assignments are exempt; a meter that was on SA A from 2020-2024 and is on SA B from 2024-onward is fine, but two open-ended assignments on the same meter is rejected.

- **FR-EFF-011** — CHECK constraint `removed_date IS NULL OR removed_date >= added_date`.

- **FR-EFF-012** — Adding a meter to an SA verifies the meter isn't on another active SA (the constraint catches it; the application layer pre-checks for a clearer error message).

- **FR-EFF-013** — Removing a meter (setting `removed_date`) is its own operation `removeMeterFromAgreement(saId, meterId, removedDate, reason)`. Audit row of class `AUDIT_OPERATIONAL` with the reason.

- **FR-EFF-014** — Meter swaps (replace M-1234 with M-5678 on the same SA at the same date) are a single transactional helper `swapMeter(saId, oldMeterId, newMeterId, swapDate, reason)`. Two `service_agreement_meter` writes in one transaction: old gets `removedDate`, new is inserted with `addedDate`. Both meters have to belong to the tenant; the new meter must not be on any other active SA (FR-EFF-010 catches it).

### 3.3 Point-in-time query helpers

- **FR-EFF-020** — Two SQL helper functions, exposed via API endpoints:

  ```sql
  CREATE OR REPLACE FUNCTION responsible_account_at(
    p_premise_id uuid,
    p_commodity_id uuid,
    p_as_of_date date
  ) RETURNS uuid LANGUAGE sql STABLE SECURITY INVOKER AS $$
    SELECT account_id FROM service_agreement
    WHERE premise_id = p_premise_id
      AND commodity_id = p_commodity_id
      AND start_date <= p_as_of_date
      AND (end_date IS NULL OR end_date >= p_as_of_date)
      AND status IN ('ACTIVE', 'PENDING', 'FINAL')   -- include FINAL because a FINAL SA was the responsible party until its end date
      AND utility_id = current_setting('app.current_utility_id')::uuid
    ORDER BY start_date DESC
    LIMIT 1
  $$;

  CREATE OR REPLACE FUNCTION meter_assignment_at(
    p_meter_id uuid,
    p_as_of_date date
  ) RETURNS TABLE(service_agreement_id uuid, account_id uuid, premise_id uuid)
    LANGUAGE sql STABLE SECURITY INVOKER AS $$
    SELECT sam.service_agreement_id, sa.account_id, sa.premise_id
    FROM service_agreement_meter sam
    JOIN service_agreement sa ON sa.id = sam.service_agreement_id
    WHERE sam.meter_id = p_meter_id
      AND sam.added_date <= p_as_of_date
      AND (sam.removed_date IS NULL OR sam.removed_date >= p_as_of_date)
      AND sam.utility_id = current_setting('app.current_utility_id')::uuid
    ORDER BY sam.added_date DESC
    LIMIT 1
  $$;
  ```

- **FR-EFF-021** — REST endpoints surfacing the helpers:
  - `GET /api/v1/premises/<id>/responsible-account?commodity=<id>&as_of=<date>` — returns the account that owned service at the date.
  - `GET /api/v1/meters/<id>/assignment?as_of=<date>` — returns the SA + account + premise that the meter was on.
  - Both return `null` (404) if no row matches — useful for audit (e.g., "this meter wasn't assigned to anyone on 2023-05-01").

- **FR-EFF-022** — A "history timeline" UI on the premise detail page shows every SA that has covered the premise, ordered by `start_date` with date-range blocks visible at a glance. Clicking a block shows the SA detail. Same pattern on the meter detail page (every SA the meter has been on).

### 3.4 ServiceTerritory — real entity

- **FR-EFF-030** — A new `ServiceTerritory` entity replaces the freeform `Premise.serviceTerritoryId` string with a real FK:

  ```prisma
  model ServiceTerritory {
    id              String   @id @default(uuid()) @db.Uuid
    utilityId       String   @map("utility_id") @db.Uuid
    code            String   @db.VarChar(32)               // tenant-unique, e.g., "RES-NW", "COMM-DOWN", "OUTSIDE-CITY"
    name            String   @db.VarChar(255)
    description     String?  @db.Text
    gisLayerId      String?  @map("gis_layer_id") @db.VarChar(128)  // ESRI feature class for boundary
    parentId        String?  @map("parent_id") @db.Uuid     // optional hierarchy (district → sub-zone)
    effectiveFrom   DateTime @map("effective_from") @db.Date
    effectiveTo     DateTime? @map("effective_to") @db.Date
    isActive        Boolean  @default(true)                  // operational toggle independent of effective dating
    createdBy       String   @map("created_by") @db.Uuid
    createdAt       DateTime @default(now()) @map("created_at") @db.Timestamptz

    parent          ServiceTerritory? @relation("TerritoryHierarchy", fields: [parentId], references: [id])
    children        ServiceTerritory[] @relation("TerritoryHierarchy")

    @@unique([utilityId, code])
    @@index([utilityId, isActive])
    @@index([utilityId, gisLayerId])
    @@map("service_territory")
  }
  ```

- **FR-EFF-031** — `Premise.serviceTerritoryId` becomes a real FK to `ServiceTerritory.id`. Migration backfill:
  1. For each distinct existing string value in `premise.service_territory_id`, create a `ServiceTerritory` row with that `code`. (Tenant admins can rename / merge afterwards.)
  2. NULL values stay NULL — premises without a territory are flagged but don't fail the migration.

- **FR-EFF-032** — Territory boundaries live in the City's GIS (`gisLayerId` references the ESRI feature class). The GIS sync worker from doc 14 is extended to **also** sync each parcel's territory membership: when a parcel's containing territory changes (annexation, district restructuring), `Premise.serviceTerritoryId` is updated and an audit row of class `AUDIT_OPERATIONAL` is emitted. Operators receive a Task per [13-workflow-approvals-action-queue.md](./13-workflow-approvals-action-queue.md) for review of any territory drift on premises with active service agreements (because territory affects rate and availability — see FR-EFF-040).

- **FR-EFF-033** — A `/settings/service-territories` admin page provides CRUD on territories (effective-dated edits trigger a new version per [docs/specs/07-rate-management.md](../specs/07-rate-management.md)'s versioning pattern). Tree view if hierarchy is used.

### 3.5 GIS-driven default rate selection

- **FR-EFF-040** — A new `ServiceTerritoryRate` junction maps each `(territory, commodity, premiseType)` to a default `RateSchedule`, effective-dated:

  ```prisma
  model ServiceTerritoryRate {
    id                  String   @id @default(uuid()) @db.Uuid
    utilityId           String   @map("utility_id") @db.Uuid
    serviceTerritoryId  String   @map("service_territory_id") @db.Uuid
    commodityId         String   @map("commodity_id") @db.Uuid
    premiseType         PremiseType?  @map("premise_type")           // null = applies to all types in territory; non-null = type-specific override
    rateScheduleId      String   @map("rate_schedule_id") @db.Uuid
    effectiveFrom       DateTime @map("effective_from") @db.Date
    effectiveTo         DateTime? @map("effective_to") @db.Date
    createdBy           String   @map("created_by") @db.Uuid
    createdAt           DateTime @default(now()) @map("created_at") @db.Timestamptz

    serviceTerritory ServiceTerritory @relation(fields: [serviceTerritoryId], references: [id])
    rateSchedule     RateSchedule     @relation(fields: [rateScheduleId], references: [id])

    @@index([utilityId, serviceTerritoryId, commodityId, premiseType, effectiveFrom])
    @@map("service_territory_rate")
  }
  ```

  The lookup precedence at SA creation: most-specific match (`territoryId + commodityId + premiseType`) → fall back to (`territoryId + commodityId`, premiseType null) → fall back to product default. Effective-dated: pick the row with `effectiveFrom <= startDate AND (effectiveTo IS NULL OR effectiveTo >= startDate)`.

- **FR-EFF-041** — A new service `selectDefaultRateSchedule(premiseId, commodityId, asOfDate)` returns the resolved rate. Used by:
  - SA creation form — on premise+commodity selection, the rate dropdown defaults to the resolved rate; operator can change it but the change is flagged (FR-EFF-042).
  - SA creation API — if the caller doesn't supply `rateScheduleId`, the resolver fills it in. If the caller supplies one that doesn't match the resolver's pick, a non-fatal warning is logged.
  - Programmatic SA creation paths (move-in, transfer-service) — automatically use the resolver.

- **FR-EFF-042** — Operator-overridden rate at SA creation: when the operator picks a different rate from the resolver's default, the SA is created with `rateScheduleId` set to the override AND a `rate_override_reason` field is populated (required text input in the UI). Audit row of class `AUDIT_FINANCIAL` records the override + reason. Reasoning: a rate override has financial impact; it's not a casual deviation.

- **FR-EFF-043** — Default-rate updates over time: tenants editing a `ServiceTerritoryRate` create a new version with `effectiveFrom = future date`; the previous version's `effectiveTo` is set automatically (same pattern as `RateSchedule.reviseRateSchedule`). Existing SAs already created don't change rate (their `rateScheduleId` is fixed at creation); only new SAs created after the new effective date pick up the new default.

- **FR-EFF-044** — Reporting view: for each `ServiceTerritoryRate`, show how many active SAs use the resolved rate vs. an override. Helps tenants spot drift.

### 3.6 Service availability

- **FR-EFF-050** — A new `ServiceTerritoryAvailability` table per `(territory, commodity)`:

  ```prisma
  model ServiceTerritoryAvailability {
    id                  String   @id @default(uuid()) @db.Uuid
    utilityId           String   @map("utility_id") @db.Uuid
    serviceTerritoryId  String   @map("service_territory_id") @db.Uuid
    commodityId         String   @map("commodity_id") @db.Uuid
    availability        ServiceAvailability @default(AVAILABLE)
    reason              String?  @db.Text                              // e.g., "outside service area; private well required"
    effectiveFrom       DateTime @map("effective_from") @db.Date
    effectiveTo         DateTime? @map("effective_to") @db.Date
    createdBy           String   @map("created_by") @db.Uuid
    createdAt           DateTime @default(now()) @map("created_at") @db.Timestamptz

    @@unique([utilityId, serviceTerritoryId, commodityId, effectiveFrom])
    @@map("service_territory_availability")
  }

  enum ServiceAvailability {
    AVAILABLE          // default: SAs can be created freely
    BY_REQUEST         // SA creation allowed but flagged for review (e.g., parcel inside service area but pending main extension)
    UNAVAILABLE        // SA creation blocked
  }
  ```

- **FR-EFF-051** — At SA creation, `selectDefaultRateSchedule` companion `checkServiceAvailability(premiseId, commodityId, asOfDate)` returns the availability status. The SA-creation endpoint:
  - `AVAILABLE` → proceeds normally.
  - `BY_REQUEST` → SA created with `status = PENDING` and an automatic Task per [doc 13](./13-workflow-approvals-action-queue.md) for the operations team to review before activation.
  - `UNAVAILABLE` → rejected with a clear error citing the territory + reason. Operator can request an override (FR-EFF-052).

- **FR-EFF-052** — Operator override of `UNAVAILABLE`: a `POST /api/v1/service-agreements/override-availability` endpoint creates a `pending_administrative_change` row per [doc 13](./13-workflow-approvals-action-queue.md). On dual approval, the SA is created with status `ACTIVE` and an audit row of class `AUDIT_SECURITY` records the override + approver IDs + reason. Permission `service-agreements.override_availability` required.

- **FR-EFF-053** — Reporting: a tenant-admin dashboard widget surfaces "active SAs in `UNAVAILABLE` zones" — should always be zero or close to it under normal operations.

### 3.7 GIS override controls

- **FR-EFF-060** — A new permission `gis.override_attributes` is **distinct from `premise.write`**. Roles can grant either, both, or neither.

- **FR-EFF-061** — A dedicated endpoint `POST /api/v1/premises/<id>/gis-override` (separate from generic `PATCH`) handles GIS-attribute overrides. It accepts only the GIS-sourced fields (`squareFootage`, `frontageFeet`, `imperviousAreaSqFt`, `assessmentBasisUnits`, `geoLat`, `geoLng`, `serviceTerritoryId` when GIS-driven, plus `gisSyncStatus` itself) plus a required `reason: string`. Permission `gis.override_attributes` required. The endpoint:
  1. Sets the field(s) to the new value.
  2. Sets `Premise.gisSyncStatus = MANUAL_OVERRIDE` to lock against future sync (see [14-special-assessments.md](./14-special-assessments.md) FR-SA-045).
  3. Emits an audit row of class `AUDIT_SECURITY` (per [01-audit-and-tamper-evidence.md](./01-audit-and-tamper-evidence.md) FR-AUDIT-032) with `before_state`, `after_state`, the changed-fields list, and the reason.
  4. If the new values would change a parcel's assessment basis (FR-SA-044), creates a Task per doc 13 for the assessment team to review.

- **FR-EFF-062** — Generic `PATCH /api/v1/premises/<id>` is **explicitly forbidden** from setting any GIS-sourced field. The Zod schema for the PATCH body excludes those fields; attempting to set them returns 422 with: *"This field is GIS-managed. Use POST /premises/{id}/gis-override to manually override (requires gis.override_attributes permission)."*

- **FR-EFF-063** — Dual approval per the entity's policy: tenants can configure (in `tenant_config.gis_override_dual_approval_thresholds`) which fields require dual approval. Defaults:
  - `gisSyncStatus` flip to `MANUAL_OVERRIDE` — always dual-approved.
  - `geoLat`/`geoLng` — single approval (low-risk).
  - `squareFootage` / `frontageFeet` / `imperviousAreaSqFt` / `assessmentBasisUnits` — dual-approved when the change exceeds 5% of the GIS-reported value (anti-fraud guard against silent assessment basis manipulation).
  - `serviceTerritoryId` — always dual-approved (territory affects rates and availability).

- **FR-EFF-064** — Releasing an override (returning the parcel to GIS-driven sync) is a separate endpoint `POST /api/v1/premises/<id>/gis-override/release` with reason. Sets `gisSyncStatus = STALE` (will be refreshed on the next sync); does NOT undo the manual values until sync runs. Audit row of class `AUDIT_SECURITY`.

- **FR-EFF-065** — A "Manual Overrides" admin page lists all premises with `gisSyncStatus = MANUAL_OVERRIDE`, sortable by override age. Compliance auditors review periodically; an override more than 12 months old should either be released (parcel attribute is now correct in GIS) or have its reason documented in a comment.

### 3.8 Non-functional requirements

- **NFR-EFF-001** — `responsible_account_at` query latency: ≤50ms p99 with proper indexes on `(utility_id, premise_id, commodity_id, start_date, end_date)`.
- **NFR-EFF-002** — `selectDefaultRateSchedule` latency: ≤30ms p99 (uses the territory + commodity + premiseType index).
- **NFR-EFF-003** — Exclusion-constraint enforcement is at commit time, so a 1ms-window race between two creators is structurally prevented; no application-layer locking required.
- **NFR-EFF-004** — Override workflow latency: ≤500ms p99 from POST to either commit (single-approval cases) or pending-approval state (dual cases).
- **NFR-EFF-005** — RLS continues to enforce tenant isolation on every new table.
- **NFR-EFF-006** — Audit emission stays in-transaction with the entity mutation (no outbox; per the architectural-discipline principle).

---

## 4. Data model changes

### 4.1 New tables

| Table | Purpose | Section |
|---|---|---|
| `ServiceTerritory` | Real entity replacing the freeform `Premise.serviceTerritoryId` string | 3.4 |
| `ServiceTerritoryRate` | Effective-dated default rate per (territory, commodity, premiseType) | 3.5 |
| `ServiceTerritoryAvailability` | Effective-dated availability per (territory, commodity) | 3.6 |

### 4.2 Modified tables

| Table | Change | Reason |
|---|---|---|
| `service_agreement` | Add generated `effective_range tstzrange` column + exclusion constraint + CHECK constraint + lifecycle trigger | FR-EFF-001..003 |
| `service_agreement_meter` | Add generated `effective_range tstzrange` + exclusion constraint + CHECK constraint | FR-EFF-010..011 |
| `premise` | Convert `serviceTerritoryId` from `String?` to `String? @db.Uuid` with FK to `ServiceTerritory.id`; backfill migration | FR-EFF-031 |
| `tenant_config` | Add `gis_override_dual_approval_thresholds` JSON | FR-EFF-063 |

### 4.3 New SQL helpers

- `responsible_account_at(premise_id, commodity_id, as_of_date)` (FR-EFF-020)
- `meter_assignment_at(meter_id, as_of_date)` (FR-EFF-020)

### 4.4 New permissions

- `gis.override_attributes` — distinct from `premise.write`
- `service-agreements.override_availability` — distinct from `service-agreements.create`

### 4.5 RLS

All new tables get tenant RLS by `utility_id` per the existing pattern. `ServiceTerritory` is read-visible to all tenant users (territories aren't sensitive); writes are gated on a new `service-territories.write` permission.

---

## 5. Implementation sequence

### Phase 1 — Effective-dating constraints + helpers (~2 weeks)

1. **`btree_gist` extension + exclusion constraints + CHECK constraints + lifecycle triggers** (~3 days). Tested against concurrent-write integration tests (multiple workers racing to create overlapping SAs).
2. **`closeServiceAgreement` cascade helper + refactor `transferService` / `moveOut` to use it** (~3 days).
3. **Tighten generic PATCH to reject lifecycle field edits; add deprecation warnings** (~2 days).
4. **`responsible_account_at` + `meter_assignment_at` SQL helpers + REST endpoints + UI history-timeline component** (~4 days).

### Phase 2 — ServiceTerritory entity + migrations (~1.5 weeks)

5. **`ServiceTerritory` schema + RLS + CRUD service + admin UI** (~3 days).
6. **Backfill migration converting `Premise.serviceTerritoryId` from string to FK** (~2 days). Includes one-time script to dedupe and prompt operator review for any orphaned territory codes.
7. **GIS sync worker extension to sync territory membership per parcel** (~2 days; depends on doc 14's GIS sync being landed).

### Phase 3 — Default rates + availability (~2 weeks)

8. **`ServiceTerritoryRate` schema + admin UI + version chain** (~3 days).
9. **`selectDefaultRateSchedule` resolver + integration into SA creation form + API** (~3 days).
10. **`ServiceTerritoryAvailability` schema + admin UI** (~2 days).
11. **`checkServiceAvailability` resolver + SA-creation gating + override endpoint with dual approval** (~3 days).
12. **Reporting widgets (override drift, unavailable-zone SAs)** (~2 days).

### Phase 4 — GIS override controls (~1.5 weeks)

13. **`gis.override_attributes` permission + override endpoint + reason capture** (~3 days).
14. **Generic-PATCH guard rejecting GIS field edits** (~1 day).
15. **Dual-approval integration via doc 13's `pending_administrative_change`** (~2 days).
16. **`AUDIT_SECURITY` event class wiring** (~2 days; depends on doc 01 FR-AUDIT-032 being landed).
17. **"Manual Overrides" admin page** (~2 days).

**Total: ~7 weeks** with one engineer; ~5 weeks with two parallel tracks (Phase 3 default-rate work and Phase 4 override work can overlap once Phase 2 lands).

Hard dependencies:
- Doc 14's GIS sync infrastructure must be landed before Phase 3 step 11 (territory drift triggers Tasks).
- Doc 01's `event_class` column on `audit_log` must be landed before Phase 4 step 16.
- Doc 13's `pending_administrative_change` must be landed before Phase 3 step 11 (availability override) and Phase 4 step 15 (GIS override dual approval).

---

## 6. Out of scope

1. **Per-field history table for SA changes** — `ServiceAgreement` mutations are tracked through `audit_log` per [01-audit-and-tamper-evidence.md](./01-audit-and-tamper-evidence.md). A separate dedicated history table (e.g., `service_agreement_history`) is not built; the audit log is the source of truth.
2. **Automatic rate migration when a `ServiceTerritoryRate` default changes** — existing active SAs keep their `rateScheduleId` from creation. Rate changes apply to NEW SAs only. To migrate existing SAs to a new rate, operators run a separate explicit migration workflow (out of this doc's scope; covered as a Phase 5+ utility tool).
3. **Multi-territory parcels** — a parcel that spans two territories is rare (unusual surveying); treated as belonging to whichever territory the centroid is in (per ESRI standard). Specialty handling (rate prorated across territories) is out of scope.
4. **Customer-portal display of effective-dated history** — the `responsible_account_at` helper is operator-facing only. Portal customers see their current relationship; they don't have access to the full premise history.
5. **Effective-dating on `Premise.ownerId`** — owner history is covered by [14-special-assessments.md](./14-special-assessments.md)'s `PremiseOwnerHistory`. This doc doesn't redefine that.
6. **Effective-dating on `Customer.firstName/lastName` and similar PII** — slowly-changing customer attributes are tracked through `audit_log`, not as effective-dated rows. Renames don't have date ranges in the way SAs do.
7. **Machine-learning rate prediction** — the rate resolver is a deterministic lookup, not a model. ML-based rate suggestion (e.g., based on historical consumption profile) is Phase 5+.
8. **GIS-driven service availability for partial commodities** — a parcel where water is `AVAILABLE` and sewer is `UNAVAILABLE` is fully supported (per-commodity rows in `ServiceTerritoryAvailability`). What's NOT supported: a parcel where water is "available only for irrigation" or other commodity sub-types. Out of scope; add new commodities to `Commodity` if needed.
9. **Real-time GIS query during availability check** — `checkServiceAvailability` reads from `ServiceTerritoryAvailability`, not from a live GIS query. The territory membership is synced (per doc 14 FR-SA-040 + this doc FR-EFF-032); availability rules are a tenant configuration. Real-time GIS query for availability adds complexity and a single point of failure for a check that runs on every SA creation.
10. **Override-bypass for system actors** — the GIS sync worker is a system actor; it can't bypass override checks because it doesn't WRITE to `Premise` GIS fields when `gisSyncStatus = MANUAL_OVERRIDE` (per [14-special-assessments.md](./14-special-assessments.md) FR-SA-045 — sync respects the override flag). Worker writes to other premises proceed normally.
11. **Bulk override** — overriding GIS attributes on N parcels at once is not supported by the override endpoint. Each override is per-premise with its own reason. Bulk operator workflow is Phase 5+ (and would itself require dual approval per the policy).

---

## 7. Risks and mitigations

| Risk | Severity | Mitigation |
|---|---|---|
| Exclusion constraint blocks legitimate transfer because of clock skew | Medium | `transferService` and `swapMeter` perform both close + open in a single transaction; the exclusion is checked at COMMIT, so simultaneous close-and-open of the same range is fine. Tested with concurrency test suite. |
| Migration to FK on `Premise.serviceTerritoryId` produces orphaned territory codes | Medium | Backfill script reviews orphans before the migration; operator approves each unique code before it becomes a real `ServiceTerritory` row. |
| `selectDefaultRateSchedule` returns wrong default because of misconfigured `ServiceTerritoryRate` | Medium | UI shows the default with the source ("default for residential premises in NW territory") and the operator can override (FR-EFF-042). Override emits `AUDIT_FINANCIAL` so excessive overrides surface in operator-behavior reports. |
| Service-availability override becomes a routine workaround | Medium | Override emits `AUDIT_SECURITY`; tenant-admin dashboard tracks override frequency per territory. Quarterly compliance review flags territories with >X% overrides. |
| Generic PATCH still allows GIS field edits via API misuse | High | Zod schema for PATCH body explicitly excludes GIS fields with a 422 error citing the override endpoint (FR-EFF-062). Integration tests cover the bypass attempts. |
| Dual approval on every GIS override slows operations | Medium | Threshold-based: only changes exceeding 5% of GIS value require dual approval (FR-EFF-063). `geoLat`/`geoLng` corrections and minor adjustments single-approve. |
| Point-in-time query returns stale data because of an in-flight write | Low | `responsible_account_at` is `STABLE` (not `IMMUTABLE`); reads see committed data. In a transaction, the query honors transaction isolation. Concurrent-read-in-progress is fine for audit purposes. |
| Closing an SA cascades to a meter assignment that should have ended earlier | Low | The cascade sets `removed_date = service_agreement.end_date`. If the meter actually came off the SA earlier, operators must use the dedicated `removeMeterFromAgreement` endpoint with the actual date BEFORE closing the SA. UI nudge surfaces this. |
| Territory drift on a parcel mid-billing-cycle | Medium | Per FR-EFF-032, a Task is created for any active-SA premise; operators decide whether to recalculate at the next cycle or pro-rate. Manual decision; no auto-action. |
| `ServiceTerritoryAvailability` change makes existing SAs invalid | Low | Existing SAs in a now-`UNAVAILABLE` zone keep their `ACTIVE` status (changing availability is forward-looking; doesn't retroactively invalidate). Operators get a Task to review the active SAs in the zone. |
| Operator types wrong reason on an override that makes audit hard to interpret | Low | Reason field is required; operations dashboard surfaces overrides with reasons shorter than 10 characters as low-quality entries. Quarterly review. |
| Override approver is the same person who originated (race or org-chart loophole) | High | Per [13-workflow-approvals-action-queue.md](./13-workflow-approvals-action-queue.md) FR-WF-090..096, originator and approver must be distinct users. Self-delegation is forbidden. Tested. |
| Backfill ServiceTerritory creates duplicates because operator-entered codes vary in case | Low | Backfill normalizes to upper-case before deduplication. Operator review surfaces ambiguous cases. |
| `effective_range` generated column doesn't update when start/end dates change | Low | `STORED` generated columns are recomputed on UPDATE in Postgres; tested. |

---

## 8. Acceptance criteria (consolidated)

### Effective-dating
- [ ] Two operators racing to create overlapping ACTIVE SAs on the same `(account, premise, commodity)` — exactly one succeeds; the other gets a structured error.
- [ ] CHECK constraint rejects `endDate < startDate` on both `service_agreement` and `service_agreement_meter`.
- [ ] Closing an SA cascades to all child meter assignments in the same transaction.
- [ ] `transferService`, `moveIn`, `moveOut` workflows produce clean lifecycle states with no overlapping ranges.
- [ ] Generic PATCH on lifecycle fields is rejected with a deprecation message.
- [ ] `responsible_account_at(premise, commodity, date)` and `meter_assignment_at(meter, date)` SQL helpers + REST endpoints work and return correct results across the audit-log timeline.
- [ ] History timeline UI shows date-range blocks on premise + meter detail pages.

### ServiceTerritory + defaults
- [ ] `ServiceTerritory` exists as a real entity with FK from `Premise`.
- [ ] Migration backfilled territory codes; operator review captured ambiguous cases.
- [ ] `ServiceTerritoryRate` admin UI works; effective-dated edits create new versions.
- [ ] `selectDefaultRateSchedule` returns correct rate per precedence (specific premiseType > general > product default).
- [ ] SA creation form pre-fills the rate from the resolver; operator override requires reason text and emits `AUDIT_FINANCIAL`.

### Service availability
- [ ] `ServiceTerritoryAvailability` admin UI works; per-commodity rows.
- [ ] SA creation in `UNAVAILABLE` zone is rejected with clear error.
- [ ] `BY_REQUEST` status creates SA in `PENDING` with auto-Task per doc 13.
- [ ] Override endpoint requires `service-agreements.override_availability` permission + dual approval; audit row of class `AUDIT_SECURITY`.
- [ ] Reporting widget surfaces active SAs in `UNAVAILABLE` zones.

### GIS override
- [ ] `gis.override_attributes` permission distinct from `premise.write`.
- [ ] `POST /premises/<id>/gis-override` requires the new permission + reason text.
- [ ] Generic PATCH rejects GIS field edits with 422 + override-endpoint guidance.
- [ ] Dual approval per `tenant_config.gis_override_dual_approval_thresholds`; threshold-based for amount-sensitive fields.
- [ ] Override emits `AUDIT_SECURITY` audit row with field-level diff.
- [ ] `gisSyncStatus = MANUAL_OVERRIDE` blocks subsequent GIS sync from updating the field.
- [ ] Override release returns the parcel to `STALE` status; sync resumes on next tick.
- [ ] "Manual Overrides" admin page lists all current overrides.

### Non-functional
- [ ] `responsible_account_at` ≤50ms p99 (NFR-EFF-001).
- [ ] `selectDefaultRateSchedule` ≤30ms p99 (NFR-EFF-002).
- [ ] All audit emission in-transaction with mutation (NFR-EFF-006).

---

## 9. References

- **Internal**:
  - [01-audit-and-tamper-evidence.md](./01-audit-and-tamper-evidence.md) — `event_class = AUDIT_SECURITY` for GIS overrides; append-only enforcement
  - [13-workflow-approvals-action-queue.md](./13-workflow-approvals-action-queue.md) — `pending_administrative_change` for dual approval; Tasks for territory drift and BY_REQUEST availability; org chart for permission delegation
  - [14-special-assessments.md](./14-special-assessments.md) — GIS sync infrastructure (FR-SA-040..045) reused; this doc generalizes FR-SA-045 manual-override pattern across all GIS-sourced fields
  - [docs/specs/02-premise-management.md](../specs/02-premise-management.md) — `Premise.serviceTerritoryId` placeholder; backfill migration
  - [docs/specs/07-rate-management.md](../specs/07-rate-management.md) — `RateSchedule` versioning pattern reused for `ServiceTerritoryRate`
  - `packages/shared/prisma/schema.prisma:358-396` — `ServiceAgreement` model (extended with exclusion constraint)
  - `packages/shared/prisma/schema.prisma:399-415` — `ServiceAgreementMeter` model (extended with exclusion constraint)
  - `packages/api/src/services/service-agreement.service.ts` — refactored to use the new lifecycle helper
  - `packages/api/src/services/workflows.service.ts` — `transferService` is the canonical pattern

- **External**:
  - PostgreSQL `btree_gist` extension — required for the exclusion-constraint pattern
  - PostgreSQL `tstzrange` type and `EXCLUDE USING gist` — overlap-prevention primitive
  - ESRI ArcGIS REST API — territory membership sync (extends doc 14's sync worker)
  - GAAP / municipal accounting practices — drive "rate change applies to new SAs only" rule (FR-EFF-043)

---

**End of doc 15.**
