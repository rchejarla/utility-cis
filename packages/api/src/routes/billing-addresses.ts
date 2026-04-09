import type { FastifyInstance } from "fastify";
import { createBillingAddressSchema, updateBillingAddressSchema } from "@utility-cis/shared";
import {
  listBillingAddresses,
  createBillingAddress,
  updateBillingAddress,
} from "../services/billing-address.service.js";

export async function billingAddressRoutes(app: FastifyInstance) {
  app.get("/api/v1/billing-addresses", async (request, reply) => {
    const { utilityId } = request.user;
    const { accountId } = request.query as { accountId: string };
    const result = await listBillingAddresses(utilityId, accountId);
    return reply.send(result);
  });

  app.post("/api/v1/billing-addresses", async (request, reply) => {
    const { utilityId, id: actorId } = request.user;
    const data = createBillingAddressSchema.parse(request.body);
    const billingAddress = await createBillingAddress(utilityId, actorId, data);
    return reply.status(201).send(billingAddress);
  });

  app.patch("/api/v1/billing-addresses/:id", async (request, reply) => {
    const { utilityId, id: actorId } = request.user;
    const { id } = request.params as { id: string };
    const data = updateBillingAddressSchema.parse(request.body);
    const billingAddress = await updateBillingAddress(utilityId, actorId, id, data);
    return reply.send(billingAddress);
  });
}
