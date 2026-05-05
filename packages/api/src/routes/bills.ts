import type { FastifyInstance } from "fastify";
import { idParamSchema } from "../lib/route-schemas.js";
import { getBill } from "../services/bill.service.js";

export async function billRoutes(app: FastifyInstance) {
  app.get(
    "/api/v1/bills/:id",
    { config: { module: "service_agreements", permission: "VIEW" } },
    async (request, reply) => {
      const { utilityId } = request.user;
      const { id } = idParamSchema.parse(request.params);
      const bill = await getBill(utilityId, id);
      return reply.send(bill);
    },
  );
}
