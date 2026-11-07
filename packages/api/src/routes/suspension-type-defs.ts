import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  baseListQuerySchema,
  createSuspensionTypeDefSchema,
  updateSuspensionTypeDefSchema,
} from "@utility-cis/shared";
import {
  listSuspensionTypes,
  createSuspensionType,
  updateSuspensionType,
} from "../services/suspension-type-def.service.js";
import { idParamSchema } from "../lib/route-schemas.js";

// Extends the shared base list query so picker components can attach
// their standard limit/page/search parameters without a 400, while
// still keeping `.strict()` to reject genuinely unknown keys.
const listQuerySchema = baseListQuerySchema
  .extend({
    includeInactive: z.coerce.boolean().optional(),
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
 * A suspension type is not that. It is the tenant's own
 * configuration, which is what `tenant_profile` already means: General,
 * Branding, Numbering, Automation and Custom Fields all sit on it. Leaving this on `settings` made "full access except system
 * settings" mean "cannot edit the small print on a bill".
 */
export async function suspensionTypeDefRoutes(app: FastifyInstance) {
  // Any authenticated user can read the active type list — the new and
  // list forms both consume it. No module permission needed; the type
  // catalogue is effectively reference data.
  app.get(
    "/api/v1/suspension-types",
    async (request, reply) => {
      const { utilityId } = request.user;
      const q = listQuerySchema.parse(request.query ?? {});
      const types = await listSuspensionTypes(utilityId, {
        includeInactive: q.includeInactive,
      });
      return reply.send({ data: types });
    },
  );

  // Mutations on the catalogue are admin-only. Gated behind the
  // settings module so tenants need explicit settings:EDIT to manage
  // their custom hold types. Global (utilityId=null) rows are seeded
  // and can't be modified through this API.
  app.post(
    "/api/v1/suspension-types",
    { config: { module: "tenant_profile", permission: "EDIT" } },
    async (request, reply) => {
      const { utilityId } = request.user;
      const data = createSuspensionTypeDefSchema.parse(request.body);
      const row = await createSuspensionType(utilityId, data);
      return reply.status(201).send(row);
    },
  );

  app.patch(
    "/api/v1/suspension-types/:id",
    { config: { module: "tenant_profile", permission: "EDIT" } },
    async (request, reply) => {
      const { utilityId } = request.user;
      const { id } = idParamSchema.parse(request.params);
      const data = updateSuspensionTypeDefSchema.parse(request.body);
      const row = await updateSuspensionType(utilityId, id, data);
      return reply.send(row);
    },
  );
}
