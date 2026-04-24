import type { FastifyInstance } from "fastify";
import {
  createSlaSchema,
  updateSlaSchema,
  slaQuerySchema,
} from "@utility-cis/shared";
import {
  listSlas,
  getSla,
  createSla,
  updateSla,
  deactivateSla,
} from "../services/sla.service.js";
import { registerCrudRoutes } from "../lib/crud-routes.js";
import { idParamSchema } from "../lib/route-schemas.js";

export async function slaRoutes(app: FastifyInstance) {
  registerCrudRoutes(app, {
    basePath: "/api/v1/slas",
    module: "service_request_slas",
    list: {
      querySchema: slaQuerySchema,
      service: (utilityId, query) => listSlas(utilityId, query as never),
    },
    get: getSla,
    create: {
      bodySchema: createSlaSchema,
      service: (user, data) =>
        createSla(user.utilityId, user.actorId, user.actorName, data as never),
    },
    update: {
      bodySchema: updateSlaSchema,
      service: (user, id, data) =>
        updateSla(user.utilityId, user.actorId, user.actorName, id, data as never),
    },
  });

  app.delete(
    "/api/v1/slas/:id",
    { config: { module: "service_request_slas", permission: "EDIT" } },
    async (request, reply) => {
      const { utilityId, id: actorId, name: actorName } = request.user;
      const { id } = idParamSchema.parse(request.params);
      const result = await deactivateSla(utilityId, actorId, actorName, id);
      return reply.send(result);
    },
  );
}
