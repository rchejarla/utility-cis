import type { FastifyInstance } from "fastify";
import { createCustomerSchema, updateCustomerSchema, customerQuerySchema } from "@utility-cis/shared";
import {
  listCustomers,
  getCustomer,
  createCustomer,
  updateCustomer,
} from "../services/customer.service.js";
import { idParamSchema } from "../lib/route-schemas.js";

export async function customerRoutes(app: FastifyInstance) {
  app.get("/api/v1/customers", { config: { module: "customers", permission: "VIEW" } }, async (request, reply) => {
    const { utilityId } = request.user;
    const query = customerQuerySchema.parse(request.query);
    const result = await listCustomers(utilityId, query);
    return reply.send(result);
  });

  app.get("/api/v1/customers/:id", { config: { module: "customers", permission: "VIEW" } }, async (request, reply) => {
    const { utilityId } = request.user;
    const { id } = idParamSchema.parse(request.params);
    const customer = await getCustomer(id, utilityId);
    return reply.send(customer);
  });

  app.post("/api/v1/customers", { config: { module: "customers", permission: "CREATE" } }, async (request, reply) => {
    const { utilityId, id: actorId, name: actorName } = request.user;
    const data = createCustomerSchema.parse(request.body);
    const customer = await createCustomer(utilityId, actorId, actorName, data);
    return reply.status(201).send(customer);
  });

  app.patch("/api/v1/customers/:id", { config: { module: "customers", permission: "EDIT" } }, async (request, reply) => {
    const { utilityId, id: actorId, name: actorName } = request.user;
    const { id } = idParamSchema.parse(request.params);
    const data = updateCustomerSchema.parse(request.body);
    const customer = await updateCustomer(utilityId, actorId, actorName, id, data);
    return reply.send(customer);
  });
}
