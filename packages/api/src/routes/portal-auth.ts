import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";

/**
 * Portal authentication endpoints under /portal/api/auth/*.
 *
 * Phase 4 v1: dev-mode registration and login. Password hashing and
 * real session management are deferred until ApptorID integration —
 * these endpoints use the same unsigned-JWT pattern the admin dev
 * endpoints use, so the whole stack (auth middleware, authorization
 * middleware, RBAC) works without any new infrastructure.
 *
 * The JWT carries the same claims as admin tokens: sub, utility_id,
 * email, name, role, plus customer_id for portal scoping. The auth
 * middleware already extracts customer_id into request.user.customerId.
 */

const registerSchema = z
  .object({
    accountNumber: z.string().min(1).max(50),
    email: z.string().email().max(255),
    name: z.string().min(1).max(255),
  })
  .strict();

const loginSchema = z
  .object({
    email: z.string().email().max(255),
    utilityId: z.string().uuid(),
  })
  .strict();

function buildDevToken(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.dev`;
}

export async function portalAuthRoutes(app: FastifyInstance) {
  app.post(
    "/portal/api/auth/register",
    { config: { skipAuth: true } },
    async (request, reply) => {
      const { accountNumber, email, name } = registerSchema.parse(request.body);

      const account = await prisma.account.findFirst({
        where: { accountNumber },
        include: { customer: true },
      });

      if (!account || !account.customer) {
        return reply.status(400).send({
          error: {
            code: "ACCOUNT_NOT_FOUND",
            message: "No account found with that account number",
          },
        });
      }

      const customer = account.customer;
      const utilityId = account.utilityId;

      if (customer.email && customer.email.toLowerCase() !== email.toLowerCase()) {
        return reply.status(400).send({
          error: {
            code: "EMAIL_MISMATCH",
            message: "Email does not match the email on file for this account",
          },
        });
      }

      const portalRole = await prisma.role.findFirst({
        where: { utilityId, name: "Portal Customer" },
      });

      if (!portalRole) {
        return reply.status(500).send({
          error: {
            code: "ROLE_NOT_FOUND",
            message: "Portal Customer role not configured for this tenant. Run seed.",
          },
        });
      }

      const existing = await prisma.cisUser.findFirst({
        where: { utilityId, customerId: customer.id },
      });

      if (existing) {
        return reply.status(409).send({
          error: {
            code: "ALREADY_REGISTERED",
            message: "A portal account already exists for this customer",
          },
        });
      }

      const user = await prisma.cisUser.create({
        data: {
          utilityId,
          email: email.toLowerCase(),
          name,
          roleId: portalRole.id,
          customerId: customer.id,
          isActive: true,
        },
        include: { role: true },
      });

      const token = buildDevToken({
        sub: user.id,
        utility_id: utilityId,
        email: user.email,
        name: user.name,
        role: user.role.name,
        customer_id: customer.id,
      });

      return reply.status(201).send({
        token,
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          roleName: user.role.name,
          customerId: customer.id,
        },
      });
    },
  );

  app.post(
    "/portal/api/auth/login",
    { config: { skipAuth: true } },
    async (request, reply) => {
      const { email, utilityId } = loginSchema.parse(request.body);

      const user = await prisma.cisUser.findFirst({
        where: {
          utilityId,
          email: email.toLowerCase(),
          customerId: { not: null },
          isActive: true,
        },
        include: { role: true },
      });

      if (!user) {
        return reply.status(401).send({
          error: {
            code: "INVALID_CREDENTIALS",
            message: "No active portal account found for this email",
          },
        });
      }

      await prisma.cisUser.update({
        where: { id: user.id },
        data: { lastLoginAt: new Date() },
      });

      const token = buildDevToken({
        sub: user.id,
        utility_id: utilityId,
        email: user.email,
        name: user.name,
        role: user.role.name,
        customer_id: user.customerId,
      });

      return reply.send({
        token,
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          roleName: user.role.name,
          customerId: user.customerId,
        },
      });
    },
  );
}
