import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { paginationArgs, paginatedResponse } from "../lib/pagination.js";
import { getUserRole } from "../services/rbac.service.js";
import { AUDIT_ACTIONS, AUDIT_ENTITY_TYPES } from "@utility-cis/shared";

/**
 * The key that authorizes reading the whole log rather than one
 * entity's history.
 *
 * `settings` is reused rather than introducing an `audit_log_all`
 * module: a new key needs `utility_module` rows for every existing
 * tenant and a place in each role preset, and this one already gates
 * the rest of the Administration section. If the tenant_profile /
 * settings / theme keys are ever consolidated, this moves with them.
 */
const UNFILTERED_READ_MODULE = "settings";

const auditSortFields = ["createdAt", "entityType", "action"] as const;

/**
 * A comma-separated list in one query parameter: `A` or `A,B`.
 *
 * Both multi-value filters on the audit log page arrive this way rather
 * than as repeated parameters, because `apiClient.get` takes
 * `Record<string, string>` and this needs no change there. Entity type
 * and action names contain no commas, so nothing needs escaping — a
 * filter whose values could would need a different encoding.
 */
const csvList = z
  .string()
  .transform((raw) => raw.split(",").map((value) => value.trim()).filter(Boolean));

const auditQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(25),
  sort: z.enum(auditSortFields).default("createdAt"),
  order: z.enum(["asc", "desc"]).default("desc"),
  entityType: csvList.pipe(z.array(z.string().max(64)).min(1)).optional(),
  entityId: z.string().uuid().optional(),
  // Piped through the enum per value, so a list cannot smuggle past it.
  action: csvList.pipe(z.array(z.enum(AUDIT_ACTIONS)).min(1)).optional(),
  actorId: z.string().uuid().optional(),
  startDate: z.string().datetime().optional(),
  endDate: z.string().datetime().optional(),
}).strict();

export async function auditLogRoutes(app: FastifyInstance) {
  /*
   * The entity types this tenant's log actually contains.
   *
   * The audit log page's Entity Type filter was a hardcoded list of
   * six — Premise, Meter, Account, ServiceAgreement, RateSchedule,
   * BillingCycle — while the API writes 27 distinct types, so most of
   * the log could not be filtered for at all. Serving the distinct
   * values is what keeps the filter from drifting again as entities are
   * added.
   *
   * Gated on `audit_log` rather than the `settings` key the unfiltered
   * read requires: this returns type names, not log contents, and
   * anyone who can read one entity's history already knows its type
   * exists.
   */
  app.get(
    "/api/v1/audit-log/entity-types",
    { config: { module: "audit_log", permission: "VIEW" } },
    async (request, reply) => {
      const { utilityId } = request.user;

      const rows = await prisma.auditLog.findMany({
        where: { utilityId },
        distinct: ["entityType"],
        select: { entityType: true },
        orderBy: { entityType: "asc" },
      });

      /*
       * The union, not either half. Serving only what the log contains
       * was the first attempt and it was worse than the hardcoded list
       * it replaced: a tenant with little history got a nearly empty
       * filter. Serving only the constant would miss writers that set
       * `entityType` from a variable, and legacy spellings that still
       * exist in old rows.
       */
      const types = new Set<string>([
        ...AUDIT_ENTITY_TYPES,
        ...rows.map((row) => row.entityType),
      ]);

      return reply.send({
        data: [...types].sort((a, b) => a.localeCompare(b)),
      });
    },
  );

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
     *
     * Exactly one type, too. `entityType` takes a list now, and several
     * types alongside one id is not one record's history — the id can
     * belong to only one of them — so accepting it would turn the
     * multi-select into a way around the key.
     */
    const pinnedToOneEntity = Boolean(query.entityId && query.entityType?.length === 1);
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

    if (query.entityType) where.entityType = { in: query.entityType };
    if (query.entityId) where.entityId = query.entityId;
    if (query.action) where.action = { in: query.action };
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

    /*
     * Rows written before `AuditContext.actorName` was required can
     * carry a null name — every `BillDocument` row did — and the list
     * used to render the raw actor uuid for them.
     *
     * Those rows cannot be repaired: the name they should have recorded
     * is not recoverable, and the column is denormalized precisely so
     * history survives a rename or a deletion. Writing today's name into
     * it would quietly falsify that. So the current name is resolved for
     * display only, in a separate field the UI labels as current rather
     * than historical, and the stored value is never touched.
     *
     * One extra query, and only when the page actually contains such a
     * row.
     */
    const unnamed = [
      ...new Set(
        data
          .filter((row) => !row.actorName && row.actorId)
          .map((row) => row.actorId as string),
      ),
    ];
    const currentNames = new Map<string, string>();
    if (unnamed.length > 0) {
      const users = await prisma.cisUser.findMany({
        where: { utilityId, id: { in: unnamed } },
        select: { id: true, name: true },
      });
      for (const user of users) currentNames.set(user.id, user.name);
    }

    const rows = data.map((row) => ({
      ...row,
      actorNameCurrent:
        row.actorName || !row.actorId ? null : currentNames.get(row.actorId) ?? null,
    }));

    return reply.send(paginatedResponse(rows, total, query));
  });
}
