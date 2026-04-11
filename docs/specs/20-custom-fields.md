# Custom Fields

**Module:** 20 — Custom Fields
**Status:** Phase 1 (backend + Customer pilot) — see roadmap
**Entities:** CustomFieldSchema, plus `custom_fields` jsonb column on Customer/Account/Premise/ServiceAgreement/Meter

## Overview

Tenant-configurable custom fields let a utility add fields to core entities without a code change or schema migration. Each tenant defines a field schema per entity type, the values are stored in a JSONB column on the entity row, and the backend validates on write against the tenant's schema.

This is the **Version B ("split")** implementation: core entity columns remain hand-coded Prisma fields validated by their own Zod schemas, and custom fields live in a separate jsonb column with their own dynamically-built validator. See the design discussion in session history for the alternative (Version A, "unified") and why we chose to keep core and custom separate.

Primary users: utility administrators who configure fields via the Settings → Custom Fields tab. End users (CSRs, field technicians) see those fields as extra inputs at the bottom of the relevant entity forms.

## Entities

### CustomFieldSchema

One row per (utility_id, entity_type). Holds the full FieldDefinition list for that entity in a jsonb column. Absence of a row means "no custom fields configured for this entity."

| Field | Type | Notes |
|-------|------|-------|
| id | UUID | PK |
| utility_id | UUID | Tenant scope |
| entity_type | VARCHAR(50) | `customer`, `account`, `premise`, `service_agreement`, or `meter` |
| fields | JSONB | `FieldDefinition[]` — see TypeScript shape below |
| version | INT | Bumped on every update; reserved for optimistic concurrency |
| created_at | TIMESTAMPTZ | |
| updated_at | TIMESTAMPTZ | |

**Unique constraint:** `(utility_id, entity_type)`
**RLS:** standard `utility_id = current_setting('app.current_utility_id')::uuid`

### FieldDefinition (TypeScript)

Stored as an array inside the `fields` jsonb column. Single source of truth for both the API validator and the web form renderer lives in `packages/shared/src/lib/custom-fields.ts`.

```typescript
interface FieldDefinition {
  key: string;              // immutable once created; lowercase alphanumeric + underscore, starts with letter
  label: string;            // display label
  description?: string;     // optional help text rendered under the input
  type: "string" | "number" | "date" | "boolean" | "enum";    // data type — drives validation
  displayType?: DisplayType;   // widget — drives rendering; see table below
  required: boolean;
  searchable: boolean;      // Phase 1: not yet wired to list filters
  order: number;            // display order within the Custom Fields section
  deprecated: boolean;      // hides from forms but preserves stored values
  enumOptions?: { value: string; label: string }[]; // required when type === "enum"
}

type DisplayType =
  | "text" | "textarea" | "email" | "url" | "phone"  // string displays
  | "number"                                          // number displays
  | "date"                                            // date displays
  | "checkbox"                                        // boolean displays
  | "select" | "radio";                               // enum displays
```

## Data type vs display type

The stored `FieldDefinition` carries two fields that govern behavior separately: `type` (the data type, which drives validation) and `displayType` (the widget, which drives rendering).

**Data type** determines the shape of the stored value and the Zod validator used by `buildZodFromFields`. A `string` field validates as a string regardless of whether it renders as a single-line input or a textarea. An `enum` field validates against the allowed option values regardless of whether it renders as a dropdown or a radio group.

**Display type** controls which input widget `CustomFieldsSection` renders. Each data type has an allowlist of valid display types; the validator rejects invalid combinations at schema save time (e.g. `type: number` with `displayType: textarea` returns a 400 with `CUSTOM_FIELDS_INVALID`).

| Data type | Allowed display types | Default |
|---|---|---|
| `string` | `text`, `textarea`, `email`, `url`, `phone` | `text` |
| `number` | `number` | `number` |
| `date` | `date` | `date` |
| `boolean` | `checkbox` | `checkbox` |
| `enum` | `select`, `radio` | `select` |

