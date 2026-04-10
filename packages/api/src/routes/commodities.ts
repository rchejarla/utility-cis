import type { FastifyInstance } from "fastify";
import { createCommoditySchema, updateCommoditySchema } from "@utility-cis/shared";
import {
  listCommodities,
  createCommodity,
  updateCommodity,
} from "../services/commodity.service.js";
import { registerCrudRoutes } from "../lib/crud-routes.js";

export async function commodityRoutes(app: FastifyInstance) {
  registerCrudRoutes(app, {
    basePath: "/api/v1/commodities",
    module: "commodities",
    list: { service: listCommodities },
    create: {
      bodySchema: createCommoditySchema,
      service: (user, data) =>
        createCommodity(user.utilityId, user.actorId, user.actorName, data as never),
    },
    update: {
      bodySchema: updateCommoditySchema,
      service: (user, id, data) =>
        updateCommodity(user.utilityId, user.actorId, user.actorName, id, data as never),
    },
  });
}
