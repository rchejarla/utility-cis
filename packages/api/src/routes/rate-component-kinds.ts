import type { FastifyInstance } from "fastify";
import {
  createRateComponentKindSchema,
  updateRateComponentKindSchema,
} from "@utility-cis/shared";
import {
  listRateComponentKinds,
  getRateComponentKind,
  createRateComponentKind,
  updateRateComponentKind,
  deleteRateComponentKind,
} from "../services/rate-component-kind.service.js";
import { idParamSchema } from "../lib/route-schemas.js";

export async function rateComponentKindRoutes(app: FastifyInstance) {
  app.get(
    "/api/v1/rate-component-kinds",
    { config: { module: "rate_schedules", permission: "VIEW" } },
    async (request) => {
      const { utilityId } = request.user;
      return listRateComponentKinds(utilityId);
    },
  );

  app.get(
    "/api/v1/rate-component-kinds/:id",
    { config: { module: "rate_schedules", permission: "VIEW" } },
    async (request) => {
      const { utilityId } = request.user;
      const { id } = idParamSchema.parse(request.params);
      return getRateComponentKind(id, utilityId);
    },
  );

  app.post(
    "/api/v1/rate-component-kinds",
    { config: { module: "rate_schedules", permission: "EDIT" } },
    async (request, reply) => {
      const { utilityId } = request.user;
      const data = createRateComponentKindSchema.parse(request.body);
      const row = await createRateComponentKind(utilityId, data);
      return reply.status(201).send(row);
    },
  );

  app.patch(
    "/api/v1/rate-component-kinds/:id",
    { config: { module: "rate_schedules", permission: "EDIT" } },
    async (request) => {
      const { utilityId } = request.user;
      const { id } = idParamSchema.parse(request.params);
      const data = updateRateComponentKindSchema.parse(request.body);
      return updateRateComponentKind(utilityId, id, data);
    },
  );

  app.delete(
    "/api/v1/rate-component-kinds/:id",
    { config: { module: "rate_schedules", permission: "DELETE" } },
    async (request, reply) => {
      const { utilityId } = request.user;
      const { id } = idParamSchema.parse(request.params);
      await deleteRateComponentKind(utilityId, id);
      return reply.status(204).send();
    },
  );
}
