import { prisma } from "../lib/prisma.js";
import {
  buildZodFromFields,
  fieldDefinitionListSchema,
  fieldDefinitionSchema,
  isReservedFieldKey,
  updateFieldDefinitionSchema,
  type CustomFieldEntityType,
  type CustomFieldSchemaDTO,
  type FieldDefinition,
} from "@utility-cis/shared";

/**
 * Service for managing tenant-configurable custom field schemas.
 *
 * One row per (utility_id, entity_type) in custom_field_schema. The
 * `fields` jsonb column holds a FieldDefinition[] array — this service
 * is the only place that reads or writes that structure.
 *
 * Consumed in two distinct flows:
 *
 *   1. **Admin CRUD**: a tenant admin uses the settings UI to add,
 *      edit, deprecate, or mark-searchable individual fields. Each
 *      mutation rewrites the whole row's `fields` array in one
 *      update — there is no row-per-field model.
 *
 *   2. **Write-time validation on core entities**: when a service
 *      like createCustomer receives a request with a `customFields`
 *      key, it calls `validateCustomFields(utilityId, "customer",
 *      data)` which loads the schema, builds a Zod validator, and
 *      rejects any payload that doesn't match. See wiring in
 *      customer.service.ts.
 *
 * Caching: the active schema per (utility, entity) is cached in
 * memory with a short TTL so every write doesn't re-query the
 * custom_field_schema table. The cache is invalidated on any mutation
 * the service itself performs. Cross-instance invalidation (e.g. a
 * second API replica updating a schema) is NOT handled in v1 — the
 * hold scheduler has the same single-instance assumption and the
 * same fix (BullMQ/Redis) would cover both.
 */

// ─── In-memory cache ────────────────────────────────────────────────

interface CacheEntry {
  schema: FieldDefinition[];
  fetchedAt: number;
}

const CACHE_TTL_MS = 60_000;
const cache = new Map<string, CacheEntry>();

function cacheKey(utilityId: string, entityType: CustomFieldEntityType): string {
  return `${utilityId}:${entityType}`;
}

function invalidate(utilityId: string, entityType: CustomFieldEntityType): void {
  cache.delete(cacheKey(utilityId, entityType));
}

async function readThroughCache(
  utilityId: string,
  entityType: CustomFieldEntityType,
): Promise<FieldDefinition[]> {
  const key = cacheKey(utilityId, entityType);
  const now = Date.now();
  const cached = cache.get(key);
  if (cached && now - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.schema;
  }

  const row = await prisma.customFieldSchema.findUnique({
    where: { utilityId_entityType: { utilityId, entityType } },
  });
  const fields = row ? ((row.fields as unknown) as FieldDefinition[]) : [];
  cache.set(key, { schema: fields, fetchedAt: now });
  return fields;
}

// ─── Public API ─────────────────────────────────────────────────────

function toDto(
  utilityId: string,
  entityType: CustomFieldEntityType,
  row: { fields: unknown; version: number; updatedAt: Date } | null,
): CustomFieldSchemaDTO {
  return {
    utilityId,
    entityType,
    fields: row ? ((row.fields as unknown) as FieldDefinition[]) : [],
    version: row?.version ?? 1,
    updatedAt: (row?.updatedAt ?? new Date()).toISOString(),
  };
}

export async function getCustomFieldSchema(
  utilityId: string,
  entityType: CustomFieldEntityType,
): Promise<CustomFieldSchemaDTO> {
  const row = await prisma.customFieldSchema.findUnique({
    where: { utilityId_entityType: { utilityId, entityType } },
  });
  return toDto(utilityId, entityType, row);
}

/**
 * Replace the entire field list for an entity. Used by bulk-editor
 * flows. Validates the incoming list (rejects duplicate keys,
 * enforces enum-option invariants, etc.) and refuses any field whose
 * key collides with a core column on the entity type.
 */
