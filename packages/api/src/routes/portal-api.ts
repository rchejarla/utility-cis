import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";

/**
 * Portal data endpoints under /portal/api/*.
 *
 * Every endpoint is scoped to the authenticated customer's data via
 * request.user.customerId. A request with no customerId on the token
 * is rejected with 403 — admin staff accessing portal routes should
 * use the impersonation endpoint (Phase 4.1) to acquire a
 * customer-scoped token.
 *
 * All endpoints are gated by portal_* modules so the authorization
 * middleware works as-is.
 */

function requireCustomerId(request: FastifyRequest): string {
  const cid = request.user?.customerId;
  if (!cid) {
    throw Object.assign(new Error("Portal endpoints require a customer-scoped token"), {
      statusCode: 403,
    });
  }
  return cid;
}

export async function portalApiRoutes(app: FastifyInstance) {
  app.get(
    "/portal/api/dashboard",
    { config: { module: "portal_accounts", permission: "VIEW" } },
    async (request, reply) => {
      const customerId = requireCustomerId(request);
      const utilityId = request.user.utilityId;

      const customer = await prisma.customer.findUnique({
        where: { id: customerId },
        select: {
          id: true,
          firstName: true,
          lastName: true,
          organizationName: true,
          customerType: true,
          email: true,
          phone: true,
          status: true,
        },
      });

      if (!customer) {
        return reply.status(404).send({
          error: { code: "CUSTOMER_NOT_FOUND", message: "Customer record not found" },
        });
      }

      const accounts = await prisma.account.findMany({
        where: { customerId, utilityId },
        select: {
          id: true,
          accountNumber: true,
          accountType: true,
          status: true,
          serviceAgreements: {
            select: {
              id: true,
              agreementNumber: true,
              status: true,
              startDate: true,
              commodity: { select: { id: true, name: true } },
              billingCycle: { select: { id: true, name: true } },
              premise: {
                select: {
                  id: true,
                  addressLine1: true,
                  city: true,
                  state: true,
                  zip: true,
                },
              },
            },
          },
        },
        orderBy: { createdAt: "desc" },
      });

      return reply.send({ customer, accounts });
    },
  );

  app.get(
    "/portal/api/accounts",
    { config: { module: "portal_accounts", permission: "VIEW" } },
    async (request, reply) => {
      const customerId = requireCustomerId(request);
      const utilityId = request.user.utilityId;

      const accounts = await prisma.account.findMany({
        where: { customerId, utilityId },
        include: {
          _count: { select: { serviceAgreements: true } },
        },
        orderBy: { createdAt: "desc" },
      });

      return reply.send({ data: accounts });
    },
  );

  app.get(
    "/portal/api/accounts/:accountId/agreements",
    { config: { module: "portal_accounts", permission: "VIEW" } },
    async (request, reply) => {
      const customerId = requireCustomerId(request);
      const { accountId } = request.params as { accountId: string };

      const account = await prisma.account.findFirst({
        where: { id: accountId, customerId },
      });

      if (!account) {
        return reply.status(404).send({
          error: { code: "ACCOUNT_NOT_FOUND", message: "Account not found or not yours" },
        });
      }

      const agreements = await prisma.serviceAgreement.findMany({
        where: { accountId },
        include: {
          commodity: { select: { name: true } },
          premise: { select: { addressLine1: true, city: true, state: true } },
          billingCycle: { select: { name: true } },
        },
        orderBy: { startDate: "desc" },
      });

      return reply.send({ data: agreements });
    },
  );

  const usageQuerySchema = z.object({
    months: z.coerce.number().int().min(1).max(36).default(12),
  });

  app.get(
    "/portal/api/agreements/:agreementId/usage",
    { config: { module: "portal_usage", permission: "VIEW" } },
    async (request, reply) => {
      const customerId = requireCustomerId(request);
      const { agreementId } = request.params as { agreementId: string };
      const { months } = usageQuerySchema.parse(request.query);

      const agreement = await prisma.serviceAgreement.findFirst({
        where: {
          id: agreementId,
          account: { customerId },
        },
        select: { id: true },
      });

      if (!agreement) {
        return reply.status(404).send({
          error: { code: "AGREEMENT_NOT_FOUND", message: "Agreement not found or not yours" },
        });
      }

      const since = new Date();
      since.setMonth(since.getMonth() - months);

      const reads = await prisma.meterRead.findMany({
        where: {
          serviceAgreementId: agreementId,
          readDate: { gte: since },
        },
        select: {
          id: true,
          readDate: true,
          reading: true,
          consumption: true,
          readType: true,
          meter: { select: { meterNumber: true } },
        },
        orderBy: { readDate: "asc" },
      });

      return reply.send({ data: reads });
    },
  );

  app.get(
    "/portal/api/profile",
    { config: { module: "portal_profile", permission: "VIEW" } },
    async (request, reply) => {
      const customerId = requireCustomerId(request);

      const customer = await prisma.customer.findUnique({
        where: { id: customerId },
        select: {
          id: true,
          firstName: true,
          lastName: true,
          organizationName: true,
          customerType: true,
          email: true,
          phone: true,
          altPhone: true,
          status: true,
        },
      });

      return reply.send({ data: customer });
    },
  );

  const updateProfileSchema = z
    .object({
      email: z.string().email().max(255).optional(),
      phone: z.string().max(20).optional(),
      altPhone: z.string().max(20).optional().or(z.literal("")),
    })
    .strict();

  app.patch(
    "/portal/api/profile",
    { config: { module: "portal_profile", permission: "EDIT" } },
    async (request, reply) => {
      const customerId = requireCustomerId(request);
      const data = updateProfileSchema.parse(request.body);

      const updated = await prisma.customer.update({
        where: { id: customerId },
        data,
        select: {
          id: true,
          firstName: true,
          lastName: true,
          organizationName: true,
          customerType: true,
          email: true,
          phone: true,
          altPhone: true,
          status: true,
        },
      });

      return reply.send({ data: updated });
    },
  );
}
