import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  listAccountContacts,
  promoteContact,
  changeUserRoleOnAccount,
  revokeUserRoleOnAccount,
} from "../services/account-contacts.service.js";
import { idParamSchema } from "../lib/route-schemas.js";

/**
 * Unified-list endpoints for the Contacts tab on an account-detail
 * page. Combines record-only Contact rows with portal-user UserRole
 * rows so the operator sees one cohesive list and can promote/demote
 * inline.
 */

const listParamSchema = z.object({ accountId: z.string().uuid() });
const promoteBodySchema = z.object({ roleId: z.string().uuid() });
const changeRoleBodySchema = z.object({ roleId: z.string().uuid() });

export async function accountContactRoutes(app: FastifyInstance) {
  app.get(
    "/api/v1/accounts/:accountId/contacts-unified",
    { config: { module: "accounts", permission: "VIEW" } },
    async (request, reply) => {
      const { utilityId } = request.user;
      const { accountId } = listParamSchema.parse(request.params);
      const rows = await listAccountContacts(utilityId, accountId);
      return reply.send({ data: rows });
    },
  );

  // Promote a Contact → CisUser + UserRole. The contact's email
  // becomes the user's login identity.
  app.post(
    "/api/v1/contacts/:id/promote",
    { config: { module: "customers", permission: "EDIT" } },
    async (request, reply) => {
      const { utilityId, id: actorId, name: actorName } = request.user;
      const { id: contactId } = idParamSchema.parse(request.params);
      const { roleId } = promoteBodySchema.parse(request.body);
      const result = await promoteContact(utilityId, contactId, roleId, {
        id: actorId,
        name: actorName,
      });
      return reply.status(201).send(result);
    },
  );

  // Change the role on an existing per-account UserRole.
  app.patch(
    "/api/v1/user-roles/:id",
    { config: { module: "customers", permission: "EDIT" } },
    async (request, reply) => {
      const { utilityId, id: actorId, name: actorName } = request.user;
      const { id } = idParamSchema.parse(request.params);
      const { roleId } = changeRoleBodySchema.parse(request.body);
      await changeUserRoleOnAccount(utilityId, id, roleId, {
        id: actorId,
        name: actorName,
      });
      return reply.status(204).send();
    },
  );

  // Revoke a per-account UserRole. CisUser stays — they may still have
  // access to other accounts.
  app.delete(
    "/api/v1/user-roles/:id",
    { config: { module: "customers", permission: "EDIT" } },
    async (request, reply) => {
      const { utilityId, id: actorId, name: actorName } = request.user;
      const { id } = idParamSchema.parse(request.params);
      await revokeUserRoleOnAccount(utilityId, id, {
        id: actorId,
        name: actorName,
      });
      return reply.status(204).send();
    },
  );
}
