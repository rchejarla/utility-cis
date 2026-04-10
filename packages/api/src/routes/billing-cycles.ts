import type { FastifyInstance } from "fastify";
import { createBillingCycleSchema, updateBillingCycleSchema } from "@utility-cis/shared";
import {
  listBillingCycles,
  getBillingCycle,
  createBillingCycle,
  updateBillingCycle,
} from "../services/billing-cycle.service.js";
import { registerCrudRoutes } from "../lib/crud-routes.js";

export async function billingCycleRoutes(app: FastifyInstance) {
  registerCrudRoutes(app, {
    basePath: "/api/v1/billing-cycles",
    module: "billing_cycles",
    list: { service: listBillingCycles },
    get: getBillingCycle,
    create: {
      bodySchema: createBillingCycleSchema,
      service: (user, data) =>
        createBillingCycle(user.utilityId, user.actorId, user.actorName, data as never),
    },
    update: {
      bodySchema: updateBillingCycleSchema,
      service: (user, id, data) =>
        updateBillingCycle(user.utilityId, user.actorId, user.actorName, id, data as never),
    },
  });
}
