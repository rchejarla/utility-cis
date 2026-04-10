import type { FastifyInstance } from "fastify";
import { createRoleSchema, updateRoleSchema } from "@utility-cis/shared";
import * as roleService from "../services/role.service.js";
import { registerCrudRoutes } from "../lib/crud-routes.js";

export async function roleRoutes(app: FastifyInstance) {
  registerCrudRoutes(app, {
    basePath: "/api/v1/roles",
    module: "settings",
    list: { service: roleService.listRoles },
    get: roleService.getRole,
    create: {
      bodySchema: createRoleSchema,
      service: (user, data) => roleService.createRole(user.utilityId, data as never),
    },
    update: {
      bodySchema: updateRoleSchema,
      service: (user, id, data) => roleService.updateRole(user.utilityId, id, data as never),
    },
    del: (id, utilityId) => roleService.deleteRole(utilityId, id),
  });
}
