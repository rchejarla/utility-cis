import type { FastifyInstance } from "fastify";
import { createUomSchema, updateUomSchema } from "@utility-cis/shared";
import { listUom, createUom, updateUom, deleteUom } from "../services/uom.service.js";

export async function uomRoutes(app: FastifyInstance) {
  app.get("/api/v1/uom", { config: { module: "commodities", permission: "VIEW" } }, async (request, reply) => {
    const { utilityId } = request.user;
    const { commodityId } = request.query as { commodityId?: string };
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
    const { id } = request.params as { id: string };
    const data = updateUomSchema.parse(request.body);
    const uom = await updateUom(utilityId, actorId, actorName, id, data);
    return reply.send(uom);
  });

  app.delete("/api/v1/uom/:id", { config: { module: "commodities", permission: "DELETE" } }, async (request, reply) => {
    const { utilityId } = request.user;
    const { id } = request.params as { id: string };
    await deleteUom(utilityId, id);
    return reply.status(204).send();
  });
}
