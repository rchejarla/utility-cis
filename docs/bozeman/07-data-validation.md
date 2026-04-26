# 07 — Data Validation & Quality Controls

**RFP commitment owner:** SaaSLogic Utilities — split between `packages/shared/src/validators/` (field-level + cross-field), `packages/api/src/services/*` (entity-level + integration-time), and `packages/web/components/` (real-time UX surfacing).
**Status:** Drafted — partial implementation. Field-level validation via Zod is strong; cross-field is ad-hoc and inconsistent; entity-level rules are scattered across services without a catalog; integration-time validation exists for meter reads but not for other ingest paths and has gaps even there. Real-time error surfacing reaches the API layer correctly but UX wording is generic.
**Effort estimate:** M (~3-5 weeks engineering — most of the work is cataloging + filling gaps, not building from scratch). The largest cost is the **entity-rules catalog** (rules don't exist as data; they live as scattered service-layer code) and the **error-message library** (replacing generic Zod messages with actionable text).

---

## 1. RFP commitment (verbatim)

> Field-level validation (data type, format, range, required, regex), cross-field validation (start-date before end-date, dependent picklists), entity-level rules (a premise must have at least one customer), and integration-time validation (incoming meter reads validated against premise eligibility and prior reads). Validation errors are surfaced to the user in real time with actionable messages.

The commitment is structured into **four validation tiers** plus a **UX requirement**:

1. **Tier 1 — Field-level**: data type, format, range, required, regex
2. **Tier 2 — Cross-field**: rules involving multiple fields on the same form (start-date < end-date, dependent picklists)
3. **Tier 3 — Entity-level**: rules involving multiple entities or aggregate state (a premise must have at least one customer)
4. **Tier 4 — Integration-time**: validation applied to data coming in via imports / external integrations
5. **Tier 5 (UX)**: real-time surfacing with **actionable** messages

---

## 2. Current state — what exists today

### 2.1 Tier 1 — Field-level validation

**Strong.** Every entity has a Zod validator file in `packages/shared/src/validators/` (32 files), used by both API and web. Coverage:

| Capability | Today |
|---|---|
| Data type (string, number, boolean, date, UUID, etc.) | ✓ Zod's primitive types |
| Format (email, URL, phone, UUID, IP, ISO datetime, regex) | ✓ Zod's built-in helpers + custom regex per validator |
| Range (numeric `min/max`, string `min/max` length, date bounds) | ✓ Zod chain — `.min()`, `.max()`, `.regex()`, `.length()` |
| Required vs optional | ✓ `.optional()` / required-by-default |
| Regex constraints | ✓ `.regex()` with explicit messages |
| Enum membership | ✓ `z.enum()` |
| Custom-field validation (defined per tenant) | ⚠️ Required + type + enum-membership only — see [06-custom-fields.md FR-CF-030](./06-custom-fields.md) for full validation-rule extension |

The validator file pattern is the source of truth — both API (Fastify routes) and Web (form components) import from `@utility-cis/shared`, so client and server agree on the rules.

### 2.2 Tier 2 — Cross-field validation

**Partial.** `.refine()` and `.superRefine()` are used in 7 of 32 validator files (`automation-config`, `customer`, `meter-read`, `rate-schedule`, `role`, `service-request`, `workflows`). Examples:

- `customer.ts`: `customerType === "INDIVIDUAL"` requires firstName + lastName; `customerType === "ORGANIZATION"` requires organizationName.
- `automation-config.ts`: HH:mm regex on quiet hours; IANA tz validated via `@vvo/tzdb` at the service layer.
- `service-request.ts`: status transitions enforced via `isValidTransition()`.

**Gaps:**

- **No "start-date before end-date" rule consistently.** ServiceAgreement, ServiceSuspension, RateSchedule, BillingCycle, PaymentPlan, Adjustment all have date-range fields. Some validate; some don't.
- **No "dependent picklist" pattern.** Custom fields don't support visibility-conditioned options today (covered separately in [06-custom-fields.md FR-CF-040](./06-custom-fields.md)). Built-in entity fields don't have dependent dropdowns either (e.g., "agreement billing cycle" picklist doesn't filter by the agreement's account's tenant in the UI).
- **Inconsistent placement.** Some cross-field rules live in the Zod validator (`.refine()`), others in the service layer ad hoc. No catalog or single source of truth for "what cross-field rules apply to entity X."

### 2.3 Tier 3 — Entity-level validation

**Limited.** What exists:

- **Foreign keys.** Prisma + Postgres FK constraints prevent dangling references (e.g., a ServiceAgreement can't reference a non-existent Account).
- **Some service-layer rules.** `createSuspension` checks for overlapping holds before insert; `evaluateAll` (delinquency) skips protected accounts before SHUT_OFF. These live in service code with no central listing.
- **Status-machine rules.** `service-request.service.ts` enforces a state machine via `isValidTransition()`.

**Gaps:**

- **The RFP-cited example fails today.** `Premise.ownerId` is nullable in the schema (`packages/shared/prisma/schema.prisma:257`). A Premise can exist with NO customer attached. The RFP claim says "a premise must have at least one customer" — currently NOT enforced.
- **No catalog of entity-level rules.** There's no `EntityRule` registry where business rules are declared and then enforced uniformly.
- **No validation on aggregate state.** Examples that would matter:
  - "An account in DELINQUENT status must have at least one open delinquency action" — not enforced
  - "A meter on an active agreement cannot be marked REMOVED until the agreement is terminated" — not enforced
  - "A customer with active service agreements cannot be hard-deleted" — partially enforced via FK ON DELETE behavior, but not surfaced as a validation error
- **Multi-tenant rule enforcement.** RLS handles row-level isolation but doesn't catch entity-rule violations (e.g., assigning a meter to a premise from a different tenant — the FK already prevents this, but if it ever didn't, no business-rule-level guard exists).

### 2.4 Tier 4 — Integration-time validation

**Partial.** What exists:

- **Meter-read ingestion** (`meter-read.service.ts`) detects:
  - `ROLLOVER` — current reading less than prior, plausibly due to dial wrap
  - `METER_DEFECT` — current reading way below prior, no rollover plausibility
  - `REVERSE_FLOW` — negative consumption that doesn't fit rollover
  - Each flagged read writes an `exceptionCode` and a CSR can resolve via `/meter-reads/exceptions`.
- **ImportBatch entity** exists in the schema (`prisma/schema.prisma:Import_batch`) with fields for `recordCount`, `status` (likely IN_PROGRESS / COMPLETED / FAILED). Backbone for validated bulk imports — not yet wired to all entry paths.

**Gaps:**

- **The RFP-cited example fails partly.** "Incoming meter reads validated against premise eligibility" is NOT enforced. The current meter-read ingestion checks the meter exists but doesn't verify the meter is currently associated with an active agreement at the expected premise. A read can land for a meter that was removed, suspended, or transferred.
- **No standard integration-time validation pipeline.** Meter-read import has its own pattern; bill imports, payment imports, service-event imports each have (or would have) bespoke validation.
- **No "validation report" output for failed imports.** When an import partially fails today, the failures land as exception-flagged rows. There's no "import summary" UI showing "ingested 1000 / 990 valid / 10 rejected with reasons."
- **No external-system pre-validation API.** Integrations cannot dry-run a payload to discover validation errors before commit — every integration commits and then gets exception-flagged rows.

### 2.5 Tier 5 — Real-time error surfacing

**Partial.** What exists:

- **API errors.** Zod errors return HTTP 400 with structured `details: [{ field, message }]` arrays. The API contract is solid.
- **Web form rendering.** Most forms catch the API error and render messages below the corresponding field. Pattern is consistent across the entity create/edit forms.

**Gaps:**

- **Generic Zod messages.** Default Zod errors say things like `"Invalid"` or `"String must contain at least 1 character(s)"`. Not user-friendly, not actionable. Examples of what should appear instead:
  - "Account number must be 8 digits, like `12345678`."
  - "Phone number must be 10 digits or include a country code (`+1` for US)."
  - "Start date must be before End date."
- **No client-side debounced validation.** Forms validate on blur or submit. Real-time as-you-type validation (e.g., highlighting an invalid email at the moment you stop typing) isn't consistently implemented.
- **No error catalog.** Each error message lives inline in its `.refine()` call or Zod chain. Hard to audit; hard to localize.

### 2.6 Per-RFP-phrase scoring

| RFP claim phrase | Current |
|---|---|
| Field-level validation: data type | ✓ |
| Field-level: format | ✓ |
| Field-level: range | ✓ |
| Field-level: required | ✓ |
| Field-level: regex | ✓ |
| Cross-field: start-date before end-date | ⚠️ Inconsistent — some entities check, some don't |
| Cross-field: dependent picklists | ⚠️ Conditional visibility on custom fields covered in doc 06; built-in fields don't have it |
| **Entity-level: a premise must have at least one customer** | ✗ `Premise.ownerId` is nullable today |
| **Integration-time: meter reads vs premise eligibility** | ✗ Currently checks prior read only; no premise-eligibility check |
| Integration-time: meter reads vs prior reads | ✓ Rollover/defect/reverse-flow detection works |
| Real-time surfacing | ⚠️ Submit-time only on most forms; blur-time on a few |
| Actionable messages | ⚠️ Generic Zod messages dominate; per-field actionable text inconsistent |

---

## 3. Gap matrix

| Tier | Capability | Gap size |
|---|---|---|
| 1 | Field-level | None |
| 2 | start-date < end-date catalog | Small — apply uniformly to ServiceAgreement, ServiceSuspension, RateSchedule, BillingCycle, PaymentPlan, Adjustment |
| 2 | Dependent picklists (built-in fields) | Small — UI pattern + a few entities |
| 3 | "Premise must have at least one customer" | Medium — schema change + service-rule + migration of orphan rows |
| 3 | Entity-rule catalog | Medium — declarative registry + enforcement layer |
| 3 | Aggregate-state rules | Medium — depends on rule count |
| 4 | Premise eligibility on meter-read import | Small — one new check in `meter-read.service.ts` |
| 4 | Standard integration-validation pipeline | Medium — pattern + library; per-integration plug-ins |
| 4 | Validation-report output for imports | Small — extends ImportBatch + UI |
| 4 | Pre-validation (dry-run) endpoint | Small — `POST /api/v1/<entity>/validate` |
| 5 | Actionable error messages | Medium — replace ~200 generic strings with per-field guidance |
| 5 | Real-time as-you-type validation | Small — debounced validation pass on relevant fields |
| 5 | Error catalog / single source of truth | Small — extract into a constants file |

---

## 4. Functional requirements

### 4.1 Tier 1 — Field-level validation

Field-level validation is essentially complete. The remaining requirement is that it stays consistent as new fields and entities are added.

- **FR-VAL-001** — Every entity create / update endpoint MUST validate input through a Zod schema in `packages/shared/src/validators/`. Inline `request.body` access without Zod parsing is a code-review reject.
  - **Acceptance:** Code-review checklist + CI grep for `request.body` vs `parse(request.body)`. Zero new violations per PR.

- **FR-VAL-002** — Custom fields MUST validate per the type + validation rules defined in [06-custom-fields.md FR-CF-030](./06-custom-fields.md). Field-level Zod validation extends to the dynamically-built schemas from `buildZodFromFields`.
  - **Acceptance:** Already required by doc 06; this is a cross-reference.

- **FR-VAL-003** — Format validators (email, phone, UUID, ISO date, postal code, etc.) MUST live in a shared `packages/shared/src/validators/formats.ts` file as named regexes + Zod schemas. Per-entity validators reference these by name rather than inlining the regex. This makes auditing the format catalog trivial.
  - **Acceptance:** All format regexes pull from the shared file. CI grep rejects inline `/^[a-z]+@/` patterns in entity validators.

### 4.2 Tier 2 — Cross-field validation

- **FR-VAL-010** — Date-range entities (ServiceAgreement, ServiceSuspension, RateSchedule, BillingCycle, PaymentPlan, Adjustment, MeterRead range queries, Bill range, etc.) MUST enforce `startDate <= endDate` at the validator layer via `.refine()`. Where `endDate` is nullable, the rule applies only when both are set.
  - **Implementation:** A reusable refinement `dateRangeOrdered<T>(startKey, endKey)` exported from `validators/refinements.ts`. Every applicable entity's validator imports + applies it.
  - **Acceptance:** Each entity create/update test asserts the rule. End-to-end forms surface the error in real time.

- **FR-VAL-011** — Conditional-required rules: when a field's required-ness depends on the value of another field (e.g., Customer `firstName` + `lastName` required when `customerType = INDIVIDUAL`), MUST be expressed via `.refine()` with a single descriptive message that names BOTH relevant fields. Done already on Customer; pattern formalized.
  - **Acceptance:** Per-pattern code review checklist.

- **FR-VAL-012** — Dependent picklists (cascading dropdowns) for built-in entity fields. Examples:
  - When the user picks an Account, the "Service Agreement" dropdown filters to that account's agreements.
  - When the user picks a Premise on START_SERVICE, the "Commodity" dropdown filters to commodities served at that premise.
  - **Implementation:** Web-side: `<EntitySelect>` already takes a `filterBy` prop in places; standardize the pattern. Server-side: list endpoints accept the filter as a query param, and validation checks the chosen child belongs to the chosen parent.
  - **Acceptance:** Two flagship cases covered (account → agreement, premise → commodity); pattern reusable for new dependencies.

- **FR-VAL-013** — Numeric cross-field rules: when one value depends on another (e.g., AutoPay `triggerDaysBeforeDue` ≤ billing cycle's `dueDateOffset`), the validator MUST express the rule via `.superRefine()` with a clear message. Catalogued centrally.

### 4.3 Tier 3 — Entity-level validation

This is where the largest gap lives. The current state has scattered rules in service code; the RFP claim implies a structured, complete coverage.

- **FR-VAL-020** — A new `entity-rules` registry MUST exist. A rule is a TypeScript-defined predicate with metadata:
  ```typescript
  interface EntityRule<TEntity, TContext = unknown> {
    id: string;                                       // stable identifier (e.g., "premise.must_have_owner")
    entity: string;                                   // "Premise" | "Account" | ...
    description: string;                              // human-readable
    severity: "ERROR" | "WARNING";                   // ERROR blocks; WARNING allows but flags
    when: "BEFORE_INSERT" | "BEFORE_UPDATE" | "BEFORE_DELETE" | "PERIODIC";
    check: (entity: TEntity, ctx: TContext) => Promise<RuleResult>;
  }
  ```
  - The registry sits in `packages/api/src/rules/` with one file per entity. Each entity-service hook calls `runRules("Premise", entity, "BEFORE_INSERT", ctx)` before persisting, getting back a list of violations.
  - **Why a registry vs scattered code:** Auditability. The RFP commitment of "entity-level rules" implies the customer can ask "what rules govern Account creation?" and get a documented answer. A registry produces that documentation as a side-effect of the code.

- **FR-VAL-021** — Premise-must-have-customer rule (RFP-cited example):
  - `Premise.ownerId` MUST become NOT NULL via a schema migration. Existing rows with NULL `ownerId` MUST be backfilled (or rejected as data-quality issues during the migration design).
  - A `EntityRule` on Premise asserts `ownerId !== null && customer.exists(ownerId)`.
  - On DELETE: deleting a Customer with owned Premises MUST be blocked (or those premises must be reassigned/closed first).
  - **Acceptance:** Attempt to create a Premise without ownerId → fails with the documented message. Attempt to delete a Customer with owned Premises → fails with a list of blocking premises.

- **FR-VAL-022** — Other RFP-implicit entity rules (the "etc." behind "entity-level rules"):
  - **Account must have a Customer.** `Account.customerId` is NOT NULL today. Verify + add an EntityRule check.
  - **ServiceAgreement must have an Account, Premise, Commodity, RateSchedule, BillingCycle.** All NOT NULL today. Confirm.
  - **A meter on an active agreement cannot be REMOVED.** New rule.
  - **A customer with active accounts cannot be hard-deleted.** New rule (already partially via FK ON DELETE Restrict, but not surfaced as a validation message — the user gets a Prisma error).
  - **An adjustment cannot exceed the open balance on the target account.** Blocked on Module 10 build.
  - Others discovered during design phase.

- **FR-VAL-023** — Rule severity:
  - `ERROR` rules block the operation with a 400 response and field-level messages.
  - `WARNING` rules allow the operation but record a flag and surface a yellow banner ("This account is delinquent — proceed?"). Used for soft-policy rules where strict enforcement is wrong (e.g., a CSR may need to override a credit check).
  - **Override mechanism:** WARNING-with-override rules require the user to confirm with a reason captured in the audit log.

- **FR-VAL-024** — Periodic rules (PERIODIC `when`): a daily worker runs all PERIODIC rules across the tenant and reports violations as a "Data quality" dashboard alert. Examples:
  - Premises with `commodityIds` that include a commodity no longer offered by the tenant
  - Service agreements with `startDate` in the future + `status: ACTIVE` (should be PENDING)
  - Open invoices older than the tenant's bill-cycle period (likely missed-billing flag)
  - **Implementation:** New `data-quality-sweep` BullMQ queue; daily cron; results land in a `data_quality_violation` table; `/data-quality` admin page shows them.

- **FR-VAL-025** — Rule documentation: every rule's `description` field MUST be human-readable. A new admin page `/settings/data-rules` lists all registered rules per entity, severity, when fires, and link to the source code (or a doc URL). This makes the City's auditors happy.

### 4.4 Tier 4 — Integration-time validation

- **FR-VAL-030** — Meter-read premise-eligibility rule (RFP-cited example):
  - On meter-read ingest, the service MUST verify:
    1. The meter exists in the tenant.
    2. The meter is currently associated with at least one ACTIVE service agreement (via `service_agreement_meter`).
    3. The agreement's premise matches the optional `premiseId` field on the read input (if supplied).
    4. The agreement is in `ACTIVE` (or recently transitioned from ACTIVE within a tolerance window for end-of-cycle reads).
  - **Failure mode:** Read still ingests but lands with `exceptionCode = "INELIGIBLE_PREMISE"` for CSR review. Hard rejection would block legitimate reads during agreement transitions.
  - **Acceptance:** Test cases for: meter on an inactive agreement; meter not associated with any agreement; premise ID mismatch.

- **FR-VAL-031** — Integration-time validation pipeline. Every bulk-import endpoint (`/api/v1/<entity>/import`, `POST .../meter-reads/batch`, etc.) MUST follow a consistent pattern:
  1. Create an `ImportBatch` row with `status = VALIDATING`.
  2. Validate every record against Tier 1, 2, 3 rules (rules execute in dry-run mode — `BEFORE_INSERT` checks fire but writes don't commit).
  3. Records that pass: insert with `importBatchId` reference.
  4. Records that fail: write to a `import_batch_error` table with the source row + error codes + messages.
  5. Update batch `status = COMPLETED` (with partial-success allowed) or `FAILED` (if all records failed) and `validatedRecordCount`, `insertedRecordCount`, `errorRecordCount`.
  - **Acceptance:** A bulk import of 1000 reads with 10 invalid → batch shows 990 inserted, 10 in `import_batch_error`, batch status `COMPLETED_WITH_ERRORS`.

- **FR-VAL-032** — Pre-validation (dry-run) endpoint: `POST /api/v1/<entity>/validate` accepts a payload, runs all field-level + cross-field + entity-level checks, returns `{ valid: boolean, errors: [...] }` without touching the DB.
  - **Use case:** External integrations want to know if their payload is valid before committing. Particularly useful for SaaSLogic Billing's bill-import integration; it can pre-check a batch of bills before sending the real import.
  - **Acceptance:** Dry-run with valid payload returns `{ valid: true }`; dry-run with invalid payload returns identical errors to a real attempt.

- **FR-VAL-033** — Import-validation reporting: a `/imports` admin page lists recent ImportBatch rows with status, counts, and a drill-down into errors. CSV download of the error list for review and re-submit.
  - **Acceptance:** Run an import; navigate to /imports; see the batch + errors; download CSV.

- **FR-VAL-034** — Validation severity in imports: same as entity-level (FR-VAL-023). WARNING violations don't block ingestion. ERROR violations send the row to the error table. Operators can configure per-rule per-import-source whether a rule is ERROR or WARNING (e.g., "rollover" might be a WARNING that ingests with the exception flag, not an ERROR that rejects).

### 4.5 Tier 5 — Real-time error surfacing with actionable messages

- **FR-VAL-040** — Error-message catalog: every Zod validator + every entity rule MUST have an explicit, actionable message. No bare `"Invalid"` or `"Required"`. Examples:
  - **Bad:** "Required"
  - **Good:** "Account number is required. Format: 8 digits."
  - **Bad:** "Invalid"
  - **Good:** "Phone number must be 10 digits or include a country code, e.g. +1 555-0100."
  - **Bad:** "Number too small"
  - **Good:** "Days past due must be 0 or greater."
  - **Implementation:** Every Zod validator declares `{ message: "..." }` on every constraint. CI grep rejects validators without explicit messages.
  - **Catalog:** Messages live alongside the validator. The library `validators/messages.ts` exports per-format default messages used by the shared format helpers (FR-VAL-003).
  - **Acceptance:** axe-core-style automated audit asserts every form field has a non-default error message.

- **FR-VAL-041** — Real-time as-you-type validation: forms MUST validate fields on blur AND on debounced input (300ms after typing stops). Errors render inline below the field with the actionable message. Server-side errors on submit also render inline.
  - **Implementation:** A `<ValidatedField>` wrapper that takes a Zod schema slice and runs it on blur + debounced input. Replaces the current `<input>` ad-hoc pattern.
  - **Acceptance:** Type an invalid email; pause; see the error appear without submitting. Fix the email; see the error clear.

- **FR-VAL-042** — Multi-error display: when a single field has multiple violations (e.g., "must be 10 digits" AND "must contain only digits"), the form renders all messages, not just the first. Zod's flat-error structure makes this trivial; the UI must respect it.
  - **Acceptance:** Type "abc" into a phone field; see both "must be 10 digits" + "must contain only digits."

- **FR-VAL-043** — Cross-field error placement: errors that span multiple fields (e.g., "start-date before end-date") render BELOW the second field by default, with a link "[i] Affects start-date and end-date." The user understands which fields to fix.
  - **Acceptance:** Test on the SR create form's date range and the suspension date range.

- **FR-VAL-044** — Entity-level error display: when an entity-level rule fires (e.g., "this account is delinquent" on a payment-plan creation), the error renders in a top-of-form banner with the rule description + a CTA "Resolve delinquency first" linking to the relevant page.
  - **Acceptance:** Trigger a rule; verify the banner; verify the CTA navigates correctly.

- **FR-VAL-045** — Internationalization-ready: error messages are plain strings today (English-only). When i18n lands (out of scope for this RFP), the catalog is structured to make translation trivial — message keys + interpolation tokens.

### 4.6 Validation as documentation

- **FR-VAL-050** — A new `/settings/data-rules` admin page lists every active validation rule across all four tiers, organized by entity. Auditable export of the full rule list as CSV/PDF.
  - **Use case:** City compliance / audit team can request "show me every validation rule on Customer." The page is the answer.
  - **Acceptance:** Page renders the rule catalog (dynamic — never out of sync with code because rules ARE code).

---

## 5. Data + infrastructure changes

### 5.1 Schema changes

```prisma
// FR-VAL-021 — Premise.ownerId becomes NOT NULL
model Premise {
  // ... existing fields ...
  ownerId  String  @map("owner_id") @db.Uuid  // was: String? — NOT NULL now
  owner    Customer @relation("PremiseOwner", fields: [ownerId], references: [id], onDelete: Restrict)
}
// Migration: backfill existing NULL ownerId rows; either assign to a placeholder
// "ORPHAN" customer per tenant (with a flag for cleanup), or block migration
// until the operator manually addresses orphans.

// FR-VAL-024 — Periodic data-quality findings
model DataQualityViolation {
  id            String   @id @default(uuid()) @db.Uuid
  utilityId     String   @map("utility_id") @db.Uuid
  ruleId        String   @map("rule_id") @db.VarChar(100)
  entityType    String   @map("entity_type") @db.VarChar(50)
  entityId      String   @map("entity_id") @db.Uuid
  severity      String   @db.VarChar(10)   // ERROR | WARNING
  message       String   @db.Text
  detectedAt    DateTime @default(now()) @map("detected_at") @db.Timestamptz
  resolvedAt    DateTime? @map("resolved_at") @db.Timestamptz
  resolvedBy    String?  @map("resolved_by") @db.Uuid
  resolutionNotes String? @map("resolution_notes") @db.Text

  @@unique([utilityId, ruleId, entityType, entityId])  // dedupes re-detection
  @@index([utilityId, severity, detectedAt])
  @@index([utilityId, entityType, entityId])
  @@map("data_quality_violation")
}

// FR-VAL-031 — Import-batch error rows
model ImportBatchError {
  id            String   @id @default(uuid()) @db.Uuid
  utilityId     String   @map("utility_id") @db.Uuid
  importBatchId String   @map("import_batch_id") @db.Uuid
  rowNumber     Int      @map("row_number")
  rawRecord     Json     @map("raw_record")  // original input row
  errorCode     String   @map("error_code") @db.VarChar(50)
  errorMessage  String   @map("error_message") @db.Text
  severity      String   @db.VarChar(10)   // ERROR | WARNING
  createdAt     DateTime @default(now()) @map("created_at") @db.Timestamptz

  importBatch ImportBatch @relation(fields: [importBatchId], references: [id], onDelete: Cascade)

  @@index([utilityId, importBatchId])
  @@map("import_batch_error")
}
```

### 5.2 Code changes

- New `packages/shared/src/validators/refinements.ts` — reusable cross-field refinements (`dateRangeOrdered`, `conditionalRequired`, etc.)
- New `packages/shared/src/validators/formats.ts` — shared format regexes + Zod schemas
- New `packages/shared/src/validators/messages.ts` — per-format default error messages
- New `packages/api/src/rules/` — entity-rule registry, one file per entity
- New `packages/api/src/rules/runner.ts` — `runRules(entity, instance, when, ctx)` helper
- New `packages/api/src/integrations/import-pipeline.ts` — generic bulk-import validator
- New `packages/web/components/validated-field.tsx` — `<ValidatedField>` wrapper for as-you-type validation
- New `packages/web/app/settings/data-rules/page.tsx` — rule documentation page
- New `packages/web/app/imports/page.tsx` — import-batch dashboard
- New `packages/web/app/data-quality/page.tsx` — periodic violations dashboard

### 5.3 New BullMQ queue

- `data-quality-sweep` — daily cron that runs all `when: PERIODIC` rules and persists violations. Reuses the BullMQ infrastructure from the scheduler-migration plan.

### 5.4 New API endpoints

| Method | Route | Purpose |
|---|---|---|
| POST | `/api/v1/<entity>/validate` | Dry-run validation (FR-VAL-032) |
| GET | `/api/v1/<entity>/import-batches` | List import batches |
| GET | `/api/v1/<entity>/import-batches/:id` | Batch detail + counts |
| GET | `/api/v1/<entity>/import-batches/:id/errors` | Error list with row data |
| GET | `/api/v1/data-quality/violations` | Open violations (for /data-quality dashboard) |
| POST | `/api/v1/data-quality/violations/:id/resolve` | Mark a violation resolved |
| GET | `/api/v1/settings/data-rules` | Rule catalog (FR-VAL-050) |

---

## 6. Implementation sequence

The sequence runs from highest-coverage-cheapest to most-expensive. Each step is independently shippable.

1. **Tier 1 polish.** Centralize formats, audit messages, fill any missing actionable text. Effort: S (~2-3 days).
2. **Tier 2 — date-range refinement.** `dateRangeOrdered` helper + apply to 6+ entities. Effort: S (~1-2 days).
3. **Tier 2 — dependent picklists.** Standardize `<EntitySelect filterBy={...}>` pattern + apply to 2 flagship cases. Effort: S (~2 days).
4. **Tier 5 — error-message catalog + actionable text.** Replace ~200 generic messages with per-field guidance. Mostly mechanical; large surface. Effort: M (~3-4 days).
5. **Tier 5 — `<ValidatedField>` + as-you-type validation.** Effort: M (~3 days).
6. **Tier 3 — Premise-must-have-customer.** Schema migration (with orphan handling) + EntityRule + delete-block. Effort: M (~3-4 days, plus migration design).
7. **Tier 3 — entity-rules registry + runner.** Catalog scaffolding + a few documented rules. Effort: M (~3-4 days).
8. **Tier 3 — fill the entity-rule catalog.** Per-entity audit + rule-writing pass. Effort: M (~5-7 days for ~15-20 rules).
9. **Tier 4 — meter-read premise eligibility.** New check in `meter-read.service.ts` with INELIGIBLE_PREMISE exception code. Effort: S (~1-2 days).
10. **Tier 4 — generic import pipeline.** Reusable validator + ImportBatchError table + endpoints + /imports UI. Effort: L (~5-7 days).
11. **Tier 4 — pre-validation endpoint per entity.** Effort: S (~1-2 days; mostly composition over existing validators).
12. **Tier 3 — periodic data-quality sweep.** New BullMQ queue + DataQualityViolation entity + dashboard. Effort: M (~4-5 days).
13. **Tier 3 — rule-documentation page.** Read the registry, render. Effort: S (~1-2 days).

**Pre-signature scope recommendation:** Items 1, 2, 3, 4, 5, 6, 9, 11. Demonstrates field + cross-field + UX surfacing + the RFP-cited Premise + meter-read examples + dry-run endpoint. ~3 weeks one engineer.

**Phase 1 SOW deliverables:** Items 7, 8, 10, 12, 13 — the entity-rules registry + import pipeline + periodic sweep + rule documentation. ~3-4 additional weeks.

**Total effort: ~5-7 weeks.**

---

## 7. Out of scope for this RFP

- **Custom rule authoring through the Settings UI.** Rules live in TypeScript code, not in a no-code rule engine. Defining new rules requires engineering. Tenant admins configure existing rules' severity (ERROR vs WARNING) but don't write new ones.
- **Workflow-engine-style multi-step validation.** No "run rule A, if passes, run rule B with side effect, then rule C" composition language. Each rule is independent.
- **Machine-learning anomaly detection.** Statistical flagging of "this looks unusual" beyond explicit rules is not promised (e.g., we won't flag a customer whose consumption pattern is statistically odd unless an explicit rule exists).
- **Real-time cross-tenant rules.** Rules operate within a single tenant's scope (RLS-bounded).
- **External rule engines** (Drools, Rules Engine API, etc.) — we use TypeScript predicates, not a third-party engine.
- **Validation of historical data.** New rules apply going forward + via the periodic sweep (FR-VAL-024). Bulk re-validation of years of historical data is operator-initiated; not promised as a default behavior on every rule change.
- **Bypass mechanism for system admins to disable rules.** Rules can be set to WARNING (with override) but cannot be globally disabled — that would be a compliance disaster.
- **Cross-entity rules across tenants** (e.g., "deduplicate customers across utilities") — out of scope.
- **Rule versioning / history** — when a rule's predicate changes in code, all subsequent evaluations use the new logic. No "this row was created under rule v2" attribution.
- **A/B testing of rule changes** — rule changes apply uniformly per release.
- **Data lineage tracking** — when a rule modifies data via an automated correction, we audit-log the change but don't track the lineage chain (e.g., "this value was originally X, was corrected to Y by rule Z").
- **Rule simulation / what-if analysis** — no UI to test "if I changed this rule, how many rows would now violate?"

---

## 8. Risks

| Risk | Mitigation |
|---|---|
| Backfilling NULL `Premise.ownerId` requires customer assignment for every orphan row | Migration creates a per-tenant `system_orphan_customer` row + assigns orphans to it. Operators run a one-time cleanup pass to reassign properly. |
| Real-time validation noise (lots of red ink as the user types) | Debounce 300ms on input; only show errors on blur AND debounce. Field starts in neutral state. |
| Generic error messages ship in the future because the CI check has gaps | CI grep tests run on every PR; reviewer checklist includes "new validators have explicit messages." |
| Periodic rules generate too many violations on a tenant's first run | Initial run logs but doesn't notify; tenant admin reviews + dismisses or fixes; subsequent runs only notify on new violations. |
| Entity-rule registry becomes a dumping ground for one-off business rules | Rule additions go through code review; rules with single-tenant applicability get tenant-scoped configuration rather than a new registry entry. |
| Pre-validation endpoint becomes an information-leak vector (an attacker probes for valid IDs by submitting payloads) | Pre-validate inputs receive the same RBAC + tenant-scoping as real writes; an attacker without permission can't even hit the endpoint. |
| Import pipeline performance on large files (100k+ rows) | Validation runs in batches of 1000; each batch wraps in a transaction; the overall import is a long-running job (BullMQ) with progress reported via the /imports UI. |
| Mocking + test data generation breaks due to stricter validation | Test fixtures need updates as rules tighten. Acceptable cost; documented as part of each rule-tightening PR. |
| WARNING-with-override flow creates audit-log spam | Document policy: overrides are intentional; auditors want them. The volume is the cost of the soft-policy approach. |
| Rule documentation page becomes stale | Page renders from code, not from a separate doc file. The act of code-reviewing a rule update is the doc update. |
| Data-quality dashboard becomes a "100 unresolved violations forever" pile | Add aging — violations older than 30 days surface in a high-priority list. Tenant admins are accountable for cleanup. |
| Multi-tenant rule scaling — periodic sweep across 100k tenants | Sweep runs per-tenant per-day, queued with priority similar to delinquency dispatcher (per scheduler-migration spec §3.3). |

---

## 9. Acceptance criteria summary

The Data Validation commitment is satisfied when ALL of the following pass:

**Tier 1 — Field-level**
- [ ] Every API endpoint validates input via Zod (FR-VAL-001).
- [ ] Custom-field validation rules from doc 06 are layered into the same Zod path (FR-VAL-002).
- [ ] Format regexes centralized in `validators/formats.ts` (FR-VAL-003).

**Tier 2 — Cross-field**
- [ ] `dateRangeOrdered` refinement applied uniformly to all date-range entities (FR-VAL-010).
- [ ] Conditional-required rules consistent across Customer + others (FR-VAL-011).
- [ ] Two flagship dependent-picklist patterns work end-to-end (FR-VAL-012).
- [ ] Cross-field numeric rules expressed via .superRefine() with clear messages (FR-VAL-013).

**Tier 3 — Entity-level**
- [ ] Entity-rule registry exists with at least 15-20 rules across all major entities (FR-VAL-020, FR-VAL-022).
- [ ] **Premise must have at least one customer** — schema NOT NULL + entity rule + delete-block (FR-VAL-021).
- [ ] Rule severity ERROR/WARNING enforced; WARNING rules support override with audit trail (FR-VAL-023).
- [ ] Daily data-quality sweep runs PERIODIC rules + persists violations + dashboard shows them (FR-VAL-024).
- [ ] Rule documentation page renders the live registry catalog (FR-VAL-025, FR-VAL-050).

**Tier 4 — Integration-time**
- [ ] **Meter-read premise eligibility** — new INELIGIBLE_PREMISE exception code on ingest (FR-VAL-030).
- [ ] Generic import pipeline used by all bulk endpoints (FR-VAL-031).
- [ ] Pre-validation `POST /<entity>/validate` returns dry-run errors without DB writes (FR-VAL-032).
- [ ] /imports admin page lists batches + errors + CSV download (FR-VAL-033).
- [ ] Per-rule per-import-source severity configurable (FR-VAL-034).

**Tier 5 — Real-time UX**
- [ ] Every Zod validator declares actionable error messages (FR-VAL-040).
- [ ] `<ValidatedField>` provides as-you-type validation on blur + 300ms debounce (FR-VAL-041).
- [ ] Multi-error fields display all violations, not just the first (FR-VAL-042).
- [ ] Cross-field errors render with field references (FR-VAL-043).
- [ ] Entity-level errors render as form-top banner with CTA (FR-VAL-044).

**Negative tests / non-commitments**
- [ ] No no-code rule editor (verifies §7).
- [ ] No ML anomaly detection (verifies §7).
- [ ] No global rule disable (verifies §7).

Sign-off: backend lead + frontend lead + data-quality / compliance lead + proposal owner.
