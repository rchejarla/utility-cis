import { z } from "zod";

/**
 * Tenant-configurable custom fields for extendable entities.
 *
 * Version B ("split") architecture: core entity columns stay
 * hand-coded as Prisma fields validated by their own Zod schemas;
 * custom fields are stored in a jsonb column on the entity and
 * validated separately via a dynamically-built Zod schema derived
 * from the tenant's `custom_field_schema` row.
 *
 * This file is the single source of truth for:
 *   - the FieldDefinition shape stored in `custom_field_schema.fields`
 *   - the Zod builder that turns a FieldDefinition[] into a validator
 *   - the Zod validators for admin CRUD of field definitions
 *
 * Consumed on both sides: API for write-time validation, web for
 * rendering form inputs and filter pills.
 *
 * Scope limits for v1 (reassess when real customers ask):
 *   - Primitive types only — string, number, date, boolean, enum
 *   - No nested objects, no arrays of objects, no multi-select
 *   - Field keys are immutable once created (rename = deprecate + re-add)
 *   - One schema per tenant per entity type (no per-role variants)
 */

/**
 * Stable set of entity types that can carry custom fields. Frozen for
 * v1 to a short list; adding a new one requires a migration to add the
 * customFields column and wiring into its create/update service.
 */
export const CUSTOM_FIELD_ENTITY_TYPES = [
  "customer",
  "account",
  "premise",
  "service_agreement",
  "meter",
] as const;

export type CustomFieldEntityType = (typeof CUSTOM_FIELD_ENTITY_TYPES)[number];

export const customFieldEntityEnum = z.enum(CUSTOM_FIELD_ENTITY_TYPES);

/**
 * Primitive field types supported in v1. Deliberately narrow — the
 * point is to let tenants capture extra scalar facts, not to build a
 * full forms-designer surface.
 */
export const FIELD_TYPES = ["string", "number", "date", "boolean", "enum"] as const;

export type FieldType = (typeof FIELD_TYPES)[number];

export const fieldTypeEnum = z.enum(FIELD_TYPES);

/**
 * An enum option used when a field's type is "enum". Value is the
 * stored constant (immutable once referenced by existing data);
 * label is the user-facing display text (editable).
 */
export interface EnumOption {
  value: string;
  label: string;
}

export const enumOptionSchema = z
  .object({
    value: z
      .string()
      .min(1)
      .max(100)
      // Keep stored values simple and safe for URL filters and
      // expression indexes. Labels have no such restriction.
      .regex(/^[A-Za-z0-9_\-.]+$/, "Value must be alphanumeric, underscore, dash, or dot"),
    label: z.string().min(1).max(200),
  })
  .strict();

/**
 * The full stored shape for one custom field. Lives inside the
 * `fields` array on custom_field_schema. Keys are immutable once a
 * row exists; the admin UI enforces this at create time and the API
 * rejects key renames.
 */
export interface FieldDefinition {
  /** Storage key inside the entity's customFields jsonb. Immutable. */
  key: string;
  /** Display label shown in forms and filters. Editable. */
  label: string;
  /** Optional help text rendered under the input. */
  description?: string;
  /** Primitive type. Determines rendering and validation. */
  type: FieldType;
  /** Whether the field is required on create/update. */
  required: boolean;
  /** Whether this field gets a filter pill on list pages. */
  searchable: boolean;
  /** Display order within the Custom Fields section. Lower = earlier. */
  order: number;
  /** When true, the field is hidden from create forms but kept in stored data. */
  deprecated: boolean;
  /** Options for type=enum. Required when type is "enum", ignored otherwise. */
  enumOptions?: EnumOption[];
}

