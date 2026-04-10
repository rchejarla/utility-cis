import type { FastifyInstance } from "fastify";
import type { z } from "zod";
import { idParamSchema } from "./route-schemas.js";

/**
 * Shared CRUD route factory. Every "entity" route module was re-implementing
 * the same 5 HTTP handlers — list / get / create / update / (optional delete) —
 * with identical boilerplate around request.user extraction, Zod parsing,
 * service dispatch, and status-code shaping. `registerCrudRoutes` consolidates
 * that into a single call so each routes file only declares its basePath,
 * permission module, schemas, and service adapters.
 *
 * The adapter closures (rather than raw service refs) exist to accommodate
 * two call shapes in the codebase:
 *   (1) audited:  service(utilityId, actorId, actorName, [id], data)
 *   (2) unaudited: service(utilityId, [id], data)      (roles, users)
 * Each adapter picks exactly the fields it needs from the AuthUser context.
 */

type Permission = "VIEW" | "CREATE" | "EDIT" | "DELETE";

export interface ServiceUser {
  utilityId: string;
  actorId: string;
  actorName: string;
}

type ListWithQuery = {
  querySchema: z.ZodTypeAny;
  service: (utilityId: string, query: unknown) => Promise<unknown>;
};
type ListWithoutQuery = {
  service: (utilityId: string) => Promise<unknown>;
};

export interface CrudRoutesConfig {
  basePath: string;
  module: string;
  list?: ListWithQuery | ListWithoutQuery;
  get?: (id: string, utilityId: string) => Promise<unknown>;
  create?: {
    bodySchema: z.ZodTypeAny;
    service: (user: ServiceUser, data: unknown) => Promise<unknown>;
  };
  update?: {
    bodySchema: z.ZodTypeAny;
    service: (user: ServiceUser, id: string, data: unknown) => Promise<unknown>;
  };
  del?: (id: string, utilityId: string) => Promise<unknown>;
}

function hasQuerySchema(list: ListWithQuery | ListWithoutQuery): list is ListWithQuery {
  return "querySchema" in list;
}

export function registerCrudRoutes(app: FastifyInstance, cfg: CrudRoutesConfig): void {
  const { basePath, module } = cfg;
  const routeOpts = (permission: Permission) => ({ config: { module, permission } });

  if (cfg.list) {
    const list = cfg.list;
    app.get(basePath, routeOpts("VIEW"), async (request, reply) => {
      const { utilityId } = request.user;
      const result = hasQuerySchema(list)
        ? await list.service(utilityId, list.querySchema.parse(request.query))
        : await list.service(utilityId);
      return reply.send(result);
    });
  }

  if (cfg.get) {
    const getFn = cfg.get;
    app.get(`${basePath}/:id`, routeOpts("VIEW"), async (request, reply) => {
      const { utilityId } = request.user;
      const { id } = idParamSchema.parse(request.params);
      return reply.send(await getFn(id, utilityId));
    });
  }

  if (cfg.create) {
    const create = cfg.create;
    app.post(basePath, routeOpts("CREATE"), async (request, reply) => {
      const { utilityId, id: actorId, name: actorName } = request.user;
      const data = create.bodySchema.parse(request.body);
      const result = await create.service({ utilityId, actorId, actorName }, data);
      return reply.status(201).send(result);
    });
  }

  if (cfg.update) {
    const update = cfg.update;
    app.patch(`${basePath}/:id`, routeOpts("EDIT"), async (request, reply) => {
      const { utilityId, id: actorId, name: actorName } = request.user;
      const { id } = idParamSchema.parse(request.params);
      const data = update.bodySchema.parse(request.body);
      const result = await update.service({ utilityId, actorId, actorName }, id, data);
      return reply.send(result);
    });
  }

  if (cfg.del) {
    const delFn = cfg.del;
    app.delete(`${basePath}/:id`, routeOpts("DELETE"), async (request, reply) => {
      const { utilityId } = request.user;
      const { id } = idParamSchema.parse(request.params);
      await delFn(id, utilityId);
      return reply.status(204).send();
    });
  }
}
