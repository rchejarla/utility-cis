import type { FastifyInstance } from "fastify";
import { idParamSchema } from "../lib/route-schemas.js";
import { getBillSegment } from "../services/bill-segment.service.js";
import { z } from "zod";
import { shadowBill, shadowBillOptions } from "../services/shadow-bill.js";

/**
 * `?with=<code>[,<code>…]` — the rate or rates to compare the billed period
 * with: one all-in tariff, or a delivery and a supply schedule together.
 */
const shadowQuerySchema = z.object({
  with: z
    .string()
    .trim()
    .min(1)
    .transform((s) => s.split(",").map((c) => c.trim()).filter(Boolean))
    .pipe(z.array(z.string().min(1).max(50)).min(1).max(5)),
});

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
   * What this billed period would have cost on another rate, which staff
   * pick (spec 26, TOU-BIL-4). Rates and returns; writes nothing, so it is
   * a VIEW, not an EDIT. `options` lists the rates that can be picked.
   */
  app.get(
    "/api/v1/bill-segments/:id/shadow/options",
    { config: { module: "agreements", permission: "VIEW" } },
    async (request, reply) => {
      const { utilityId } = request.user;
      const { id } = idParamSchema.parse(request.params);
      return reply.send({ data: await shadowBillOptions(utilityId, id) });
    },
  );

  app.get(
    "/api/v1/bill-segments/:id/shadow",
    { config: { module: "agreements", permission: "VIEW" } },
    async (request, reply) => {
      const { utilityId } = request.user;
      const { id } = idParamSchema.parse(request.params);
      const { with: compareCode } = shadowQuerySchema.parse(request.query);
      return reply.send(await shadowBill(utilityId, id, compareCode));
    },
  );
}
