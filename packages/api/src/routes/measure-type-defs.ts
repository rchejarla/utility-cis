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

  // Mutations are admin-only via the commodities module — measure
  // types are operational catalog data (alongside commodities and
  // UOMs), not tenant chrome/system settings.
  app.post(
    "/api/v1/measure-types",
    { config: { module: "commodities", permission: "CREATE" } },
    async (request, reply) => {
      const { utilityId } = request.user;
      const data = createMeasureTypeDefSchema.parse(request.body);
      const row = await createMeasureType(utilityId, data);
      return reply.status(201).send(row);
    },
  );

  app.patch(
    "/api/v1/measure-types/:id",
    { config: { module: "commodities", permission: "EDIT" } },
    async (request, reply) => {
      const { utilityId } = request.user;
      const { id } = idParamSchema.parse(request.params);
      const data = updateMeasureTypeDefSchema.parse(request.body);
      const row = await updateMeasureType(utilityId, id, data);
      return reply.send(row);
    },
  );
}
