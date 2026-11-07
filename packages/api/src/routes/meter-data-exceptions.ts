import type { FastifyInstance } from "fastify";
import { meterDataExceptionQuerySchema } from "@utility-cis/shared";
import {
  listDataExceptions,
  acceptDataException,
  reopenDataException,
} from "../services/meter-data-exception.service.js";
import { idParamSchema } from "../lib/route-schemas.js";

/**
 * The interval-coverage queue (spec 26, TOU-GAP-1).
 *
 * Two verbs and a list, because the sweep owns the rest: it opens a row
 * when a day's intervals do not cover it and resolves the row when the
 * data arrives, so nothing here creates or deletes one. What a person
 * does is decide — and `accept` is the decision with consequences,
 * since `checkTouReadiness` sums accepted minutes and stops blocking
 * them.
 *
 * **Gated on `meter_reads`, not `billing`.** Accepting changes what a
 * bill contains, which argues for the billing key, but the judgement
 * being made is about meter data: whether a hole in an interval series
 * is ever going to be filled. That is the same authority as correcting
 * a read, which also moves a bill and lives here. The 2026-11-03 review
 * that moved billing runs onto `billing` drew the line in the same
 * place: an operation on one record stays with that record's module.
 */
export async function meterDataExceptionRoutes(app: FastifyInstance) {
  app.get(
    "/api/v1/meter-data-exceptions",
    { config: { module: "meter_reads", permission: "VIEW" } },
    async (request, reply) => {
      const { utilityId } = request.user;
      const query = meterDataExceptionQuerySchema.parse(request.query ?? {});
      return reply.send(await listDataExceptions(utilityId, query));
    },
  );

  app.post(
    "/api/v1/meter-data-exceptions/:id/accept",
    { config: { module: "meter_reads", permission: "EDIT" } },
    async (request, reply) => {
      const { utilityId, id: actorId, name: actorName } = request.user;
      const { id } = idParamSchema.parse(request.params);
      const row = await acceptDataException(id, {
        utilityId,
        actorId,
        actorName,
        entityType: "meter_data_exception",
      });
      return reply.send(row);
    },
  );

  app.post(
    "/api/v1/meter-data-exceptions/:id/reopen",
    { config: { module: "meter_reads", permission: "EDIT" } },
    async (request, reply) => {
      const { utilityId, id: actorId, name: actorName } = request.user;
      const { id } = idParamSchema.parse(request.params);
      const row = await reopenDataException(id, {
        utilityId,
        actorId,
        actorName,
        entityType: "meter_data_exception",
      });
      return reply.send(row);
    },
  );
}
