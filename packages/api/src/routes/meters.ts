import type { FastifyInstance } from "fastify";
import { createMeterSchema, updateMeterSchema, meterQuerySchema } from "@utility-cis/shared";
import {
  listMeters,
  getMeter,
  createMeter,
  updateMeter,
} from "../services/meter.service.js";
import { idParamSchema } from "../lib/route-schemas.js";

export async function meterRoutes(app: FastifyInstance) {
  app.get("/api/v1/meters", { config: { module: "meters", permission: "VIEW" } }, async (request, reply) => {
    const { utilityId } = request.user;
    const query = meterQuerySchema.parse(request.query);
    const result = await listMeters(utilityId, query);
    return reply.send(result);
  });

  app.get("/api/v1/meters/:id", { config: { module: "meters", permission: "VIEW" } }, async (request, reply) => {
    const { utilityId } = request.user;
    const { id } = idParamSchema.parse(request.params);
    const meter = await getMeter(id, utilityId);
    return reply.send(meter);
  });

  app.post("/api/v1/meters", { config: { module: "meters", permission: "CREATE" } }, async (request, reply) => {
    const { utilityId, id: actorId, name: actorName } = request.user;
    const data = createMeterSchema.parse(request.body);
    const meter = await createMeter(utilityId, actorId, actorName, data);
    return reply.status(201).send(meter);
  });

  app.patch("/api/v1/meters/:id", { config: { module: "meters", permission: "EDIT" } }, async (request, reply) => {
    const { utilityId, id: actorId, name: actorName } = request.user;
    const { id } = idParamSchema.parse(request.params);
    const data = updateMeterSchema.parse(request.body);
    const meter = await updateMeter(utilityId, actorId, actorName, id, data);
    return reply.send(meter);
  });
}
