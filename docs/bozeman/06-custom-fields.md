# 06 — Custom Fields

**RFP commitment owner:** SaaSLogic Utilities (`packages/api/src/services/custom-field-schema.service.ts` + `packages/web/components/custom-fields/*` + `packages/web/app/settings/custom-fields/`)
**Status:** Drafted — **partial implementation, the most-built RFP capability so far.** Phases 1 + 2 of the existing module spec ([docs/specs/20-custom-fields.md](../specs/20-custom-fields.md)) are complete: 5 entity types, 5 data types, 10 display types, settings UI, deprecation flow, 60-second cache. The RFP claim adds three feature classes the current build doesn't cover: **richer field types** (currency, multi-select), **richer field behavior** (validation rules, conditional visibility, default values), and **reporting integration** (standard reports, ad-hoc query builder, API extracts).
**Effort estimate:** L (~4-6 weeks engineering, with reporting / query-builder being the dominant cost).

---

## 1. RFP commitment (verbatim)

> Custom fields can be added to all major entities (customer, premise, meter, account, service request, etc.) without development effort, through the Settings module. Custom fields support typed values (text, number, date, currency, picklist, multi-select), validation rules, conditional visibility, default values, and display ordering. Custom fields appear in standard reporting, in the ad-hoc query builder, and in API extracts — no separate reporting work is needed to surface them.

The commitment breaks into three blocks:

- **Block A — Entity + type coverage**: 5+ named entities (RFP names customer/premise/meter/account/service request explicitly, with "etc."), 6 explicitly-named field types (text, number, date, currency, picklist, multi-select).
- **Block B — Field behavior**: validation rules, conditional visibility, default values, display ordering.
- **Block C — Surfacing**: custom fields automatically appear in standard reporting, ad-hoc query builder, and API extracts — without per-field reporting work.

---

## 2. Current state — what exists today

This is the most-built capability in the RFP set. The existing module spec at [docs/specs/20-custom-fields.md](../specs/20-custom-fields.md) is the engineering-side reference; this section summarizes it from the RFP-coverage angle.

### 2.1 Architecture

- **Storage model**: per-tenant `CustomFieldSchema` row keyed by `(utilityId, entityType)`, holding a JSON array of `FieldDefinition`s. Per-entity `custom_fields` JSONB column on the entity table itself stores the values.
- **Validation**: `buildZodFromFields(definitions)` constructs a Zod schema dynamically; the entity service validates writes through it and rejects mismatched values with `CUSTOM_FIELDS_INVALID`.
- **Display**: `<CustomFieldsSection>` React component reads the schema from the API and dispatches on `displayType` to the right widget.
- **Cache**: 60-second TTL per tenant, lazy-populated, invalidated on schema writes. Single-instance cache; multi-replica deploy needs a Redis-backed cache (called out in module spec §195-198).

### 2.2 Entities supported

The existing schema supports custom fields on **5 entities**:

| Entity | Status | Storage column |
|---|---|---|
| Customer | ✓ Wired (Phase 1 pilot) | `customer.custom_fields` |
| Account | ✓ Wired (Phase 2) | `account.custom_fields` |
| Premise | ✓ Wired (Phase 2) | `premise.custom_fields` |
| ServiceAgreement | ✓ Wired (Phase 2) | `service_agreement.custom_fields` |
| Meter | ✓ Wired (Phase 2) | `meter.custom_fields` |
| **ServiceRequest** | ✗ **Not supported** — `service_request` table has no `custom_fields` column | — |
| Adjustment | ✗ Adjustment domain doesn't exist (Module 10 not built) | — |

### 2.3 Data types supported

Five data types, ten display widgets. Sourced from `packages/shared/src/lib/custom-fields.ts`:

```typescript
export const FIELD_TYPES = ["string", "number", "date", "boolean", "enum"] as const;
```

| Data type | Display types | RFP claim coverage |
|---|---|---|
| `string` | text, textarea, email, url, phone | ✓ "text" |
| `number` | number | ✓ "number" |
| `date` | date | ✓ "date" |
| `boolean` | checkbox | (not in RFP claim list) |
| `enum` | select, radio | ✓ "picklist" |
| **(missing)** | currency | ✗ **"currency" not a separate type** |
| **(missing)** | multi-select | ✗ **"multi-select" explicitly excluded in Phase 1** |
| **(missing)** | datetime | (not in RFP claim list; Phase 3 roadmap) |

### 2.4 Field behavior supported

