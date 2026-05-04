import type { FastifyInstance } from "fastify";
import { getRegisteredGrammar } from "../services/rate-grammar.service.js";

export async function rateGrammarRoutes(app: FastifyInstance) {
  app.get(
    "/api/v1/rate-grammar/registered",
    { config: { module: "rate_schedules", permission: "VIEW" } },
    async (request) => {
      const { utilityId } = request.user;
      return getRegisteredGrammar(utilityId);
    },
  );
}
