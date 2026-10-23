import type { FastifyInstance } from "fastify";
import { idParamSchema } from "../lib/route-schemas.js";
import { billQuerySchema } from "@utility-cis/shared";
import { getBill, listBills } from "../services/bill.service.js";
import { deliverBill, listBillDeliveries } from "../services/bill-delivery.service.js";

export async function billRoutes(app: FastifyInstance) {
  /**
   * The tenant-wide bill list.
   *
   * On `accounts:VIEW`, the same gate as the account-scoped list it
   * generalises: seeing every bill is the same authority as seeing one
   * account's bills, applied to every account a user can already reach.
   * Reading bills is not the authority to post them — that stays on
   * `accounts:EDIT` with `POST /api/v1/bills/:id/post`.
   */
  app.get(
    "/api/v1/bills",
    { config: { module: "accounts", permission: "VIEW" } },
    async (request, reply) => {
      const { utilityId } = request.user;
      const query = billQuerySchema.parse(request.query ?? {});
      return reply.send(await listBills(utilityId, query));
    },
  );

  app.get(
    "/api/v1/bills/:id",
    { config: { module: "accounts", permission: "VIEW" } },
    async (request, reply) => {
      const { utilityId } = request.user;
      const { id } = idParamSchema.parse(request.params);
      const bill = await getBill(utilityId, id);
      return reply.send(bill);
    },
  );

  /*
   * Send a posted bill to the customer it is addressed to.
   *
   * `EDIT`, like posting, and for the same reason: it acts outward on
   * the customer's behalf rather than reading. A clerk who may only look
   * at a bill may not put it in someone's inbox.
   *
   * 202, not 200 — the bill is queued for the notification worker, which
   * is where retries and quiet hours live. The response names the
   * outbox row so the caller can follow it.
   */
  app.post(
    "/api/v1/bills/:id/deliver",
    { config: { module: "accounts", permission: "EDIT" } },
    async (request, reply) => {
      const { utilityId } = request.user;
      const { id } = idParamSchema.parse(request.params);
      const notificationId = await deliverBill(utilityId, id);
      return reply.status(202).send({ notificationId });
    },
  );

  /** Every attempt to deliver this bill, newest first. */
  app.get(
    "/api/v1/bills/:id/deliveries",
    { config: { module: "accounts", permission: "VIEW" } },
    async (request, reply) => {
      const { utilityId } = request.user;
      const { id } = idParamSchema.parse(request.params);
      return reply.send(await listBillDeliveries(utilityId, id));
    },
  );
}
