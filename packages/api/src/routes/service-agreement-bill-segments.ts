import type { FastifyInstance } from "fastify";
import { idParamSchema } from "../lib/route-schemas.js";
import { createBillSegmentSchema } from "@utility-cis/shared";
import {
  createBillSegmentForServiceAgreement,
  listBillSegmentsForServiceAgreement,
} from "../services/bill-segment.service.js";

export async function serviceAgreementBillSegmentRoutes(app: FastifyInstance) {
  app.post(
    "/api/v1/service-agreements/:id/bill-segments",
    { config: { module: "agreements", permission: "EDIT" } },
    async (request, reply) => {
      const { utilityId, id: actorId, name: actorName } = request.user;
      const { id: saId } = idParamSchema.parse(request.params);
      const body = createBillSegmentSchema.parse(request.body);
      const segment = await createBillSegmentForServiceAgreement(
        utilityId,
        actorId,
        actorName,
        saId,
        {
          periodStart: new Date(body.periodStart),
          periodEnd: new Date(body.periodEnd),
        },
      );
      return reply.status(201).send(segment);
    },
  );

  app.get(
    "/api/v1/service-agreements/:id/bill-segments",
    { config: { module: "agreements", permission: "VIEW" } },
    async (request, reply) => {
      const { utilityId } = request.user;
      const { id: saId } = idParamSchema.parse(request.params);
      const segments = await listBillSegmentsForServiceAgreement(utilityId, saId);
      return reply.send(segments);
    },
  );
}