export async function replaceCustomFieldSchema(
  utilityId: string,
  entityType: CustomFieldEntityType,
  rawFields: unknown,
): Promise<CustomFieldSchemaDTO> {
  const fields = fieldDefinitionListSchema.parse(rawFields);

  // Reject reserved key collisions. Checked for every incoming field
  // (not just new ones) so even bulk imports can't sneak a conflict
  // in. The first collision is reported — admins fix one at a time.
  for (const field of fields) {
    if (isReservedFieldKey(entityType, field.key)) {
      throw Object.assign(
        new Error(
          `Field key "${field.key}" is reserved — it matches a core column on ${entityType}. Pick a different key.`,
        ),
        { statusCode: 400, code: "CUSTOM_FIELD_KEY_RESERVED" },
      );
    }
  }

  const row = await prisma.customFieldSchema.upsert({
    where: { utilityId_entityType: { utilityId, entityType } },
    update: {
      fields: fields as unknown as object,
      version: { increment: 1 },
    },
    create: {
      utilityId,
      entityType,
      fields: fields as unknown as object,
      version: 1,
    },
  });

  invalidate(utilityId, entityType);
  return toDto(utilityId, entityType, row);
}

/**
 * Append a single field to the entity's schema. Rejects duplicate
 * keys (the admin UI should prevent these at the form level too) and
 * rejects reserved keys that would collide with a core column on
 * this entity type.
 */
export async function addCustomField(
  utilityId: string,
  entityType: CustomFieldEntityType,
  rawField: unknown,
): Promise<CustomFieldSchemaDTO> {
  const parsed = fieldDefinitionSchema.parse(rawField);

  // Reserved-key check runs BEFORE the duplicate check because a
  // collision with a core column is more serious than a tenant-local
  // duplicate — the former leaks into core field serialization, the
  // latter just means the tenant already added it.
  if (isReservedFieldKey(entityType, parsed.key)) {
    throw Object.assign(
      new Error(
        `Field key "${parsed.key}" is reserved — it matches a core column on ${entityType}. Pick a different key.`,
      ),
      { statusCode: 400, code: "CUSTOM_FIELD_KEY_RESERVED" },
    );
  }

  const existing = await prisma.customFieldSchema.findUnique({
    where: { utilityId_entityType: { utilityId, entityType } },
  });
  const current = existing ? ((existing.fields as unknown) as FieldDefinition[]) : [];

  if (current.some((f) => f.key === parsed.key)) {
    throw Object.assign(
      new Error(`Field key "${parsed.key}" already exists`),
      { statusCode: 400, code: "CUSTOM_FIELD_KEY_EXISTS" },
    );
  }

  const next = [...current, parsed];
  return replaceCustomFieldSchema(utilityId, entityType, next);
}

/**
 * Patch an individual field by key (metadata only — key itself is
 * immutable). Not found returns 404.
 */
export async function updateCustomField(
  utilityId: string,
  entityType: CustomFieldEntityType,
  fieldKey: string,
  patch: unknown,
): Promise<CustomFieldSchemaDTO> {
  const parsedPatch = updateFieldDefinitionSchema.parse(patch);

  const existing = await prisma.customFieldSchema.findUnique({
    where: { utilityId_entityType: { utilityId, entityType } },
  });
  if (!existing) {
    throw Object.assign(new Error("No custom field schema for this entity"), {
      statusCode: 404,
    });
  }
  const current = (existing.fields as unknown) as FieldDefinition[];
  const idx = current.findIndex((f) => f.key === fieldKey);
  if (idx === -1) {
    throw Object.assign(new Error(`Field "${fieldKey}" not found`), {
      statusCode: 404,
    });
  }

  const merged: FieldDefinition = { ...current[idx], ...parsedPatch };
  // Re-run the full field validator on the merged result so invariants
  // (enum options required for type=enum, etc.) hold after the patch.
  fieldDefinitionSchema.parse(merged);

  const next = [...current];
  next[idx] = merged;
  return replaceCustomFieldSchema(utilityId, entityType, next);
}

