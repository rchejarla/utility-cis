import type { FastifyInstance } from "fastify";
import { createCommoditySchema, updateCommoditySchema } from "@utility-cis/shared";
import {
  listCommodities,
  createCommodity,
  updateCommodity,
} from "../services/commodity.service.js";

export async function commodityRoutes(app: FastifyInstance) {
  app.get("/api/v1/commodities", async (request, reply) => {
    const { utilityId } = request.user;
    const commodities = await listCommodities(utilityId);
    return reply.send(commodities);
  });

  app.post("/api/v1/commodities", async (request, reply) => {
    const { utilityId, id: actorId } = request.user;
    const data = createCommoditySchema.parse(request.body);
    const commodity = await createCommodity(utilityId, actorId, data);
    return reply.status(201).send(commodity);
  });

  app.patch("/api/v1/commodities/:id", async (request, reply) => {
    const { utilityId, id: actorId } = request.user;
    const { id } = request.params as { id: string };
    const data = updateCommoditySchema.parse(request.body);
    const commodity = await updateCommodity(utilityId, actorId, id, data);
    return reply.send(commodity);
  });
}
