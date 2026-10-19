import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { config } from "../config.js";
import { provisionTenant, listUtilities } from "../services/provisioning.service.js";

/**
 * Provisioning from a browser, fenced to development.
 *
 * D1 says provisioning is "callable from a script, **no UI**", and the
 * build order puts a console at step 6. This exists against that, by
 * decision — and the objection it answers was never the screen but the
 * authority. Before the platform actor exists (step 5), a provisioning
 * page has nowhere to live but a tenant's own Administration section,
 * gated on a tenant permission, which is exactly the borrowing §1.6
 * flags with Bull Board: one tenant's admin acting above tenants.
 *
 * The fence is the answer. These routes are registered only when
 * `!IS_PROD && ENABLE_DEV_AUTH_ENDPOINTS`, the same condition guarding
 * `/api/v1/auth/dev-login`, so they cannot exist in a production build
 * at all — and a tool that cannot ship cannot become a tenant's route to
 * provisioning other tenants. The page they serve lives at `/dev/tenants`,
 * outside admin chrome and absent from every sidebar.
 *
 * When step 5 lands, this moves behind the platform actor and the fence
 * comes off. Until then it is a single-tenant operator's console, which
 * is what D5's `self_serve` mode describes anyway.
 */

const IS_PROD = config.NODE_ENV === "production";
const DEV_ENDPOINTS_ENABLED = !IS_PROD && config.ENABLE_DEV_AUTH_ENDPOINTS;

const provisionBodySchema = z
  .object({
    utilityId: z.string().uuid().optional(),
    name: z.string().trim().min(1).max(255),
    firstAdmin: z
      .object({
        email: z.string().email().max(255),
        name: z.string().trim().min(1).max(255),
      })
      .optional(),
    dryRun: z.boolean().optional(),
  })
  .strict();

export async function devTenantRoutes(app: FastifyInstance) {
  if (!DEV_ENDPOINTS_ENABLED) {
    // Register nothing, so the 404 is Fastify's own rather than a
    // handler reporting on a route it admits exists.
    app.log.info(
      "[dev] tenant provisioning endpoints disabled (set ENABLE_DEV_AUTH_ENDPOINTS=true in non-prod to enable)",
    );
    return;
  }

  // Both routes take `settings:EDIT`, including the read. The Utility
  // Admin preset holds `settings: ["VIEW"]` — the single permission
  // separating it from System Admin — so gating the list on VIEW would
  // let any tenant's own admin enumerate every other tenant's name, id
  // and counts, which is the borrowing the fence exists to prevent.
  app.get(
    "/api/v1/dev/tenants",
    { config: { module: "settings", permission: "EDIT" } },
    async (_request, reply) => {
      return reply.send({ data: await listUtilities() });
    },
  );

  app.post(
    "/api/v1/dev/tenants",
    { config: { module: "settings", permission: "EDIT" } },
    async (request, reply) => {
      const body = provisionBodySchema.parse(request.body);

      const result = await provisionTenant({
        utilityId: body.utilityId ?? crypto.randomUUID(),
        name: body.name,
        firstAdmin: body.firstAdmin,
        dryRun: body.dryRun,
      });

      // 200, not 201, for a dry run: nothing was created, and a client
      // reading the status rather than the body should not be told it was.
      return reply.status(body.dryRun ? 200 : 201).send(result);
    },
  );
}