/**
 * Mark a field deprecated — sugar over updateCustomField. Deprecated
 * fields are hidden from new forms but existing stored values are
 * preserved in the jsonb column indefinitely.
 */
export async function deprecateCustomField(
  utilityId: string,
  entityType: CustomFieldEntityType,
  fieldKey: string,
): Promise<CustomFieldSchemaDTO> {
  return updateCustomField(utilityId, entityType, fieldKey, { deprecated: true });
}

/**
 * Hard-delete a custom field from a tenant's schema. Dangerous because
 * it can orphan or destroy stored values — the default behavior is to
 * refuse when any entity row contains data for the field, returning a
 * row count so the admin can decide whether to deprecate instead or
 * pass `force: true` to scrub the values first.
 *
 * Two-phase execution:
 *   1. Count rows in the entity's table whose custom_fields jsonb has
 *      the target key. Scoped to the tenant via utility_id.
 *   2. If count > 0 and !force → throw 400 CUSTOM_FIELD_HAS_DATA
 *      with the row count in the message so the admin UI can show
 *      a specific confirm dialog.
 *   3. If force → atomically remove the key from every matching row
 *      (`custom_fields = custom_fields - $key`), then remove the
 *      field from the schema list.
 *
 * The entity table name comes from a static whitelist keyed by
 * entityType, so there is no untrusted interpolation into the SQL.
 * The field key is regex-validated by fieldDefinitionSchema before
 * ever reaching this function, so it is also safe to embed in the
 * parameterised query as $2.
 */
const ENTITY_TABLE_NAMES: Record<CustomFieldEntityType, string> = {
  customer: "customer",
  account: "account",
  premise: "premise",
  service_agreement: "service_agreement",
  meter: "meter",
};

export async function deleteCustomField(
  utilityId: string,
  entityType: CustomFieldEntityType,
  fieldKey: string,
  opts: { force?: boolean } = {},
): Promise<CustomFieldSchemaDTO> {
  // Confirm the field exists before touching any data.
  const existing = await prisma.customFieldSchema.findUnique({
    where: { utilityId_entityType: { utilityId, entityType } },
  });
  if (!existing) {
    throw Object.assign(new Error("No custom field schema for this entity"), {
      statusCode: 404,
    });
  }
  const current = (existing.fields as unknown) as FieldDefinition[];
  if (!current.some((f) => f.key === fieldKey)) {
    throw Object.assign(new Error(`Field "${fieldKey}" not found`), {
      statusCode: 404,
    });
  }

  const tableName = ENTITY_TABLE_NAMES[entityType];

  // Count rows that currently hold a value for this key. The
  // `custom_fields ? $2` operator matches any row whose jsonb has
  // the given top-level key, regardless of value.
  const countSql = `SELECT COUNT(*)::int AS count FROM ${tableName} WHERE utility_id = $1::uuid AND custom_fields ? $2`;
  const rows = (await prisma.$queryRawUnsafe(countSql, utilityId, fieldKey)) as Array<{
    count: number;
  }>;
  const dataRowCount = rows[0]?.count ?? 0;

  if (dataRowCount > 0 && !opts.force) {
    throw Object.assign(
      new Error(
        `Cannot delete "${fieldKey}": ${dataRowCount} ${entityType} row(s) contain data for this field. Deprecate instead, or call with force=true to permanently delete the data.`,
      ),
      {
        statusCode: 400,
        code: "CUSTOM_FIELD_HAS_DATA",
        meta: { rowCount: dataRowCount },
      },
    );
  }

  if (dataRowCount > 0) {
    // Force delete path. Atomically remove the key from every
    // matching row's jsonb. The `-` operator returns a new jsonb
    // without the key; scoping by utility_id keeps us within
    // tenant boundaries; scoping by `custom_fields ? $2` means we
    // only touch rows that actually have the key (no unnecessary
    // writes).
    const scrubSql = `UPDATE ${tableName} SET custom_fields = custom_fields - $2 WHERE utility_id = $1::uuid AND custom_fields ? $2`;
    await prisma.$executeRawUnsafe(scrubSql, utilityId, fieldKey);
  }

  // Remove from the schema list and persist.
  const next = current.filter((f) => f.key !== fieldKey);
  return replaceCustomFieldSchema(utilityId, entityType, next);
}

