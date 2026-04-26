import type { FastifyInstance } from "fastify";
import { AutomationConfigPatchSchema } from "@utility-cis/shared";
import {
  getAutomationConfig,
  patchAutomationConfig,
} from "../services/automation-config.service.js";

/**
 * Routes:
 *   GET /api/v1/settings/automation        — load current config
 *   PATCH /api/v1/settings/automation      — patch zero-or-more fields
 *
 * RBAC: tenant_profile:VIEW / tenant_profile:EDIT — same module that
 * gates other tenant-level config (branding, retention, billing).
 *
 * Validation:
 *   - Zod schema (timezone shape, HH:mm regex, integer ranges) at the
 *     route boundary.
 *   - IANA semantic check inside the service so it fires regardless
 *     of how the route layer changes (programmatic callers, tests, etc.).
 *
 * Errors:
 *   - Invalid IANA → 400 with the underlying message. The error
 *     is thrown from the service; we coerce it to a 400 instead of
 *     letting the global error handler treat it as a 500.
 */
export async function automationConfigRoutes(app: FastifyInstance) {
  app.get(
    "/api/v1/settings/automation",
    { config: { module: "tenant_profile", permission: "VIEW" } },
    async (request, reply) => {
      const { utilityId } = request.user;
      const config = await getAutomationConfig(utilityId);
      return reply.send(config);
    },
  );

  app.patch(
    "/api/v1/settings/automation",
    { config: { module: "tenant_profile", permission: "EDIT" } },
    async (request, reply) => {
      const { utilityId } = request.user;
      const patch = AutomationConfigPatchSchema.parse(request.body);

      try {
        const next = await patchAutomationConfig(utilityId, patch);
        return reply.send(next);
      } catch (err) {
        if (err instanceof Error && /Invalid IANA timezone/.test(err.message)) {
          return reply.status(400).send({
            error: { code: "INVALID_TIMEZONE", message: err.message },
          });
        }
        throw err;
      }
    },
  );
}
