import type { FastifyInstance } from "fastify";
import {
  createTouPeriodSchema,
  touPeriodQuerySchema,
  updateTouPeriodSchema,
} from "@utility-cis/shared";
import {
  createTouPeriod,
  deleteTouPeriod,
  getTouPeriod,
  listTouPeriods,
  updateTouPeriod,
} from "../services/tou-period.service.js";
import { registerCrudRoutes } from "../lib/crud-routes.js";

/**
 * A tenant's TOU periods (spec 26, TOU-CAL-1).
 *
 * Under **`rate_schedules`**, like the calendars that assign hours to
 * them and the schedules that price them: these are the tiers a tariff
 * charges at, and whoever may set the hours may name the tiers.
 *
 * Plain CRUD, unlike the calendar's collections. They are replaced
 * whole because their invariants belong to the list; a period has none
 * left to share — the unique code is an index's job and a calendar's
 * hours reference the code directly.
 */
export async function touPeriodRoutes(app: FastifyInstance) {
  registerCrudRoutes(app, {
    basePath: "/api/v1/tou-periods",
    module: "rate_schedules",
    list: {
      querySchema: touPeriodQuerySchema,
      service: (utilityId, query) => listTouPeriods(utilityId, query as never),
    },
    get: getTouPeriod,
    create: {
      bodySchema: createTouPeriodSchema,
      service: (user, data) =>
        createTouPeriod(user.utilityId, user.actorId, user.actorName, data as never),
    },
    update: {
      bodySchema: updateTouPeriodSchema,
      service: (user, id, data) =>
        updateTouPeriod(user.utilityId, user.actorId, user.actorName, id, data as never),
    },
    del: (id, user) => deleteTouPeriod(id, user),
  });
}
