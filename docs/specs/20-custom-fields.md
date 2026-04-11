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
  type: "string" | "number" | "date" | "boolean" | "enum";
  required: boolean;
  searchable: boolean;      // Phase 1: not yet wired to list filters
  order: number;            // display order within the Custom Fields section
  deprecated: boolean;      // hides from forms but preserves stored values
  enumOptions?: { value: string; label: string }[]; // required when type === "enum"
}
```

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

**Phase 1 wiring status:**
- ✅ Customer (pilot)
- ⬜ Account
- ⬜ Premise
- ⬜ ServiceAgreement
- ⬜ Meter

The other four entities are mechanical repetition of the same pattern — they're deferred to Phase 2 so the Customer pilot can be verified end to end first.

## Caching

The service maintains an in-memory cache of `(utilityId, entityType) → FieldDefinition[]` with a 60-second TTL. The cache is populated lazily and invalidated whenever the service writes to the schema. Cross-instance invalidation (two API replicas with divergent caches) is NOT handled in v1 — the same "single-instance only" caveat that applies to the suspension scheduler applies here. Moving to BullMQ + Redis fixes both.

## UI Pages

### Settings → Custom Fields tab (`/settings`, Custom Fields tab)

Admin-only (requires `settings.EDIT` for mutations; any authenticated user can view). Renders:

- **Entity picker**: five pill buttons (Customer, Account, Premise, Service Agreement, Meter). Clicking switches the view to that entity's field list.
- **Field list**: all current fields for the selected entity, active ones first and deprecated ones at the bottom (greyed out). Each row shows the key (immutable), type, and inline editors for label, required, and searchable. A "Deprecate" button on each active row triggers `POST /fields/:key/deprecate` after a confirm dialog.
- **Add Field form**: dashed border, collapsed by default. Expands to a form with key, label, type, required, searchable, description, and (when type is enum) a dynamic list of value/label pairs. On submit, calls `POST /fields`.

### Customer create form (`/customers/new`)

Loads `/api/v1/custom-fields/customer` on mount. When the response contains fields, a "Custom Fields" section renders at the bottom of the form (below the built-in phone/alt-phone row). Each field is rendered by `CustomFieldsSection` using a switch on type:

- `string` → text input
- `number` → number input (client coerces to null on empty)
- `date` → HTML date picker
- `boolean` → checkbox
- `enum` → select dropdown with the declared options

Submit merges custom values into the request body under the `customFields` key, which the backend validates via `validateCustomFields` before writing.

When the tenant has no custom fields configured, the section renders nothing and the form looks identical to the original.

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
- Shared: `FieldDefinition` type, `buildZodFromFields` validator builder, admin CRUD validators
- API: `custom-field-schema.service.ts` with read, upsert, add/update/deprecate, validateCustomFields helper, in-memory cache
- API routes: `/api/v1/custom-fields/:entity` and nested field routes
- Customer service wired to validate and persist custom fields on create/update
- Web: `<CustomFieldsSection>` component with dispatch on field type
- Customer form (`/customers/new`) integrated end to end
- Settings → Custom Fields admin tab with entity picker, field list, and Add Field form
- 20 shared tests for validators and the Zod builder
- 14 API service tests for validateCustomFields

**Phase 2 (planned):**
- Wire validateCustomFields into Account, Premise, ServiceAgreement, Meter create/update services
- Integrate `<CustomFieldsSection>` into the four corresponding create/edit forms
- Display custom field values on entity detail pages (read-only grid section)
- Customer edit form wiring (currently only `new` uses the section)

**Phase 3 (planned):**
- **Searchable fields** — translate the `searchable` flag into real index management. Admin marks a field searchable → backend runs `CREATE INDEX CONCURRENTLY ... ON <table> ((custom_fields->>'<key>'))`. The list page reads searchable fields from the schema and renders filter pills above the table that map to query params like `cf_taxId=123`. Entity list services recognize the `cf_*` query params and translate them to Prisma filters using the expression index.
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
