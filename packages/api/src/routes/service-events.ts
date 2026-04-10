import type { FastifyInstance } from "fastify";
import {
  createServiceEventSchema,
  resolveServiceEventSchema,
  serviceEventQuerySchema,
} from "@utility-cis/shared";
import {
  listServiceEvents,
  getServiceEvent,
  createServiceEvent,
  resolveServiceEvent,
  eventsForPremise,
} from "../services/service-event.service.js";
import { idParamSchema } from "../lib/route-schemas.js";
import { z } from "zod";

const premiseIdParam = z.object({ premiseId: z.string().uuid() });

export async function serviceEventRoutes(app: FastifyInstance) {
  app.get(
    "/api/v1/service-events",
    { config: { module: "service_events", permission: "VIEW" } },
    async (request, reply) => {
      const { utilityId } = request.user;
      const query = serviceEventQuerySchema.parse(request.query);
      return reply.send(await listServiceEvents(utilityId, query));
    },
  );

  app.get(
    "/api/v1/service-events/:id",
    { config: { module: "service_events", permission: "VIEW" } },
    async (request, reply) => {
      const { utilityId } = request.user;
      const { id } = idParamSchema.parse(request.params);
      return reply.send(await getServiceEvent(id, utilityId));
    },
  );

  app.post(
    "/api/v1/service-events",
    { config: { module: "service_events", permission: "CREATE" } },
    async (request, reply) => {
      const { utilityId, id: actorId, name: actorName } = request.user;
      const data = createServiceEventSchema.parse(request.body);
      const result = await createServiceEvent(utilityId, actorId, actorName, data);
      return reply.status(201).send(result);
    },
  );

  app.post(
    "/api/v1/service-events/:id/resolve",
    { config: { module: "service_events", permission: "EDIT" } },
    async (request, reply) => {
      const { utilityId, id: actorId, name: actorName } = request.user;
      const { id } = idParamSchema.parse(request.params);
      const data = resolveServiceEventSchema.parse(request.body);
      const result = await resolveServiceEvent(utilityId, actorId, actorName, id, data);
      return reply.send(result);
    },
  );

  app.get(
    "/api/v1/premises/:premiseId/service-events",
    { config: { module: "service_events", permission: "VIEW" } },
    async (request, reply) => {
      const { utilityId } = request.user;
      const { premiseId } = premiseIdParam.parse(request.params);
      return reply.send({ data: await eventsForPremise(utilityId, premiseId) });
    },
  );
}
