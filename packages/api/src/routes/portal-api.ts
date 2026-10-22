import type { FastifyInstance, FastifyRequest } from "fastify";
import { Prisma } from "@utility-cis/shared/src/generated/prisma";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { listBillsForAccount } from "../services/bill.service.js";

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
          error: {
            code: "CUSTOMER_NOT_FOUND",
            message: "Customer record not found. If you recently re-seeded the database, log out and log back in to refresh your session.",
          },
        });
      }

      const accounts = await prisma.account.findMany({
        where: { customerId, utilityId },
        select: {
          id: true,
          accountNumber: true,
          accountType: true,
          status: true,
          // What the account owes. Maintained by AR posting in the same
          // transaction that raises the receivable, so it is the
          // authoritative figure rather than something to recompute
          // from the bills in a browser.
          balance: true,
          billingCycle: { select: { id: true, name: true } },
          serviceAgreements: {
            select: {
              id: true,
              agreementNumber: true,
              status: true,
              startDate: true,
              commodity: { select: { id: true, name: true } },
              servicePoints: {
                where: { endDate: null },
                select: {
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
          },
        },
        orderBy: { createdAt: "desc" },
      });

      // Summed here rather than in the browser: one number the client
      // cannot derive differently, and Decimal arithmetic stays off the
      // float side of the wire.
      const amountDue = accounts
        .reduce((sum, a) => sum.add(a.balance), new Prisma.Decimal(0))
        .toFixed(2);

      return reply.send({ customer, accounts, amountDue });
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
    "/portal/api/accounts/:accountId",
    { config: { module: "portal_accounts", permission: "VIEW" } },
    async (request, reply) => {
      const customerId = requireCustomerId(request);
      const { accountId } = request.params as { accountId: string };

      const account = await prisma.account.findFirst({
        where: { id: accountId, customerId },
        include: {
          billingCycle: { select: { id: true, name: true } },
          serviceAgreements: {
            include: {
              commodity: { select: { id: true, name: true } },
              servicePoints: {
                include: {
                  premise: { select: { id: true, addressLine1: true, city: true, state: true, zip: true } },
                  meters: {
                    include: {
                      meter: {
                        select: {
                          id: true,
                          meterNumber: true,
                          meterType: true,
                          status: true,
                          uom: { select: { code: true, name: true } },
                        },
                      },
                    },
                  },
                },
              },
            },
            orderBy: { startDate: "desc" },
          },
        },
      });

      if (!account) {
        return reply.status(404).send({
          error: { code: "ACCOUNT_NOT_FOUND", message: "Account not found or not yours" },
        });
      }

      return reply.send({ data: account });
    },
  );

  /**
   * The customer's own bills for one of their accounts.
   *
   * Bills hang off the Account, so this is account-scoped like its
   * admin counterpart `GET /api/v1/accounts/:id/bills` — the portal
   * iterates the accounts `/portal/api/accounts` already returns rather
   * than asking for a customer-wide list.
   *
   * It exists rather than reusing the admin route because that route
   * filters on tenant and account only: a CSR may read any account, so
   * it has no ownership check to borrow. Granting a portal token
   * `accounts:VIEW` would therefore let any signed-in customer read a
   * stranger's bills by passing their account id.
   *
   * Ownership is checked before the bills are fetched, and a miss is a
   * 404 rather than a 403: whether some other customer's account exists
   * is not this caller's to learn.
   */
  app.get(
    "/portal/api/accounts/:accountId/bills",
    { config: { module: "portal_accounts", permission: "VIEW" } },
    async (request, reply) => {
      const customerId = requireCustomerId(request);
      const utilityId = request.user.utilityId;
      const { accountId } = request.params as { accountId: string };

      const account = await prisma.account.findFirst({
        where: { id: accountId, customerId, utilityId },
        select: { id: true },
      });

      if (!account) {
        return reply.status(404).send({
          error: { code: "ACCOUNT_NOT_FOUND", message: "Account not found or not yours" },
        });
      }

      // Unposted bills are withheld. A bill is a calculation until it
      // is posted: it has raised no receivable and moved no balance, so
      // the customer does not owe it — the admin AR tab excludes them
      // for the same reason. The staff Bills tab must still show them
      // (that is where posting happens), so the filter belongs here
      // rather than in the shared service.
      const bills = await listBillsForAccount(utilityId, accountId);
      return reply.send({ data: bills.filter((b) => b.postedAt !== null) });
    },
  );

  const usageQuerySchema = z.object({
    from: z.string().regex(/^\d{4}-\d{2}$/).optional(),
    to: z.string().regex(/^\d{4}-\d{2}$/).optional(),
  });

  app.get(
    "/portal/api/agreements/:agreementId/usage",
    { config: { module: "portal_usage", permission: "VIEW" } },
    async (request, reply) => {
      const customerId = requireCustomerId(request);
      const { agreementId } = request.params as { agreementId: string };
      const query = usageQuerySchema.parse(request.query);

      // Default: trailing 12 months. Max range: 36 months.
      const now = new Date();
      const toDate = query.to ? new Date(query.to + "-28") : now;
      const defaultFrom = new Date(now);
      defaultFrom.setMonth(defaultFrom.getMonth() - 12);
      const fromDate = query.from ? new Date(query.from + "-01") : defaultFrom;

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

      const reads = await prisma.meterRead.findMany({
        where: {
          serviceAgreementId: agreementId,
          readDate: { gte: fromDate, lte: toDate },
        },
        select: {
          id: true,
          readDate: true,
          reading: true,
          consumption: true,
          readType: true,
          meter: { select: { meterNumber: true } },
          uom: { select: { code: true, name: true } },
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
