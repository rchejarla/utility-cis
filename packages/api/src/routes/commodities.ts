import type { FastifyInstance } from "fastify";
import { createCommoditySchema, updateCommoditySchema } from "@utility-cis/shared";
import {
  listCommodities,
  createCommodity,
  updateCommodity,
} from "../services/commodity.service.js";
import { idParamSchema } from "../lib/route-schemas.js";

export async function commodityRoutes(app: FastifyInstance) {
  app.get("/api/v1/commodities", { config: { module: "commodities", permission: "VIEW" } }, async (request, reply) => {
    const { utilityId } = request.user;
    const commodities = await listCommodities(utilityId);
    return reply.send(commodities);
  });

  app.post("/api/v1/commodities", { config: { module: "commodities", permission: "CREATE" } }, async (request, reply) => {
    const { utilityId, id: actorId, name: actorName } = request.user;
    const data = createCommoditySchema.parse(request.body);
    const commodity = await createCommodity(utilityId, actorId, actorName, data);
    return reply.status(201).send(commodity);
  });

  app.patch("/api/v1/commodities/:id", { config: { module: "commodities", permission: "EDIT" } }, async (request, reply) => {
    const { utilityId, id: actorId, name: actorName } = request.user;
    const { id } = idParamSchema.parse(request.params);
    const data = updateCommoditySchema.parse(request.body);
    const commodity = await updateCommodity(utilityId, actorId, actorName, id, data);
    return reply.send(commodity);
  });
}
