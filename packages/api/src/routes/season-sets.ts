import type { FastifyInstance } from "fastify";
import {
  createSeasonSetSchema,
  putSeasonsSchema,
  seasonSetQuerySchema,
  updateSeasonSetSchema,
} from "@utility-cis/shared";
import {
  createSeasonSet,
  deleteSeasonSet,
  getSeasonSet,
  listSeasonSets,
  publishSeasonSet,
  putSeasons,
  updateSeasonSet,
} from "../services/season-set.service.js";
import { idParamSchema } from "../lib/route-schemas.js";
import { registerCrudRoutes } from "../lib/crud-routes.js";

/**
 * A tenant's season sets (spec 26, §1).
 *
 * Under the **`rate_schedules`** module, like TOU calendars and for the
 * same reason: a season code is only ever something a rate component or
 * a calendar's hours are keyed on, and whoever may price a tariff
 * decides where summer starts.
 */
export async function seasonSetRoutes(app: FastifyInstance) {
  registerCrudRoutes(app, {
    basePath: "/api/v1/season-sets",
    module: "rate_schedules",
    list: {
      querySchema: seasonSetQuerySchema,
      service: (utilityId, query) => listSeasonSets(utilityId, query as never),
    },
    get: getSeasonSet,
    create: {
      bodySchema: createSeasonSetSchema,
      service: (user, data) =>
        createSeasonSet(user.utilityId, user.actorId, user.actorName, data as never),
    },
    update: {
      bodySchema: updateSeasonSetSchema,
      service: (user, id, data) =>
        updateSeasonSet(user.utilityId, user.actorId, user.actorName, id, data as never),
    },
    del: (id, user) => deleteSeasonSet(id, user),
  });

  const write = { config: { module: "rate_schedules", permission: "EDIT" } };

  /*
   * The seasons are replaced whole: "covers every day exactly once" is
   * a property of the list, so a per-row save would make every
   * intermediate state invalid.
   */
  app.put("/api/v1/season-sets/:id/seasons", write, async (request, reply) => {
    const { utilityId, id: actorId, name: actorName } = request.user;
    const { id } = idParamSchema.parse(request.params);
    const data = putSeasonsSchema.parse(request.body);
    await putSeasons(utilityId, actorId, actorName, id, data);
    return reply.status(200).send(await getSeasonSet(id, utilityId));
  });

  app.post("/api/v1/season-sets/:id/publish", write, async (request, reply) => {
    const { utilityId, id: actorId, name: actorName } = request.user;
    const { id } = idParamSchema.parse(request.params);
    return reply.status(200).send(await publishSeasonSet(utilityId, actorId, actorName, id));
  });
}
