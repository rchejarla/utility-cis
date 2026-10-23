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
      /*
       * Created for review, never posted here (Bozeman — off-cycle
       * billing). A run makes bills and a person posts them as a second,
       * deliberate act; this path used to post immediately per the
       * tenant's `autoPostBills`, so the same act moved money or did
       * not depending on which screen it was started from — and the
       * screen with less context around it was the one that charged the
       * customer straight away.
       *
       * `autoPostBills` now governs nothing. It is left in the
       * automation config rather than quietly deleted, because removing
       * a setting an operator may have turned off is its own decision.
       */
      const bill = await generateBillForAccount(
        utilityId,
        actorId,
        actorName,
        accountId,
        {
          asOfDate: body.asOfDate ? new Date(body.asOfDate) : undefined,
          suppressAutoPost: true,
        },
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
