import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  readRouteInputSchema,
  readRouteUpdateSchema,
  readRouteQuerySchema,
  readRouteStopInputSchema,
  unsequencedPremiseQuerySchema,
  entryOpenSchema,
  entryRowSaveSchema,
  routeSheetQuerySchema,
  readRouteProgressQuerySchema,
} from "@utility-cis/shared";
import {
  createReadRoute,
  getReadRoute,
  listReadRoutes,
  updateReadRoute,
  addStop,
  removeStop,
  listRouteStopDetails,
  listUnsequencedPremises,
} from "../services/read-route.service.js";
import { buildRouteSheet, renderRouteSheetPdf } from "../services/read-route/route-sheet.js";
import {
  openEntry,
  saveEntryRow,
  submitEntry,
  reopenEntryForCorrections,
} from "../services/read-route-entry.service.js";
import { getReadingProgress } from "../services/reading-progress.service.js";
import { idParamSchema } from "../lib/route-schemas.js";

/**
 * Everything HTTP about read routes: the routes themselves, their stops,
 * the printed sheet, typing a sheet in, and how far along one is
 * (spec 30; design §§5.1, 5.6, 5.7, 5.9).
 *
 * Not `registerCrudRoutes`, for the same reason meter reads are not: the
 * shape diverges from stock CRUD almost immediately. There is no DELETE
 * for a route (deactivating one is a PATCH, because its reads point at
 * it), the stops are a sub-collection with their own refusals, one
 * endpoint answers with a PDF, and four of them are a batch lifecycle
 * rather than a resource.
 *
 * **Permissions are §5.10's, and nothing here invents a module.** VIEW
 * reads — the list, a route, its stops, the tray, the sheet, the
 * progress. CREATE enters — opening entry, saving a row, submitting,
 * reopening a sheet to correct it. EDIT maintains — creating a route,
 * renaming one, adding and removing stops. That split is deliberate and
 * is not a detail: a clerk typing a sheet in is not the person who
 * decides which addresses are on the walk, so CREATE does not carry
 * stop maintenance.
 *
 * **Every refusal comes from the service, by `statusCode` and `code`.**
 * No route re-checks a rule — `ROUTE_IS_EXTERNAL`, `ROUTE_CODE_TAKEN`,
 * `PREMISE_ALREADY_ON_ROUTE`, `ENTRY_CLOSED`, `READ_BILLED` and the rest
 * are decided once, under the row locks that make them true, and this
 * file only parses input and names paths.
 */

const stopParamSchema = z.object({
  id: z.string().uuid(),
  stopId: z.string().uuid(),
});

const batchParamSchema = z.object({
  id: z.string().uuid(),
  batchId: z.string().uuid(),
});

/** A `YYYY-MM-DD` as UTC midnight, which is what every date in this feature is. */
const utcDay = (day: string) => new Date(`${day}T00:00:00.000Z`);