**Backward compatibility**: when `displayType` is absent from a stored FieldDefinition (e.g. a legacy row created before the split existed), the renderer uses `defaultDisplayType(type)` which returns the first entry from the allowlist for that type.

**Note on datetime**: a "Date and time" option was considered for Phase 1 but deferred. Representing datetime cleanly requires a new data type (`datetime`) with its own `z.string().datetime()` validator — it can't just be a display type of `date` because the existing `z.string().date()` validator only accepts `YYYY-MM-DD`. See the Phase 2 roadmap.

## Unified admin-facing Kind

Admins don't see the raw data-type vs display-type split. The admin Type dropdown shows a flat list of 10 user-facing "Kinds", each of which maps to a `(type, displayType)` pair internally:

| Admin sees | `type` | `displayType` | Uses enumOptions? |
|---|---|---|---|
| Text (single line) | string | text | no |
| Long text (multi-line) | string | textarea | no |
| Email | string | email | no |
| URL | string | url | no |
| Phone | string | phone | no |
| Number | number | number | no |
| Date | date | date | no |
| Yes / No (checkbox) | boolean | checkbox | no |
| Dropdown (single choice from list) | enum | select | **yes** |
| Radio group (single choice from list) | enum | radio | **yes** |

The `CUSTOM_FIELD_KINDS` constant in `packages/shared/src/lib/custom-fields.ts` is the single source of truth for this mapping. Adding a new display type or data type starts by appending to this list and adding the corresponding render case in `CustomFieldsSection`.

The admin Add Field / Edit Field form picks a Kind and the code then writes `type` and `displayType` together so they stay consistent. The "List of Values" editor (for enumOptions) only appears when the selected Kind has `hasOptions: true` — i.e. Dropdown or Radio group.

## Storage model on core entities

Each extendable entity table gained a `custom_fields JSONB NOT NULL DEFAULT '{}'` column:

- `customer.custom_fields`
- `account.custom_fields`
- `premise.custom_fields`
- `service_agreement.custom_fields`
- `meter.custom_fields`

Values are stored as a flat object keyed by the field's `key`. Example:

```json
{
  "tax_id": "12-3456789",
  "tier": "GOLD",
  "anniversary_date": "2020-04-11",
  "is_vip": true
}
```

## Write-time validation

The backend rejects writes that don't match the tenant's schema. See `validateCustomFields` in `packages/api/src/services/custom-field-schema.service.ts`.

Validation rules:

1. **No schema configured**: customFields must be absent or empty. A non-empty payload when no schema is configured returns `400 CUSTOM_FIELDS_NOT_CONFIGURED`.
2. **Shape check**: payload must be a plain object. Arrays, strings, numbers return `400 CUSTOM_FIELDS_SHAPE`.
3. **Strict key matching**: unknown keys are rejected via Zod's `.strict()` on the dynamically-built validator. Writing to a deprecated field is also rejected.
4. **Type checks**: values must match the declared type (string, number, date ISO string, boolean, or one of the declared enum values).
5. **Required fields**: on create, required fields must be present. On update, required fields only need to be present if the stored row doesn't already have them.

Errors are tagged with `CUSTOM_FIELDS_INVALID` status 400 and returned through the standard error handler.

### Update semantics

Patch payloads merge with existing stored values. A tenant that adds a required field after some customers were already created will NOT break those existing rows — the update validator merges stored + patch before re-validating, so partial updates don't trip the "required" check as long as the stored row has the value.

### Deprecated-field preservation

When an admin deprecates a field, existing stored values are preserved in the jsonb column indefinitely. The validator:

- Rejects new writes to deprecated keys (strict mode)
- Filters deprecated keys out of the stored state before merging, so an update patch doesn't fail because a legacy value exists in storage
- Re-attaches deprecated stored values to its output so the final write back to Prisma preserves them

