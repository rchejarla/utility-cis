import type { FastifyInstance } from "fastify";
import { idParamSchema } from "../lib/route-schemas.js";
import { createBillSegmentSchema } from "@utility-cis/shared";
import {
  createBillSegmentForServiceAgreement,
  listBillSegmentsForServiceAgreement,
  resolveServicePeriod,
} from "../services/bill-segment.service.js";

export async function serviceAgreementBillSegmentRoutes(app: FastifyInstance) {
  app.post(
    "/api/v1/service-agreements/:id/bill-segments",
    { config: { module: "agreements", permission: "EDIT" } },
    async (request, reply) => {
      const { utilityId, id: actorId, name: actorName } = request.user;
      const { id: saId } = idParamSchema.parse(request.params);
      const body = createBillSegmentSchema.parse(request.body ?? {});
      const segment = await createBillSegmentForServiceAgreement(
        utilityId,
        actorId,
        actorName,
        saId,
        {
          periodStart: body.periodStart ? new Date(body.periodStart) : undefined,
          periodEnd: body.periodEnd ? new Date(body.periodEnd) : undefined,
        },
      );
      return reply.status(201).send(segment);
    },
  );

  /**
   * What the next segment would cover, so the UI can show the interval
   * rather than ask someone to type one.
   *
   * Answers the refusal as a body rather than a status when there is no
   * read to bill: a form needs to say "no read since 2026-01-30" where
   * it would otherwise show a period, and that is not an error on the
   * part of whoever opened the page.
   */
  app.get(
    "/api/v1/service-agreements/:id/next-service-period",
    { config: { module: "agreements", permission: "VIEW" } },
    async (request, reply) => {
      const { utilityId } = request.user;
      const { id: saId } = idParamSchema.parse(request.params);
      try {
        const period = await resolveServicePeriod(utilityId, saId);
        return reply.send({
          periodStart: period.periodStart,
          periodEnd: period.periodEnd,
          readCount: period.readCount,
          days:
            Math.round(
              (period.periodEnd.getTime() - period.periodStart.getTime()) / 86_400_000,
            ) + 1,
        });
      } catch (err) {
        const code = (err as { code?: string }).code;
        if (code === "NO_READ_IN_WINDOW" || code === "READ_PREDATES_BILLED_PERIOD") {
          return reply.send({
            periodStart: null,
            periodEnd: null,
            reason: code,
            message: (err as Error).message,
          });
        }
        throw err;
      }
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
