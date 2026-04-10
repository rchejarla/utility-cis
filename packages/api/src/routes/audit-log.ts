import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { paginationArgs, paginatedResponse } from "../lib/pagination.js";

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
