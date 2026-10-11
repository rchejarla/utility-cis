import type { FastifyInstance } from "fastify";
import { billMessageCreateSchema, billMessageUpdateSchema } from "@utility-cis/shared";
import {
  listBillMessages,
  createBillMessage,
  updateBillMessage,
  deleteBillMessage,
} from "../services/bill-message.service.js";
import { idParamSchema } from "../lib/route-schemas.js";

/**
 * Bill message management.
 *
 * Gated on `settings` rather than `accounts`: the text printed on bills
 * is tenant configuration, and editing it should not require the
 * authority to read every account. Reading the catalogue needs
 * settings:VIEW for the same reason the other settings catalogues do —
 * it is not reference data every user needs.
 */
export async function billMessageRoutes(app: FastifyInstance) {
  app.get(
    "/api/v1/bill-messages",
    { config: { module: "settings", permission: "VIEW" } },
    async (request, reply) => {
      const { utilityId } = request.user;
      return reply.send({ data: await listBillMessages(utilityId) });
    },
  );

  app.post(
    "/api/v1/bill-messages",
    { config: { module: "settings", permission: "EDIT" } },
    async (request, reply) => {
      const { utilityId, id: actorId, name: actorName } = request.user;
      const data = billMessageCreateSchema.parse(request.body);
      const row = await createBillMessage(utilityId, actorId, actorName, data);
      return reply.status(201).send(row);
    },
  );

  app.patch(
    "/api/v1/bill-messages/:id",
    { config: { module: "settings", permission: "EDIT" } },
    async (request, reply) => {
      const { utilityId, id: actorId, name: actorName } = request.user;
      const { id } = idParamSchema.parse(request.params);
      const data = billMessageUpdateSchema.parse(request.body);
      const row = await updateBillMessage(utilityId, actorId, actorName, id, data);
      return reply.send(row);
    },
  );

  app.delete(
    "/api/v1/bill-messages/:id",
    { config: { module: "settings", permission: "DELETE" } },
    async (request, reply) => {
      const { utilityId, id: actorId, name: actorName } = request.user;
      const { id } = idParamSchema.parse(request.params);
      await deleteBillMessage(utilityId, actorId, actorName, id);
      return reply.status(204).send();
    },
  );
}
