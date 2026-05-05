import type { FastifyInstance } from "fastify";
import { idParamSchema } from "../lib/route-schemas.js";
import { createBillSchema } from "@utility-cis/shared";
import {
  createBillForServiceAgreement,
  listBillsForServiceAgreement,
} from "../services/bill.service.js";

export async function serviceAgreementBillRoutes(app: FastifyInstance) {
  app.post(
    "/api/v1/service-agreements/:id/bills",
    { config: { module: "agreements", permission: "EDIT" } },
    async (request, reply) => {
      const { utilityId, id: actorId, name: actorName } = request.user;
      const { id: saId } = idParamSchema.parse(request.params);
      const body = createBillSchema.parse(request.body);
      const bill = await createBillForServiceAgreement(
        utilityId,
        actorId,
        actorName,
        saId,
        {
          periodStart: new Date(body.periodStart),
          periodEnd: new Date(body.periodEnd),
        },
      );
      return reply.status(201).send(bill);
    },
  );

  app.get(
    "/api/v1/service-agreements/:id/bills",
    { config: { module: "agreements", permission: "VIEW" } },
    async (request, reply) => {
      const { utilityId } = request.user;
      const { id: saId } = idParamSchema.parse(request.params);
      const bills = await listBillsForServiceAgreement(utilityId, saId);
      return reply.send(bills);
    },
  );
}