export const fieldDefinitionSchema = z
  .object({
    key: z
      .string()
      .min(1)
      .max(64)
      // Keys become JSON property names and expression-index names.
      // Strict alphanumeric + underscore prevents injection into the
      // mark-searchable DDL path and keeps storage keys clean.
      .regex(
        /^[a-z][a-z0-9_]*$/,
        "Key must start with a lowercase letter and contain only lowercase letters, digits, and underscores",
      ),
    label: z.string().min(1).max(200),
    description: z.string().max(500).optional(),
    type: fieldTypeEnum,
    required: z.boolean().default(false),
    searchable: z.boolean().default(false),
    order: z.number().int().nonnegative().default(100),
    deprecated: z.boolean().default(false),
    enumOptions: z.array(enumOptionSchema).optional(),
  })
  .strict()
  .superRefine((def, ctx) => {
    if (def.type === "enum") {
      if (!def.enumOptions || def.enumOptions.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "enumOptions is required and must be non-empty when type is 'enum'",
          path: ["enumOptions"],
        });
      } else {
        const seen = new Set<string>();
        for (const opt of def.enumOptions) {
          if (seen.has(opt.value)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: `Duplicate enum option value: ${opt.value}`,
              path: ["enumOptions"],
            });
            break;
          }
          seen.add(opt.value);
        }
      }
    }
  });

/**
 * Whole-schema validator used when an admin upserts the entire field
 * list at once (e.g. via PUT from a bulk editor). Rejects duplicate
 * keys within the same schema.
 */
