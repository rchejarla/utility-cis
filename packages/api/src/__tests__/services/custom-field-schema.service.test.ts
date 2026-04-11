import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  addCustomField,
  deleteCustomField,
  replaceCustomFieldSchema,
  validateCustomFields,
  _resetCustomFieldCache,
} from "../../services/custom-field-schema.service.js";
import { prisma } from "../../lib/prisma.js";
import type { FieldDefinition } from "@utility-cis/shared";

/**
 * Service-layer tests for validateCustomFields.
 *
 * Focus: the happy path and the rejection paths that matter at the
 * boundary — wrong shape, unknown fields, missing required, type
 * mismatch, create vs update merge semantics.
 *
 * The full Zod-builder test matrix lives in the shared package.
 * These tests verify the service layer's wiring around it.
 */

const UID = "00000000-0000-4000-8000-00000000000a";

function field(partial: Partial<FieldDefinition> & Pick<FieldDefinition, "key" | "type">): FieldDefinition {
  return {
    label: partial.key,
    required: false,
    searchable: false,
    order: 0,
    deprecated: false,
    ...partial,
  } as FieldDefinition;
}

describe("validateCustomFields", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetCustomFieldCache();
  });

  function stubSchema(fields: FieldDefinition[]) {
    (prisma.customFieldSchema.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      utilityId: UID,
      entityType: "customer",
      fields: fields as unknown as object,
      version: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }

  describe("no tenant schema configured", () => {
    beforeEach(() => {
      (prisma.customFieldSchema.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    });

    it("returns empty object when payload is undefined and no schema exists", async () => {
      const result = await validateCustomFields(UID, "customer", undefined, {
        mode: "create",
      });
      expect(result).toEqual({});
    });

    it("returns empty object when payload is empty object and no schema exists", async () => {
      const result = await validateCustomFields(UID, "customer", {}, {
        mode: "create",
      });
      expect(result).toEqual({});
    });

    it("rejects non-empty payload when no schema is configured", async () => {
      await expect(
        validateCustomFields(UID, "customer", { rogue: "x" }, { mode: "create" }),
      ).rejects.toMatchObject({
        statusCode: 400,
        code: "CUSTOM_FIELDS_NOT_CONFIGURED",
      });
    });
  });

  describe("shape validation", () => {
    it("rejects a non-object payload", async () => {
      await expect(
        validateCustomFields(UID, "customer", "not-an-object", { mode: "create" }),
      ).rejects.toMatchObject({
        statusCode: 400,
        code: "CUSTOM_FIELDS_SHAPE",
      });
    });

    it("rejects an array payload", async () => {
      await expect(
        validateCustomFields(UID, "customer", ["nope"], { mode: "create" }),
      ).rejects.toMatchObject({
        statusCode: 400,
        code: "CUSTOM_FIELDS_SHAPE",
      });
    });
  });

  describe("with configured schema", () => {
    it("accepts a well-formed payload on create", async () => {
      stubSchema([field({ key: "tax_id", type: "string" })]);

      const result = await validateCustomFields(
        UID,
        "customer",
        { tax_id: "abc123" },
        { mode: "create" },
      );
      expect(result).toEqual({ tax_id: "abc123" });
    });

    it("rejects unknown keys with CUSTOM_FIELDS_INVALID", async () => {
      stubSchema([field({ key: "tax_id", type: "string" })]);

      await expect(
        validateCustomFields(UID, "customer", { rogue: "x" }, { mode: "create" }),
      ).rejects.toMatchObject({
        statusCode: 400,
        code: "CUSTOM_FIELDS_INVALID",
      });
    });

    it("rejects missing required fields on create", async () => {
      stubSchema([field({ key: "tax_id", type: "string", required: true })]);

      await expect(
        validateCustomFields(UID, "customer", {}, { mode: "create" }),
      ).rejects.toMatchObject({
        statusCode: 400,
        code: "CUSTOM_FIELDS_INVALID",
      });
    });

    it("on update, merges stored values so required fields don't need to be resent", async () => {
      stubSchema([field({ key: "tax_id", type: "string", required: true })]);

      // User stored tax_id earlier, now patches a (non-existent)
      // optional field. The required field should inherit from the
      // stored state and the patch should succeed.
      const result = await validateCustomFields(
        UID,
        "customer",
        {}, // empty patch
        {
          mode: "update",
          existingStored: { tax_id: "old-value" },
        },
      );
      expect(result.tax_id).toBe("old-value");
    });

    it("on update, the patch takes precedence over stored values", async () => {
      stubSchema([field({ key: "tax_id", type: "string" })]);

      const result = await validateCustomFields(
        UID,
        "customer",
        { tax_id: "new-value" },
        {
          mode: "update",
          existingStored: { tax_id: "old-value" },
        },
      );
      expect(result.tax_id).toBe("new-value");
    });

    it("rejects a type mismatch (string in a number field)", async () => {
      stubSchema([field({ key: "score", type: "number" })]);

      await expect(
        validateCustomFields(
          UID,
          "customer",
          { score: "not a number" },
          { mode: "create" },
        ),
      ).rejects.toMatchObject({ statusCode: 400 });
    });

    it("validates enum fields against declared options", async () => {
      stubSchema([
        field({
          key: "tier",
          type: "enum",
          enumOptions: [
            { value: "GOLD", label: "Gold" },
            { value: "SILVER", label: "Silver" },
          ],
        }),
      ]);

      await expect(
        validateCustomFields(UID, "customer", { tier: "BRONZE" }, { mode: "create" }),
      ).rejects.toMatchObject({ statusCode: 400 });

      const ok = await validateCustomFields(
        UID,
        "customer",
        { tier: "GOLD" },
        { mode: "create" },
      );
      expect(ok.tier).toBe("GOLD");
    });

    it("preserves deprecated stored values on update without re-validating them", async () => {
      // Admin deprecated `old` after the customer row was already
      // written with `old: "legacy-value"`. A later update should:
      //   1. not fail (the deprecated key exists in storage but is
      //      not allowed as an input)
      //   2. return a result that still contains `old: "legacy-value"`
      //      so the downstream prisma.update doesn't accidentally
      //      erase it from the jsonb column
      stubSchema([
        field({ key: "live", type: "string" }),
        field({ key: "old", type: "string", deprecated: true }),
      ]);

      const result = await validateCustomFields(
        UID,
        "customer",
        { live: "new-value" },
        {
          mode: "update",
          existingStored: { live: "old-value", old: "legacy-value" },
        },
      );
      expect(result).toEqual({
        live: "new-value",
        old: "legacy-value",
      });
    });

    it("rejects inbound writes to deprecated fields", async () => {
      // The caller should never try to write a deprecated field.
      // Unlike the preservation test above, this time the client
      // explicitly sends a value for the deprecated key — the
      // validator's strict mode rejects it.
      stubSchema([
        field({ key: "live", type: "string" }),
        field({ key: "old", type: "string", deprecated: true }),
      ]);

      await expect(
        validateCustomFields(
          UID,
          "customer",
          { live: "x", old: "rogue-write" },
          { mode: "create" },
        ),
      ).rejects.toMatchObject({ statusCode: 400, code: "CUSTOM_FIELDS_INVALID" });
    });
  });
});

