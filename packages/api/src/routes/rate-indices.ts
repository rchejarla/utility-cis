import type { FastifyInstance } from "fastify";
import {
  createRateIndexSchema,
  updateRateIndexSchema,
  rateIndexQuerySchema,
} from "@utility-cis/shared";
import {
  listRateIndices,
  getRateIndex,
  createRateIndex,
  updateRateIndex,
  deleteRateIndex,
} from "../services/rate-index.service.js";
import { idParamSchema } from "../lib/route-schemas.js";

export async function rateIndexRoutes(app: FastifyInstance) {
  app.get(
    "/api/v1/rate-indices",
    { config: { module: "rate_schedules", permission: "VIEW" } },
    async (request) => {
      const { utilityId } = request.user;
      const query = rateIndexQuerySchema.parse(request.query);
      return listRateIndices(utilityId, query);
    },
  );

  app.get(
    "/api/v1/rate-indices/:id",
    { config: { module: "rate_schedules", permission: "VIEW" } },
    async (request) => {
      const { utilityId } = request.user;
      const { id } = idParamSchema.parse(request.params);
      return getRateIndex(id, utilityId);
    },
  );

  app.post(
    "/api/v1/rate-indices",
    { config: { module: "rate_schedules", permission: "EDIT" } },
    async (request, reply) => {
      const { utilityId } = request.user;
      const data = createRateIndexSchema.parse(request.body);
      const row = await createRateIndex(utilityId, data);
      return reply.status(201).send(row);
    },
  );

  app.patch(
    "/api/v1/rate-indices/:id",
    { config: { module: "rate_schedules", permission: "EDIT" } },
    async (request) => {
      const { utilityId } = request.user;
      const { id } = idParamSchema.parse(request.params);
      const data = updateRateIndexSchema.parse(request.body);
      return updateRateIndex(utilityId, id, data);
    },
  );

  app.delete(
    "/api/v1/rate-indices/:id",
    { config: { module: "rate_schedules", permission: "DELETE" } },
    async (request, reply) => {
      const { utilityId } = request.user;
      const { id } = idParamSchema.parse(request.params);
      await deleteRateIndex(utilityId, id);
      return reply.status(204).send();
    },
  );
}
