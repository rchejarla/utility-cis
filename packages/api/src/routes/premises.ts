import type { FastifyInstance } from "fastify";
import { createPremiseSchema, updatePremiseSchema, premiseQuerySchema } from "@utility-cis/shared";
import {
  listPremises,
  getPremise,
  getPremisesGeo,
  createPremise,
  updatePremise,
} from "../services/premise.service.js";
import { registerCrudRoutes } from "../lib/crud-routes.js";

export async function premiseRoutes(app: FastifyInstance) {
  // Custom /geo route must be registered BEFORE the factory's /:id route
  // so Fastify's radix tree matches it first.
  app.get(
    "/api/v1/premises/geo",
    { config: { module: "premises", permission: "VIEW" } },
    async (request, reply) => {
      const geoJson = await getPremisesGeo(request.user.utilityId);
      return reply.send(geoJson);
    }
  );

  registerCrudRoutes(app, {
    basePath: "/api/v1/premises",
    module: "premises",
    list: {
      querySchema: premiseQuerySchema,
      service: (utilityId, query) => listPremises(utilityId, query as never),
    },
    get: getPremise,
    create: {
      bodySchema: createPremiseSchema,
      service: (user, data) =>
        createPremise(user.utilityId, user.actorId, user.actorName, data as never),
    },
    update: {
      bodySchema: updatePremiseSchema,
      service: (user, id, data) =>
        updatePremise(user.utilityId, user.actorId, user.actorName, id, data as never),
    },
  });
}
