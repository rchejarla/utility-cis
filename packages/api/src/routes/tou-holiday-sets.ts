import type { FastifyInstance } from "fastify";
import {
  createTouHolidaySetSchema,
  putTouHolidaysSchema,
  touHolidaySetQuerySchema,
  updateTouHolidaySetSchema,
} from "@utility-cis/shared";
import {
  createTouHolidaySet,
  deleteTouHolidaySet,
  getTouHolidaySet,
  listTouHolidaySets,
  publishTouHolidaySet,
  putTouHolidays,
  updateTouHolidaySet,
} from "../services/tou-holiday-set.service.js";
import { idParamSchema } from "../lib/route-schemas.js";
import { registerCrudRoutes } from "../lib/crud-routes.js";

/**
 * A tenant's holiday sets (spec 26, TOU-CAL-4 and TOU-UI-2).
 *
 * Under the **`rate_schedules`** module like the calendars that name
 * them: a holiday here is not a company holiday, it is a day a tariff
 * prices differently, and whoever may set the hours may set which days
 * get them.
 */
export async function touHolidaySetRoutes(app: FastifyInstance) {
  registerCrudRoutes(app, {
    basePath: "/api/v1/tou-holiday-sets",
    module: "rate_schedules",
    list: {
      querySchema: touHolidaySetQuerySchema,
      service: (utilityId, query) => listTouHolidaySets(utilityId, query as never),
    },
    get: getTouHolidaySet,
    create: {
      bodySchema: createTouHolidaySetSchema,
      service: (user, data) =>
        createTouHolidaySet(user.utilityId, user.actorId, user.actorName, data as never),
    },
    update: {
      bodySchema: updateTouHolidaySetSchema,
      service: (user, id, data) =>
        updateTouHolidaySet(user.utilityId, user.actorId, user.actorName, id, data as never),
    },
    del: (id, user) => deleteTouHolidaySet(id, user),
  });

  const write = { config: { module: "rate_schedules", permission: "EDIT" } };

  /*
   * The dates are replaced whole: a set is one answer to "which days
   * are holidays", and a per-row save would make every intermediate
   * state a different answer.
   */
  app.put("/api/v1/tou-holiday-sets/:id/holidays", write, async (request, reply) => {
    const { utilityId, id: actorId, name: actorName } = request.user;
    const { id } = idParamSchema.parse(request.params);
    const data = putTouHolidaysSchema.parse(request.body);
    await putTouHolidays(utilityId, actorId, actorName, id, data);
    return reply.status(200).send(await getTouHolidaySet(id, utilityId));
  });

  app.post("/api/v1/tou-holiday-sets/:id/publish", write, async (request, reply) => {
    const { utilityId, id: actorId, name: actorName } = request.user;
    const { id } = idParamSchema.parse(request.params);
    return reply
      .status(200)
      .send(await publishTouHolidaySet(utilityId, actorId, actorName, id));
  });
}
