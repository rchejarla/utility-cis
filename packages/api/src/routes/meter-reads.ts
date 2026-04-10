import type { FastifyInstance } from "fastify";
import {
  createMeterReadSchema,
  correctMeterReadSchema,
  meterReadQuerySchema,
  resolveExceptionSchema,
} from "@utility-cis/shared";
import {
  listMeterReads,
  getMeterRead,
  readsForMeter,
  listExceptions,
  createMeterRead,
  correctMeterRead,
  resolveException,
  deleteMeterRead,
} from "../services/meter-read.service.js";
import { idParamSchema } from "../lib/route-schemas.js";
import { z } from "zod";

/**
 * Meter-read routes can't use the `registerCrudRoutes` factory because
 * the shape is non-standard: no plain UPDATE (corrections create new
 * rows), extra endpoints for per-meter history, exception queue, and
 * exception resolution. Declarative factory work stops and hand-rolling
 * begins right at the point where the business rules diverge from the
 * stock CRUD template.
 */

const meterIdParamSchema = z.object({ meterId: z.string().uuid() });

export async function meterReadRoutes(app: FastifyInstance) {
  app.get(
    "/api/v1/meter-reads",
    { config: { module: "meter_reads", permission: "VIEW" } },
    async (request, reply) => {
      const { utilityId } = request.user;
      const query = meterReadQuerySchema.parse(request.query);
      return reply.send(await listMeterReads(utilityId, query));
    },
  );

  // Exception queue — list reads flagged for review that haven't been
  // billed yet. Defined BEFORE the /:id route so Fastify's radix matches
  // the literal "exceptions" segment instead of interpreting it as an id.
  app.get(
    "/api/v1/meter-reads/exceptions",
    { config: { module: "meter_reads", permission: "VIEW" } },
    async (request, reply) => {
      const { utilityId } = request.user;
      const query = meterReadQuerySchema.parse(request.query);
      return reply.send(await listExceptions(utilityId, query));
    },
  );

  app.get(
    "/api/v1/meter-reads/:id",
    { config: { module: "meter_reads", permission: "VIEW" } },
    async (request, reply) => {
      const { utilityId } = request.user;
      const { id } = idParamSchema.parse(request.params);
      return reply.send(await getMeterRead(id, utilityId));
    },
  );

  app.post(
    "/api/v1/meter-reads",
    { config: { module: "meter_reads", permission: "CREATE" } },
    async (request, reply) => {
      const { utilityId, id: actorId, name: actorName } = request.user;
      const data = createMeterReadSchema.parse(request.body);
      const read = await createMeterRead(utilityId, actorId, actorName, data);
      return reply.status(201).send(read);
    },
  );

  // PATCH on a meter read is a CORRECTION — the original is preserved,
  // a new CORRECTED row is inserted. The spec is explicit that this
  // must not mutate the original for audit integrity.
  app.patch(
    "/api/v1/meter-reads/:id",
    { config: { module: "meter_reads", permission: "EDIT" } },
    async (request, reply) => {
      const { utilityId, id: actorId, name: actorName } = request.user;
      const { id } = idParamSchema.parse(request.params);
      const data = correctMeterReadSchema.parse(request.body);
      const read = await correctMeterRead(utilityId, actorId, actorName, id, data);
      return reply.status(201).send(read);
    },
  );

  app.post(
    "/api/v1/meter-reads/:id/resolve-exception",
    { config: { module: "meter_reads", permission: "EDIT" } },
    async (request, reply) => {
      const { utilityId, id: actorId, name: actorName } = request.user;
      const { id } = idParamSchema.parse(request.params);
      const data = resolveExceptionSchema.parse(request.body);
      const read = await resolveException(utilityId, actorId, actorName, id, data);
      return reply.send(read);
    },
  );

  // Hard-delete a meter read. Guarded server-side against deleting
  // frozen (billed) reads or reads that have been corrected by a
  // subsequent CORRECTED row. See deleteMeterRead in the service for
  // the full rule set.
  app.delete(
    "/api/v1/meter-reads/:id",
    { config: { module: "meter_reads", permission: "DELETE" } },
    async (request, reply) => {
      const { utilityId, id: actorId, name: actorName } = request.user;
      const { id } = idParamSchema.parse(request.params);
      await deleteMeterRead(utilityId, actorId, actorName, id);
      return reply.status(204).send();
    },
  );

  // Per-meter read history for the meter detail page chart/timeline.
  app.get(
    "/api/v1/meters/:meterId/reads",
    { config: { module: "meters", permission: "VIEW" } },
    async (request, reply) => {
      const { utilityId } = request.user;
      const { meterId } = meterIdParamSchema.parse(request.params);
      const limitParam = z
        .object({ limit: z.coerce.number().int().positive().max(500).default(100) })
        .parse(request.query);
      const reads = await readsForMeter(utilityId, meterId, limitParam.limit);
      return reply.send({ data: reads });
    },
  );
}
