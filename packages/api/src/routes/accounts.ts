import type { FastifyInstance } from "fastify";
import { createAccountSchema, updateAccountSchema, accountQuerySchema } from "@utility-cis/shared";
import {
  listAccounts,
  getAccount,
  createAccount,
  updateAccount,
} from "../services/account.service.js";

export async function accountRoutes(app: FastifyInstance) {
  app.get("/api/v1/accounts", { config: { module: "accounts", permission: "VIEW" } }, async (request, reply) => {
    const { utilityId } = request.user;
    const query = accountQuerySchema.parse(request.query);
    const result = await listAccounts(utilityId, query);
    return reply.send(result);
  });

  app.get("/api/v1/accounts/:id", { config: { module: "accounts", permission: "VIEW" } }, async (request, reply) => {
    const { utilityId } = request.user;
    const { id } = request.params as { id: string };
    const account = await getAccount(id, utilityId);
    return reply.send(account);
  });

  app.post("/api/v1/accounts", { config: { module: "accounts", permission: "CREATE" } }, async (request, reply) => {
    const { utilityId, id: actorId, name: actorName } = request.user;
    const data = createAccountSchema.parse(request.body);
    const account = await createAccount(utilityId, actorId, actorName, data);
    return reply.status(201).send(account);
  });

  app.patch("/api/v1/accounts/:id", { config: { module: "accounts", permission: "EDIT" } }, async (request, reply) => {
    const { utilityId, id: actorId, name: actorName } = request.user;
    const { id } = request.params as { id: string };
    const data = updateAccountSchema.parse(request.body);
    const account = await updateAccount(utilityId, actorId, actorName, id, data);
    return reply.send(account);
  });
}
