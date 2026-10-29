import type { FastifyInstance } from "fastify";
import {
  createDelinquencyRuleSchema,
  updateDelinquencyRuleSchema,
  delinquencyRuleQuerySchema,
  delinquencyActionQuerySchema,
  resolveDelinquencySchema,
  escalateDelinquencySchema,
  PaymentPlanTermsSchema,
} from "@utility-cis/shared";
import { prisma } from "../lib/prisma.js";
import { paginatedTenantList } from "../lib/pagination.js";
import { evaluateAll, resolveAccount, escalateAccount } from "../services/delinquency.service.js";
import { resolvePlanTerms } from "../services/payment-plan/terms.js";
import { patchSettingsNamespace } from "../services/tenant-config.service.js";
import { resolveReason } from "../services/ar/reason.service.js";
import { assertServiceRequestTypeCode } from "../services/service-request-type-def.service.js";

/**
 * The reason a tier's fee will cite has to be usable as a FEE reason —
 * checked here, where the operator typed it.
 *
 * `assessFee` puts it through the same gate at sweep time, and both
 * layers stay: this one is for the human, since without it a tier saved
 * against an ADJUSTMENT_DEBIT reason throws at 03:00 inside a worker,
 * possibly after other accounts in the tenant have already been
 * noticed. The sweep-time check remains because a reason can be retired
 * after a rule cites it.
 *
 * `resolveReason` takes a transaction client and `prisma` satisfies that
 * type, so this is literally the same gate rather than a second opinion
 * about what a fee reason is — vocabulary included: REASON_NOT_FOUND for
 * missing or retired, REASON_TYPE_MISMATCH for the wrong type.
 */
async function assertUsableFeeReason(
  utilityId: string,
  feeReasonId: string | null | undefined,
): Promise<void> {
  if (!feeReasonId) return;
  const reason = await resolveReason(prisma, utilityId, feeReasonId, "FEE");

  /*
   * And it has to be a reason a tier may charge to. Being an active FEE
   * reason is not enough: a returned-payment fee is raised when a
   * payment bounces, a tap fee when a tap is cut, each answering to its
   * own event rather than to time passing. Booking late fees under one
   * of those is a silent accounting error — the customer's bill prints
   * the reason's own label, so it would say "Tap fee".
   *
   * Read from the reason rather than from a list of codes here, because
   * reason codes are tenant-configurable; see
   * `LedgerReasonDef.allowsDelinquencyFee`.
   */
  if (!reason.allowsDelinquencyFee) {
    throw Object.assign(
      new Error(
        `Reason ${reason.code} is not one a delinquency tier may charge to. ` +
          `Mark it as available to delinquency, or pick a late-fee reason.`,
      ),
      { statusCode: 422, code: "REASON_NOT_FOR_DELINQUENCY" },
    );
  }
}

/**
 * Same again for the work-order type codes a tier dispatches, and for
 * the same reason: the sweep that uses them runs at 03:00 on a worker,
 * and skips an action it cannot route rather than failing the tenant's
 * whole pass — so an unknown code typed here would otherwise go
 * unnoticed until someone asked why no crew had been sent.
 */
async function assertUsableRequestTypes(
  utilityId: string,
  data: { serviceRequestTypeCode?: string | null; reconnectRequestTypeCode?: string | null },
): Promise<void> {
  for (const code of [data.serviceRequestTypeCode, data.reconnectRequestTypeCode]) {
    if (code) await assertServiceRequestTypeCode(utilityId, code);
  }
}

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
      await assertUsableFeeReason(utilityId, data.feeReasonId);
      await assertUsableRequestTypes(utilityId, data);
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
      await assertUsableFeeReason(utilityId, data.feeReasonId);
      await assertUsableRequestTypes(utilityId, data);
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

  // ─── Payment plan terms ────────────────────────────────────────

  /*
   * The tenant's terms for deferred payment agreements, beside the rules
   * rather than in Settings: delinquency rules and plan terms are the
   * same kind of thing — how this utility chases money — and an operator
   * configuring collections should not have to know that one is a table
   * and the other is JSON. Design §4a.
   */
  app.get(
    "/api/v1/delinquency/plan-terms",
    { config: { module: "delinquency", permission: "VIEW" } },
    async (request, reply) => {
      const { utilityId } = request.user;
      return reply.send({ terms: await resolvePlanTerms(utilityId) });
    },
  );

  app.put(
    "/api/v1/delinquency/plan-terms",
    { config: { module: "delinquency", permission: "EDIT" } },
    async (request, reply) => {
      const { utilityId } = request.user;

      /*
       * The whole namespace, validated as a whole: `.strict()` refuses a
       * misspelled key rather than storing it to be ignored, and the
       * min/max refinement refuses a range that would offer no valid
       * plan at all. Parsing also fills any key the client omitted with
       * its default, so what lands in the column is always complete —
       * a partial namespace is then only ever something written before
       * this route existed.
       */
      const terms = PaymentPlanTermsSchema.parse(request.body);
      await patchSettingsNamespace(utilityId, "paymentPlans", terms);
      return reply.send({ terms });
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
