import type { FastifyInstance } from "fastify";
import { createRoleSchema, updateRoleSchema } from "@utility-cis/shared";
import * as roleService from "../services/role.service.js";

export async function roleRoutes(app: FastifyInstance) {
  app.get("/api/v1/roles", { config: { module: "settings", permission: "VIEW" } }, async (request) => {
    return roleService.listRoles(request.user.utilityId);
  });

  app.get("/api/v1/roles/:id", { config: { module: "settings", permission: "VIEW" } }, async (request) => {
    const { id } = request.params as { id: string };
    return roleService.getRole(id, request.user.utilityId);
  });

  app.post("/api/v1/roles", { config: { module: "settings", permission: "CREATE" } }, async (request, reply) => {
    const data = createRoleSchema.parse(request.body);
    const role = await roleService.createRole(request.user.utilityId, data);
    reply.status(201).send(role);
  });

  app.patch("/api/v1/roles/:id", { config: { module: "settings", permission: "EDIT" } }, async (request) => {
    const { id } = request.params as { id: string };
    const data = updateRoleSchema.parse(request.body);
    return roleService.updateRole(request.user.utilityId, id, data);
  });

  app.delete("/api/v1/roles/:id", { config: { module: "settings", permission: "DELETE" } }, async (request, reply) => {
    const { id } = request.params as { id: string };
    await roleService.deleteRole(request.user.utilityId, id);
    reply.status(204).send();
  });
}
