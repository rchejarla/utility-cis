import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  customFieldEntityEnum,
  fieldDefinitionListSchema,
  addFieldDefinitionSchema,
  updateFieldDefinitionSchema,
  type CustomFieldEntityType,
} from "@utility-cis/shared";
import {
  getCustomFieldSchema,
  replaceCustomFieldSchema,
  addCustomField,
  updateCustomField,
  deprecateCustomField,
  deleteCustomField,
} from "../services/custom-field-schema.service.js";

/**
 * Routes for managing tenant custom-field schemas.
 *
 * GET is authenticated-any so forms and list pages can load the
 * schema without requiring a specific permission — the data is
 * metadata the UI needs to render itself.
 *
 * All mutations are gated by `settings.EDIT` because changing the
 * schema is a tenant-administration action.
 */

const entityParamSchema = z
  .object({
    entity: customFieldEntityEnum,
  })
  .strict();

const entityAndKeyParamSchema = z
  .object({
    entity: customFieldEntityEnum,
    fieldKey: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z][a-z0-9_]*$/),
  })
  .strict();

const replaceBodySchema = z
  .object({
    fields: fieldDefinitionListSchema,
  })
  .strict();

/*
 * `tenant_profile`, not `settings` (moved 2026-11-03).
 *
 * `settings` is the one key that separates Utility Admin from System
 * Admin — Utility Admin holds `settings: ["VIEW"]` — so it should mean
 * what that role's description says: *system* settings, the things that
 * expose or erase a tenant's data. Keys, retention, the danger zone and
 * which integrations are wired stay there.
 *
 * A custom field definition is not that. It is the tenant's own
 * configuration, which is what `tenant_profile` already means: General,
 * Branding, Numbering, Automation and Custom Fields' menu entry all sit
 * on it. **The menu entry for this screen already gated on
 * `tenant_profile`**, so a Utility Admin was shown Custom Fields and
 * refused on save — the same mismatch Users & Roles had.
 */
export async function customFieldSchemaRoutes(app: FastifyInstance) {
  // Read the full schema for one entity. No module permission — any
  // authenticated user on the tenant can read the shape of their
  // custom fields.
  app.get(
    "/api/v1/custom-fields/:entity",
    async (request, reply) => {
      const { utilityId } = request.user;
      const { entity } = entityParamSchema.parse(request.params);
      const result = await getCustomFieldSchema(utilityId, entity as CustomFieldEntityType);
      return reply.send(result);
    },
  );

  // Replace the full field list. Useful for bulk editor flows or for
  // importing a schema. Validates the whole list for invariants.
  app.put(
    "/api/v1/custom-fields/:entity",
    { config: { module: "tenant_profile", permission: "EDIT" } },
    async (request, reply) => {
      const { utilityId } = request.user;
      const { entity } = entityParamSchema.parse(request.params);
      const body = replaceBodySchema.parse(request.body);
      const result = await replaceCustomFieldSchema(
        utilityId,
        entity as CustomFieldEntityType,
        body.fields,
      );
      return reply.send(result);
    },
  );

  // Append one field. Keys must be unique within an entity.
  app.post(
    "/api/v1/custom-fields/:entity/fields",
    { config: { module: "tenant_profile", permission: "EDIT" } },
    async (request, reply) => {
      const { utilityId } = request.user;
      const { entity } = entityParamSchema.parse(request.params);
      const body = addFieldDefinitionSchema.parse(request.body);
      const result = await addCustomField(
        utilityId,
        entity as CustomFieldEntityType,
        body,
      );
      return reply.status(201).send(result);
    },
  );

  // Patch a field's metadata (label, required, searchable, enum
  // options, etc.). The key itself is immutable and can't be
  // changed through this route.
  app.patch(
    "/api/v1/custom-fields/:entity/fields/:fieldKey",
    { config: { module: "tenant_profile", permission: "EDIT" } },
    async (request, reply) => {
      const { utilityId } = request.user;
      const { entity, fieldKey } = entityAndKeyParamSchema.parse(request.params);
      const body = updateFieldDefinitionSchema.parse(request.body);
      const result = await updateCustomField(
        utilityId,
        entity as CustomFieldEntityType,
        fieldKey,
        body,
      );
      return reply.send(result);
    },
  );

  // Mark a field deprecated — sugar over the PATCH above.
  app.post(
    "/api/v1/custom-fields/:entity/fields/:fieldKey/deprecate",
    { config: { module: "tenant_profile", permission: "EDIT" } },
    async (request, reply) => {
      const { utilityId } = request.user;
      const { entity, fieldKey } = entityAndKeyParamSchema.parse(request.params);
      const result = await deprecateCustomField(
        utilityId,
        entity as CustomFieldEntityType,
        fieldKey,
      );
      return reply.send(result);
    },
  );

  // Hard-delete a field. The `force` query parameter controls the
  // data-safety gate: without it, deletion refuses when any row
  // holds data for the field (CUSTOM_FIELD_HAS_DATA). With
  // ?force=true, the backend scrubs those values from storage
  // atomically and then removes the field from the schema.
  //
  // Gated by settings.DELETE specifically so the permission to
  // destroy custom field data is separable from plain EDIT — the
  // Utility Admin role has it, CSR-level roles don't.
  app.delete(
    "/api/v1/custom-fields/:entity/fields/:fieldKey",
    { config: { module: "tenant_profile", permission: "DELETE" } },
    async (request, reply) => {
      const { utilityId } = request.user;
      const { entity, fieldKey } = entityAndKeyParamSchema.parse(request.params);
      const force = (request.query as { force?: string })?.force === "true";
      const result = await deleteCustomField(
        utilityId,
        entity as CustomFieldEntityType,
        fieldKey,
        { force },
      );
      return reply.send(result);
    },
  );
}
