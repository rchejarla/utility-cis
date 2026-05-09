import type { FastifyInstance } from "fastify";
import { idParamSchema } from "../lib/route-schemas.js";
import { generateBillSchema } from "@utility-cis/shared";
import {
  generateBillForAccount,
  listBillsForAccount,
} from "../services/bill.service.js";

export async function accountBillRoutes(app: FastifyInstance) {
  app.post(
    "/api/v1/accounts/:id/bills",
    { config: { module: "accounts", permission: "EDIT" } },
    async (request, reply) => {
      const { utilityId, id: actorId, name: actorName } = request.user;
      const { id: accountId } = idParamSchema.parse(request.params);
      const body = generateBillSchema.parse(request.body ?? {});
      const bill = await generateBillForAccount(
        utilityId,
        actorId,
        actorName,
        accountId,
        { asOfDate: body.asOfDate ? new Date(body.asOfDate) : undefined },
      );
      return reply.status(201).send(bill);
    },
  );

  app.get(
    "/api/v1/accounts/:id/bills",
    { config: { module: "accounts", permission: "VIEW" } },
    async (request, reply) => {
      const { utilityId } = request.user;
      const { id: accountId } = idParamSchema.parse(request.params);
      const bills = await listBillsForAccount(utilityId, accountId);
      return reply.send(bills);
    },
  );
}
