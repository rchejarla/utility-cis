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
    { config: { module: "settings", permission: "EDIT" } },
    async (request, reply) => {
      const { utilityId } = request.user;
      const data = createSuspensionTypeDefSchema.parse(request.body);
      const row = await createSuspensionType(utilityId, data);
      return reply.status(201).send(row);
    },
  );

  app.patch(
    "/api/v1/suspension-types/:id",
    { config: { module: "settings", permission: "EDIT" } },
    async (request, reply) => {
      const { utilityId } = request.user;
      const { id } = idParamSchema.parse(request.params);
      const data = updateSuspensionTypeDefSchema.parse(request.body);
      const row = await updateSuspensionType(utilityId, id, data);
      return reply.send(row);
    },
  );
}
