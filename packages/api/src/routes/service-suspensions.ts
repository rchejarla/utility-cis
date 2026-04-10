import type { FastifyInstance } from "fastify";
import {
  createSuspensionSchema,
  updateSuspensionSchema,
  suspensionQuerySchema,
} from "@utility-cis/shared";
import {
  listSuspensions,
  getSuspension,
  createSuspension,
  updateSuspension,
  completeSuspension,
  suspensionsForAgreement,
} from "../services/service-suspension.service.js";
import { registerCrudRoutes } from "../lib/crud-routes.js";
import { idParamSchema } from "../lib/route-schemas.js";
import { z } from "zod";

const agreementIdParam = z.object({ agreementId: z.string().uuid() });
const completeBody = z.object({ endDate: z.string().date().optional() }).strict();

export async function serviceSuspensionRoutes(app: FastifyInstance) {
  registerCrudRoutes(app, {
    basePath: "/api/v1/service-suspensions",
    module: "service_suspensions",
    list: {
      querySchema: suspensionQuerySchema,
      service: (utilityId, query) => listSuspensions(utilityId, query as never),
    },
    get: getSuspension,
    create: {
      bodySchema: createSuspensionSchema,
      service: (user, data) =>
        createSuspension(user.utilityId, user.actorId, user.actorName, data as never),
    },
    update: {
      bodySchema: updateSuspensionSchema,
      service: (user, id, data) =>
        updateSuspension(user.utilityId, user.actorId, user.actorName, id, data as never),
    },
  });

  app.post(
    "/api/v1/service-suspensions/:id/complete",
    { config: { module: "service_suspensions", permission: "EDIT" } },
    async (request, reply) => {
      const { utilityId, id: actorId, name: actorName } = request.user;
      const { id } = idParamSchema.parse(request.params);
      const { endDate } = completeBody.parse(request.body ?? {});
      const result = await completeSuspension(utilityId, actorId, actorName, id, endDate);
      return reply.send(result);
    },
  );

  app.get(
    "/api/v1/service-agreements/:agreementId/suspensions",
    { config: { module: "service_suspensions", permission: "VIEW" } },
    async (request, reply) => {
      const { utilityId } = request.user;
      const { agreementId } = agreementIdParam.parse(request.params);
      return reply.send({ data: await suspensionsForAgreement(utilityId, agreementId) });
    },
  );
}
