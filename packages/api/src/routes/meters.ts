import type { FastifyInstance } from "fastify";
import { createMeterSchema, updateMeterSchema, meterQuerySchema } from "@utility-cis/shared";
import {
  listMeters,
  getMeter,
  createMeter,
  updateMeter,
} from "../services/meter.service.js";
import { registerCrudRoutes } from "../lib/crud-routes.js";

export async function meterRoutes(app: FastifyInstance) {
  registerCrudRoutes(app, {
    basePath: "/api/v1/meters",
    module: "meters",
    // Mirrored from a legacy CIS in overlay mode, so staff writes are
    // refused there (spec 28, OVL-T-3). Reads and the overlay import
    // are untouched.
    mirroredFromLegacy: true,
    list: {
      querySchema: meterQuerySchema,
      service: (utilityId, query) => listMeters(utilityId, query as never),
    },
    get: getMeter,
    create: {
      bodySchema: createMeterSchema,
      service: (user, data) =>
        createMeter(user.utilityId, user.actorId, user.actorName, data as never),
    },
    update: {
      bodySchema: updateMeterSchema,
      service: (user, id, data) =>
        updateMeter(user.utilityId, user.actorId, user.actorName, id, data as never),
    },
  });
}
