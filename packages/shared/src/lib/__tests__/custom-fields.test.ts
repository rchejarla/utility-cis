import { describe, it, expect } from "vitest";
import {
  buildZodFromFields,
  fieldDefinitionSchema,
  fieldDefinitionListSchema,
  isReservedFieldKey,
  parseCustomFields,
  defaultDisplayType,
  isValidDisplayType,
  kindForField,
  CORE_FIELD_KEYS,
  CUSTOM_FIELD_KINDS,
  type FieldDefinition,
} from "../custom-fields";

describe("custom-fields shared module", () => {
  describe("fieldDefinitionSchema", () => {
    it("accepts a well-formed string field", () => {
      const parsed = fieldDefinitionSchema.parse({
        key: "tax_id",
        label: "Tax ID",
        type: "string",
        required: false,
        searchable: true,
        order: 10,
        deprecated: false,
      });
      expect(parsed.key).toBe("tax_id");
    });

    it("rejects keys that don't start with a lowercase letter", () => {
      expect(() =>
        fieldDefinitionSchema.parse({
          key: "1bad",
          label: "Bad",
          type: "string",
          required: false,
          searchable: false,
          order: 0,
          deprecated: false,
        }),
      ).toThrow(/lowercase letter/);
    });

    it("rejects keys containing uppercase or dashes", () => {
      expect(() =>
        fieldDefinitionSchema.parse({
          key: "taxId",
          label: "Tax ID",
          type: "string",
          required: false,
          searchable: false,
          order: 0,
          deprecated: false,
        }),
      ).toThrow();
    });

    it("requires enumOptions when type is enum", () => {
      expect(() =>
        fieldDefinitionSchema.parse({
          key: "tier",
          label: "Tier",
          type: "enum",
          required: false,
          searchable: false,
          order: 0,
          deprecated: false,
        }),
      ).toThrow(/enumOptions/);
    });

    it("rejects duplicate enum option values", () => {
      expect(() =>
        fieldDefinitionSchema.parse({
          key: "tier",
          label: "Tier",
          type: "enum",
          required: false,
          searchable: false,
          order: 0,
          deprecated: false,
          enumOptions: [
            { value: "GOLD", label: "Gold" },
            { value: "GOLD", label: "Gold Dup" },
          ],
        }),
      ).toThrow(/Duplicate/);
    });

    it("accepts a well-formed enum field", () => {
      const parsed = fieldDefinitionSchema.parse({
        key: "tier",
        label: "Tier",
        type: "enum",
        required: true,
        searchable: true,
        order: 5,
        deprecated: false,
        enumOptions: [
          { value: "GOLD", label: "Gold" },
          { value: "SILVER", label: "Silver" },
        ],
      });
      expect(parsed.enumOptions).toHaveLength(2);
    });
  });

  describe("fieldDefinitionListSchema", () => {
    it("rejects duplicate keys in the same list", () => {
      expect(() =>
        fieldDefinitionListSchema.parse([
          {
            key: "x",
            label: "X1",
            type: "string",
            required: false,
            searchable: false,
            order: 0,
            deprecated: false,
          },
          {
            key: "x",
            label: "X2",
            type: "number",
            required: false,
            searchable: false,
            order: 1,
            deprecated: false,
          },
        ]),
      ).toThrow(/Duplicate field key/);
    });

    it("accepts an empty list", () => {
      expect(fieldDefinitionListSchema.parse([])).toEqual([]);
    });
  });

  describe("buildZodFromFields", () => {
    function field(partial: Partial<FieldDefinition> & Pick<FieldDefinition, "key" | "type">): FieldDefinition {
      return {
        label: partial.label ?? partial.key,
        required: partial.required ?? false,
        searchable: partial.searchable ?? false,
        order: partial.order ?? 0,
        deprecated: partial.deprecated ?? false,
        ...partial,
      } as FieldDefinition;
    }

    it("validates a simple string payload", () => {
      const validator = buildZodFromFields([field({ key: "tax_id", type: "string" })]);
      expect(validator.parse({ tax_id: "123-45-6789" })).toEqual({ tax_id: "123-45-6789" });
    });

    it("rejects unknown keys via strict mode", () => {
      const validator = buildZodFromFields([field({ key: "tax_id", type: "string" })]);
      expect(() => validator.parse({ tax_id: "x", rogue: "y" })).toThrow();
    });

    it("enforces required on required fields", () => {
      const validator = buildZodFromFields([
        field({ key: "tax_id", type: "string", required: true }),
      ]);
      expect(() => validator.parse({})).toThrow();
    });

    it("allows optional fields to be omitted or explicitly null", () => {
      const validator = buildZodFromFields([field({ key: "note", type: "string" })]);
      expect(validator.parse({})).toEqual({});
      expect(validator.parse({ note: null })).toEqual({ note: null });
      expect(validator.parse({ note: "hello" })).toEqual({ note: "hello" });
    });

    it("coerces number inputs", () => {
      const validator = buildZodFromFields([field({ key: "score", type: "number" })]);
      const parsed = validator.parse({ score: 42 });
      expect(parsed).toEqual({ score: 42 });
    });

    it("rejects non-finite numbers", () => {
      const validator = buildZodFromFields([field({ key: "score", type: "number" })]);
      expect(() => validator.parse({ score: Infinity })).toThrow();
    });

    it("validates dates as ISO date strings", () => {
      const validator = buildZodFromFields([field({ key: "birth", type: "date" })]);
      expect(validator.parse({ birth: "2026-04-11" })).toEqual({ birth: "2026-04-11" });
      expect(() => validator.parse({ birth: "not-a-date" })).toThrow();
    });

    it("validates boolean fields", () => {
      const validator = buildZodFromFields([field({ key: "flag", type: "boolean" })]);
      expect(validator.parse({ flag: true })).toEqual({ flag: true });
      expect(validator.parse({ flag: false })).toEqual({ flag: false });
    });

    it("validates enum fields against declared options only", () => {
      const validator = buildZodFromFields([
        field({
          key: "tier",
          type: "enum",
          enumOptions: [
            { value: "GOLD", label: "Gold" },
            { value: "SILVER", label: "Silver" },
          ],
        }),
      ]);
      expect(validator.parse({ tier: "GOLD" })).toEqual({ tier: "GOLD" });
      expect(() => validator.parse({ tier: "BRONZE" })).toThrow();
    });

    it("skips deprecated fields entirely from the validator", () => {
      const validator = buildZodFromFields([
        field({ key: "live", type: "string" }),
        field({ key: "old", type: "string", deprecated: true }),
      ]);
      // Deprecated field is not known to the validator so writing it
      // back on a new payload is rejected (prevents accidental writes).
      expect(() => validator.parse({ live: "yes", old: "still here" })).toThrow();
      expect(validator.parse({ live: "yes" })).toEqual({ live: "yes" });
    });

    it("throws when an enum field has no options at build time", () => {
      // fieldDefinitionSchema would catch this at save time, but the
      // builder has its own defensive guard in case an older stored
      // row somehow slipped through.
      expect(() =>
        buildZodFromFields([
          { ...field({ key: "tier", type: "enum" }), enumOptions: [] },
        ]),
      ).toThrow(/no options/);
    });

    it("parseCustomFields is a thin wrapper that returns the parsed object", () => {
      const result = parseCustomFields(
        [field({ key: "live_key", type: "string" })],
        { live_key: "abc" },
      );
      expect(result).toEqual({ live_key: "abc" });
    });
  });

  describe("isReservedFieldKey", () => {
    it("returns true for core customer columns", () => {
      expect(isReservedFieldKey("customer", "tax_id")).toBe(true);
      expect(isReservedFieldKey("customer", "first_name")).toBe(true);
      expect(isReservedFieldKey("customer", "email")).toBe(true);
      expect(isReservedFieldKey("customer", "status")).toBe(true);
    });

    it("returns true for system metadata columns on every entity", () => {
      for (const entity of ["customer", "account", "premise", "meter", "service_agreement"] as const) {
        expect(isReservedFieldKey(entity, "id")).toBe(true);
        expect(isReservedFieldKey(entity, "utility_id")).toBe(true);
        expect(isReservedFieldKey(entity, "custom_fields")).toBe(true);
        expect(isReservedFieldKey(entity, "created_at")).toBe(true);
        expect(isReservedFieldKey(entity, "updated_at")).toBe(true);
      }
    });

    it("returns true for entity-specific core columns", () => {
      expect(isReservedFieldKey("account", "account_number")).toBe(true);
      expect(isReservedFieldKey("premise", "address_line1")).toBe(true);
      expect(isReservedFieldKey("meter", "meter_number")).toBe(true);
      expect(isReservedFieldKey("service_agreement", "agreement_number")).toBe(true);
    });

    it("returns false for keys that don't match any core column", () => {
      expect(isReservedFieldKey("customer", "membership_tier")).toBe(false);
      expect(isReservedFieldKey("customer", "favorite_color")).toBe(false);
      expect(isReservedFieldKey("account", "referral_source")).toBe(false);
      expect(isReservedFieldKey("meter", "warranty_end")).toBe(false);
    });

    it("is case-sensitive (uppercase variants are not reserved)", () => {
      // The custom field key regex already forces lowercase, but we
      // still confirm the check itself is case-sensitive so an admin
      // who somehow bypassed the regex can't sneak past with MiXeDcAsE.
      expect(isReservedFieldKey("customer", "TAX_ID")).toBe(false);
      expect(isReservedFieldKey("customer", "Tax_Id")).toBe(false);
    });

    it("every entity has at least the common reserved keys", () => {
      for (const entity of ["customer", "account", "premise", "meter", "service_agreement"] as const) {
        expect(CORE_FIELD_KEYS[entity]).toContain("id");
        expect(CORE_FIELD_KEYS[entity]).toContain("utility_id");
        expect(CORE_FIELD_KEYS[entity]).toContain("custom_fields");
      }
    });
  });

  describe("displayType", () => {
    it("defaultDisplayType returns the first allowed display per data type", () => {
      expect(defaultDisplayType("string")).toBe("text");
      expect(defaultDisplayType("number")).toBe("number");
      expect(defaultDisplayType("date")).toBe("date");
      expect(defaultDisplayType("boolean")).toBe("checkbox");
      expect(defaultDisplayType("enum")).toBe("select");
    });

    it("isValidDisplayType accepts all string display types", () => {
      expect(isValidDisplayType("string", "text")).toBe(true);
      expect(isValidDisplayType("string", "textarea")).toBe(true);
      expect(isValidDisplayType("string", "email")).toBe(true);
      expect(isValidDisplayType("string", "url")).toBe(true);
      expect(isValidDisplayType("string", "phone")).toBe(true);
    });

    it("isValidDisplayType rejects mismatched pairs", () => {
      expect(isValidDisplayType("number", "textarea")).toBe(false);
      expect(isValidDisplayType("boolean", "text")).toBe(false);
      expect(isValidDisplayType("string", "radio")).toBe(false);
      expect(isValidDisplayType("enum", "checkbox")).toBe(false);
      expect(isValidDisplayType("date", "select")).toBe(false);
    });

    it("accepts enum displayType of radio (not just select)", () => {
      expect(isValidDisplayType("enum", "select")).toBe(true);
      expect(isValidDisplayType("enum", "radio")).toBe(true);
    });

    it("date data type only allows 'date' display for now (datetime deferred to Phase 2)", () => {
      expect(isValidDisplayType("date", "date")).toBe(true);
      // datetime is intentionally not in the display type enum —
      // it needs a separate data type with z.string().datetime()
      // validation, which is a Phase 2 scope item.
    });

    it("fieldDefinitionSchema accepts a valid displayType", () => {
      const parsed = fieldDefinitionSchema.parse({
        key: "bio",
        label: "Bio",
        type: "string",
        displayType: "textarea",
        required: false,
        searchable: false,
        order: 10,
        deprecated: false,
      });
      expect(parsed.displayType).toBe("textarea");
    });

    it("fieldDefinitionSchema rejects displayType that doesn't match data type", () => {
      expect(() =>
        fieldDefinitionSchema.parse({
          key: "score",
          label: "Score",
          type: "number",
          displayType: "textarea",
          required: false,
          searchable: false,
          order: 10,
          deprecated: false,
        }),
      ).toThrow(/Display type/);
    });

    it("fieldDefinitionSchema allows displayType to be omitted", () => {
      const parsed = fieldDefinitionSchema.parse({
        key: "name",
        label: "Name",
        type: "string",
        required: false,
        searchable: false,
        order: 10,
        deprecated: false,
      });
      expect(parsed.displayType).toBeUndefined();
    });

    it("fieldDefinitionSchema accepts enum with radio displayType", () => {
      const parsed = fieldDefinitionSchema.parse({
        key: "tier",
        label: "Tier",
        type: "enum",
        displayType: "radio",
        required: false,
        searchable: false,
        order: 10,
        deprecated: false,
        enumOptions: [
          { value: "GOLD", label: "Gold" },
          { value: "SILVER", label: "Silver" },
        ],
      });
      expect(parsed.displayType).toBe("radio");
    });
  });

  describe("CUSTOM_FIELD_KINDS", () => {
    it("includes the expected user-facing kinds", () => {
      const values = CUSTOM_FIELD_KINDS.map((k) => k.value);
      expect(values).toContain("text");
      expect(values).toContain("textarea");
      expect(values).toContain("email");
      expect(values).toContain("dropdown");
      expect(values).toContain("radio");
      expect(values).toContain("checkbox");
      expect(values).toContain("date");
      // datetime is intentionally not in the list — deferred to
      // Phase 2 (needs a separate data type with datetime validator).
      expect(values).not.toContain("datetime");
    });

    it("dropdown and radio kinds have hasOptions=true, others have hasOptions=false", () => {
      const dropdown = CUSTOM_FIELD_KINDS.find((k) => k.value === "dropdown");
      const radio = CUSTOM_FIELD_KINDS.find((k) => k.value === "radio");
      const text = CUSTOM_FIELD_KINDS.find((k) => k.value === "text");
      const checkbox = CUSTOM_FIELD_KINDS.find((k) => k.value === "checkbox");
      expect(dropdown?.hasOptions).toBe(true);
      expect(radio?.hasOptions).toBe(true);
      expect(text?.hasOptions).toBe(false);
      expect(checkbox?.hasOptions).toBe(false);
    });

    it("every kind maps to a valid (dataType, displayType) pair", () => {
      for (const kind of CUSTOM_FIELD_KINDS) {
        expect(isValidDisplayType(kind.dataType, kind.displayType)).toBe(true);
      }
    });

    it("kindForField finds the matching Kind for a stored field", () => {
      const textarea = kindForField({ type: "string", displayType: "textarea" });
      expect(textarea.value).toBe("textarea");

      const radio = kindForField({ type: "enum", displayType: "radio" });
      expect(radio.value).toBe("radio");
    });

    it("kindForField falls back to the default display when no displayType is stored", () => {
      // A legacy field created before the displayType concept existed
      // has just `type: "string"` and no displayType. kindForField
      // should treat it as "text" (the default for string).
      const legacy = kindForField({ type: "string" });
      expect(legacy.value).toBe("text");

      const legacyEnum = kindForField({ type: "enum" });
      expect(legacyEnum.value).toBe("dropdown");
    });
  });
});