describe("reserved-key rejection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetCustomFieldCache();
    // Default state for mutation tests: no existing schema.
    (prisma.customFieldSchema.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    (prisma.customFieldSchema.upsert as ReturnType<typeof vi.fn>).mockImplementation(
      async (args: { create?: unknown; update?: unknown }) => ({
        utilityId: UID,
        entityType: "customer",
        fields: (args.create as { fields?: unknown })?.fields ?? [],
        version: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
    );
  });

  it("addCustomField rejects a reserved customer column key", async () => {
    await expect(
      addCustomField(UID, "customer", {
        key: "tax_id", // collides with core customer.tax_id column
        label: "Tax ID",
        type: "string",
        required: false,
        searchable: false,
        order: 0,
        deprecated: false,
      }),
    ).rejects.toMatchObject({
      statusCode: 400,
      code: "CUSTOM_FIELD_KEY_RESERVED",
    });
  });

  it("addCustomField rejects a system metadata key like 'id'", async () => {
    await expect(
      addCustomField(UID, "customer", {
        key: "id",
        label: "ID",
        type: "string",
        required: false,
        searchable: false,
        order: 0,
        deprecated: false,
      }),
    ).rejects.toMatchObject({
      statusCode: 400,
      code: "CUSTOM_FIELD_KEY_RESERVED",
    });
  });

  it("addCustomField rejects the custom_fields key itself", async () => {
    // Edge case: the jsonb column name shouldn't be usable as its
    // own contents, even though it's syntactically a valid key.
    await expect(
      addCustomField(UID, "meter", {
        key: "custom_fields",
        label: "Custom Fields",
        type: "string",
        required: false,
        searchable: false,
        order: 0,
        deprecated: false,
      }),
    ).rejects.toMatchObject({
      statusCode: 400,
      code: "CUSTOM_FIELD_KEY_RESERVED",
    });
  });

  it("addCustomField accepts a non-reserved key", async () => {
    const result = await addCustomField(UID, "customer", {
      key: "membership_tier",
      label: "Membership Tier",
      type: "string",
      required: false,
      searchable: false,
      order: 0,
      deprecated: false,
    });
    expect(result.entityType).toBe("customer");
    expect(result.fields).toHaveLength(1);
    expect(result.fields[0].key).toBe("membership_tier");
  });

  it("replaceCustomFieldSchema rejects a list containing a reserved key", async () => {
    await expect(
      replaceCustomFieldSchema(UID, "account", [
        {
          key: "favorite_metric",
          label: "Favorite Metric",
          type: "string",
          required: false,
          searchable: false,
          order: 0,
          deprecated: false,
        },
        {
          key: "account_number", // collides with core account.account_number column
          label: "Account Number (custom)",
          type: "string",
          required: false,
          searchable: false,
          order: 1,
          deprecated: false,
        },
      ]),
    ).rejects.toMatchObject({
      statusCode: 400,
      code: "CUSTOM_FIELD_KEY_RESERVED",
    });
  });

  it("reserved-key check is enforced per-entity (same key may be valid on another entity if not reserved there)", async () => {
    // `meter_number` is reserved on meter but not on customer, so a
    // customer custom field with that key should be accepted. The
    // test confirms isReservedFieldKey is entity-scoped rather than
    // globally pooled.
    const result = await addCustomField(UID, "customer", {
      key: "meter_number",
      label: "Preferred Meter",
      type: "string",
      required: false,
      searchable: false,
      order: 0,
      deprecated: false,
    });
    expect(result.fields[0].key).toBe("meter_number");
  });
});