/**
 * Write-time validator used by every core entity service that
 * supports custom fields. Loads the tenant schema via the cache,
 * builds a Zod validator from the field list, and parses the
 * payload. On success returns the parsed payload merged with any
 * existing stored values (so a partial update doesn't clobber
 * fields the caller didn't touch). On failure throws a Zod error
 * with the standard error handler shape.
 *
 * `mode` controls merge behavior:
 *   - "create": treat input as the full set of values; required
 *     fields must all be present.
 *   - "update": treat input as a patch over `existingStored`;
 *     required fields only need to be present if they're being
 *     updated (not in the patch).
 */
export async function validateCustomFields(
  utilityId: string,
  entityType: CustomFieldEntityType,
  payload: unknown,
  opts: {
    mode: "create" | "update";
    existingStored?: Record<string, unknown>;
  },
): Promise<Record<string, unknown>> {
  // Absent payload is always fine — callers that don't send a
  // customFields key simply skip this validator entirely. This
  // function is only called when the caller explicitly passed one.
  if (payload === undefined || payload === null) {
    return opts.existingStored ?? {};
  }

  if (typeof payload !== "object" || Array.isArray(payload)) {
    throw Object.assign(new Error("customFields must be an object"), {
      statusCode: 400,
      code: "CUSTOM_FIELDS_SHAPE",
    });
  }

  const fields = await readThroughCache(utilityId, entityType);
  if (fields.length === 0) {
    // Tenant hasn't configured any custom fields — the payload must
    // be empty. Anything else means the client is sending keys the
    // tenant never declared.
    if (Object.keys(payload as object).length > 0) {
      throw Object.assign(
        new Error(
          `customFields is non-empty but no custom fields are configured for ${entityType}`,
        ),
        { statusCode: 400, code: "CUSTOM_FIELDS_NOT_CONFIGURED" },
      );
    }
    return {};
  }

  // For update mode, merge stored values + patch so partial updates
  // don't fail on required fields the caller didn't resend. But the
  // merge must filter stored values down to keys that are still
  // in the active (non-deprecated) field set — otherwise a field
  // the admin deprecated after the row was written would leak into
  // the validator and trip strict mode. Deprecated stored values
  // are preserved separately and re-attached to the validator's
  // output before we return, so the column keeps its historical
  // shape.
  const activeKeys = new Set(fields.filter((f) => !f.deprecated).map((f) => f.key));
  const deprecatedStored: Record<string, unknown> = {};
  let validationInput: Record<string, unknown>;

  if (opts.mode === "update" && opts.existingStored) {
    const activeStored: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(opts.existingStored)) {
      if (activeKeys.has(k)) {
        activeStored[k] = v;
      } else {
        deprecatedStored[k] = v;
      }
    }
    validationInput = { ...activeStored, ...(payload as Record<string, unknown>) };
  } else {
    validationInput = payload as Record<string, unknown>;
  }

  const validator = buildZodFromFields(fields);
  try {
    const parsed = validator.parse(validationInput) as Record<string, unknown>;
    // Re-attach any deprecated stored values so they stay in the
    // jsonb column. The client can never write to them (strict mode
    // in the validator above rejects deprecated keys on new input)
    // but existing rows keep their legacy data indefinitely.
    return { ...deprecatedStored, ...parsed };
  } catch (err) {
    // Let the error handler middleware format the Zod error; just
    // annotate with a consistent status code and error code.
    if (err instanceof Error) {
      (err as { statusCode?: number }).statusCode = 400;
      (err as { code?: string }).code = "CUSTOM_FIELDS_INVALID";
    }
    throw err;
  }
}

// Test hook — let the test suite reset the cache between cases.
export function _resetCustomFieldCache(): void {
  cache.clear();
}
