import type { FastifyInstance } from "fastify";
import { createContactSchema, updateContactSchema } from "@utility-cis/shared";
import {
  listContacts,
  createContact,
  updateContact,
  deleteContact,
} from "../services/contact.service.js";

export async function contactRoutes(app: FastifyInstance) {
  app.get("/api/v1/contacts", async (request, reply) => {
    const { utilityId } = request.user;
    const { accountId } = request.query as { accountId: string };
    const result = await listContacts(utilityId, accountId);
    return reply.send(result);
  });

  app.post("/api/v1/contacts", async (request, reply) => {
    const { utilityId, id: actorId } = request.user;
    const data = createContactSchema.parse(request.body);
    const contact = await createContact(utilityId, actorId, data);
    return reply.status(201).send(contact);
  });

  app.patch("/api/v1/contacts/:id", async (request, reply) => {
    const { utilityId, id: actorId } = request.user;
    const { id } = request.params as { id: string };
    const data = updateContactSchema.parse(request.body);
    const contact = await updateContact(utilityId, actorId, id, data);
    return reply.send(contact);
  });

  app.delete("/api/v1/contacts/:id", async (request, reply) => {
    const { utilityId, id: actorId } = request.user;
    const { id } = request.params as { id: string };
    await deleteContact(utilityId, actorId, id);
    return reply.status(204).send();
  });
}