describe("deleteCustomField", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetCustomFieldCache();
  });

  function stubSchemaWithField(fieldKey: string) {
    (prisma.customFieldSchema.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      utilityId: UID,
      entityType: "customer",
      fields: [
        field({ key: fieldKey, type: "string" }),
        field({ key: "other", type: "string" }),
      ] as unknown as object,
      version: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    (prisma.customFieldSchema.upsert as ReturnType<typeof vi.fn>).mockImplementation(
      async (args: { create?: unknown; update?: unknown }) => ({
        utilityId: UID,
        entityType: "customer",
        fields: (args.update as { fields?: unknown })?.fields ?? [],
        version: 2,
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
    );
  }

  it("returns 404 when no schema exists for the entity", async () => {
    (prisma.customFieldSchema.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    await expect(
      deleteCustomField(UID, "customer", "nonexistent"),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("returns 404 when the field isn't in the schema", async () => {
    stubSchemaWithField("favorite_color");

    await expect(
      deleteCustomField(UID, "customer", "not_a_field"),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("deletes cleanly when no rows contain data for the field", async () => {
    stubSchemaWithField("favorite_color");
    // No rows have the key
    (prisma.$queryRawUnsafe as ReturnType<typeof vi.fn>).mockResolvedValue([{ count: 0 }]);

    const result = await deleteCustomField(UID, "customer", "favorite_color");
    expect(result.fields.find((f) => f.key === "favorite_color")).toBeUndefined();
    // The scrub UPDATE should NOT have run because there was no data
    expect(prisma.$executeRawUnsafe).not.toHaveBeenCalled();
  });

  it("refuses to delete when data exists and force is not set", async () => {
    stubSchemaWithField("favorite_color");
    (prisma.$queryRawUnsafe as ReturnType<typeof vi.fn>).mockResolvedValue([{ count: 42 }]);

    await expect(
      deleteCustomField(UID, "customer", "favorite_color"),
    ).rejects.toMatchObject({
      statusCode: 400,
      code: "CUSTOM_FIELD_HAS_DATA",
    });
    // No destructive work should have happened
    expect(prisma.$executeRawUnsafe).not.toHaveBeenCalled();
    expect(prisma.customFieldSchema.upsert).not.toHaveBeenCalled();
  });

  it("includes the row count in the error so the UI can show it", async () => {
    stubSchemaWithField("favorite_color");
    (prisma.$queryRawUnsafe as ReturnType<typeof vi.fn>).mockResolvedValue([{ count: 7 }]);

    try {
      await deleteCustomField(UID, "customer", "favorite_color");
      throw new Error("should have thrown");
    } catch (err) {
      const e = err as Error & { meta?: { rowCount?: number }; message: string };
      expect(e.meta?.rowCount).toBe(7);
      expect(e.message).toContain("7");
    }
  });

  it("force-deletes data by running the scrub UPDATE then removing the field", async () => {
    stubSchemaWithField("favorite_color");
    (prisma.$queryRawUnsafe as ReturnType<typeof vi.fn>).mockResolvedValue([{ count: 3 }]);

    const result = await deleteCustomField(UID, "customer", "favorite_color", {
      force: true,
    });

    // Scrub ran
    expect(prisma.$executeRawUnsafe).toHaveBeenCalledTimes(1);
    const scrubCall = (prisma.$executeRawUnsafe as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(scrubCall[0]).toContain("UPDATE customer");
    expect(scrubCall[0]).toContain("custom_fields - $2");
    expect(scrubCall[1]).toBe(UID);
    expect(scrubCall[2]).toBe("favorite_color");

    // Field is removed from the schema
    expect(result.fields.find((f) => f.key === "favorite_color")).toBeUndefined();
  });

  it("force with no data is a safe no-op scrub", async () => {
    stubSchemaWithField("favorite_color");
    (prisma.$queryRawUnsafe as ReturnType<typeof vi.fn>).mockResolvedValue([{ count: 0 }]);

    await deleteCustomField(UID, "customer", "favorite_color", { force: true });

    // Count was 0, so the scrub UPDATE is skipped entirely
    expect(prisma.$executeRawUnsafe).not.toHaveBeenCalled();
  });

  it("targets the correct table per entity type", async () => {
    // Verify the service picks the right table for the scrub query
    // based on entityType, not a global default.
    (prisma.customFieldSchema.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      utilityId: UID,
      entityType: "meter",
      fields: [field({ key: "warranty_end", type: "date" })] as unknown as object,
      version: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    (prisma.customFieldSchema.upsert as ReturnType<typeof vi.fn>).mockResolvedValue({
      utilityId: UID,
      entityType: "meter",
      fields: [],
      version: 2,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    (prisma.$queryRawUnsafe as ReturnType<typeof vi.fn>).mockResolvedValue([{ count: 5 }]);

    await deleteCustomField(UID, "meter", "warranty_end", { force: true });

    const scrubCall = (prisma.$executeRawUnsafe as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(scrubCall[0]).toContain("UPDATE meter");
    // Should not accidentally touch customer or another table
    expect(scrubCall[0]).not.toContain("customer");
    expect(scrubCall[0]).not.toContain("premise");
  });
});
