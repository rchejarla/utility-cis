import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  listPremiseTypes,
  createPremiseType,
  updatePremiseType,
} from "../services/premise-type-def.service.js";
import { idParamSchema } from "../lib/route-schemas.js";

const listQuerySchema = z
  .object({
    includeInactive: z.coerce.boolean().optional(),
  })
  .strict();

const createSchema = z.object({
  code: z.string().min(1).max(50),
  label: z.string().min(1).max(100),
  description: z.string().max(2000).optional(),
  sortOrder: z.number().int().min(0).optional(),
  isActive: z.boolean().optional(),
});

const updateSchema = createSchema.partial();

export async function premiseTypeDefRoutes(app: FastifyInstance) {
  // Reference data — any authenticated user can list active types.
  // Powers dropdowns on the Premise create/edit forms.
  app.get("/api/v1/premise-types", async (request, reply) => {
    const { utilityId } = request.user;
    const q = listQuerySchema.parse(request.query ?? {});
    const types = await listPremiseTypes(utilityId, { includeInactive: q.includeInactive });
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
    "/api/v1/premise-types",
    { config: { module: "tenant_profile", permission: "CREATE" } },
    async (request, reply) => {
      const { utilityId } = request.user;
      const data = createSchema.parse(request.body);
      const row = await createPremiseType(utilityId, data);
      return reply.status(201).send(row);
    },
  );

  app.patch(
    "/api/v1/premise-types/:id",
    { config: { module: "tenant_profile", permission: "EDIT" } },
    async (request, reply) => {
      const { utilityId } = request.user;
      const { id } = idParamSchema.parse(request.params);
      const data = updateSchema.parse(request.body);
      const row = await updatePremiseType(utilityId, id, data);
      return reply.send(row);
    },
  );
}
