import type { FastifyInstance } from "fastify";
import {
  agreePaymentPlanSchema,
  cancelPaymentPlanSchema,
} from "@utility-cis/shared";
import { createPaymentPlan } from "../services/payment-plan/create.js";
import { cancelPaymentPlan } from "../services/payment-plan/lifecycle.js";
import {
  getPaymentPlan,
  listAccountPaymentPlans,
} from "../services/payment-plan/read.js";

/**
 * Deferred payment agreements.
 *
 * Module `delinquency`, because a plan is what a utility offers instead
 * of chasing — the same authority that configures the ladder. The verbs
 * split by what they do rather than by what they touch: `CREATE` to
 * agree one, `EDIT` to cancel one, `VIEW` to read. A CSR who may agree a
 * plan at the counter is not thereby someone who may tear one up.
 */
export async function paymentPlanRoutes(app: FastifyInstance) {
  app.get(
    "/api/v1/accounts/:id/payment-plans",
    { config: { module: "delinquency", permission: "VIEW" } },
    async (request, reply) => {
      const { utilityId } = request.user;
      const { id } = request.params as { id: string };
      return reply.send({ data: await listAccountPaymentPlans(utilityId, id) });
    },
  );

  app.post(
    "/api/v1/accounts/:id/payment-plans",
    { config: { module: "delinquency", permission: "CREATE" } },
    async (request, reply) => {
      const { utilityId, id: actorId, name: actorName } = request.user;
      const { id } = request.params as { id: string };
      const input = agreePaymentPlanSchema.parse(request.body);

      const result = await createPaymentPlan(utilityId, actorId, actorName, id, input);
      return reply.status(201).send(result);
    },
  );

  app.get(
    "/api/v1/payment-plans/:id",
    { config: { module: "delinquency", permission: "VIEW" } },
    async (request, reply) => {
      const { utilityId } = request.user;
      const { id } = request.params as { id: string };

      const plan = await getPaymentPlan(utilityId, id);
      if (!plan) {
        return reply
          .status(404)
          .send({ error: { code: "PLAN_NOT_FOUND", message: "Payment plan not found" } });
      }
      return reply.send(plan);
    },
  );

  app.post(
    "/api/v1/payment-plans/:id/cancel",
    { config: { module: "delinquency", permission: "EDIT" } },
    async (request, reply) => {
      const { utilityId, id: actorId, name: actorName } = request.user;
      const { id } = request.params as { id: string };
      const { notes } = cancelPaymentPlanSchema.parse(request.body ?? {});

      const result = await cancelPaymentPlan(utilityId, actorId, actorName, id, notes);
      return reply.send(result);
    },
  );
}
