import type { FastifyInstance } from "fastify";
import { createMeterSchema, updateMeterSchema, meterQuerySchema } from "@utility-cis/shared";
import {
  listMeters,
  getMeter,
  createMeter,
  updateMeter,
} from "../services/meter.service.js";

export async function meterRoutes(app: FastifyInstance) {
  app.get("/api/v1/meters", async (request, reply) => {
    const { utilityId } = request.user;
    const query = meterQuerySchema.parse(request.query);
    const result = await listMeters(utilityId, query);
    return reply.send(result);
  });

  app.get("/api/v1/meters/:id", async (request, reply) => {
    const { utilityId } = request.user;
    const { id } = request.params as { id: string };
    const meter = await getMeter(id, utilityId);
    return reply.send(meter);
  });

  app.post("/api/v1/meters", async (request, reply) => {
    const { utilityId, id: actorId, name: actorName } = request.user;
    const data = createMeterSchema.parse(request.body);
    const meter = await createMeter(utilityId, actorId, actorName, data);
    return reply.status(201).send(meter);
  });

  app.patch("/api/v1/meters/:id", async (request, reply) => {
    const { utilityId, id: actorId, name: actorName } = request.user;
    const { id } = request.params as { id: string };
    const data = updateMeterSchema.parse(request.body);
    const meter = await updateMeter(utilityId, actorId, actorName, id, data);
    return reply.send(meter);
  });
}
