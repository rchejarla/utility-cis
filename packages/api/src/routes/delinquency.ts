import type { FastifyInstance } from "fastify";
import {
  createDelinquencyRuleSchema,
  updateDelinquencyRuleSchema,
  delinquencyRuleQuerySchema,
  delinquencyActionQuerySchema,
  resolveDelinquencySchema,
  escalateDelinquencySchema,
} from "@utility-cis/shared";
import { prisma } from "../lib/prisma.js";
import { paginatedTenantList } from "../lib/pagination.js";
import { evaluateAll, resolveAccount, escalateAccount } from "../services/delinquency.service.js";

export async function delinquencyRoutes(app: FastifyInstance) {
  // ─── Rules CRUD ────────────────────────────────────────────────

  app.get(
    "/api/v1/delinquency-rules",
    { config: { module: "delinquency", permission: "VIEW" } },
    async (request, reply) => {
      const { utilityId } = request.user;
      const query = delinquencyRuleQuerySchema.parse(request.query);
      const where: Record<string, unknown> = { utilityId };
      if (query.accountType) where.accountType = query.accountType;
      if (query.isActive !== undefined) where.isActive = query.isActive;
      return reply.send(await paginatedTenantList(prisma.delinquencyRule, where, query));
    },
  );

  app.post(
    "/api/v1/delinquency-rules",
    { config: { module: "delinquency", permission: "CREATE" } },
    async (request, reply) => {
      const { utilityId } = request.user;
      const data = createDelinquencyRuleSchema.parse(request.body);
      const rule = await prisma.delinquencyRule.create({
        data: {
          utilityId,
          ...data,
          minBalance: data.minBalance,
          effectiveDate: data.effectiveDate ? new Date(data.effectiveDate) : new Date(),
        },
      });
      return reply.status(201).send(rule);
    },
  );

  app.get(
    "/api/v1/delinquency-rules/:id",
    { config: { module: "delinquency", permission: "VIEW" } },
    async (request, reply) => {
      const { utilityId } = request.user;
      const { id } = request.params as { id: string };
      const rule = await prisma.delinquencyRule.findFirst({ where: { id, utilityId } });
      if (!rule) return reply.status(404).send({ error: { code: "NOT_FOUND", message: "Rule not found" } });
      return reply.send(rule);
    },
  );

  app.patch(
    "/api/v1/delinquency-rules/:id",
    { config: { module: "delinquency", permission: "EDIT" } },
    async (request, reply) => {
      const { utilityId } = request.user;
      const { id } = request.params as { id: string };
      const data = updateDelinquencyRuleSchema.parse(request.body);
      const rule = await prisma.delinquencyRule.update({ where: { id, utilityId }, data });
      return reply.send(rule);
    },
  );

  app.delete(
    "/api/v1/delinquency-rules/:id",
    { config: { module: "delinquency", permission: "DELETE" } },
    async (request, reply) => {
      const { utilityId } = request.user;
      const { id } = request.params as { id: string };
      await prisma.delinquencyRule.update({ where: { id, utilityId }, data: { isActive: false } });
      return reply.status(204).send();
    },
  );

  // ─── Actions ───────────────────────────────────────────────────

  app.get(
    "/api/v1/delinquency-actions",
    { config: { module: "delinquency", permission: "VIEW" } },
    async (request, reply) => {
      const { utilityId } = request.user;
      const query = delinquencyActionQuerySchema.parse(request.query);
      const where: Record<string, unknown> = { utilityId };
      if (query.accountId) where.accountId = query.accountId;
      if (query.status) where.status = query.status;
      if (query.tier) where.tier = query.tier;
      return reply.send(
        await paginatedTenantList(prisma.delinquencyAction, where, query, {
          include: {
            account: { select: { accountNumber: true, customerId: true, balance: true } },
            rule: { select: { name: true } },
          },
        }),
      );
    },
  );

  app.get(
    "/api/v1/delinquency-actions/:id",
    { config: { module: "delinquency", permission: "VIEW" } },
    async (request, reply) => {
      const { utilityId } = request.user;
      const { id } = request.params as { id: string };
      const action = await prisma.delinquencyAction.findFirst({
        where: { id, utilityId },
        include: {
          account: { select: { accountNumber: true, customerId: true, balance: true } },
          rule: true,
        },
      });
      if (!action) return reply.status(404).send({ error: { code: "NOT_FOUND", message: "Action not found" } });
      return reply.send(action);
    },
  );

  app.post(
    "/api/v1/delinquency-actions/:id/cancel",
    { config: { module: "delinquency", permission: "EDIT" } },
    async (request, reply) => {
      const { utilityId } = request.user;
      const { id } = request.params as { id: string };
      const action = await prisma.delinquencyAction.findFirst({ where: { id, utilityId } });
      if (!action) return reply.status(404).send({ error: { code: "NOT_FOUND", message: "Action not found" } });
      if (action.status !== "PENDING") {
        return reply.status(400).send({ error: { code: "INVALID_STATUS", message: "Only PENDING actions can be cancelled" } });
      }
      const updated = await prisma.delinquencyAction.update({
        where: { id },
        data: { status: "CANCELLED", resolvedAt: new Date(), resolutionType: "WAIVED" },
      });
      return reply.send(updated);
    },
  );

  // ─── Account-level operations ──────────────────────────────────

  app.get(
    "/api/v1/accounts/:id/delinquency",
    { config: { module: "delinquency", permission: "VIEW" } },
    async (request, reply) => {
      const { utilityId } = request.user;
      const { id } = request.params as { id: string };
      const actions = await prisma.delinquencyAction.findMany({
        where: { accountId: id, utilityId },
        include: { rule: { select: { name: true } } },
        orderBy: { createdAt: "desc" },
      });
      return reply.send({ data: actions });
    },
  );

  app.post(
    "/api/v1/accounts/:id/delinquency/resolve",
    { config: { module: "delinquency", permission: "EDIT" } },
    async (request, reply) => {
      const { utilityId, id: userId } = request.user;
      const { id } = request.params as { id: string };
      const data = resolveDelinquencySchema.parse(request.body);
      const count = await resolveAccount(utilityId, id, data.resolutionType, data.notes, userId);
      return reply.send({ resolved: count });
    },
  );

  app.post(
    "/api/v1/accounts/:id/delinquency/escalate",
    { config: { module: "delinquency", permission: "EDIT" } },
    async (request, reply) => {
      const { utilityId, id: userId } = request.user;
      const { id } = request.params as { id: string };
      const data = escalateDelinquencySchema.parse(request.body ?? {});
      const result = await escalateAccount(utilityId, id, userId, data.notes);
      if (!result) {
        return reply.status(400).send({ error: { code: "NO_NEXT_TIER", message: "No next rule tier available for escalation" } });
      }
      return reply.status(201).send(result);
    },
  );

  // ─── Reporting ─────────────────────────────────────────────────

  app.get(
    "/api/v1/delinquency/eligible-for-shutoff",
    { config: { module: "delinquency", permission: "VIEW" } },
    async (request, reply) => {
      const { utilityId } = request.user;
      const actions = await prisma.delinquencyAction.findMany({
        where: { utilityId, actionType: "SHUT_OFF_ELIGIBLE", status: { in: ["PENDING", "COMPLETED"] } },
        include: {
          account: {
            select: {
              id: true, accountNumber: true, balance: true, lastDueDate: true,
              isProtected: true, protectionReason: true,
              customer: { select: { firstName: true, lastName: true, organizationName: true, customerType: true } },
            },
          },
          rule: { select: { name: true } },
        },
        orderBy: { createdAt: "desc" },
      });
      return reply.send({ data: actions });
    },
  );

  app.get(
    "/api/v1/delinquency/summary",
    { config: { module: "delinquency", permission: "VIEW" } },
    async (request, reply) => {
      const { utilityId } = request.user;
      const actions = await prisma.delinquencyAction.findMany({
        where: { utilityId, status: { in: ["PENDING", "COMPLETED"] } },
        select: { tier: true, balanceAtAction: true },
      });
      const byTier: Record<number, { count: number; balance: number }> = {};
      let totalBalance = 0;
      for (const a of actions) {
        const bal = Number(a.balanceAtAction);
        totalBalance += bal;
        if (!byTier[a.tier]) byTier[a.tier] = { count: 0, balance: 0 };
        byTier[a.tier].count++;
        byTier[a.tier].balance += bal;
      }
      return reply.send({
        totalAccounts: actions.length,
        totalBalance,
        byTier,
      });
    },
  );

  // ─── Manual evaluate trigger ───────────────────────────────────

  app.post(
    "/api/v1/delinquency/evaluate",
    { config: { module: "delinquency", permission: "CREATE" } },
    async (request, reply) => {
      const { utilityId } = request.user;
      const result = await evaluateAll(utilityId);
      return reply.send(result);
    },
  );
}
