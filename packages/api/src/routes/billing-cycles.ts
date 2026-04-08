import type { FastifyInstance } from "fastify";
import { createBillingCycleSchema, updateBillingCycleSchema } from "@utility-cis/shared";
import {
  listBillingCycles,
  createBillingCycle,
  updateBillingCycle,
} from "../services/billing-cycle.service.js";

export async function billingCycleRoutes(app: FastifyInstance) {
  app.get("/api/v1/billing-cycles", async (request, reply) => {
    const { utilityId } = request.user;
    const result = await listBillingCycles(utilityId);
    return reply.send(result);
  });

  app.post("/api/v1/billing-cycles", async (request, reply) => {
    const { utilityId, id: actorId } = request.user;
    const data = createBillingCycleSchema.parse(request.body);
    const billingCycle = await createBillingCycle(utilityId, actorId, data);
    return reply.status(201).send(billingCycle);
  });

  app.patch("/api/v1/billing-cycles/:id", async (request, reply) => {
    const { utilityId, id: actorId } = request.user;
    const { id } = request.params as { id: string };
    const data = updateBillingCycleSchema.parse(request.body);
    const billingCycle = await updateBillingCycle(utilityId, actorId, id, data);
    return reply.send(billingCycle);
  });
}