| RFP-claimed behavior | Current state |
|---|---|
| **Validation rules** | ⚠️ Partial. Required + reserved-key + type-conformance + enum-option-membership are validated. **No regex, no min/max, no length, no custom rule expressions.** |
| **Conditional visibility** | ✗ Not implemented; not on the roadmap. |
| **Default values** | ✗ `FieldDefinition` does not include a `defaultValue` field. |
| **Display ordering** | ⚠️ Partial. The `order: number` field exists; admin types numbers manually. **No drag-and-drop UI.** Spec §265 calls drag-and-drop "fine for v1." |

### 2.5 Settings UI

- `/settings/custom-fields` — admin tab present, gated by `tenant_profile:EDIT`. Per-entity picker (5 pills), field list, Add Field form, Edit + Deprecate + Delete actions.
- Two-phase delete: data-safety gate refuses delete on rows with stored data (`CUSTOM_FIELD_HAS_DATA`); a "force" mode scrubs values then removes the field.
- 40 shared tests + 28 API service tests cover validators, reserved keys, displayType, deletion paths.

### 2.6 Reporting / query builder / API extracts

- **Reporting module**: ✗ Doesn't exist. No `/reports` route, no report-builder UI, no scheduled reports, no report-storage table.
- **Ad-hoc query builder**: ✗ Doesn't exist. Standard list pages have filter chips per-entity but no general query composer.
- **API extracts**: ⚠️ Partial. Standard `GET /api/v1/<entity>` endpoints DO return `customFields` automatically because the JSONB column is selected. CSV / Excel bulk export endpoints don't exist. The OpenAPI spec describes the `customFields` JSON property generically (no per-tenant schema reflection — auditors would see "any object" and wouldn't know which custom fields are defined).

### 2.7 Per-RFP-phrase scoring

| RFP claim phrase | Current |
|---|---|
| All major entities (customer, premise, meter, account, service request, etc.) | 5 / 6 — service request missing |
| Without development effort, through the Settings module | ✓ |
| text | ✓ |
| number | ✓ |
| date | ✓ |
| **currency** | ✗ |
| picklist | ✓ |
| **multi-select** | ✗ |
| validation rules | ⚠️ required/type only |
| **conditional visibility** | ✗ |
| **default values** | ✗ |
| display ordering | ⚠️ manual integers, no drag/drop |
| Custom fields appear in **standard reporting** | ✗ no reporting module |
| Custom fields appear in **ad-hoc query builder** | ✗ no query builder |
| Custom fields appear in **API extracts** | ⚠️ standard CRUD only |
| No separate reporting work needed | ✗ — reporting itself doesn't exist |

---

## 3. Gap matrix

