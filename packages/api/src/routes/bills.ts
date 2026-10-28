import type { FastifyInstance } from "fastify";
import { idParamSchema } from "../lib/route-schemas.js";
import { billQuerySchema } from "@utility-cis/shared";
import { getBill, listBills } from "../services/bill.service.js";
import { loadBillPresentation } from "../services/bill-presentation.service.js";
import { deliverBill, listBillDeliveries } from "../services/bill-delivery.service.js";
import {
  holdBill,
  releaseBill,
  holdAccountBilling,
  releaseAccountBilling,
  listHeldBills,
} from "../services/bill-hold.service.js";
import { z } from "zod";

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

  /**
   * What the bill *says* — the resolved content its document renders.
   *
   * `GET /bills/:id` returns the stored `Bill`: rated segments and
   * `bill.total`. That is not what the customer receives. A late fee
   * raises no rated line, so it reaches the page through the
   * presentation's fees group, and the printed total is rated + fees.
   * Staff reading the bill popup therefore saw a different number from
   * the one on the paper in the customer's hand, by exactly the fees —
   * which is the moment a phone call goes wrong.
   *
   * A read, so `accounts:VIEW` like the bill itself. It is a separate
   * endpoint rather than a wider `GET /bills/:id` because resolving a
   * presentation refuses an incomplete issuer, recipient or charge set
   * with a 422, and a popup that cannot open because the remittance
   * address is unset would be a worse screen than one showing rated
   * lines.
   */
  app.get(
    "/api/v1/bills/:id/presentation",
    { config: { module: "accounts", permission: "VIEW" } },
    async (request, reply) => {
      const { utilityId } = request.user;
      const { id } = idParamSchema.parse(request.params);
      return reply.send(await loadBillPresentation(utilityId, id));
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

  /*
   * Holds — Bozeman #136. A held bill can neither post nor be delivered.
   *
   * Both directions are `accounts:EDIT`. Placing a hold is conservative
   * and releasing is the consequential one, which argued for splitting
   * them across two permissions; the simpler rule was chosen
   * deliberately, and the audit log records who did which either way.
   */
  app.post(
    "/api/v1/bills/:id/hold",
    { config: { module: "accounts", permission: "EDIT" } },
    async (request, reply) => {
      const { utilityId, id: actorId, name: actorName } = request.user;
      const { id } = idParamSchema.parse(request.params);
      const { reason } = z
        .object({ reason: z.string().min(1).max(500) })
        .strict()
        .parse(request.body ?? {});
      await holdBill(utilityId, actorId, actorName, id, reason);
      return reply.status(204).send();
    },
  );

  app.post(
    "/api/v1/bills/:id/release",
    { config: { module: "accounts", permission: "EDIT" } },
    async (request, reply) => {
      const { utilityId, id: actorId, name: actorName } = request.user;
      const { id } = idParamSchema.parse(request.params);
      await releaseBill(utilityId, actorId, actorName, id);
      return reply.status(204).send();
    },
  );

  /** The worklist, and the "bills on hold" figure spec 09 describes. */
  app.get(
    "/api/v1/bills/held",
    { config: { module: "accounts", permission: "VIEW" } },
    async (request, reply) => {
      const { utilityId } = request.user;
      return reply.send(await listHeldBills(utilityId));
    },
  );

  /*
   * A standing hold on the account: its bills are born held, and the
   * ones already waiting to post are held with it.
   */
  app.post(
    "/api/v1/accounts/:id/billing-hold",
    { config: { module: "accounts", permission: "EDIT" } },
    async (request, reply) => {
      const { utilityId, id: actorId, name: actorName } = request.user;
      const { id } = idParamSchema.parse(request.params);
      const { reason } = z
        .object({ reason: z.string().min(1).max(500) })
        .strict()
        .parse(request.body ?? {});
      return reply.send(await holdAccountBilling(utilityId, actorId, actorName, id, reason));
    },
  );

  app.post(
    "/api/v1/accounts/:id/billing-release",
    { config: { module: "accounts", permission: "EDIT" } },
    async (request, reply) => {
      const { utilityId, id: actorId, name: actorName } = request.user;
      const { id } = idParamSchema.parse(request.params);
      return reply.send(await releaseAccountBilling(utilityId, actorId, actorName, id));
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
