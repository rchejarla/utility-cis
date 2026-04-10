import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { createUomSchema, updateUomSchema } from "@utility-cis/shared";
import { idParamSchema } from "../lib/route-schemas.js";
import { listUom, createUom, updateUom, deleteUom } from "../services/uom.service.js";

const uomQuerySchema = z.object({
  commodityId: z.string().uuid().optional(),
}).strict();

export async function uomRoutes(app: FastifyInstance) {
  app.get("/api/v1/uom", { config: { module: "commodities", permission: "VIEW" } }, async (request, reply) => {
    const { utilityId } = request.user;
    const { commodityId } = uomQuerySchema.parse(request.query);
    const uoms = await listUom(utilityId, commodityId);
    return reply.send(uoms);
  });

  app.post("/api/v1/uom", { config: { module: "commodities", permission: "CREATE" } }, async (request, reply) => {
    const { utilityId, id: actorId, name: actorName } = request.user;
    const data = createUomSchema.parse(request.body);
    const uom = await createUom(utilityId, actorId, actorName, data);
    return reply.status(201).send(uom);
  });

  app.patch("/api/v1/uom/:id", { config: { module: "commodities", permission: "EDIT" } }, async (request, reply) => {
    const { utilityId, id: actorId, name: actorName } = request.user;
    const { id } = idParamSchema.parse(request.params);
    const data = updateUomSchema.parse(request.body);
    const uom = await updateUom(utilityId, actorId, actorName, id, data);
    return reply.send(uom);
  });

  app.delete("/api/v1/uom/:id", { config: { module: "commodities", permission: "DELETE" } }, async (request, reply) => {
    const { utilityId } = request.user;
    const { id } = idParamSchema.parse(request.params);
    await deleteUom(utilityId, id);
    return reply.status(204).send();
  });
}
