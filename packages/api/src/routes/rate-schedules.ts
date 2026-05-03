import type { FastifyInstance } from "fastify";
import {
  createRateScheduleSchema,
  rateScheduleQuerySchema,
  reviseRateScheduleSchema,
} from "@utility-cis/shared";
import {
  listRateSchedules,
  getRateSchedule,
  createRateSchedule,
  reviseRateSchedule,
} from "../services/rate-schedule.service.js";
import { idParamSchema } from "../lib/route-schemas.js";
import { registerCrudRoutes } from "../lib/crud-routes.js";

export async function rateScheduleRoutes(app: FastifyInstance) {
  registerCrudRoutes(app, {
    basePath: "/api/v1/rate-schedules",
    module: "rate_schedules",
    list: {
      querySchema: rateScheduleQuerySchema,
      service: (utilityId, query) => listRateSchedules(utilityId, query as never),
    },
    get: getRateSchedule,
    create: {
      bodySchema: createRateScheduleSchema,
      service: (user, data) =>
        createRateSchedule(user.utilityId, user.actorId, user.actorName, data as never),
    },
    // No PATCH — rate schedules are immutable. Revisions go through POST /:id/revise below.
  });

  app.post(
    "/api/v1/rate-schedules/:id/revise",
    { config: { module: "rate_schedules", permission: "EDIT" } },
    async (request, reply) => {
      const { utilityId, id: actorId, name: actorName } = request.user;
      const { id } = idParamSchema.parse(request.params);
      const data = reviseRateScheduleSchema.parse(request.body);
      const schedule = await reviseRateSchedule(utilityId, actorId, actorName, id, data);
      return reply.status(201).send(schedule);
    }
  );
}
