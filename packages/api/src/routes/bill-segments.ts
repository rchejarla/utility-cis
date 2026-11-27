import type { FastifyInstance } from "fastify";
import { idParamSchema } from "../lib/route-schemas.js";
import { getBillSegment } from "../services/bill-segment.service.js";
import { shadowBill } from "../services/shadow-bill.js";

export async function billSegmentRoutes(app: FastifyInstance) {
  app.get(
    "/api/v1/bill-segments/:id",
    { config: { module: "agreements", permission: "VIEW" } },
    async (request, reply) => {
      const { utilityId } = request.user;
      const { id } = idParamSchema.parse(request.params);
      const segment = await getBillSegment(utilityId, id);
      return reply.send(segment);
    },
  );

  /*
   * What this billed period would have cost on the schedule its tariff
   * names as its comparison (spec 26, TOU-BIL-4). Rates and returns;
   * writes nothing, so it is a VIEW, not an EDIT.
   */
  app.get(
    "/api/v1/bill-segments/:id/shadow",
    { config: { module: "agreements", permission: "VIEW" } },
    async (request, reply) => {
      const { utilityId } = request.user;
      const { id } = idParamSchema.parse(request.params);
      return reply.send(await shadowBill(utilityId, id));
    },
  );
}
