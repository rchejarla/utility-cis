import type { FastifyInstance } from "fastify";
import { createUserSchema, updateUserSchema, userQuerySchema } from "@utility-cis/shared";
import * as userService from "../services/user.service.js";
import { registerCrudRoutes } from "../lib/crud-routes.js";

export async function userRoutes(app: FastifyInstance) {
  registerCrudRoutes(app, {
    basePath: "/api/v1/users",
    module: "settings",
    list: {
      querySchema: userQuerySchema,
      service: (utilityId, query) => userService.listUsers(utilityId, query as never),
    },
    get: userService.getUser,
    create: {
      bodySchema: createUserSchema,
      service: (user, data) => userService.createUser(user.utilityId, data as never),
    },
    update: {
      bodySchema: updateUserSchema,
      service: (user, id, data) => userService.updateUser(user.utilityId, id, data as never),
    },
  });
}
