import type { FastifyInstance } from "fastify";
import {
  assignTouCalendarSchema,
  createRateScheduleSchema,
  rateScheduleQuerySchema,
  reviseRateScheduleSchema,
} from "@utility-cis/shared";
import {
  listRateSchedules,
  getRateSchedule,
  createRateSchedule,
  reviseRateSchedule,
  publishRateSchedule,
  assignTouCalendar,
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

  /*
   * Not a PATCH on the schedule: there is deliberately none (see the
   * CRUD block above). A draft's TOU calendar is the single field that
   * may change without forking a version, so it gets the single route
   * that can change it.
   */
  app.put(
    "/api/v1/rate-schedules/:id/tou-calendar",
    { config: { module: "rate_schedules", permission: "EDIT" } },
    async (request) => {
      const { utilityId, id: actorId, name: actorName } = request.user;
      const { id } = idParamSchema.parse(request.params);
      const { touCalendarId } = assignTouCalendarSchema.parse(request.body);
      return assignTouCalendar(utilityId, actorId, actorName, id, touCalendarId);
    },
  );

  app.post(
    "/api/v1/rate-schedules/:id/publish",
    { config: { module: "rate_schedules", permission: "EDIT" } },
    async (request, reply) => {
      const { utilityId, id: actorId, name: actorName } = request.user;
      const { id } = idParamSchema.parse(request.params);
      const schedule = await publishRateSchedule(utilityId, actorId, actorName, id);
      return reply.status(200).send(schedule);
    },
  );
}