| Capability | Current | Gap |
|---|---|---|
| Customer / Account / Premise / Meter / ServiceAgreement custom fields | ✓ | — |
| **ServiceRequest custom fields** | ✗ | Add column + enum + wire service |
| Adjustment custom fields | ✗ (entity doesn't exist) | Blocked on Module 10 build |
| text / number / date / picklist | ✓ | — |
| **currency type** | ✗ | New `currency` data type with formatted display + validator |
| **multi-select type** | ✗ | New `multiselect` data type — array-of-strings storage, `enumOptions`-driven |
| Required field validation | ✓ | — |
| **Min/max validation (numeric/date)** | ✗ | Add `minValue` + `maxValue` to FieldDefinition |
| **Length validation (string)** | ✗ | Add `minLength` + `maxLength` |
| **Regex validation (string)** | ✗ | Add `pattern` regex |
| **Conditional visibility** | ✗ | Add `visibleWhen` rule expression on FieldDefinition; web renderer evaluates |
| **Default values** | ✗ | Add `defaultValue` on FieldDefinition; create-form pre-populates |
| Display ordering (manual integer) | ✓ | — |
| **Drag-and-drop ordering UI** | ✗ | Sortable list in Settings UI |
| **Standard reporting** | ✗ no reports module | Build a basic reporting module that auto-includes custom fields |
| **Ad-hoc query builder** | ✗ no query builder | Build a query composer UI with filter+columns+grouping |
| **API extracts (CSV/Excel)** | ⚠️ JSON only, full-CRUD | Add bulk export endpoints per entity; include custom fields; auto-update OpenAPI |

---

## 4. Functional requirements

Grouped by the three RFP blocks: **A — entity/type coverage**, **B — field behavior**, **C — surfacing**.

### 4.1 Block A — Entity coverage

- **FR-CF-001** — `ATTACHMENT_ENTITY_TYPES` analog for custom fields MUST include `ServiceRequest`. Add `custom_fields JSONB DEFAULT '{}'` column to `service_request` table; wire `validateCustomFields` into the service-request create/update services with the existing merge semantics; integrate `<CustomFieldsSection>` into the SR create form + detail page (read mode + edit mode) following the pattern from [docs/specs/20-custom-fields.md](../specs/20-custom-fields.md) Phase 2.
  - **Acceptance:** Admin defines a `inspection_required` boolean field for ServiceRequest; SR create form shows the field; saving + reloading preserves the value.

- **FR-CF-002** — Adjustment custom fields are gated on Module 10's Adjustment entity build. Trivial follow-on once Adjustment exists; out of this doc's primary scope.

- **FR-CF-003** — Reserved-key list (`CORE_FIELD_KEYS`) MUST be extended for ServiceRequest. List is the current SR column names: `id`, `utility_id`, `request_number`, `request_type`, `status`, `priority`, `account_id`, `premise_id`, `service_agreement_id`, `description`, `sla_due_at`, `sla_breached`, `assigned_team`, `assigned_to_user_id`, `source`, `attachments`, `created_by`, `created_at`, `updated_at`, etc. Compile-time coverage check (existing roadmap item from spec Phase 3) MUST run for ServiceRequest from day one.

### 4.2 Block A — Currency type

- **FR-CF-010** — A new data type `currency` MUST be added to `FIELD_TYPES`. Storage shape: a number representing the value in the smallest currency unit (cents, when USD), so `$12.34` stores as `1234`. The schema `FieldDefinition` carries an additional `currencyCode` (default `USD`) for display.
  - **Validation:** Same numeric validation as `number` (min/max if defined), plus rejection of non-integer cent amounts to enforce the smallest-unit invariant.
  - **Display:** New `currency` display type — input formatted with locale-aware grouping (`$1,234.56`), parsed back to cents on submit. Detail-page view renders the formatted value with the currency symbol.
  - **Why a new data type vs `number` + display formatting:** locale + rounding semantics differ from generic number. A `temperatureC` number field should validate as a plain `number` (`98.6`). A `monthlyFee` currency field needs cent-level integer enforcement. Conflating them invites subtle rounding bugs.
  - **Acceptance:** Admin defines a `monthly_fee` currency field on Account; CSR enters `12.34`; storage shows `1234`; detail page renders `$12.34`.

### 4.3 Block A — Multi-select type

- **FR-CF-020** — A new data type `multiselect` MUST be added to `FIELD_TYPES`. Storage shape: array of strings. Each string MUST match one of `enumOptions[].value`.
  - **Display:** New `multiselect` display type — checkbox group (default) or multi-select dropdown for >5 options. Detail-page view renders selected option labels comma-separated.
  - **Validation:** Each array element must be a known option value. Duplicate values rejected. Required validation: array must be non-empty. Max selections: optional `maxSelections` constraint on the FieldDefinition.
  - **Acceptance:** Admin defines a `service_features` multiselect field with options `["solar", "ev_charger", "heat_pump"]`; CSR selects two; storage is an array; detail page renders both selected labels.

### 4.4 Block B — Validation rules

The existing implementation supports `required` + type conformance only. RFP-grade validation needs more:

- **FR-CF-030** — `FieldDefinition` MUST be extended with optional validation-rule fields:
  - For `number` / `currency`: `minValue` (number), `maxValue` (number)
  - For `string` / `text`-display: `minLength` (int), `maxLength` (int), `pattern` (regex string with safe-regex check)
  - For `date`: `minDate`, `maxDate` (ISO strings; supports relative tokens `now`, `today`, `now+30d`)
  - For `multiselect`: `maxSelections` (int)
  - For all types: `customErrorMessage` (string) overriding the default error
  - **Acceptance:** Each rule exercised by an integration test that asserts both happy-path and validation-failure cases.

- **FR-CF-031** — `pattern` regex MUST be passed through `safe-regex` (or equivalent ReDoS-prevention library) at admin save-time. Pathological regex (catastrophic backtracking) is rejected with `CUSTOM_FIELD_INVALID_PATTERN` before it ever reaches user input. Server-side validation imposes a 100ms hard timeout per regex match.
  - **Acceptance:** Try to save `(a+)+$` as a regex; admin save fails with the documented error.

- **FR-CF-032** — `buildZodFromFields` extends to layer the new constraints into the dynamic Zod schema:
  - `z.number().min(minValue).max(maxValue)` for number/currency
  - `z.string().min(minLength).max(maxLength).regex(new RegExp(pattern))` for string
  - Date min/max via custom refinement
  - `z.array(z.enum(...)).max(maxSelections)` for multiselect

- **FR-CF-033** — Web-side validation: the `<CustomFieldsSection>` renderer applies the same constraints client-side for fast feedback. Server validation is the source of truth — client validation is a UX layer.

### 4.5 Block B — Conditional visibility

- **FR-CF-040** — `FieldDefinition` MUST be extended with an optional `visibleWhen` rule expression that determines whether the field is rendered on forms/detail pages. The rule references **other custom fields on the same entity** (or core fields via the reserved-key list).
  - **Expression shape:** A small JSON DSL — not a free-form code execution path:
    ```json
    {
      "all": [
        { "field": "service_type", "op": "eq", "value": "commercial" },
        { "field": "monthly_volume", "op": "gte", "value": 10000 }
      ]
    }
    ```
  - Operators: `eq`, `ne`, `in`, `nin`, `gt`, `gte`, `lt`, `lte`, `truthy`, `falsy`. Combinators: `all`, `any`, `not`.
  - **Why a DSL not arbitrary code:** Stored expressions evaluate on every form render and on every save; arbitrary code is an attack surface. The DSL covers ~95% of real conditional-visibility needs.
  - **Acceptance:** Admin defines field `commercial_tier` with `visibleWhen: {all: [{field: "service_type", op: "eq", value: "commercial"}]}`. Form shows `commercial_tier` only after `service_type` is set to commercial.

- **FR-CF-041** — `visibleWhen` evaluation is **client-side** (UX feedback), but server validation **does not enforce** the visibility rule. A hidden-but-required field that has no value DOES NOT block save. This is intentional: visibility is a UX concern, not a data-integrity concern. If a tenant wants enforcement they make the dependent field non-required.
  - **Acceptance:** Save with a hidden required field empty; save succeeds. Reveal the field; save with the field empty; save fails.

- **FR-CF-042** — Settings UI: the field-form for create/edit MUST expose a visual rule builder for `visibleWhen`. Drop-down for field, operator, value. AND/OR group composition. Power users can switch to a JSON view for complex rules.
  - **Acceptance:** Admin builds a 2-clause AND rule via the UI; saved expression matches the DSL shape; rule renders on the form.

### 4.6 Block B — Default values

- **FR-CF-050** — `FieldDefinition` MUST be extended with an optional `defaultValue` field. Type-coerced to the field's data type at save-time on the schema (string→string, number→number, etc.). For multiselect: array of strings. For date: ISO date string OR relative token (`today`, `today+30d`).
  - **Acceptance:** Admin defines a number field with `defaultValue: 5`; CSR opens the create form; the field is pre-filled with 5; CSR can override.

- **FR-CF-051** — Defaults apply only on **create forms**, not on edit. Editing a record keeps the stored value (which may be missing if the field was added later — in that case the form pre-fills the default for the user to confirm).
  - **Acceptance:** Add a new field with default after some records exist; editing those records shows the default in the input but does NOT save until the user explicitly submits.

- **FR-CF-052** — Server-side fill: when a record is created via API without a value for a field that has a default, the server applies the default. UI clients always provide explicit values; API-only callers benefit from server-side default enforcement.

### 4.7 Block B — Drag-and-drop ordering

- **FR-CF-060** — Settings UI replaces the manual `order: number` text input with a drag-and-drop reorder UI. Behind the scenes, `order` numbers are still stored; the drag-and-drop UI assigns sequential values on drop.
  - **Implementation:** `@dnd-kit/sortable` or equivalent; the drop handler computes new sequential `order` values and PATCHes the schema.
  - **Acceptance:** Admin drags a field from position 3 to position 1; the schema persists; the create form renders fields in the new order.

### 4.8 Block C — Surfacing

This is the largest sub-scope in the doc. None of these capabilities exists today.

#### 4.8.1 Standard reporting

- **FR-CF-070** — A new reporting module MUST exist with at minimum:
  - Pre-built report templates per entity (customer list, account aging, meter inventory, SR summary, etc.)
  - Each template auto-includes columns for the tenant's defined custom fields on that entity
  - Output formats: HTML table view, CSV download, PDF export
  - Optional date-range + tenant-filter parameters per template
  - Schedulable via the BullMQ scheduler infrastructure (extends [scheduler-migration plan](../superpowers/plans/2026-04-24-job-scheduler-migration.md)) — recurring reports email a CSV/PDF to subscribed users

- **FR-CF-071** — When a tenant adds a custom field, every standard report on that entity MUST include the new column on the next run **without code change**. The report-rendering layer reads the custom-field schema at run-time and joins the JSON value into the result set.
  - **Acceptance:** A pre-existing "Customer list" report runs cleanly. Tenant adds a `tax_exemption_status` field on Customer. Next run of "Customer list" includes the new column.

- **FR-CF-072** — Reports respect tenant + RBAC context. A user with `customers:VIEW` can run customer reports; users without it can't. Reports never bypass RLS.

- **FR-CF-073** — The minimum viable reporting module ships with **8 pre-built templates** covering the 5 entities + 3 cross-entity (customer + accounts; SRs + status timeline; usage by premise). Customer-specific reports beyond these 8 are out of scope (City can request via support; built ad-hoc).

#### 4.8.2 Ad-hoc query builder

- **FR-CF-080** — A query builder UI at `/reports/builder` MUST allow users with `reports:VIEW` to compose queries:
  - **Pick an entity** (one of Customer, Account, Premise, Meter, ServiceAgreement, ServiceRequest)
  - **Pick columns** — both core columns and custom-field columns shown in a checklist
  - **Define filters** — same DSL as conditional visibility (FR-CF-040), evaluated server-side as Postgres expressions
  - **Group by** — optional column for aggregation
  - **Aggregations** — count, sum, average, min, max
  - **Sort** — multi-column sort with asc/desc
  - **Pagination** — limit + offset

- **FR-CF-081** — Saved queries: a user can save a built query as a named view. Saved views appear in their personal sidebar; admins can promote a view to "shared" so others can use it.

- **FR-CF-082** — Result export: every query result is downloadable as CSV, Excel (.xlsx), or JSON. Custom-field columns flatten into the same row shape as core columns — no nested JSON structures in the export.

- **FR-CF-083** — Performance: query results limited to 10,000 rows per execution. Exceeding rows triggers a notice + offer to schedule the query as a report (FR-CF-070).

- **FR-CF-084** — Security: every column requested goes through the user's per-module VIEW permission check. A user with `customers:VIEW` but not `accounts:VIEW` can build a Customer query but not an Account query.

- **FR-CF-085** — Custom-field column injection: when the user picks an entity, the column picker reads `CustomFieldSchema` for that entity and displays each defined field as a selectable column. **No code change needed when a tenant adds a field — the picker reflects schema in real-time.**

#### 4.8.3 API extracts

- **FR-CF-090** — Bulk export endpoints `GET /api/v1/<entity>/export?format=csv|xlsx|json` MUST exist for each entity. Filters mirror the standard list endpoint. Output includes core columns + every defined custom field as a flat column.
  - **Implementation:** Streams results in chunks (no load-all-into-memory); supports up to 100k rows per request without timeout.
  - **Acceptance:** Hit `/api/v1/customers/export?format=csv` for a tenant with 50k customers + 5 custom fields; response is a CSV with 50k+1 rows and 12+5 columns.

- **FR-CF-091** — OpenAPI spec MUST include a `x-custom-fields` extension on each entity's schema describing the per-tenant custom-field definitions. Auto-regenerated from the `CustomFieldSchema` table on each tenant. External integration partners using the OpenAPI spec to generate clients see the actual field shape, not just `additionalProperties: any`.
  - **Implementation:** Per-tenant OpenAPI variant served at `/api/v1/openapi.json?tenant=<id>` (gated by `api_keys:VIEW`). Default `/api/v1/openapi.json` describes the schema generically.

- **FR-CF-092** — Webhooks (when implemented; out of this doc) carry the full `customFields` payload alongside core fields, no separate "subscribe to custom field changes" feature needed.

### 4.9 What does NOT change

A few aspects of the existing implementation are good as-is:

- **Per-tenant scoping** (RLS on `custom_field_schema` and JSONB columns) — keep
- **Reserved-key protection** — keep
- **Two-phase delete with data-safety gate** — keep
- **Deprecation flow** — keep
- **60-second cache TTL** — keep for now; revisit when query-builder load justifies a Redis-backed cache (see scheduler-migration spec for the analogous note on suspension scheduler caching)
- **40 + 28 existing tests** — keep, extend for new types/rules/visibility

---

## 5. Data + infrastructure changes

### 5.1 Schema additions

```typescript
// FieldDefinition shape extension (in packages/shared/src/lib/custom-fields.ts)

export const FIELD_TYPES = [
  "string",
  "number",
  "date",
  "boolean",
  "enum",
  "currency",      // FR-CF-010
  "multiselect",   // FR-CF-020
] as const;

interface FieldDefinition {
  // ... existing fields ...
  currencyCode?: string;            // FR-CF-010, default "USD"
  defaultValue?: unknown;           // FR-CF-050
  visibleWhen?: VisibilityRule;     // FR-CF-040
  validation?: {                    // FR-CF-030
    minValue?: number;
    maxValue?: number;
    minLength?: number;
    maxLength?: number;
    pattern?: string;               // safe-regex pre-validated
    minDate?: string;               // ISO or "today"/"today+30d" tokens
    maxDate?: string;
    maxSelections?: number;
    customErrorMessage?: string;
  };
}

interface VisibilityRule {
  all?: VisibilityClause[];
  any?: VisibilityClause[];
  not?: VisibilityRule;
}

interface VisibilityClause {
  field: string;
  op: "eq" | "ne" | "in" | "nin" | "gt" | "gte" | "lt" | "lte" | "truthy" | "falsy";
  value?: unknown;
}
```

### 5.2 Schema additions for ServiceRequest

```prisma
model ServiceRequest {
  // ... existing fields ...
  customFields  Json @default("{}") @map("custom_fields")
}
```

Migration: `add_service_request_custom_fields` adds the column with the default empty object so existing rows continue to validate.

### 5.3 Reporting + query-builder data model

```prisma
// Reporting

model ReportTemplate {
  id              String   @id @default(uuid()) @db.Uuid
  utilityId       String?  @map("utility_id") @db.Uuid  // null = system template, available to all tenants
  name            String   @db.VarChar(100)
  entityType      String   @map("entity_type") @db.VarChar(50)
  description     String?  @db.Text
  config          Json     // filter spec, default columns, sort
  isSystem        Boolean  @default(false) @map("is_system")
  createdAt       DateTime @default(now()) @map("created_at") @db.Timestamptz
  updatedAt       DateTime @updatedAt @map("updated_at") @db.Timestamptz

  @@index([utilityId])
  @@map("report_template")
}

model SavedQuery {
  id              String   @id @default(uuid()) @db.Uuid
  utilityId       String   @map("utility_id") @db.Uuid
  ownerId         String   @map("owner_id") @db.Uuid  // CisUser
  name            String   @db.VarChar(100)
  isShared        Boolean  @default(false) @map("is_shared")
  entityType      String   @map("entity_type") @db.VarChar(50)
  config          Json     // columns, filters, group, sort
  createdAt       DateTime @default(now()) @map("created_at") @db.Timestamptz
  updatedAt       DateTime @updatedAt @map("updated_at") @db.Timestamptz

  @@index([utilityId, ownerId])
  @@index([utilityId, isShared])
  @@map("saved_query")
}

model ScheduledReport {
  id              String   @id @default(uuid()) @db.Uuid
  utilityId       String   @map("utility_id") @db.Uuid
  templateId      String?  @map("template_id") @db.Uuid
  savedQueryId    String?  @map("saved_query_id") @db.Uuid
  name            String   @db.VarChar(100)
  cronPattern     String   @map("cron_pattern") @db.VarChar(50)
  recipients      Json     // array of CisUser IDs or email addresses
  format          String   @db.VarChar(10)  // csv | xlsx | pdf
  enabled         Boolean  @default(true)
  lastRunAt       DateTime? @map("last_run_at") @db.Timestamptz
  createdAt       DateTime @default(now()) @map("created_at") @db.Timestamptz

  @@index([utilityId, enabled])
  @@map("scheduled_report")
}
```

### 5.4 New API surface

| Method | Route | Purpose |
|---|---|---|
| GET | `/api/v1/<entity>/export?format=csv\|xlsx\|json` | Bulk export with custom fields |
| GET | `/api/v1/openapi.json?tenant=<id>` | Per-tenant OpenAPI with custom-field shapes |
| GET | `/api/v1/reports` | List available report templates |
| POST | `/api/v1/reports/:id/run` | Run a report; returns rows or download URL |
| GET | `/api/v1/reports/queries` | List saved queries |
| POST | `/api/v1/reports/queries` | Save a new query |
| POST | `/api/v1/reports/queries/:id/run` | Run a saved query |
| GET/POST/DELETE | `/api/v1/reports/scheduled/:id?` | Scheduled-report CRUD |

### 5.5 New BullMQ queues

- `report-execution` — runs scheduled reports per their cron and emails the output to recipients
- `query-execution` — async runner for saved queries; result stored temporarily + signed download URL emailed when ready

Both use the existing scheduler-migration patterns from the BullMQ work.

---

## 6. Implementation sequence

Each phase ships independently. The phases line up with the three RFP blocks plus the foundation extensions.

### Phase A — Field-type extensions

1. **ServiceRequest custom-fields wiring.** Column add + service integration + UI integration. Effort: M (~3-4 days).
2. **Currency data type.** New type + display widget + validator + integration test. Effort: S (~2 days).
3. **Multi-select data type.** New type + display widget + validator + integration test. Effort: M (~3-4 days).

### Phase B — Field behavior extensions

4. **Validation rules** (min/max, length, regex, date bounds, max selections). Schema fields + buildZodFromFields extension + admin UI for rule entry + safe-regex check. Effort: M (~4-5 days).
5. **Default values.** Schema field + create-form pre-fill + server-side default fill + integration test. Effort: S (~2 days).
6. **Conditional visibility.** DSL spec + parser + client-side renderer + admin rule builder UI. Effort: L (~5-7 days).
7. **Drag-and-drop ordering UI.** `@dnd-kit/sortable` integration. Effort: S (~1-2 days).

### Phase C — Surfacing

8. **API bulk export** (`GET /<entity>/export?format=...`). Per-entity streaming export. Effort: M (~3-4 days).
9. **Per-tenant OpenAPI variant.** `x-custom-fields` extension. Effort: S (~2 days).
10. **Reporting module — 8 templates + run + email + schedule.** Largest line-item; new entity, new UI, new BullMQ workers. Effort: L (~7-10 days).
11. **Ad-hoc query builder UI + saved queries + result export.** Largest UX surface in the doc. Effort: L (~10-14 days).

### Pre-signature scope recommendation

Phases A + B + the API extract work from C (items 1-9, ~20-25 days). This delivers:
- All 7 entities supported (5 existing + ServiceRequest + Adjustment-once-Module-10-ships)
- All 6 RFP-named field types
- Validation rules / conditional visibility / default values / drag-and-drop
- API extracts including custom fields

Phase C items 10 + 11 (standard reporting + ad-hoc query builder) commit as Phase 1 sprint deliverables in the SOW. Together they're ~3-4 weeks of additional work.

**Total effort: ~6-7 weeks for full scope, ~5 weeks for pre-signature scope.**

---

## 7. Out of scope for this RFP

- **Field-level RBAC** — the RFP doesn't claim per-field role permissions ("only managers see salary"). The existing module spec calls this Phase 4. Out of scope here.
- **Per-tenant variants** of a schema (e.g., residential vs commercial Customer fields). Existing spec calls this Phase 4. Out of scope.
- **Field-level audit** — currently custom-field changes roll up into the parent entity's audit row. Per-field audit not promised.
- **Migration tooling for renaming keys** — keys are immutable forever. Tooling to rename + migrate stored values not promised.
- **Full-text search across custom-field values** — searchable flag exists but not yet wired to indexes; spec Phase 3 item. Out of scope here unless City requires.
- **Computed fields** — fields whose value is derived from other fields via expression. Not promised.
- **Cross-entity custom fields** — a field defined once and reused on multiple entities. Each entity has its own schema.
- **Conditional REQUIRED-ness** ("required if X") — visibility changes whether the field shows; required-when is a different rule. Not in scope.
- **WYSIWYG / rich-text editor display type** — not a primitive type; out of scope.
- **File-upload as a custom field type** — file uploads belong in the Attachments domain ([04-attachments.md](./04-attachments.md)). Don't conflate.
- **Report-builder visual designer** — the query builder is column-pick + filter-builder + group-by, not a drag-and-drop layout designer.
- **Custom report templates beyond the 8 shipped** — City can request via support; built case-by-case. Not part of standard product.
- **Pivoting / cross-tabulation in reports** — basic group-by is in scope; multi-dimensional pivot tables are not.
- **Real-time dashboards** built on custom fields — saved queries are run on demand or on schedule, not pushed live to dashboards.
- **External BI integration** (Tableau, Power BI) — the API extract surface (CSV / Excel / JSON / OpenAPI) is the integration surface. Direct BI connectors are not promised.
- **Field versioning / history** — the FieldDefinition has a `version` integer, but it's reserved for optimistic concurrency, not user-facing history. No "see what this field looked like 6 months ago" feature.

---

## 8. Risks

| Risk | Mitigation |
|---|---|
| Adding a custom field on a high-traffic entity (e.g., 1M-row Customer table) takes too long | Schema add is a column-default change on a JSONB column — Postgres handles this at metadata level, no row rewrite. Documented in admin-side help text. |
| Tenant adds 100 fields and reporting performance degrades | The 100-field cap from spec §264 stays. Reports + query-builder benchmarked for 100-field schemas. |
| Regex DoS via `pattern` validation rule | Safe-regex check at admin save-time + 100ms server-side timeout per match (FR-CF-031). Worst case: regex eats CPU on a single request, server keeps going. |
| Conditional visibility DSL is too restrictive for a tenant's real rule | Document the DSL clearly; "Other" rules go through engineering customization. Power users can edit JSON directly. The 95%-coverage estimate may be optimistic; track requests for unsupported operators. |
| Hidden-but-required field surprise on save | Documented in admin help text and in the field-form UI: "Hidden fields are not validated on save." |
| Default values out of sync with stored data on existing records | Documented behavior: defaults apply at create-form-fill time only; existing records are unchanged. UI surfaces "(default)" annotation when the form pre-fills with a default that didn't come from stored data. |
| Multi-select option added/removed orphans stored arrays | Same Phase 4 issue from the existing enum behavior; deprecate the option, scrub on demand, or migrate via tooling. Don't promise automatic. |
| Query builder lets users build queries that take 5 minutes | Server-side query-timeout cap (default 30s) + 10k-row result cap + paginated execution. Long-running queries scheduled instead. |
| Custom-field columns in CSV export break downstream tools that expect fixed-shape exports | Document the schema change in tenant onboarding. Optionally provide a "core-only" export flag for legacy integrations. |
| Currency rounding errors when migrating from `number` field | Provide a migration tool that re-stores number values as currency (multiply by 100); document its idempotency and reversibility. |
| Reporting cron storms a tenant's worker pool | Reuse the queue-priority pattern from the scheduler migration (FR-AUDIT analog) — long-running reports get lower priority. |
| Pre-built report templates don't match a specific City need | Templates are starting points; the query builder + saved queries handle the gap. Document the boundary. |
| Per-tenant OpenAPI variant becomes large | Cache aggressively (5-min TTL); generate on-demand per `?tenant=<id>` request; CDN-cacheable. |
| Drag-and-drop reorder fights with concurrent admin edits | Optimistic concurrency via the existing `version` column on `CustomFieldSchema`; conflict surfaces a "another admin changed this; reload" toast. |

---

## 9. Acceptance criteria summary

The Custom Fields commitment is satisfied when ALL of the following pass:

**Block A — Entity + type coverage**
- [ ] ServiceRequest entity supports custom fields end-to-end (schema column, service integration, create form, detail page) (FR-CF-001).
- [ ] Reserved-key list extended for ServiceRequest with compile-time coverage check (FR-CF-003).
- [ ] Currency data type accepts decimal input, stores cents, displays formatted; min/max validation works (FR-CF-010).
- [ ] Multi-select data type accepts arrays of option values; max-selections validation enforced; checkbox-group display works (FR-CF-020).
- [ ] Adjustment custom fields gated on Module 10 build; non-blocking for this RFP (FR-CF-002).

**Block B — Field behavior**
- [ ] Validation rules (min/max, length, regex, date bounds, max-selections) all enforced server-side; client-side pre-validation matches (FR-CF-030, FR-CF-032, FR-CF-033).
- [ ] Regex `pattern` is ReDoS-safe; pathological regex rejected at save-time (FR-CF-031).
- [ ] Conditional visibility DSL evaluates client-side; hidden fields don't render; visible fields validate (FR-CF-040, FR-CF-041).
- [ ] Settings UI rule builder produces valid DSL expressions for AND/OR groups + all 10 operators (FR-CF-042).
- [ ] Default values applied on create forms; existing edits don't auto-overwrite stored values (FR-CF-050, FR-CF-051).
- [ ] Drag-and-drop reorder UI updates `order` numbers; render order reflects new sequence on next form load (FR-CF-060).

**Block C — Surfacing**
- [ ] Bulk export endpoints stream up to 100k rows per request with custom fields included as flat columns (FR-CF-090).
- [ ] Per-tenant OpenAPI variant includes `x-custom-fields` extension; downstream clients see the actual field shape (FR-CF-091).
- [ ] 8 pre-built reporting templates auto-include custom-field columns when tenants add fields; no code change needed (FR-CF-070, FR-CF-071, FR-CF-073).
- [ ] Reports respect tenant + RBAC scoping (FR-CF-072).
- [ ] Reports schedulable via cron; recipients receive output via configured notification channel (FR-CF-070).
- [ ] Ad-hoc query builder lets users pick entity + columns + filters + group-by + sort; saved queries persist; shared views work (FR-CF-080, FR-CF-081).
- [ ] Query results exportable as CSV/Excel/JSON; row cap (10k) enforced; long queries offer scheduled mode (FR-CF-082, FR-CF-083).
- [ ] Custom-field columns auto-appear in column picker when tenant adds a field; no schema reload required beyond the 60s cache TTL (FR-CF-085).

**Negative tests**
- [ ] Field-level RBAC NOT implemented (verifies Phase-4 boundary).
- [ ] No cross-entity custom fields (verifies entity-isolation).
- [ ] No real-time dashboards (verifies query-builder is on-demand only).

Sign-off: backend lead + frontend lead + reporting / BI integration lead + proposal owner.
