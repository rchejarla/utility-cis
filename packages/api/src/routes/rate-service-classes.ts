import type { FastifyInstance } from "fastify";
import {
  createRateServiceClassSchema,
  updateRateServiceClassSchema,
  rateServiceClassQuerySchema,
} from "@utility-cis/shared";
import {
  listRateServiceClasses,
  getRateServiceClass,
  createRateServiceClass,
  updateRateServiceClass,
  softDeleteRateServiceClass,
} from "../services/rate-service-class.service.js";
import { idParamSchema } from "../lib/route-schemas.js";

export async function rateServiceClassRoutes(app: FastifyInstance) {
  app.get(
    "/api/v1/rate-service-classes",
    { config: { module: "rate_schedules", permission: "VIEW" } },
    async (request) => {
      const { utilityId } = request.user;
      const query = rateServiceClassQuerySchema.parse(request.query);
      return listRateServiceClasses(utilityId, query);
    },
  );

  app.get(
    "/api/v1/rate-service-classes/:id",
    { config: { module: "rate_schedules", permission: "VIEW" } },
    async (request) => {
      const { utilityId } = request.user;
      const { id } = idParamSchema.parse(request.params);
      return getRateServiceClass(id, utilityId);
    },
  );

  app.post(
    "/api/v1/rate-service-classes",
    { config: { module: "rate_schedules", permission: "EDIT" } },
    async (request, reply) => {
      const { utilityId } = request.user;
      const data = createRateServiceClassSchema.parse(request.body);
      const row = await createRateServiceClass(utilityId, data);
      return reply.status(201).send(row);
    },
  );

  app.patch(
    "/api/v1/rate-service-classes/:id",
    { config: { module: "rate_schedules", permission: "EDIT" } },
    async (request) => {
      const { utilityId } = request.user;
      const { id } = idParamSchema.parse(request.params);
      const data = updateRateServiceClassSchema.parse(request.body);
      return updateRateServiceClass(utilityId, id, data);
    },
  );

  app.delete(
    "/api/v1/rate-service-classes/:id",
    { config: { module: "rate_schedules", permission: "DELETE" } },
    async (request, reply) => {
      const { utilityId } = request.user;
      const { id } = idParamSchema.parse(request.params);
      await softDeleteRateServiceClass(utilityId, id);
      return reply.status(204).send();
    },
  );
}
