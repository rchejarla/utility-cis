import type { FastifyInstance } from "fastify";
import { idParamSchema } from "../lib/route-schemas.js";
import { getBillSegment } from "../services/bill-segment.service.js";

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
}
