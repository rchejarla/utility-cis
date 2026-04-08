import type { FastifyInstance } from "fastify";
import { createAccountSchema, updateAccountSchema, accountQuerySchema } from "@utility-cis/shared";
import {
  listAccounts,
  getAccount,
  createAccount,
  updateAccount,
} from "../services/account.service.js";

export async function accountRoutes(app: FastifyInstance) {
  app.get("/api/v1/accounts", async (request, reply) => {
    const { utilityId } = request.user;
    const query = accountQuerySchema.parse(request.query);
    const result = await listAccounts(utilityId, query);
    return reply.send(result);
  });

  app.get("/api/v1/accounts/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const account = await getAccount(id);
    return reply.send(account);
  });

  app.post("/api/v1/accounts", async (request, reply) => {
    const { utilityId, id: actorId } = request.user;
    const data = createAccountSchema.parse(request.body);
    const account = await createAccount(utilityId, actorId, data);
    return reply.status(201).send(account);
  });

  app.patch("/api/v1/accounts/:id", async (request, reply) => {
    const { utilityId, id: actorId } = request.user;
    const { id } = request.params as { id: string };
    const data = updateAccountSchema.parse(request.body);
    const account = await updateAccount(utilityId, actorId, id, data);
    return reply.send(account);
  });
}
