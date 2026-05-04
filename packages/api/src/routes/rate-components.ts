import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  createRateComponentSchema,
  updateRateComponentSchema,
} from "@utility-cis/shared";
import {
  listComponentsForSchedule,
  getRateComponent,
  createRateComponent,
  updateRateComponent,
  deleteRateComponent,
} from "../services/rate-component.service.js";
import { idParamSchema } from "../lib/route-schemas.js";

const scheduleIdParamSchema = z.object({ scheduleId: z.string().uuid() });

export async function rateComponentRoutes(app: FastifyInstance) {
  app.get(
    "/api/v1/rate-schedules/:scheduleId/components",
    { config: { module: "rate_schedules", permission: "VIEW" } },
    async (request) => {
      const { utilityId } = request.user;
      const { scheduleId } = scheduleIdParamSchema.parse(request.params);
      return listComponentsForSchedule(scheduleId, utilityId);
    },
  );

  app.post(
    "/api/v1/rate-schedules/:scheduleId/components",
    { config: { module: "rate_schedules", permission: "EDIT" } },
    async (request, reply) => {
      const { utilityId } = request.user;
      const { scheduleId } = scheduleIdParamSchema.parse(request.params);
      const data = createRateComponentSchema.parse(request.body);
      const row = await createRateComponent(utilityId, scheduleId, data);
      return reply.status(201).send(row);
    },
  );

  app.get(
    "/api/v1/rate-components/:id",
    { config: { module: "rate_schedules", permission: "VIEW" } },
    async (request) => {
      const { utilityId } = request.user;
      const { id } = idParamSchema.parse(request.params);
      return getRateComponent(id, utilityId);
    },
  );

  app.patch(
    "/api/v1/rate-components/:id",
    { config: { module: "rate_schedules", permission: "EDIT" } },
    async (request) => {
      const { utilityId } = request.user;
      const { id } = idParamSchema.parse(request.params);
      const data = updateRateComponentSchema.parse(request.body);
      return updateRateComponent(utilityId, id, data);
    },
  );

  app.delete(
    "/api/v1/rate-components/:id",
    { config: { module: "rate_schedules", permission: "DELETE" } },
    async (request, reply) => {
      const { utilityId } = request.user;
      const { id } = idParamSchema.parse(request.params);
      await deleteRateComponent(utilityId, id);
      return reply.status(204).send();
    },
  );
}
