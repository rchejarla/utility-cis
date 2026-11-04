import type { FastifyInstance } from "fastify";
import {
  createTouHolidayListSchema,
  putTouHolidayRulesSchema,
  touHolidayListQuerySchema,
  updateTouHolidayListSchema,
} from "@utility-cis/shared";
import {
  createTouHolidayList,
  deleteTouHolidayList,
  getTouHolidayList,
  listTouHolidayLists,
  putTouHolidayRules,
  updateTouHolidayList,
} from "../services/tou-holiday-list.service.js";
import { z } from "zod";
import { idParamSchema } from "../lib/route-schemas.js";
import { registerCrudRoutes } from "../lib/crud-routes.js";

/** Three years from here, for looking further ahead than the default. */
const resolvedQuerySchema = z
  .object({ fromYear: z.coerce.number().int().min(1970).max(2200).optional() })
  .strict();

/**
 * A tenant's holiday lists (spec 26, TOU-CAL-4, TOU-UI-2 and TOU-UI-2a).
 *
 * Under the **`rate_schedules`** module like the calendars that name
 * them: a holiday here is not a company holiday, it is a day a tariff
 * prices differently, and whoever may set the hours may set which days
 * get them.
 *
 * A list is **shared across calendars** — a utility's holidays do not
 * vary by tariff, and per calendar, adding one would mean editing three
 * and missing one.
 */
export async function touHolidayListRoutes(app: FastifyInstance) {
  registerCrudRoutes(app, {
    basePath: "/api/v1/tou-holiday-lists",
    module: "rate_schedules",
    list: {
      querySchema: touHolidayListQuerySchema,
      service: (utilityId, query) => listTouHolidayLists(utilityId, query as never),
    },
    get: getTouHolidayList,
    create: {
      bodySchema: createTouHolidayListSchema,
      service: (user, data) =>
        createTouHolidayList(user.utilityId, user.actorId, user.actorName, data as never),
    },
    update: {
      bodySchema: updateTouHolidayListSchema,
      service: (user, id, data) =>
        updateTouHolidayList(user.utilityId, user.actorId, user.actorName, id, data as never),
    },
    del: (id, user) => deleteTouHolidayList(id, user),
  });

  /*
   * The same payload as the GET, for a window the caller names. The
   * CRUD factory's `get` takes only an id, so this is its own route
   * rather than a query parameter on that one.
   */
  app.get(
    "/api/v1/tou-holiday-lists/:id/resolved",
    { config: { module: "rate_schedules", permission: "VIEW" } },
    async (request, reply) => {
      const { utilityId } = request.user;
      const { id } = idParamSchema.parse(request.params);
      const { fromYear } = resolvedQuerySchema.parse(request.query);
      return reply.status(200).send(await getTouHolidayList(id, utilityId, fromYear));
    },
  );

  /*
   * The rules are replaced whole, like every other collection in this
   * subsystem: a list is read as a set — "these are our holidays" — and
   * a per-row save would make every intermediate state a different
   * answer to that.
   *
   * The response is the whole list including the dates the rules now
   * resolve to, because the output is the point: a rule nobody can see
   * the result of is a rule nobody will trust, and the observance is
   * where the surprises live.
   */
  app.put(
    "/api/v1/tou-holiday-lists/:id/rules",
    { config: { module: "rate_schedules", permission: "EDIT" } },
    async (request, reply) => {
      const { utilityId, id: actorId, name: actorName } = request.user;
      const { id } = idParamSchema.parse(request.params);
      const data = putTouHolidayRulesSchema.parse(request.body);
      await putTouHolidayRules(utilityId, actorId, actorName, id, data);
      return reply.status(200).send(await getTouHolidayList(id, utilityId));
    },
  );
}
