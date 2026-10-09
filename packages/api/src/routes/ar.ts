import type { FastifyInstance } from "fastify";
import { postBillSchema, recordPaymentSchema, reverseEntrySchema } from "@utility-cis/shared";
import { idParamSchema } from "../lib/route-schemas.js";
import { prisma } from "../lib/prisma.js";
import { postBill } from "../services/ar/posting.service.js";
import { reconcileBalances } from "../services/ar/reconciliation.service.js";
import { recordPayment } from "../services/ar/payment.service.js";
import { reverseEntry } from "../services/ar/reversal.service.js";

/**
 * AR routes. Posting is gated on `accounts:EDIT`, the same permission as
 * generating a bill (`POST /api/v1/accounts/:id/bills` in account-bills.ts).
 * Generation already posts the bill when auto-post is on, so posting must
 * require no more permission than generating; otherwise switching auto-post
 * on would let a user create receivables they cannot post directly.
 *
 * Recording and reversing a payment are gated on the `payments` module
 * instead. Taking money and reversing it is a different authority from
 * reading or generating against an account — a clerk at the counter is
 * not the same person as whoever adjusts a bill — and §8 splits the keys
 * on exactly that line. Reversal sits on EDIT rather than CREATE because
 * it changes the standing of an entry that already exists.
 *
 * The two reads are gated on `accounts:VIEW`, including reconciliation:
 * what it returns is account balances, not tenant configuration. Gating
 * it on `tenant_profile` would have made it unreachable for a tenant
 * licensed for accounts but not that module, because the authorization
 * middleware answers 403 MODULE_DISABLED before any permission check.
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
    { config: { module: "accounts", permission: "VIEW" } },
    async (request, reply) => {
      const drift = await reconcileBalances(request.user.utilityId);
      return reply.send({ ok: drift.length === 0, drift });
    },
  );

  app.post(
    "/api/v1/accounts/:id/payments",
    { config: { module: "payments", permission: "CREATE" } },
    async (request, reply) => {
      const { utilityId, id: actorId, name: actorName } = request.user;
      const { id: accountId } = idParamSchema.parse(request.params);
      const input = recordPaymentSchema.parse(request.body ?? {});
      const result = await recordPayment(utilityId, actorId, actorName, accountId, input);
      return reply.status(201).send(result);
    },
  );

  app.post(
    "/api/v1/ledger-entries/:id/reverse",
    { config: { module: "payments", permission: "EDIT" } },
    async (request, reply) => {
      const { utilityId, id: actorId, name: actorName } = request.user;
      const { id: entryId } = idParamSchema.parse(request.params);
      const input = reverseEntrySchema.parse(request.body ?? {});
      const result = await reverseEntry(utilityId, actorId, actorName, entryId, input);
      return reply.status(201).send(result);
    },
  );
}
