import type { FastifyInstance } from "fastify";
import {
  createRateAssignmentRoleSchema,
  updateRateAssignmentRoleSchema,
} from "@utility-cis/shared";
import {
  listRateAssignmentRoles,
  getRateAssignmentRole,
  createRateAssignmentRole,
  updateRateAssignmentRole,
  deleteRateAssignmentRole,
} from "../services/rate-assignment-role.service.js";
import { idParamSchema } from "../lib/route-schemas.js";

export async function rateAssignmentRoleRoutes(app: FastifyInstance) {
  app.get(
    "/api/v1/rate-assignment-roles",
    { config: { module: "rate_schedules", permission: "VIEW" } },
    async (request) => {
      const { utilityId } = request.user;
      return listRateAssignmentRoles(utilityId);
    },
  );

  app.get(
    "/api/v1/rate-assignment-roles/:id",
    { config: { module: "rate_schedules", permission: "VIEW" } },
    async (request) => {
      const { utilityId } = request.user;
      const { id } = idParamSchema.parse(request.params);
      return getRateAssignmentRole(id, utilityId);
    },
  );

  app.post(
    "/api/v1/rate-assignment-roles",
    { config: { module: "rate_schedules", permission: "EDIT" } },
    async (request, reply) => {
      const { utilityId } = request.user;
      const data = createRateAssignmentRoleSchema.parse(request.body);
      const row = await createRateAssignmentRole(utilityId, data);
      return reply.status(201).send(row);
    },
  );

  app.patch(
    "/api/v1/rate-assignment-roles/:id",
    { config: { module: "rate_schedules", permission: "EDIT" } },
    async (request) => {
      const { utilityId } = request.user;
      const { id } = idParamSchema.parse(request.params);
      const data = updateRateAssignmentRoleSchema.parse(request.body);
      return updateRateAssignmentRole(utilityId, id, data);
    },
  );

  app.delete(
    "/api/v1/rate-assignment-roles/:id",
    { config: { module: "rate_schedules", permission: "DELETE" } },
    async (request, reply) => {
      const { utilityId } = request.user;
      const { id } = idParamSchema.parse(request.params);
      await deleteRateAssignmentRole(utilityId, id);
      return reply.status(204).send();
    },
  );
}
