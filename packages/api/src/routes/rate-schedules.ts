import type { FastifyInstance } from "fastify";
import { createRateScheduleSchema, rateScheduleQuerySchema } from "@utility-cis/shared";
import {
  listRateSchedules,
  getRateSchedule,
  createRateSchedule,
  reviseRateSchedule,
} from "../services/rate-schedule.service.js";

export async function rateScheduleRoutes(app: FastifyInstance) {
  app.get("/api/v1/rate-schedules", { config: { module: "rate_schedules", permission: "VIEW" } }, async (request, reply) => {
    const { utilityId } = request.user;
    const query = rateScheduleQuerySchema.parse(request.query);
    const result = await listRateSchedules(utilityId, query);
    return reply.send(result);
  });

  app.get("/api/v1/rate-schedules/:id", { config: { module: "rate_schedules", permission: "VIEW" } }, async (request, reply) => {
    const { utilityId } = request.user;
    const { id } = request.params as { id: string };
    const schedule = await getRateSchedule(id, utilityId);
    return reply.send(schedule);
  });

  app.post("/api/v1/rate-schedules", { config: { module: "rate_schedules", permission: "CREATE" } }, async (request, reply) => {
    const { utilityId, id: actorId, name: actorName } = request.user;
    const data = createRateScheduleSchema.parse(request.body);
    const schedule = await createRateSchedule(utilityId, actorId, actorName, data);
    return reply.status(201).send(schedule);
  });

  app.post("/api/v1/rate-schedules/:id/revise", { config: { module: "rate_schedules", permission: "EDIT" } }, async (request, reply) => {
    const { utilityId, id: actorId, name: actorName } = request.user;
    const { id } = request.params as { id: string };
    const data = createRateScheduleSchema.parse(request.body);
    const schedule = await reviseRateSchedule(utilityId, actorId, actorName, id, data);
    return reply.status(201).send(schedule);
  });
}
