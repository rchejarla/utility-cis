import { describe, it, expect } from "vitest";
import type { FieldDefinition } from "@utility-cis/shared";
import {
  CUSTOM_FIELD_PREFIX,
  asCanonicalFields,
  extractCustomFields,
} from "../../imports/custom-fields.js";

/**
 * Custom fields on an import row.
 *
 * A tenant's extra facts live in `custom_field_schema.fields` and are
 * declared per tenant, so the static handler list cannot name them —
 * they are appended to a kind's canonical fields per request, prefixed
 * so they cannot collide with a core column.
 *
 * This matters beyond tidiness: stormwater is priced from
 * `premise:attr:eru_count`, which is a premise custom field. Before
 * this, a bulk-loaded premise arrived with `customFields = {}` and its
 * stormwater component found nothing to rate on, so a migrated tenant
 * had to have every ERU count typed in by hand.
 *
 * **Everything out of a CSV is a string**, which is the whole
 * difficulty. `buildZodFromFields` is built for JSON bodies and uses
 * `z.coerce.boolean()` — and `Boolean("false")` is `true`, so handing
 * it raw cells would turn every "false" in every file into a yes. Each
 * declared type is therefore converted here first, and only then
 * validated against the tenant's own schema.
 */

function def(over: Partial<FieldDefinition> & { key: string; type: FieldDefinition["type"] }): FieldDefinition {
  return {
    label: over.key,
    required: false,
    searchable: false,
    order: 1,
    deprecated: false,
    ...over,
  } as FieldDefinition;
}

const DEFS: FieldDefinition[] = [
  def({ key: "eru_count", type: "number", label: "ERU count" }),
  def({ key: "has_stormwater_infra", type: "boolean", label: "Has stormwater infrastructure" }),
  def({ key: "survey_date", type: "date", label: "Survey date" }),
  def({
    key: "basin",
    type: "enum",
    label: "Drainage basin",
    enumOptions: [
      { value: "north", label: "North" },
      { value: "south", label: "South" },
    ],
  }),
];

describe("custom fields offered to the wizard", () => {
  it("prefixes each key so it cannot collide with a core column", () => {
    const fields = asCanonicalFields(DEFS);
    expect(fields.map((f) => f.name)).toEqual([
      "custom:eru_count",
      "custom:has_stormwater_infra",
      "custom:survey_date",
      "custom:basin",
    ]);
    // A premise already has a core `status`; a tenant is free to
    // declare one too, and the prefix is what keeps them apart.
    expect(asCanonicalFields([def({ key: "status", type: "string" })])[0].name).toBe(
      `${CUSTOM_FIELD_PREFIX}status`,
    );
  });

  it("carries the tenant's own label and required flag", () => {
    const fields = asCanonicalFields([
      def({ key: "eru_count", type: "number", label: "ERU count", required: true }),
    ]);
    expect(fields[0]).toMatchObject({ label: "ERU count", required: true });
  });

  it("does not offer a deprecated field", () => {
    const fields = asCanonicalFields([
      def({ key: "old_code", type: "string", deprecated: true }),
      def({ key: "live_code", type: "string" }),
    ]);
    expect(fields.map((f) => f.name)).toEqual(["custom:live_code"]);
  });
});

describe("reading custom fields off a row", () => {
  it("converts the declared types out of their string form", () => {
    const result = extractCustomFields(
      {
        "custom:eru_count": "3.5",
        "custom:has_stormwater_infra": "true",
        "custom:survey_date": "2026-01-15",
        "custom:basin": "north",
      },
      DEFS,
    );
    expect(result).toEqual({
      ok: true,
      values: {
        eru_count: 3.5,
        has_stormwater_infra: true,
        survey_date: "2026-01-15",
        basin: "north",
      },
    });
  });

  it("reads 'false' as false, which a coercing validator would not", () => {
    /*
     * The one that would have been silently wrong in every imported
     * file: `z.coerce.boolean()` is `Boolean(value)`, and every
     * non-empty string is truthy. A column of "false" would have
     * imported as a column of yes.
     */
    for (const no of ["false", "FALSE", "no", "N", "0", "f"]) {
      const result = extractCustomFields({ "custom:has_stormwater_infra": no }, DEFS);
      expect(result, `"${no}" should read as false`).toEqual({
        ok: true,
        values: { has_stormwater_infra: false },
      });
    }
    for (const yes of ["true", "TRUE", "yes", "Y", "1", "t"]) {
      const result = extractCustomFields({ "custom:has_stormwater_infra": yes }, DEFS);
      expect(result).toEqual({ ok: true, values: { has_stormwater_infra: true } });
    }
  });

  it("refuses a boolean it cannot read rather than guessing", () => {
    const result = extractCustomFields({ "custom:has_stormwater_infra": "maybe" }, DEFS);
    expect(result).toMatchObject({ ok: false, code: "INVALID_CUSTOM_FIELD" });
  });

  it("omits an empty cell instead of storing a blank", () => {
    // A CSV has a cell for every column whether or not it means
    // anything. "" is absence, not a value, and storing it would make
    // `eru_count` a string on half the rows.
    const result = extractCustomFields(
      { "custom:eru_count": "", "custom:basin": "   " },
      DEFS,
    );
    expect(result).toEqual({ ok: true, values: {} });
  });

  it("rejects a value the tenant's schema does not allow", () => {
    expect(
      extractCustomFields({ "custom:basin": "east" }, DEFS),
    ).toMatchObject({ ok: false, code: "INVALID_CUSTOM_FIELD" });
    expect(
      extractCustomFields({ "custom:eru_count": "not-a-number" }, DEFS),
    ).toMatchObject({ ok: false, code: "INVALID_CUSTOM_FIELD" });
    expect(
      extractCustomFields({ "custom:survey_date": "15/01/2026" }, DEFS),
    ).toMatchObject({ ok: false, code: "INVALID_CUSTOM_FIELD" });
  });

  it("names the field in the message, because a row has several", () => {
    const result = extractCustomFields({ "custom:basin": "east" }, DEFS);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("basin");
  });

  it("fails a required field that the file left blank", () => {
    const defs = [def({ key: "eru_count", type: "number", required: true })];
    expect(extractCustomFields({ "custom:eru_count": "" }, defs)).toMatchObject({
      ok: false,
      code: "INVALID_CUSTOM_FIELD",
    });
  });

  it("is an empty object when the tenant has declared nothing", () => {
    expect(extractCustomFields({ addressLine1: "1 Main St" }, [])).toEqual({
      ok: true,
      values: {},
    });
  });
});
