import type { FastifyInstance } from "fastify";
import {
  createServiceRequestSchema,
  updateServiceRequestSchema,
  assignServiceRequestSchema,
  transitionServiceRequestSchema,
  completeServiceRequestSchema,
  cancelServiceRequestSchema,
  serviceRequestQuerySchema,
} from "@utility-cis/shared";
import {
  listServiceRequests,
  getServiceRequest,
  createServiceRequest,
  updateServiceRequest,
  assignServiceRequest,
  transitionServiceRequest,
  completeServiceRequest,
  cancelServiceRequest,
  listByAccount,
  listByPremise,
} from "../services/service-request.service.js";
import { registerCrudRoutes } from "../lib/crud-routes.js";
import { idParamSchema } from "../lib/route-schemas.js";

export async function serviceRequestRoutes(app: FastifyInstance) {
  registerCrudRoutes(app, {
    basePath: "/api/v1/service-requests",
    module: "service_requests",
    list: {
      querySchema: serviceRequestQuerySchema,
      service: (utilityId, query) => listServiceRequests(utilityId, query as never),
    },
    get: getServiceRequest,
    create: {
      bodySchema: createServiceRequestSchema,
      service: (user, data) =>
        createServiceRequest(user.utilityId, user.actorId, user.actorName, data as never),
    },
    update: {
      bodySchema: updateServiceRequestSchema,
      service: (user, id, data) =>
        updateServiceRequest(user.utilityId, user.actorId, user.actorName, id, data as never),
    },
  });

  app.post(
    "/api/v1/service-requests/:id/assign",
    { config: { module: "service_requests", permission: "EDIT" } },
    async (request, reply) => {
      const { utilityId, id: actorId, name: actorName } = request.user;
      const { id } = idParamSchema.parse(request.params);
      const data = assignServiceRequestSchema.parse(request.body);
      return reply.send(await assignServiceRequest(utilityId, actorId, actorName, id, data));
    },
  );

  app.post(
    "/api/v1/service-requests/:id/transition",
    { config: { module: "service_requests", permission: "EDIT" } },
    async (request, reply) => {
      const { utilityId, id: actorId, name: actorName } = request.user;
      const { id } = idParamSchema.parse(request.params);
      const data = transitionServiceRequestSchema.parse(request.body);
      return reply.send(await transitionServiceRequest(utilityId, actorId, actorName, id, data));
    },
  );

  app.post(
    "/api/v1/service-requests/:id/complete",
    { config: { module: "service_requests", permission: "EDIT" } },
    async (request, reply) => {
      const { utilityId, id: actorId, name: actorName } = request.user;
      const { id } = idParamSchema.parse(request.params);
      const data = completeServiceRequestSchema.parse(request.body);
      return reply.send(await completeServiceRequest(utilityId, actorId, actorName, id, data));
    },
  );

  app.post(
    "/api/v1/service-requests/:id/cancel",
    { config: { module: "service_requests", permission: "EDIT" } },
    async (request, reply) => {
      const { utilityId, id: actorId, name: actorName } = request.user;
      const { id } = idParamSchema.parse(request.params);
      const data = cancelServiceRequestSchema.parse(request.body);
      return reply.send(await cancelServiceRequest(utilityId, actorId, actorName, id, data));
    },
  );

  app.get(
    "/api/v1/accounts/:id/service-requests",
    { config: { module: "service_requests", permission: "VIEW" } },
    async (request, reply) => {
      const { utilityId } = request.user;
      const { id } = idParamSchema.parse(request.params);
      return reply.send(await listByAccount(utilityId, id));
    },
  );

  app.get(
    "/api/v1/premises/:id/service-requests",
    { config: { module: "service_requests", permission: "VIEW" } },
    async (request, reply) => {
      const { utilityId } = request.user;
      const { id } = idParamSchema.parse(request.params);
      return reply.send(await listByPremise(utilityId, id));
    },
  );
}
