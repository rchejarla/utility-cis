import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { runAsTenant } from "../lib/tenant-context.js";

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
    /**
     * Required, with no default, the same way login requires it.
     *
     * An account number is unique *per tenant*
     * (`@@unique([utility_id, account_number])`), so looking one up
     * without a tenant is not a shortcut — it finds whichever row
     * Postgres reaches first, which may be a different utility's
     * customer. A default would be worse than requiring it: in
     * production an omitted field would quietly mean one particular
     * tenant.
     */
    utilityId: z.string().uuid(),
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
      const { accountNumber, email, name, utilityId } = registerSchema.parse(request.body);

      /*
       * One scope around the whole handler, not around each query.
       *
       * Registration is `skipAuth` — there is no request scope to
       * inherit, because the point of the route is that the caller has
       * no account yet. Six statements run here (account, role,
       * cis_user, then two inserts in a transaction), and on a
       * connection the policies apply to, any one of them left outside
       * the scope raises `22P02` on `''::uuid` rather than returning the
       * wrong row. So the scope has to cover the handler, and the
       * reply-building inside it is harmless.
       */
      return runAsTenant(utilityId, async () => {
        const account = await prisma.account.findFirst({
          where: { utilityId, accountNumber },
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

        // Slice 1 transitional behavior: portal users still get a tenant-
        // wide user_role assignment to the Portal Customer role so the
        // existing portal middleware (which reads tenant-wide role)
        // keeps working. Slice 3 will switch to per-account user_role
        // rows and migrate this row out.
        const user = await prisma.$transaction(async (tx) => {
          const created = await tx.cisUser.create({
            data: {
              utilityId,
              email: email.toLowerCase(),
              name,
              customerId: customer.id,
              isActive: true,
            },
          });
          await tx.userRole.create({
            data: {
              utilityId,
              userId: created.id,
              accountId: null,
              roleId: portalRole.id,
            },
          });
          return created;
        });

        const token = buildDevToken({
          sub: user.id,
          utility_id: utilityId,
          email: user.email,
          name: user.name,
          role: portalRole.name,
          customer_id: customer.id,
        });

        return reply.status(201).send({
          token,
          user: {
            id: user.id,
            email: user.email,
            name: user.name,
            roleName: portalRole.name,
            customerId: customer.id,
          },
        });
      });
    },
  );

  app.post(
    "/portal/api/auth/login",
    { config: { skipAuth: true } },
    async (request, reply) => {
      const { email, utilityId } = loginSchema.parse(request.body);

      /*
       * Scoped explicitly, and around all three statements: a portal
       * customer signing in has no tenant to inherit one from, which is
       * why this route is `skipAuth`. The tenant is named in the request
       * body, and the handler answers only whether an active portal user
       * with this email exists in it.
       */
      const signedIn = await runAsTenant(utilityId, async () => {
        const found = await prisma.cisUser.findFirst({
          where: {
            utilityId,
            email: email.toLowerCase(),
            customerId: { not: null },
            isActive: true,
          },
        });
        if (!found) return null;

        // Resolve their tenant-wide role for the JWT (Portal Customer
        // for now; Slice 3 introduces per-account roles).
        const roleAssignment = await prisma.userRole.findFirst({
          where: { userId: found.id, utilityId, accountId: null },
          include: { role: { select: { name: true } } },
        });

        await prisma.cisUser.update({
          where: { id: found.id },
          data: { lastLoginAt: new Date() },
        });

        return { found, roleName: roleAssignment?.role.name ?? "Portal Customer" };
      });

      if (!signedIn) {
        return reply.status(401).send({
          error: {
            code: "INVALID_CREDENTIALS",
            message: "No active portal account found for this email",
          },
        });
      }
      const { found: user, roleName } = signedIn;

      const token = buildDevToken({
        sub: user.id,
        utility_id: utilityId,
        email: user.email,
        name: user.name,
        role: roleName,
        customer_id: user.customerId,
      });

      return reply.send({
        token,
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          roleName,
          customerId: user.customerId,
        },
      });
    },
  );
}
