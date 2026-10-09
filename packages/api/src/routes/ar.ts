import type { FastifyInstance } from "fastify";
import { postBillSchema } from "@utility-cis/shared";
import { idParamSchema } from "../lib/route-schemas.js";
import { prisma } from "../lib/prisma.js";
import { postBill } from "../services/ar/posting.service.js";

/**
 * AR routes. Posting is gated on the `agreements` module — the same
 * permission as bill generation — because when auto-post is on,
 * generating a bill IS posting it. A stronger gate here would let
 * someone bypass this permission by turning auto-post on.
 */
export async function arRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    "/api/v1/bills/:id/post",
    { config: { module: "agreements", permission: "CREATE" } },
    async (request, reply) => {
      const { utilityId, id: actorId, name: actorName } = request.user;
      const { id: billId } = idParamSchema.parse(request.params);
      const input = postBillSchema.parse(request.body ?? {});
      const result = await postBill(utilityId, actorId, actorName, billId, input);
      return reply.status(201).send(result);
    },
  );

  app.get(
    "/api/v1/accounts/:id/unposted-bills",
    { config: { module: "agreements", permission: "VIEW" } },
    async (request, reply) => {
      const { utilityId } = request.user;
      const { id: accountId } = idParamSchema.parse(request.params);
      const bills = await prisma.bill.findMany({
        where: { utilityId, accountId, postedAt: null },
        orderBy: { periodEnd: "asc" },
        select: {
          id: true,
          billNumber: true,
          periodStart: true,
          periodEnd: true,
          dueDate: true,
          total: true,
        },
      });
      return reply.send({
        data: bills.map((b) => ({ ...b, total: b.total.toFixed(4) })),
      });
    },
  );
}