This means a tenant can deprecate a field without fear of data loss, and can un-deprecate later (by PATCHing `deprecated: false`) to see the preserved values reappear in the form.

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/custom-fields/:entity` | Read the tenant's schema for one entity. No module permission — any authenticated user on the tenant can read it, because forms and list pages need it to render. |
| PUT | `/api/v1/custom-fields/:entity` | Replace the entire field list. Useful for bulk editors. Gated by `settings.EDIT`. |
| POST | `/api/v1/custom-fields/:entity/fields` | Append one field. Rejects duplicate keys. Gated by `settings.EDIT`. |
| PATCH | `/api/v1/custom-fields/:entity/fields/:fieldKey` | Update a field's metadata (label, required, searchable, enum options, etc.). Key is immutable. Gated by `settings.EDIT`. |
| POST | `/api/v1/custom-fields/:entity/fields/:fieldKey/deprecate` | Mark a field deprecated. Sugar over the PATCH above. |

`:entity` is restricted to one of `customer | account | premise | service_agreement | meter` — see `CUSTOM_FIELD_ENTITY_TYPES` in shared.

## Service-layer wiring

Each core entity service that supports custom fields calls `validateCustomFields` before writing. Pattern:

```typescript
import { validateCustomFields } from "./custom-field-schema.service.js";

