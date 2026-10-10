import type { FastifyInstance } from "fastify";
import { idParamSchema } from "../lib/route-schemas.js";
import { billQuerySchema } from "@utility-cis/shared";
import { getBill, listBills } from "../services/bill.service.js";

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
}
