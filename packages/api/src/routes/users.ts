import type { FastifyInstance } from "fastify";
import { createUserSchema, updateUserSchema, userQuerySchema } from "@utility-cis/shared";
import * as userService from "../services/user.service.js";
import { idParamSchema } from "../lib/route-schemas.js";

export async function userRoutes(app: FastifyInstance) {
  app.get("/api/v1/users", { config: { module: "settings", permission: "VIEW" } }, async (request) => {
    const query = userQuerySchema.parse(request.query);
    return userService.listUsers(request.user.utilityId, query);
  });

  app.get("/api/v1/users/:id", { config: { module: "settings", permission: "VIEW" } }, async (request) => {
    const { id } = idParamSchema.parse(request.params);
    return userService.getUser(id, request.user.utilityId);
  });

  app.post("/api/v1/users", { config: { module: "settings", permission: "CREATE" } }, async (request, reply) => {
    const data = createUserSchema.parse(request.body);
    const user = await userService.createUser(request.user.utilityId, data);
    reply.status(201).send(user);
  });

  app.patch("/api/v1/users/:id", { config: { module: "settings", permission: "EDIT" } }, async (request) => {
    const { id } = idParamSchema.parse(request.params);
    const data = updateUserSchema.parse(request.body);
    return userService.updateUser(request.user.utilityId, id, data);
  });
}