export const fieldDefinitionListSchema = z
  .array(fieldDefinitionSchema)
  .max(100, "A single entity type cannot have more than 100 custom fields")
  .superRefine((fields, ctx) => {
    const seen = new Set<string>();
    for (const field of fields) {
      if (seen.has(field.key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Duplicate field key: ${field.key}`,
          path: [],
        });
        return;
      }
      seen.add(field.key);
    }
  });

/**
 * Admin API validators for individual field mutations.
 */
export const addFieldDefinitionSchema = fieldDefinitionSchema;
export const updateFieldDefinitionSchema = z
  .object({
    // key is immutable — not accepted on update
    label: z.string().min(1).max(200).optional(),
    description: z.string().max(500).optional(),
    required: z.boolean().optional(),
    searchable: z.boolean().optional(),
    order: z.number().int().nonnegative().optional(),
    deprecated: z.boolean().optional(),
    enumOptions: z.array(enumOptionSchema).optional(),
  })
  .strict();

/**
 * Turn a FieldDefinition array into a Zod validator that accepts an
 * object whose keys match the active (non-deprecated) fields and
 * whose values match the declared types. Unknown keys are rejected
 * via `.strict()`.
 *
 * Used by the API's `validateCustomFields` helper when a create or
 * update payload includes a customFields object. The tenant's schema
 * is loaded, passed through this function, and the resulting
 * validator parses the payload — any type mismatch, missing required
 * field, or unknown key returns a clean 400.
 *
 * Deprecated fields are intentionally excluded from the validator so
 * new writes don't try to populate them, but existing stored values
 * are NOT clobbered — the caller merges the new payload into the
 * existing jsonb column rather than replacing it wholesale.
 */
export function buildZodFromFields(fields: FieldDefinition[]): z.ZodTypeAny {
  const shape: Record<string, z.ZodTypeAny> = {};

  for (const field of fields) {
    if (field.deprecated) continue;

    let base: z.ZodTypeAny;
    switch (field.type) {
      case "string":
        base = z.string().max(4000);
        break;
      case "number":
        // z.coerce.number handles JSON bodies that send a numeric
        // string (e.g. from an HTML number input). Frontend forms
        // submit numbers as numbers already; this just keeps the
        // validator tolerant.
        base = z.coerce.number().finite();
        break;
      case "date":
        base = z.string().date();
        break;
      case "boolean":
        base = z.coerce.boolean();
        break;
      case "enum": {
        const values = (field.enumOptions ?? []).map((o) => o.value);
        if (values.length === 0) {
          // Should have been caught at schema save time by the
          // superRefine on fieldDefinitionSchema, but guard defensively.
          throw new Error(
            `Custom field "${field.key}" is type enum but has no options`,
          );
        }
        base = z.enum(values as [string, ...string[]]);
        break;
      }
    }

    // Required fields must be present and non-null. Optional fields
    // may be omitted entirely OR explicitly set to null — storing a
    // null signals "user cleared this field" and is different from
    // omitting it.
    if (field.required) {
      shape[field.key] = base;
    } else {
      shape[field.key] = base.nullable().optional();
    }
  }

  return z.object(shape).strict();
}

/**
 * Validate a payload against a tenant's field list. Returns the
 * parsed/coerced output on success, throws a Zod error on failure.
 * Thin wrapper around buildZodFromFields for callers that don't need
 * the intermediate validator object.
 */
export function parseCustomFields(
  fields: FieldDefinition[],
  payload: unknown,
): Record<string, unknown> {
  const validator = buildZodFromFields(fields);
  return validator.parse(payload) as Record<string, unknown>;
}

/**
 * DTO returned by GET /api/v1/custom-fields/:entity — includes the
 * tenant's field list plus metadata the web admin UI needs (version
 * for optimistic concurrency, updatedAt for display).
 */
export interface CustomFieldSchemaDTO {
  utilityId: string;
  entityType: CustomFieldEntityType;
  fields: FieldDefinition[];
  version: number;
  updatedAt: string;
}

/**
 * Reserved field keys per entity type.
 *
 * Admins cannot create a custom field whose key collides with one of
 * the entity's core Prisma columns, system metadata columns (created_at,
 * updated_at, utility_id, id, custom_fields itself), or any future-
 * reserved value. Enforced at the API boundary by addCustomField /
 * replaceCustomFieldSchema and surfaced in the admin UI as an inline
 * error on the Add Field form.
 *
 * Kept as snake_case lowercase strings because that's the shape
 * custom field keys must take (the key regex is /^[a-z][a-z0-9_]*$/).
 * This lets the isReservedFieldKey check be a direct string compare
 * rather than having to normalize between camelCase Prisma names and
 * the admin-facing key format.
 *
 * Maintenance: when a new column is added to one of the extendable
 * entity tables, add its snake_case name to the relevant array here
 * to prevent collisions. Missing a new column doesn't break anything
 * security-wise — it just allows a confusing duplicate-input UX
 * until the list is updated.
 */
const COMMON_RESERVED_KEYS = [
  "id",
  "utility_id",
  "custom_fields",
  "created_at",
  "updated_at",
  "search_vector",
] as const;

export const CORE_FIELD_KEYS: Record<CustomFieldEntityType, readonly string[]> = {
  customer: [
    ...COMMON_RESERVED_KEYS,
    "customer_type",
    "first_name",
    "last_name",
    "organization_name",
    "email",
    "phone",
    "alt_phone",
    "date_of_birth",
    "drivers_license",
    "tax_id",
    "status",
  ],
  account: [
    ...COMMON_RESERVED_KEYS,
    "account_number",
    "customer_id",
    "account_type",
    "status",
    "credit_rating",
    "deposit_amount",
    "deposit_waived",
    "deposit_waived_reason",
    "language_pref",
    "paperless_billing",
    "budget_billing",
    "saaslogic_account_id",
    "closed_at",
  ],
  premise: [
    ...COMMON_RESERVED_KEYS,
    "address_line1",
    "address_line2",
    "city",
    "state",
    "zip",
    "geo_lat",
    "geo_lng",
    "premise_type",
    "commodity_ids",
    "service_territory_id",
    "municipality_code",
    "status",
    "owner_id",
  ],
  meter: [
    ...COMMON_RESERVED_KEYS,
    "premise_id",
    "meter_number",
    "commodity_id",
    "meter_type",
    "uom_id",
    "dial_count",
    "multiplier",
    "install_date",
    "removal_date",
    "status",
    "notes",
  ],
  service_agreement: [
    ...COMMON_RESERVED_KEYS,
    "agreement_number",
    "account_id",
    "premise_id",
    "commodity_id",
    "rate_schedule_id",
    "billing_cycle_id",
    "start_date",
    "end_date",
    "status",
    "read_sequence",
  ],
};

/**
 * Is the given key reserved by a core column on this entity type?
 * Returns true when the key would collide with a built-in field and
 * should be rejected as a custom field key.
 */
export function isReservedFieldKey(
  entityType: CustomFieldEntityType,
  key: string,
): boolean {
  return CORE_FIELD_KEYS[entityType].includes(key);
}
