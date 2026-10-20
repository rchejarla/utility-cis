import type { FastifyInstance } from "fastify";
import { getUtilityReadiness } from "../services/utility-readiness.service.js";

/**
 * What this tenant still needs before it can operate, for the tenant.
 *
 * The same answer the platform console reads, served to the only people
 * who can act on it: the operator sees it to know why a tenant is quiet,
 * and the tenant's own admin sees a list of what to go and do. Every
 * remedy — a commodity, a billing cycle, a published tariff, the issuer
 * block — is theirs to make.
 *
 * `settings:VIEW`, which `/settings/bill-production` already requires to
 * show the issuer fields two of these checks are about. Not a new module
 * key: that would need a `utility_module` row for every existing tenant
 * and a place in each of the six presets to answer a question this key
 * already covers.
 *
 * No utility parameter. The only tenant this can report on is the
 * token's own — `request.user.utilityId` — so there is nothing to
 * mis-scope.
 */
export async function readinessRoutes(app: FastifyInstance) {
  app.get(
    "/api/v1/readiness",
    { config: { module: "settings", permission: "VIEW" } },
    async (request, reply) => {
      return reply.send(await getUtilityReadiness(request.user.utilityId));
    },
  );
}
