import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { paginationArgs, paginatedResponse } from "../lib/pagination.js";
import { getUserRole } from "../services/rbac.service.js";

/**
 * The key that authorizes reading the whole log rather than one
 * entity's history.
 *
 * `settings` is reused rather than introducing an `audit_log_all`
 * module: a new key needs `tenant_module` rows for every existing
 * tenant and a place in each role preset, and this one already gates
 * the rest of the Administration section. If the tenant_profile /
 * settings / theme keys are ever consolidated, this moves with them.
 */
const UNFILTERED_READ_MODULE = "settings";

const auditSortFields = ["createdAt", "entityType", "action"] as const;

const auditQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(25),
  sort: z.enum(auditSortFields).default("createdAt"),
  order: z.enum(["asc", "desc"]).default("desc"),
  entityType: z.string().max(64).optional(),
  entityId: z.string().uuid().optional(),
  action: z.enum(["CREATE", "UPDATE", "DELETE"]).optional(),
  actorId: z.string().uuid().optional(),
  startDate: z.string().datetime().optional(),
  endDate: z.string().datetime().optional(),
}).strict();

export async function auditLogRoutes(app: FastifyInstance) {
  app.get("/api/v1/audit-log", { config: { module: "audit_log", permission: "VIEW" } }, async (request, reply) => {
    const { utilityId } = request.user;
    const query = auditQuerySchema.parse(request.query);

    /*
     * Two needs, one endpoint, and until now one authority.
     *
     * Five entity detail pages (account, premise, rate schedule,
     * service agreement, service request) show an Audit tab that sends
     * `entityType` + `entityId`. That is why the CSR and Field
     * Technician presets hold `audit_log: ["VIEW"]` — reading the
     * history of the record in front of you is counter work.
     *
     * Every filter here is optional, though, so the same grant also
     * answered a request with no filters at all: every audit row for
     * the tenant, including role changes, user management and settings
     * edits. Hiding the menu entry never restricted that, because the
     * endpoint was always reachable directly.
     *
     * Both filters are required, not either: `entityType=Role` alone
     * would sweep exactly the table this is protecting.
     */
    const pinnedToOneEntity = Boolean(query.entityType && query.entityId);
    if (!pinnedToOneEntity) {
      const userRole = await getUserRole(request.user.id, utilityId);
      /*
       * A request whose actor has no `cisUser` row is let through by
       * `authorizationMiddleware` as the migration path, so this guard
       * must not become the single place that rejects it — otherwise
       * the endpoint behaves differently from every other route for
       * the same caller. Only a known role is held to the key.
       */
      const perms = userRole?.permissions as Record<string, string[]> | undefined;
      if (perms && !(perms[UNFILTERED_READ_MODULE] ?? []).includes("VIEW")) {
        return reply.status(403).send({
          error: {
            code: "FORBIDDEN",
            message:
              "Reading the whole audit log requires settings:VIEW. " +
              "Supply entityType and entityId to read one record's history.",
          },
        });
      }
    }

    const where: Record<string, unknown> = { utilityId };

    if (query.entityType) where.entityType = query.entityType;
    if (query.entityId) where.entityId = query.entityId;
    if (query.action) where.action = query.action;
    if (query.actorId) where.actorId = query.actorId;

    if (query.startDate || query.endDate) {
      const createdAt: Record<string, Date> = {};
      if (query.startDate) createdAt.gte = new Date(query.startDate);
      if (query.endDate) createdAt.lte = new Date(query.endDate);
      where.createdAt = createdAt;
    }

    const [data, total] = await Promise.all([
      prisma.auditLog.findMany({
        where,
        ...paginationArgs(query),
      }),
      prisma.auditLog.count({ where }),
    ]);

    return reply.send(paginatedResponse(data, total, query));
  });
}