export async function createCustomer(utilityId, actorId, actorName, data) {
  const { customFields: rawCustom, ...core } = data;
  const validatedCustom = await validateCustomFields(
    utilityId,
    "customer",
    rawCustom,
    { mode: "create" },
  );
  return auditCreate(
    ...,
    () => prisma.customer.create({
      data: { ...core, utilityId, customFields: validatedCustom as object },
    }),
  );
}
```

**Wiring status (all five entities now complete):**
- ✅ Customer (Phase 1 pilot)
- ✅ Account (Phase 2)
- ✅ Premise (Phase 2)
- ✅ ServiceAgreement (Phase 2)
- ✅ Meter (Phase 2)

Every extendable entity now follows the same pattern: validators accept an optional `customFields` passthrough; services split it off the payload, validate via `validateCustomFields` against the tenant schema, and persist into the jsonb column. New forms render `<CustomFieldsSection>` at the bottom and only include `customFields` in the request body when at least one value is set. Detail pages show stored values as label/value rows in view mode and switch to `<CustomFieldsSection>` (with the page's local `fieldStyle`/`labelStyle`/`hideHeader` overrides) in edit mode.

## Caching

The service maintains an in-memory cache of `(utilityId, entityType) → FieldDefinition[]` with a 60-second TTL. The cache is populated lazily and invalidated whenever the service writes to the schema. Cross-instance invalidation (two API replicas with divergent caches) is NOT handled in v1 — the same "single-instance only" caveat that applies to the suspension scheduler applies here. Moving to BullMQ + Redis fixes both.

## UI Pages

### Settings → Custom Fields tab (`/settings`, Custom Fields tab)

Admin-only (requires `settings.EDIT` for most mutations, `settings.DELETE` for the destructive delete path). Authenticated users without edit permission see a read-only field list. Renders:

- **Entity picker** — five pill buttons (Customer, Account, Premise, Service Agreement, Meter). Clicking switches the view to that entity's field list. Switching entities also clears any in-progress add-or-edit state.
- **Field list** — all current fields for the selected entity, active ones first and deprecated ones at the bottom (greyed out). Each row shows the key (immutable), the unified Kind label (e.g. "Dropdown (single choice from list)"), a deprecated badge if applicable, and inline editors for label, required, and searchable. Three action buttons sit on the right of each row:
  - **Edit** (blue border) — expands the row into the shared FieldForm in edit mode. Only one row can be in edit mode at a time; opening a second closes the first.
  - **Deprecate** (grey border) — triggers `POST /fields/:key/deprecate` after a confirm dialog. Hidden on rows that are already deprecated.
  - **Delete** (red border) — triggers the two-phase delete flow described under "Deleting a custom field" below.
- **Add Field form** — dashed border, collapsed by default. Click **+ Add Field** to expand.
- **FieldForm** — the shared form component that handles both Add and Edit. Differences between the two modes:
  - **Create mode**: Key input is editable with live reserved-key / duplicate-key validation (inline red error as you type). Type dropdown shows all 10 Kinds.
  - **Edit mode**: Key input is disabled and labeled "(locked)". Type dropdown is filtered to alternatives within the same data type so admins can safely switch display widgets (text ↔ textarea ↔ email, dropdown ↔ radio) without risking data migration. Changing the data type is blocked entirely — an explanatory note appears under the Type dropdown directing admins to deprecate and recreate instead.
  - Both modes: required inputs (Key, Label, Type, and List of Values when applicable) are marked with a red asterisk via a reusable `RequiredMark` component.

#### Deleting a custom field

The Delete button initiates a two-phase destructive flow (see `deleteCustomField` in `custom-field-schema.service.ts`):

1. Initial confirm dialog. If the admin cancels here, nothing happens.
2. Client calls `DELETE /api/v1/custom-fields/:entity/fields/:fieldKey` (default, no `force`).
3. Backend counts rows in the entity table whose `custom_fields` jsonb contains the target key (`custom_fields ? $key`). If count is 0, deletes cleanly. If count > 0, returns `400 CUSTOM_FIELD_HAS_DATA` with the count in the error's `meta.rowCount`.
4. Client parses the row count out of the error message, shows a second confirm dialog with the number (e.g. "42 row(s) contain data for this field. Continuing will permanently erase those values."), and on approval retries with `?force=true`.
5. Force-mode backend scrubs the key from every matching row via `UPDATE <entity_table> SET custom_fields = custom_fields - $key WHERE utility_id = $1 AND custom_fields ? $key`, then removes the field from the schema and invalidates the tenant cache.

### Customer create form (`/customers/new`)

Loads `/api/v1/custom-fields/customer` on mount. When the response contains fields, a "Custom Fields" section renders at the bottom of the form (below the built-in phone/alt-phone row). Each field is rendered by `CustomFieldsSection` using a switch on `displayType` (falling back to `defaultDisplayType(type)` for legacy rows):

- `text` → single-line text input
- `textarea` → multi-line textarea (4 rows default, resizable)
- `email` → `<input type="email">` with a placeholder
- `url` → `<input type="url">` with a placeholder
- `phone` → `<input type="tel">` with a placeholder
- `number` → number input (client coerces to null on empty)
- `date` → project `DatePicker` component (calendar popup, not the native browser date input)
- `checkbox` → single checkbox labeled "Yes"
- `select` → `<select>` dropdown populated from `enumOptions`
- `radio` → radio group with one button per `enumOption`, keyed by the field key so multiple fields on the same form don't collide

Required fields show a red asterisk next to their label. The section respects the host's visual conventions via optional `inputStyle`, `fieldStyle`, `labelStyle`, and `hideHeader` props — see `CustomFieldsSectionProps` for the full list.

Submit merges custom values into the request body under the `customFields` key, which the backend validates via `validateCustomFields` before writing.

When the tenant has no custom fields configured, the section renders nothing and the form looks identical to the original.

### Customer detail page (`/customers/[id]`)

**View mode**: the Custom Fields section renders between the Contact and System sections as a label/value grid matching the page's core `fieldStyle` (180px label column + value column). Values are formatted by data type: booleans render as "Yes"/"No", enums resolve to their option labels, everything else renders as stored. Missing values render as an em-dash.

Deprecated fields with stored values render below the active ones at 60% opacity with a small red "deprecated" tag next to the label, so legacy data stays visible.

**Edit mode**: replaces the view-mode grid with `CustomFieldsSection`. Host styles (`fieldStyle`, `labelStyle`, `inputStyle`) are passed through so custom fields visually match the core inline-edit inputs on the same page — darker `--bg-deep` background, 180px left column for labels, etc. The section's own heading is suppressed via `hideHeader` because the page renders its own "Custom Fields" section header to match the "Contact" and "System" headers around it.

On Save, the page diffs the edited custom fields against the stored values via JSON comparison and only includes `customFields` in the PATCH body when they actually differ.

## Scope and limits for Phase 1

Deliberately narrow for v1:

- **Primitive types only** — no nested objects, no arrays of values, no multi-select, no file upload
- **Per-entity, not per-role-variant** — one schema per (tenant, entity). No "residential customer" vs "commercial customer" variants.
- **Immutable keys** — once a field exists, its key can't be renamed. The admin UI enforces this at create time.
- **100 fields per entity** — enforced by `fieldDefinitionListSchema.max(100)`. Plenty for real utilities.
- **No drag-and-drop ordering** — admins type `order` numbers directly. Fine for v1.

## Phase Roadmap

**Phase 1 (complete):**
- Database: `custom_fields` column on 5 entity tables + `custom_field_schema` table + RLS policy
- Shared: `FieldDefinition` type (with optional `displayType`), `buildZodFromFields` validator builder, admin CRUD validators, `CORE_FIELD_KEYS` reserved-key list with `isReservedFieldKey` helper
- Shared: `FIELD_DISPLAY_TYPES` constant, `ALLOWED_DISPLAY_TYPES` per-data-type allowlist, `CUSTOM_FIELD_KINDS` unified admin Kind list, `defaultDisplayType` / `isValidDisplayType` / `kindForField` helpers
- API: `custom-field-schema.service.ts` with read, upsert, add/update/deprecate/delete, validateCustomFields helper with create/update merge semantics and deprecated-field preservation, in-memory per-tenant cache (60s TTL)
- API: reserved-key rejection on addCustomField / replaceCustomFieldSchema (`CUSTOM_FIELD_KEY_RESERVED`)
- API: two-phase deleteCustomField with data-safety gate (`CUSTOM_FIELD_HAS_DATA` on count > 0, force-mode scrubs jsonb values before removing the field)
- API routes: `GET/PUT /api/v1/custom-fields/:entity`, `POST/PATCH/DELETE /fields/:fieldKey`, `POST /fields/:fieldKey/deprecate`
- Customer service wired to validate and persist custom fields on create/update (pilot)
- Web: `<CustomFieldsSection>` component with dispatch on `displayType`, supporting text, textarea, email, url, phone, number, date (via project DatePicker), checkbox, select, and radio display widgets
- Web: `<CustomFieldsSection>` host overrides — `inputStyle`, `fieldStyle`, `labelStyle`, `hideHeader` — so detail pages and form shells can both render the section in their own visual language
- Web: `<DatePicker>` extended with optional `triggerStyle` prop for theme matching
- Customer create form (`/customers/new`) integrated end to end
- Customer detail page (`/customers/[id]`) — view mode uses page fieldStyle grid for label/value display; edit mode uses CustomFieldsSection with host styles passed through; save diffs custom fields and PATCHes only when changed
- Settings → Custom Fields admin tab with entity picker (5 pills), field list, Add Field form, Edit button (inline expand into shared FieldForm with locked key and restricted Kind dropdown), Deprecate and two-phase Delete buttons
- Shared FieldForm handles both create and edit via `mode` prop; required fields marked with red asterisks via reusable `RequiredMark` helper; live reserved-key validation on the key input
- 40 shared tests for validators, Zod builder, displayType, reserved keys, CUSTOM_FIELD_KINDS invariants
- 28 API service tests for validateCustomFields, addCustomField, replaceCustomFieldSchema, and deleteCustomField (all paths including reserved-key and data-safety gates)

**Phase 2 (complete):**
- ✅ Wired `validateCustomFields` into Account, Premise, ServiceAgreement, Meter create/update services with full merge semantics
- ✅ Integrated `<CustomFieldsSection>` into the four corresponding create forms (`/accounts/new`, `/premises/new`, `/service-agreements/new`, `/meters/new`)
- ✅ Custom field display on all four detail pages — view mode renders stored values as label/value rows matching each page's local `fieldStyle` grid; edit mode swaps in `<CustomFieldsSection>` with host styles passed through so inputs blend with the surrounding inline-edit fields
- ✅ Each detail page's `handleSave` diffs custom fields against stored values and only includes them in the PATCH body when they actually changed
- ✅ Each detail page's `handleEdit` seeds `editCustomFields` from `entity.customFields` and `handleCancel` clears the bucket so re-entering edit mode starts fresh

**Phase 3 (planned):**
- **Datetime support** — add `datetime` as a new entry in `FIELD_TYPES` with its own `z.string().datetime()` validator (ISO 8601 with time offset). Currently datetime is intentionally NOT supported because making it a display type of the `date` data type would cause the validator to reject any value with a time portion. The proper fix is a new data type alongside `date`, with a dedicated display type and either a DateTimePicker component or a composed DatePicker + time input. Estimated 1–2 hours of focused work once we have a real use case.
- **Enum option cleanup on removal** — when an admin removes an enum option that still has stored values in some rows, warn with a row count and offer to scrub. Currently removing an option just orphans the data against the new schema, which will reject future updates on those rows.
- **Compile-time CORE_FIELD_KEYS coverage check** — assert that the reserved-key list covers every column in the Prisma schema for extendable entities, so drift is caught at CI time instead of relying on manual maintenance.
- **Searchable fields** — translate the `searchable` flag into real index management. Admin marks a field searchable → backend runs `CREATE INDEX CONCURRENTLY ... ON <table> ((custom_fields->>'<key>'))`. The list page reads searchable fields from the schema and renders filter pills above the table that map to query params like `cf_taxId=123`. Entity list services recognize the `cf_*` query params and translate them to Prisma filters using the expression index. (Was originally Phase 3; promoted here.)
- Full-text search integration — custom-field values included in the tsvector for searchable fields
- Export / import schemas as JSON for sharing between environments

**Phase 4 (planned):**
- Field-level RBAC: role-based visibility on specific custom fields (e.g. "only managers can see salary field")
- Field-level audit: each custom field change emits its own audit event rather than being collapsed into the parent entity's update event
- Per-tenant variants of a schema (e.g. residential vs commercial customer)
- Migration tooling for renaming keys (currently key is immutable forever)

## Business Rules

1. **Key immutability:** A field's `key` is immutable once created. Renaming requires deprecating the old field and adding a new one with the new key. This prevents data from becoming orphaned and keeps existing JSONB values valid.

2. **Deprecate instead of delete:** There is no "delete field" action. Fields can be deprecated (hidden from forms, stored data preserved) but never removed. This guarantees that no admin action can destroy custom field data.

3. **Required fields don't break existing rows:** Making a field required only affects new writes. Existing entity rows that were created before the field was marked required keep their existing stored values indefinitely. An update to such a row merges patch+stored before validating, so partial patches don't fail on required fields.

4. **Enum option values are immutable for data safety:** The admin UI doesn't prevent editing enum option values, but doing so orphans any stored data that referenced the old value. Documentation advises admins to add new options rather than rename existing ones. (Phase 4 may enforce this programmatically.)

5. **Cache TTL is 60 seconds:** Custom field schema changes propagate within 60 seconds. Admins who just made a change and immediately refresh an entity form may briefly see the old schema. This is documented in the Settings tab help text.

## Bozeman RFP Coverage

The Custom Fields module is foundational for several Bozeman RFP functional areas that require tenant-specific data capture:

- **Tenant-specific billing attributes** — utilities often need to track jurisdiction codes, tariff riders, or other locally-defined metadata on accounts and agreements. Custom fields provide this without a schema change per tenant.
- **Meter metadata** — tracking data like warranty expiration, calibration dates, or manufacturer serial batches varies by utility. Custom fields on Meter handle this.
- **Customer attributes** — demographic fields, marketing preferences, or service programs vary by utility. Custom fields on Customer cover the gap.

Direct coverage will be documented as specific requirements get wired up in Phases 2–4.
