import type { FastifyInstance } from "fastify";
import {
  createSAScheduleAssignmentSchema,
  updateSAScheduleAssignmentSchema,
  saScheduleAssignmentQuerySchema,
} from "@utility-cis/shared";
import {
  listSAScheduleAssignments,
  getSAScheduleAssignment,
  createSAScheduleAssignment,
  updateSAScheduleAssignment,
  deleteSAScheduleAssignment,
} from "../services/sa-rate-schedule-assignment.service.js";
import { idParamSchema } from "../lib/route-schemas.js";

export async function saRateScheduleAssignmentRoutes(app: FastifyInstance) {
  app.get(
    "/api/v1/sa-rate-schedule-assignments",
    { config: { module: "rate_schedules", permission: "VIEW" } },
    async (request) => {
      const { utilityId } = request.user;
      const query = saScheduleAssignmentQuerySchema.parse(request.query);
      return listSAScheduleAssignments(utilityId, query);
    },
  );

  app.get(
    "/api/v1/sa-rate-schedule-assignments/:id",
    { config: { module: "rate_schedules", permission: "VIEW" } },
    async (request) => {
      const { utilityId } = request.user;
      const { id } = idParamSchema.parse(request.params);
      return getSAScheduleAssignment(id, utilityId);
    },
  );

  app.post(
    "/api/v1/sa-rate-schedule-assignments",
    { config: { module: "rate_schedules", permission: "EDIT" } },
    async (request, reply) => {
      const { utilityId } = request.user;
      const data = createSAScheduleAssignmentSchema.parse(request.body);
      const row = await createSAScheduleAssignment(utilityId, data);
      return reply.status(201).send(row);
    },
  );

  app.patch(
    "/api/v1/sa-rate-schedule-assignments/:id",
    { config: { module: "rate_schedules", permission: "EDIT" } },
    async (request) => {
      const { utilityId } = request.user;
      const { id } = idParamSchema.parse(request.params);
      const data = updateSAScheduleAssignmentSchema.parse(request.body);
      return updateSAScheduleAssignment(utilityId, id, data);
    },
  );

  app.delete(
    "/api/v1/sa-rate-schedule-assignments/:id",
    { config: { module: "rate_schedules", permission: "DELETE" } },
    async (request, reply) => {
      const { utilityId } = request.user;
      const { id } = idParamSchema.parse(request.params);
      await deleteSAScheduleAssignment(utilityId, id);
      return reply.status(204).send();
    },
  );
}
