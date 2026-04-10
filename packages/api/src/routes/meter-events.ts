import type { FastifyInstance } from "fastify";
import {
  createMeterEventSchema,
  updateMeterEventSchema,
  meterEventQuerySchema,
} from "@utility-cis/shared";
import {
  listMeterEvents,
  getMeterEvent,
  createMeterEvent,
  updateMeterEvent,
} from "../services/meter-event.service.js";
import { registerCrudRoutes } from "../lib/crud-routes.js";

export async function meterEventRoutes(app: FastifyInstance) {
  registerCrudRoutes(app, {
    basePath: "/api/v1/meter-events",
    module: "meter_events",
    list: {
      querySchema: meterEventQuerySchema,
      service: (utilityId, query) => listMeterEvents(utilityId, query as never),
    },
    get: getMeterEvent,
    create: {
      bodySchema: createMeterEventSchema,
      service: (user, data) =>
        createMeterEvent(user.utilityId, user.actorId, user.actorName, data as never),
    },
    update: {
      bodySchema: updateMeterEventSchema,
      service: (user, id, data) =>
        updateMeterEvent(user.utilityId, user.actorId, user.actorName, id, data as never),
    },
  });
}
