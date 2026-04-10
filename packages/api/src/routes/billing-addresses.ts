import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { createBillingAddressSchema, updateBillingAddressSchema } from "@utility-cis/shared";
import { idParamSchema } from "../lib/route-schemas.js";
import {
  listBillingAddresses,
  createBillingAddress,
  updateBillingAddress,
} from "../services/billing-address.service.js";

const billingAddressQuerySchema = z.object({
  accountId: z.string().uuid(),
}).strict();

export async function billingAddressRoutes(app: FastifyInstance) {
  app.get("/api/v1/billing-addresses", { config: { module: "customers", permission: "VIEW" } }, async (request, reply) => {
    const { utilityId } = request.user;
    const { accountId } = billingAddressQuerySchema.parse(request.query);
    const result = await listBillingAddresses(utilityId, accountId);
    return reply.send(result);
  });

  app.post("/api/v1/billing-addresses", { config: { module: "customers", permission: "CREATE" } }, async (request, reply) => {
    const { utilityId, id: actorId } = request.user;
    const data = createBillingAddressSchema.parse(request.body);
    const billingAddress = await createBillingAddress(utilityId, actorId, data);
    return reply.status(201).send(billingAddress);
  });

  app.patch("/api/v1/billing-addresses/:id", { config: { module: "customers", permission: "EDIT" } }, async (request, reply) => {
    const { utilityId, id: actorId } = request.user;
    const { id } = idParamSchema.parse(request.params);
    const data = updateBillingAddressSchema.parse(request.body);
    const billingAddress = await updateBillingAddress(utilityId, actorId, id, data);
    return reply.send(billingAddress);
  });
}
