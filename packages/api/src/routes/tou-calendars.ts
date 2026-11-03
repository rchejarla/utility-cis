import type { FastifyInstance } from "fastify";
import {
  createTouCalendarSchema,
  putTouDayOverridesSchema,
  putTouDayTypesSchema,
  putTouPeriodsSchema,
  putTouSpansSchema,
  touCalendarQuerySchema,
  touDayPreviewQuerySchema,
  touSpotCheckQuerySchema,
  updateTouCalendarSchema,
} from "@utility-cis/shared";
import {
  createTouCalendar,
  deleteTouCalendar,
  getTouCalendar,
  listTouCalendars,
  previewTouDay,
  publishTouCalendar,
  putTouDayOverrides,
  putTouDayTypes,
  putTouPeriods,
  putTouSpans,
  spotCheckTouCalendar,
  updateTouCalendar,
  validateTouCalendar,
} from "../services/tou-calendar.service.js";
import { idParamSchema } from "../lib/route-schemas.js";
import { registerCrudRoutes } from "../lib/crud-routes.js";

/**
 * TOU calendars (spec 26, §5).
 *
 * Under the **`rate_schedules`** module rather than one of its own. A
 * TOU calendar is part of a tariff: it has no meaning except as the
 * hours a schedule prices against, and `publishRateSchedule` already
 * refuses a TOU schedule whose calendar does not line up. A separate
 * module would have to be enabled per tenant, and someone holding
 * `rate_schedules:EDIT` without it could build a schedule they are
 * unable to publish.
 */
export async function touCalendarRoutes(app: FastifyInstance) {
  registerCrudRoutes(app, {
    basePath: "/api/v1/tou-calendars",
    module: "rate_schedules",
    list: {
      querySchema: touCalendarQuerySchema,
      service: (utilityId, query) => listTouCalendars(utilityId, query as never),
    },
    get: getTouCalendar,
    create: {
      bodySchema: createTouCalendarSchema,
      service: (user, data) =>
        createTouCalendar(user.utilityId, user.actorId, user.actorName, data as never),
    },
    update: {
      bodySchema: updateTouCalendarSchema,
      service: (user, id, data) =>
        updateTouCalendar(user.utilityId, user.actorId, user.actorName, id, data as never),
    },
    del: (id, user) => deleteTouCalendar(id, user),
  });

  const write = { config: { module: "rate_schedules", permission: "EDIT" } };
  const read = { config: { module: "rate_schedules", permission: "VIEW" } };

  /*
   * The three child collections are replaced whole, which is why these
   * are PUTs on a sub-path and not a CRUD set each. See the service's
   * header: the invariants belong to the list, not the row.
   */
  app.put("/api/v1/tou-calendars/:id/periods", write, async (request, reply) => {
    const { utilityId, id: actorId, name: actorName } = request.user;
    const { id } = idParamSchema.parse(request.params);
    const data = putTouPeriodsSchema.parse(request.body);
    await putTouPeriods(utilityId, actorId, actorName, id, data);
    return reply.status(200).send(await getTouCalendar(id, utilityId));
  });

  app.put("/api/v1/tou-calendars/:id/day-types", write, async (request, reply) => {
    const { utilityId, id: actorId, name: actorName } = request.user;
    const { id } = idParamSchema.parse(request.params);
    const data = putTouDayTypesSchema.parse(request.body);
    await putTouDayTypes(utilityId, actorId, actorName, id, data);
    return reply.status(200).send(await getTouCalendar(id, utilityId));
  });

  app.put("/api/v1/tou-calendars/:id/spans", write, async (request, reply) => {
    const { utilityId, id: actorId, name: actorName } = request.user;
    const { id } = idParamSchema.parse(request.params);
    const data = putTouSpansSchema.parse(request.body);
    await putTouSpans(utilityId, actorId, actorName, id, data);
    /*
     * The whole calendar comes back, not the group that was saved,
     * because saving one group changes the validation of none of the
     * others but changes the screen's verdict on the calendar as a
     * whole — and a client that had to re-fetch to learn that would
     * show a stale "ready to publish" for as long as it took.
     */
    return reply.status(200).send(await getTouCalendar(id, utilityId));
  });

  app.put("/api/v1/tou-calendars/:id/overrides", write, async (request, reply) => {
    const { utilityId, id: actorId, name: actorName } = request.user;
    const { id } = idParamSchema.parse(request.params);
    const data = putTouDayOverridesSchema.parse(request.body);
    await putTouDayOverrides(utilityId, actorId, actorName, id, data);
    return reply.status(200).send(await getTouCalendar(id, utilityId));
  });

  app.post("/api/v1/tou-calendars/:id/publish", write, async (request, reply) => {
    const { utilityId, id: actorId, name: actorName } = request.user;
    const { id } = idParamSchema.parse(request.params);
    const calendar = await publishTouCalendar(utilityId, actorId, actorName, id);
    return reply.status(200).send(calendar);
  });

  app.get("/api/v1/tou-calendars/:id/validation", read, async (request, reply) => {
    const { utilityId } = request.user;
    const { id } = idParamSchema.parse(request.params);
    return reply.status(200).send(await validateTouCalendar(id, utilityId));
  });

  /** TOU-UI-1c. */
  app.get("/api/v1/tou-calendars/:id/spot-check", read, async (request, reply) => {
    const { utilityId } = request.user;
    const { id } = idParamSchema.parse(request.params);
    const query = touSpotCheckQuerySchema.parse(request.query);
    return reply.status(200).send(await spotCheckTouCalendar(id, utilityId, query));
  });

  /** TOU-UI-1e. */
  app.get("/api/v1/tou-calendars/:id/day", read, async (request, reply) => {
    const { utilityId } = request.user;
    const { id } = idParamSchema.parse(request.params);
    const query = touDayPreviewQuerySchema.parse(request.query);
    return reply.status(200).send(await previewTouDay(id, utilityId, query));
  });
}
