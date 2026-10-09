import type { FastifyInstance } from "fastify";
import { postBillSchema } from "@utility-cis/shared";
import { idParamSchema } from "../lib/route-schemas.js";
import { prisma } from "../lib/prisma.js";
import { postBill } from "../services/ar/posting.service.js";
import { reconcileBalances } from "../services/ar/reconciliation.service.js";

/**
 * AR routes. Posting is gated on `accounts:EDIT`, the same permission as
 * generating a bill (`POST /api/v1/accounts/:id/bills` in account-bills.ts).
 * Generation already posts the bill when auto-post is on, so posting must
 * require no more permission than generating; otherwise switching auto-post
 * on would let a user create receivables they cannot post directly.
 */
export async function arRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    "/api/v1/bills/:id/post",
    { config: { module: "accounts", permission: "EDIT" } },
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
    { config: { module: "accounts", permission: "VIEW" } },
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

  app.get(
    "/api/v1/ar/reconciliation",
    { config: { module: "tenant_profile", permission: "VIEW" } },
    async (request, reply) => {
      const drift = await reconcileBalances(request.user.utilityId);
      return reply.send({ ok: drift.length === 0, drift });
    },
  );
}
