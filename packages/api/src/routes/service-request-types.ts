import type { FastifyInstance } from "fastify";
import { serviceRequestTypeQuerySchema } from "@utility-cis/shared";
import { listServiceRequestTypes } from "../services/service-request-type-def.service.js";

export async function serviceRequestTypeRoutes(app: FastifyInstance) {
  app.get(
    "/api/v1/service-request-types",
    { config: { module: "service_requests", permission: "VIEW" } },
    async (request, reply) => {
      const { utilityId } = request.user;
      const query = serviceRequestTypeQuerySchema.parse(request.query);
      const result = await listServiceRequestTypes(utilityId, {
        includeInactive: query.includeInactive,
      });
      return reply.send(result);
    },
  );
}
