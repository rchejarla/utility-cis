import {
  parseCustomFields,
  type CanonicalFieldDef,
  type CustomFieldEntityType,
  type FieldDefinition,
} from "@utility-cis/shared";
import { prisma } from "../lib/prisma.js";

/**
 * Tenant-declared custom fields, as import columns.
 *
 * A tenant's extra facts live in `custom_field_schema.fields`, one row
 * per (utility, entity type), so they are not knowable when a handler
 * registers at boot — the registry is static and the same for every
 * tenant. They are appended to a kind's canonical fields per request
 * instead, by `GET /imports/kinds/:kind/fields` and by the mapping
 * validation on POST, which must agree or a column the wizard offered
 * would be refused on submit.
 *
 * Why it matters rather than being a completeness exercise: stormwater
 * is priced from `premise:attr:eru_count`, which is a premise custom
 * field. A bulk-loaded premise used to arrive with `customFields = {}`,
 * so its stormwater component had nothing to rate on and a migrated
 * tenant had to have every ERU count typed in by hand.
 */

/**
 * Prefix on the canonical-field name. A tenant may declare a key that
 * matches a core column — `status` on a premise, say — and the prefix
 * is what keeps the two apart in the mapping the operator submits.
 */
export const CUSTOM_FIELD_PREFIX = "custom:";

/** The tenant's live field definitions for one entity type. */
export async function customFieldDefs(
  utilityId: string,
  entityType: CustomFieldEntityType,
): Promise<FieldDefinition[]> {
  const row = await prisma.customFieldSchema.findFirst({
    where: { utilityId, entityType },
    select: { fields: true },
  });
  if (!row) return [];
  const fields = row.fields as unknown;
  return Array.isArray(fields) ? (fields as FieldDefinition[]) : [];
}

/** The definitions, as columns the wizard can offer. */
export function asCanonicalFields(defs: FieldDefinition[]): CanonicalFieldDef[] {
  return defs
    .filter((d) => !d.deprecated)
    .map((d) => ({
      name: `${CUSTOM_FIELD_PREFIX}${d.key}`,
      label: d.label,
      required: d.required,
      description: d.description,
      // No aliases: a tenant's own key is not something this codebase
      // can guess synonyms for, and auto-detect already matches a
      // header against the canonical name.
    }));
}

/**
 * The `custom:`-prefixed cells of a mapped row, untouched.
 *
 * `parseRow` is synchronous and tenant-blind, so it cannot validate
 * these — it carries them through on the typed row instead, and
 * `processRow` validates them against the definitions `prepareBatch`
 * loaded. Keys keep their prefix so `extractCustomFields` reads them
 * the same way whichever handler passes them.
 */
export function pickCustomCells(raw: Record<string, string>): Record<string, string> {
  const cells: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (key.startsWith(CUSTOM_FIELD_PREFIX)) cells[key] = value;
  }
  return cells;
}

export type CustomFieldExtraction =
  | { ok: true; values: Record<string, unknown> }
  | { ok: false; code: string; message: string };

/** The words a CSV uses for a boolean, since there is no convention. */
const TRUE_WORDS = new Set(["true", "yes", "y", "1", "t"]);
const FALSE_WORDS = new Set(["false", "no", "n", "0", "f"]);

/**
 * Pull the tenant's custom fields out of one mapped row.
 *
 * **Every cell is a string, and that is the whole difficulty.**
 * `buildZodFromFields` is written for JSON bodies: it uses
 * `z.coerce.boolean()`, which is `Boolean(value)`, so every non-empty
 * string is true and a column of "false" would import as a column of
 * yes. Booleans are therefore read here, by word, before the tenant's
 * own schema validates the result. Numbers coerce safely, and a date
 * is expected as `YYYY-MM-DD`, which is what the validator wants.
 *
 * An empty cell is absence, not a value: a CSV carries a cell for every
 * column whether it means anything or not, and storing `""` would make
 * `eru_count` a string on half the rows. A required field left blank
 * then fails validation, which is the right outcome.
 */
export function extractCustomFields(
  raw: Record<string, string>,
  defs: FieldDefinition[],
): CustomFieldExtraction {
  const payload: Record<string, unknown> = {};

  for (const d of defs) {
    if (d.deprecated) continue;
    const cell = (raw[`${CUSTOM_FIELD_PREFIX}${d.key}`] ?? "").trim();
    if (!cell) continue;

    if (d.type === "boolean") {
      const word = cell.toLowerCase();
      if (TRUE_WORDS.has(word)) payload[d.key] = true;
      else if (FALSE_WORDS.has(word)) payload[d.key] = false;
      else {
        return {
          ok: false,
          code: "INVALID_CUSTOM_FIELD",
          message: `"${d.key}" is "${cell}", which is not a yes or a no`,
        };
      }
      continue;
    }

    payload[d.key] = cell;
  }

  try {
    return { ok: true, values: parseCustomFields(defs, payload) };
  } catch (err: unknown) {
    // The row carries several of these, so the message names which.
    const issues = (err as { issues?: Array<{ path?: unknown[]; message?: string }> }).issues;
    const first = issues?.[0];
    const key = Array.isArray(first?.path) ? first?.path.join(".") : undefined;
    return {
      ok: false,
      code: "INVALID_CUSTOM_FIELD",
      message: key
        ? `"${key}": ${first?.message ?? "is not valid for this tenant's schema"}`
        : `A custom field is not valid for this tenant's schema`,
    };
  }
}

/**
 * A kind's canonical fields plus the tenant's custom ones.
 *
 * Used by both the fields endpoint and the POST's mapping validation:
 * if they disagreed, the wizard would offer a column the submit
 * refuses.
 */
export async function canonicalFieldsWithCustom(
  utilityId: string,
  handler: { canonicalFields: CanonicalFieldDef[]; customFieldEntity?: CustomFieldEntityType },
): Promise<CanonicalFieldDef[]> {
  if (!handler.customFieldEntity) return handler.canonicalFields;
  const defs = await customFieldDefs(utilityId, handler.customFieldEntity);
  return [...handler.canonicalFields, ...asCanonicalFields(defs)];
}
