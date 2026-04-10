import type { FastifyInstance } from "fastify";
import {
  transferServiceSchema,
  moveInSchema,
  moveOutSchema,
  searchQuerySchema,
} from "@utility-cis/shared";
import {
  transferService,
  moveIn,
  moveOut,
  globalSearch,
} from "../services/workflows.service.js";
import { idParamSchema } from "../lib/route-schemas.js";

export async function workflowRoutes(app: FastifyInstance) {
  /**
   * Transfer of service: reassign an active service agreement from one
   * account to another in a single atomic operation. Closes the source
   * agreement, records optional final/initial meter reads, creates the
   * target agreement. The source agreement id comes from the URL; the
   * target account and transfer details come from the body.
   */
  app.post(
    "/api/v1/service-agreements/:id/transfer",
    { config: { module: "workflows", permission: "CREATE" } },
    async (request, reply) => {
      const { utilityId, id: actorId, name: actorName } = request.user;
      const { id } = idParamSchema.parse(request.params);
      const data = transferServiceSchema.parse(request.body);
      const result = await transferService(utilityId, actorId, actorName, id, data);
      return reply.status(201).send(result);
    },
  );

  /**
   * Move-in: coordinated customer + account + agreement setup. Body
   * may include a new customer or reference an existing one. Exactly
   * one must be provided — the Zod schema enforces it.
   */
  app.post(
    "/api/v1/workflows/move-in",
    { config: { module: "workflows", permission: "CREATE" } },
    async (request, reply) => {
      const { utilityId, id: actorId, name: actorName } = request.user;
      const data = moveInSchema.parse(request.body);
      const result = await moveIn(utilityId, actorId, actorName, data);
      return reply.status(201).send(result);
    },
  );

  /**
   * Move-out: finalize all active agreements on an account for a
   * premise, record final meter reads, optionally close the account.
   */
  app.post(
    "/api/v1/workflows/move-out",
    { config: { module: "workflows", permission: "CREATE" } },
    async (request, reply) => {
      const { utilityId, id: actorId, name: actorName } = request.user;
      const data = moveOutSchema.parse(request.body);
      const result = await moveOut(utilityId, actorId, actorName, data);
      return reply.status(201).send(result);
    },
  );

  /**
   * Global full-text search. Public-ish: every module gets searched,
   * but results respect utility_id scope (RLS plus in-query WHERE).
   * The `kinds` query param narrows which entity types to hit —
   * omitting it returns all four.
   */
  app.get(
    "/api/v1/search",
    { config: { module: "search", permission: "VIEW" } },
    async (request, reply) => {
      const { utilityId } = request.user;
      const query = searchQuerySchema.parse(request.query);
      const hits = await globalSearch(utilityId, query);
      return reply.send({ data: hits });
    },
  );
}
