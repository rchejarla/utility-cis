import type { FastifyInstance } from "fastify";
import { createUomSchema, updateUomSchema } from "@utility-cis/shared";
import { listUom, createUom, updateUom } from "../services/uom.service.js";

export async function uomRoutes(app: FastifyInstance) {
  app.get("/api/v1/uom", async (request, reply) => {
    const { utilityId } = request.user;
    const { commodityId } = request.query as { commodityId?: string };
    const uoms = await listUom(utilityId, commodityId);
    return reply.send(uoms);
  });

  app.post("/api/v1/uom", async (request, reply) => {
    const { utilityId, id: actorId } = request.user;
    const data = createUomSchema.parse(request.body);
    const uom = await createUom(utilityId, actorId, data);
    return reply.status(201).send(uom);
  });

  app.patch("/api/v1/uom/:id", async (request, reply) => {
    const { utilityId, id: actorId } = request.user;
    const { id } = request.params as { id: string };
    const data = updateUomSchema.parse(request.body);
    const uom = await updateUom(utilityId, actorId, id, data);
    return reply.send(uom);
  });
}
