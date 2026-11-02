import type { FastifyInstance } from "fastify";
import { createAccountSchema, updateAccountSchema, accountQuerySchema } from "@utility-cis/shared";
import {
  listAccounts,
  getAccount,
  createAccount,
  updateAccount,
} from "../services/account.service.js";
import { registerCrudRoutes } from "../lib/crud-routes.js";

export async function accountRoutes(app: FastifyInstance) {
  registerCrudRoutes(app, {
    basePath: "/api/v1/accounts",
    module: "accounts",
    // Mirrored from a legacy CIS in overlay mode, so staff writes are
    // refused there (spec 28, OVL-T-3). Reads and the overlay import
    // are untouched.
    mirroredFromLegacy: true,
    list: {
      querySchema: accountQuerySchema,
      service: (utilityId, query) => listAccounts(utilityId, query as never),
    },
    get: getAccount,
    create: {
      bodySchema: createAccountSchema,
      service: (user, data) =>
        createAccount(user.utilityId, user.actorId, user.actorName, data as never),
    },
    update: {
      bodySchema: updateAccountSchema,
      service: (user, id, data) =>
        updateAccount(user.utilityId, user.actorId, user.actorName, id, data as never),
    },
  });
}
