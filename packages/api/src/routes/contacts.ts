import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { createContactSchema, updateContactSchema } from "@utility-cis/shared";
import { idParamSchema } from "../lib/route-schemas.js";
import {
  listContacts,
  createContact,
  updateContact,
  deleteContact,
} from "../services/contact.service.js";

const contactQuerySchema = z.object({
  accountId: z.string().uuid(),
}).strict();

export async function contactRoutes(app: FastifyInstance) {
  app.get("/api/v1/contacts", { config: { module: "customers", permission: "VIEW" } }, async (request, reply) => {
    const { utilityId } = request.user;
    const { accountId } = contactQuerySchema.parse(request.query);
    const result = await listContacts(utilityId, accountId);
    return reply.send(result);
  });

  app.post("/api/v1/contacts", { config: { module: "customers", permission: "CREATE" } }, async (request, reply) => {
    const { utilityId, id: actorId } = request.user;
    const data = createContactSchema.parse(request.body);
    const contact = await createContact(utilityId, actorId, data);
    return reply.status(201).send(contact);
  });

  app.patch("/api/v1/contacts/:id", { config: { module: "customers", permission: "EDIT" } }, async (request, reply) => {
    const { utilityId, id: actorId } = request.user;
    const { id } = idParamSchema.parse(request.params);
    const data = updateContactSchema.parse(request.body);
    const contact = await updateContact(utilityId, actorId, id, data);
    return reply.send(contact);
  });

  app.delete("/api/v1/contacts/:id", { config: { module: "customers", permission: "DELETE" } }, async (request, reply) => {
    const { utilityId, id: actorId } = request.user;
    const { id } = idParamSchema.parse(request.params);
    await deleteContact(utilityId, actorId, id);
    return reply.status(204).send();
  });
}