export async function readRouteRoutes(app: FastifyInstance) {
  app.get(
    "/api/v1/read-routes",
    { config: { module: "meter_reads", permission: "VIEW" } },
    async (request, reply) => {
      const { utilityId } = request.user;
      const query = readRouteQuerySchema.parse(request.query ?? {});
      return reply.send(await listReadRoutes(utilityId, query));
    },
  );

  app.post(
    "/api/v1/read-routes",
    { config: { module: "meter_reads", permission: "EDIT" } },
    async (request, reply) => {
      const { utilityId, id: actorId, name: actorName } = request.user;
      const input = readRouteInputSchema.parse(request.body);
      const route = await createReadRoute(utilityId, { id: actorId, name: actorName }, input);
      return reply.status(201).send(route);
    },
  );

  app.get(
    "/api/v1/read-routes/:id",
    { config: { module: "meter_reads", permission: "VIEW" } },
    async (request, reply) => {
      const { utilityId } = request.user;
      const { id } = idParamSchema.parse(request.params);
      return reply.send(await getReadRoute(utilityId, id));
    },
  );

  app.patch(
    "/api/v1/read-routes/:id",
    { config: { module: "meter_reads", permission: "EDIT" } },
    async (request, reply) => {
      const { utilityId, id: actorId, name: actorName } = request.user;
      const { id } = idParamSchema.parse(request.params);
      // `origin` is absent from this schema on purpose — claiming a
      // vendor's route as local reassigns who owns the itinerary, which
      // is its own operation, not a field.
      const input = readRouteUpdateSchema.parse(request.body);
      return reply.send(await updateReadRoute(utilityId, { id: actorId, name: actorName }, id, input));
    },
  );

  /*
   * The stops, with the address a reader walks to and the cycles the
   * accounts served there bill on. `{ data }` and no `meta`: a route's
   * stops are a morning's walk, so there is no page to be on.
   */
  app.get(
    "/api/v1/read-routes/:id/stops",
    { config: { module: "meter_reads", permission: "VIEW" } },
    async (request, reply) => {
      const { utilityId } = request.user;
      const { id } = idParamSchema.parse(request.params);
      return reply.send({ data: await listRouteStopDetails(utilityId, id) });
    },
  );

  app.post(
    "/api/v1/read-routes/:id/stops",
    { config: { module: "meter_reads", permission: "EDIT" } },
    async (request, reply) => {
      const { utilityId, id: actorId, name: actorName } = request.user;
      const { id } = idParamSchema.parse(request.params);
      const input = readRouteStopInputSchema.parse(request.body);
      const stop = await addStop(utilityId, { id: actorId, name: actorName }, id, input);
      return reply.status(201).send(stop);
    },
  );

  app.delete(
    "/api/v1/read-routes/:id/stops/:stopId",
    { config: { module: "meter_reads", permission: "EDIT" } },
    async (request, reply) => {
      const { utilityId, id: actorId, name: actorName } = request.user;
      const { id, stopId } = stopParamSchema.parse(request.params);
      await removeStop(utilityId, { id: actorId, name: actorName }, id, stopId);
      return reply.status(204).send();
    },
  );

  /*
   * The tray: premises on **no route at all**, not "missing from this
   * one". A reader visits an address once, so offering a premise that is
   * already on another route would invite the double visit ordering
   * exists to prevent.
   */
  app.get(
    "/api/v1/read-routes/:id/unsequenced",
    { config: { module: "meter_reads", permission: "VIEW" } },
    async (request, reply) => {
      const { utilityId } = request.user;
      const { id } = idParamSchema.parse(request.params);
      const query = unsequencedPremiseQuerySchema.parse(request.query ?? {});
      return reply.send(await listUnsequencedPremises(utilityId, id, query));
    },
  );

  /**
   * The sheet. `format=json` answers the data instead of the paper,
   * because `buildRouteSheet` also returns the stops it could **not**
   * print — a premise on the route with no readable meter — and a PDF
   * body cannot carry that. A stop that disappears from a sheet with no
   * trace is the silent failure §5.1 forbids, so the route page asks for
   * the JSON and says so before anybody prints.
   *
   * Not persisted, and so not an attachment: a sheet is scrap paper,
   * reprintable from the stops at any time, and the reads that come back
   * are the record.
   */
  app.get(
    "/api/v1/read-routes/:id/sheet",
    { config: { module: "meter_reads", permission: "VIEW" } },
    async (request, reply) => {
      const { utilityId } = request.user;
      const { id } = idParamSchema.parse(request.params);
      const { onDate, format } = routeSheetQuerySchema.parse(request.query ?? {});
      const sheet = await buildRouteSheet(utilityId, id, utcDay(onDate));
      if (format === "json") return reply.send(sheet);
      return reply
        .header("Content-Type", "application/pdf")
        .header(
          "Content-Disposition",
          `inline; filename="route-${sheet.routeCode}-${sheet.forDate}.pdf"`,
        )
        .send(await renderRouteSheetPdf(sheet));
    },
  );

  /*
   * Opening entry is idempotent — the batch already opened for that
   * (route, date) comes back, in whatever state it is in — so this is a
   * POST that may create nothing. 201 either way: what the caller asked
   * for is "the sheet for this day", and reporting 200 for the second
   * clerk to open a route would leak which of them got there first.
   */
  app.post(
    "/api/v1/read-routes/:id/entry",
    { config: { module: "meter_reads", permission: "CREATE" } },
    async (request, reply) => {
      const { utilityId, id: actorId, name: actorName } = request.user;
      const { id } = idParamSchema.parse(request.params);
      const { readDate } = entryOpenSchema.parse(request.body);
      const opened = await openEntry(
        utilityId,
        { id: actorId, name: actorName },
        id,
        utcDay(readDate),
      );
      return reply.status(201).send(opened);
    },
  );

  app.patch(
    "/api/v1/read-routes/:id/entry/:batchId/rows",
    { config: { module: "meter_reads", permission: "CREATE" } },
    async (request, reply) => {
      const { utilityId, id: actorId, name: actorName } = request.user;
      const { batchId } = batchParamSchema.parse(request.params);
      const input = entryRowSaveSchema.parse(request.body);
      const row = await saveEntryRow(utilityId, { id: actorId, name: actorName }, batchId, input);
      return reply.send(row);
    },
  );

  app.post(
    "/api/v1/read-routes/:id/entry/:batchId/submit",
    { config: { module: "meter_reads", permission: "CREATE" } },
    async (request, reply) => {
      const { utilityId, id: actorId, name: actorName } = request.user;
      const { batchId } = batchParamSchema.parse(request.params);
      return reply.send(await submitEntry(utilityId, { id: actorId, name: actorName }, batchId));
    },
  );

  /**
   * Reopen a posted sheet so the stops it refused can be corrected.
   *
   * **No batch id in the path.** `reopenEntryForCorrections` finds the
   * batch itself from `(route, date)`, under the same `read_route` row
   * lock `openEntry` takes — that lock is what makes "find and reopen"
   * one decision — so a segment naming a batch would be a lie in the
   * URL: the service would ignore it, and a caller passing the wrong one
   * would be reopening a different sheet than they named. It mirrors
   * `POST .../entry`, which takes the same `readDate`.
   *
   * Refuses a sheet that posted cleanly (409 `ENTRY_NOTHING_TO_CORRECT`):
   * reopening one could not be told apart from posting it twice.
   */
  app.post(
    "/api/v1/read-routes/:id/entry/reopen",
    { config: { module: "meter_reads", permission: "CREATE" } },
    async (request, reply) => {
      const { utilityId, id: actorId, name: actorName } = request.user;
      const { id } = idParamSchema.parse(request.params);
      const { readDate } = entryOpenSchema.parse(request.body);
      const reopened = await reopenEntryForCorrections(
        utilityId,
        { id: actorId, name: actorName },
        id,
        utcDay(readDate),
      );
      return reply.send(reopened);
    },
  );

  /*
   * How far along this route is. The cycle is the route's own and is not
   * a parameter: a route has one, it is required, and letting a caller
   * name a different one only creates a mismatch to refuse.
   */
  app.get(
    "/api/v1/read-routes/:id/progress",
    { config: { module: "meter_reads", permission: "VIEW" } },
    async (request, reply) => {
      const { utilityId } = request.user;
      const { id } = idParamSchema.parse(request.params);
      const query = readRouteProgressQuerySchema.parse(request.query ?? {});
      const route = await getReadRoute(utilityId, id);
      return reply.send(
        await getReadingProgress(utilityId, {
          billingCycleId: route.billingCycleId,
          readRouteId: id,
          page: query.page,
          limit: query.limit,
          ...(query.asOf ? { asOf: query.asOf } : {}),
        }),
      );
    },
  );
}
