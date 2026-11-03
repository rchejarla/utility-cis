import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  baseListQuerySchema,
  createMeasureTypeDefSchema,
  updateMeasureTypeDefSchema,
} from "@utility-cis/shared";
import {
  listMeasureTypes,
  createMeasureType,
  updateMeasureType,
} from "../services/measure-type-def.service.js";
import { idParamSchema } from "../lib/route-schemas.js";

const listQuerySchema = baseListQuerySchema
  .extend({
    includeInactive: z.coerce.boolean().optional(),
  })
  .strict();

export async function measureTypeDefRoutes(app: FastifyInstance) {
  // Reference data — any authenticated user can list active types.
  // Used by the Commodities / UOM edit forms to populate the
  // "measure type" dropdown, so permission-gating would just break
  // non-admin list pages.
  app.get("/api/v1/measure-types", async (request, reply) => {
    const { utilityId } = request.user;
    const q = listQuerySchema.parse(request.query ?? {});
    const types = await listMeasureTypes(utilityId, {
      includeInactive: q.includeInactive,
    });
    return reply.send({ data: types });
  });

  /*
   * Maintaining the list answers to `tenant_profile`, which is where
   * Custom Fields already sits. Reading it, above, stays open to any
   * authenticated user, because every form that offers these types
   * needs them.
   *
   * Reads and writes were one key until 2026-11-03, so a Field
   * Technician holding `premises:EDIT` for field work could rewrite the
   * premise type list, and a CSR holding `accounts:EDIT` could rewrite
   * the account type list. Neither is their job, and neither showed up
   * as a grant — it arrived with the operational verb.
   */
  app.post(
    "/api/v1/measure-types",
    { config: { module: "tenant_profile", permission: "CREATE" } },
    async (request, reply) => {
      const { utilityId } = request.user;
      const data = createMeasureTypeDefSchema.parse(request.body);
      const row = await createMeasureType(utilityId, data);
      return reply.status(201).send(row);
    },
  );

  app.patch(
    "/api/v1/measure-types/:id",
    { config: { module: "tenant_profile", permission: "EDIT" } },
    async (request, reply) => {
      const { utilityId } = request.user;
      const { id } = idParamSchema.parse(request.params);
      const data = updateMeasureTypeDefSchema.parse(request.body);
      const row = await updateMeasureType(utilityId, id, data);
      return reply.send(row);
    },
  );
}
