import type { FastifyInstance } from "fastify";
import { createBillingCycleSchema, updateBillingCycleSchema } from "@utility-cis/shared";
import {
  listBillingCycles,
  getBillingCycle,
  createBillingCycle,
  updateBillingCycle,
} from "../services/billing-cycle.service.js";
import { idParamSchema } from "../lib/route-schemas.js";

export async function billingCycleRoutes(app: FastifyInstance) {
  app.get("/api/v1/billing-cycles", { config: { module: "billing_cycles", permission: "VIEW" } }, async (request, reply) => {
    const { utilityId } = request.user;
    const result = await listBillingCycles(utilityId);
    return reply.send(result);
  });

  app.get("/api/v1/billing-cycles/:id", { config: { module: "billing_cycles", permission: "VIEW" } }, async (request, reply) => {
    const { utilityId } = request.user;
    const { id } = idParamSchema.parse(request.params);
    const result = await getBillingCycle(id, utilityId);
    return reply.send(result);
  });

  app.post("/api/v1/billing-cycles", { config: { module: "billing_cycles", permission: "CREATE" } }, async (request, reply) => {
    const { utilityId, id: actorId, name: actorName } = request.user;
    const data = createBillingCycleSchema.parse(request.body);
    const billingCycle = await createBillingCycle(utilityId, actorId, actorName, data);
    return reply.status(201).send(billingCycle);
  });

  app.patch("/api/v1/billing-cycles/:id", { config: { module: "billing_cycles", permission: "EDIT" } }, async (request, reply) => {
    const { utilityId, id: actorId, name: actorName } = request.user;
    const { id } = idParamSchema.parse(request.params);
    const data = updateBillingCycleSchema.parse(request.body);
    const billingCycle = await updateBillingCycle(utilityId, actorId, actorName, id, data);
    return reply.send(billingCycle);
  });
}
