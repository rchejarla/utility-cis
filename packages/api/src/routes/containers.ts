import type { FastifyInstance } from "fastify";
import {
  createContainerSchema,
  updateContainerSchema,
  swapContainerSchema,
  containerQuerySchema,
} from "@utility-cis/shared";
import {
  listContainers,
  getContainer,
  createContainer,
  updateContainer,
  swapContainer,
  containersForPremise,
  containersForAgreement,
} from "../services/container.service.js";
import { registerCrudRoutes } from "../lib/crud-routes.js";
import { idParamSchema } from "../lib/route-schemas.js";
import { z } from "zod";

const premiseIdParam = z.object({ premiseId: z.string().uuid() });
const agreementIdParam = z.object({ agreementId: z.string().uuid() });

export async function containerRoutes(app: FastifyInstance) {
  registerCrudRoutes(app, {
    basePath: "/api/v1/containers",
    module: "containers",
    list: {
      querySchema: containerQuerySchema,
      service: (utilityId, query) => listContainers(utilityId, query as never),
    },
    get: getContainer,
    create: {
      bodySchema: createContainerSchema,
      service: (user, data) =>
        createContainer(user.utilityId, user.actorId, user.actorName, data as never),
    },
    update: {
      bodySchema: updateContainerSchema,
      service: (user, id, data) =>
        updateContainer(user.utilityId, user.actorId, user.actorName, id, data as never),
    },
  });

  // Custom swap endpoint — atomic size/type change preserving audit history
  app.post(
    "/api/v1/containers/:id/swap",
    { config: { module: "containers", permission: "EDIT" } },
    async (request, reply) => {
      const { utilityId, id: actorId, name: actorName } = request.user;
      const { id } = idParamSchema.parse(request.params);
      const data = swapContainerSchema.parse(request.body);
      const result = await swapContainer(utilityId, actorId, actorName, id, data);
      return reply.status(201).send(result);
    },
  );

  app.get(
    "/api/v1/premises/:premiseId/containers",
    { config: { module: "containers", permission: "VIEW" } },
    async (request, reply) => {
      const { utilityId } = request.user;
      const { premiseId } = premiseIdParam.parse(request.params);
      return reply.send({ data: await containersForPremise(utilityId, premiseId) });
    },
  );

  app.get(
    "/api/v1/service-agreements/:agreementId/containers",
    { config: { module: "containers", permission: "VIEW" } },
    async (request, reply) => {
      const { utilityId } = request.user;
      const { agreementId } = agreementIdParam.parse(request.params);
      return reply.send({ data: await containersForAgreement(utilityId, agreementId) });
    },
  );
}
