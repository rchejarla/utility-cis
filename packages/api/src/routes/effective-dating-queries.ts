import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { idParamSchema } from "../lib/route-schemas.js";

/**
 * Point-in-time queries surfacing the SQL helpers
 * `responsible_account_at` and `meter_assignment_at` (migration
 * 20260427162359_point_in_time_helpers). The functions read
 * `current_setting('app.current_utility_id')` for tenant scoping; this
 * route sets it transactionally before each query.
 *
 * Returns 404 (with body) when no match — useful for "this meter
 * wasn't assigned to anyone on this date" answers.
 */

const responsibleAccountQuerySchema = z.object({
  commodity: z.string().uuid(),
  as_of: z.string().date(),
});

const assignmentQuerySchema = z.object({
  as_of: z.string().date(),
});

export async function effectiveDatingQueryRoutes(app: FastifyInstance) {
  // Full SA history for a premise — every SA that has ever covered it,
  // including FINAL/CLOSED rows that the standard premise-detail
  // include filters out. The History tab on premise detail uses this.
  app.get(
    "/api/v1/premises/:id/agreement-history",
    { config: { module: "premises", permission: "VIEW" } },
    async (request, reply) => {
      const { utilityId } = request.user;
      const { id } = idParamSchema.parse(request.params);

      const rows = await prisma.serviceAgreement.findMany({
        where: { utilityId, servicePoints: { some: { premiseId: id } } },
        select: {
          id: true,
          agreementNumber: true,
          status: true,
          startDate: true,
          endDate: true,
          commodity: { select: { id: true, name: true } },
          account: { select: { id: true, accountNumber: true } },
        },
        orderBy: [{ startDate: "desc" }, { createdAt: "desc" }],
      });

      return reply.send(rows);
    },
  );

  // Full SPM history for a meter — every assignment, ordered by
  // addedDate desc. Used by the meter detail History tab.
  app.get(
    "/api/v1/meters/:id/assignment-history",
    { config: { module: "meters", permission: "VIEW" } },
    async (request, reply) => {
      const { utilityId } = request.user;
      const { id } = idParamSchema.parse(request.params);

      const rows = await prisma.servicePointMeter.findMany({
        where: { utilityId, meterId: id },
        select: {
          id: true,
          addedDate: true,
          removedDate: true,
          servicePoint: {
            select: {
              id: true,
              premise: { select: { id: true, addressLine1: true } },
              serviceAgreement: {
                select: {
                  id: true,
                  agreementNumber: true,
                  status: true,
                  account: { select: { id: true, accountNumber: true } },
                },
              },
            },
          },
        },
        orderBy: [{ addedDate: "desc" }],
      });

      return reply.send(rows);
    },
  );

  app.get(
    "/api/v1/premises/:id/responsible-account",
    { config: { module: "premises", permission: "VIEW" } },
    async (request, reply) => {
      const { utilityId } = request.user;
      const { id } = idParamSchema.parse(request.params);
      const { commodity, as_of } = responsibleAccountQuerySchema.parse(request.query);

      const rows = await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.current_utility_id', ${utilityId}, true)`;
        return tx.$queryRaw<{ account_id: string | null }[]>`
          SELECT responsible_account_at(
            ${id}::uuid,
            ${commodity}::uuid,
            ${as_of}::date
          ) AS account_id
        `;
      });

      const accountId = rows[0]?.account_id ?? null;
      if (!accountId) {
        return reply.status(404).send({
          error: { code: "NO_RESPONSIBLE_ACCOUNT", message: "No responsible account at the requested date" },
        });
      }

      const account = await prisma.account.findUnique({
        where: { id: accountId, utilityId },
        select: { id: true, accountNumber: true },
      });

      return reply.send({
        accountId,
        accountNumber: account?.accountNumber ?? null,
        asOfDate: as_of,
      });
    },
  );

  app.get(
    "/api/v1/meters/:id/assignment",
    { config: { module: "meters", permission: "VIEW" } },
    async (request, reply) => {
      const { utilityId } = request.user;
      const { id } = idParamSchema.parse(request.params);
      const { as_of } = assignmentQuerySchema.parse(request.query);

      const rows = await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.current_utility_id', ${utilityId}, true)`;
        return tx.$queryRaw<
          { service_agreement_id: string; account_id: string; premise_id: string }[]
        >`
          SELECT * FROM meter_assignment_at(${id}::uuid, ${as_of}::date)
        `;
      });

      const row = rows[0];
      if (!row) {
        return reply.status(404).send({
          error: { code: "NO_ASSIGNMENT", message: "Meter was not assigned at the requested date" },
        });
      }

      const sa = await prisma.serviceAgreement.findUnique({
        where: { id: row.service_agreement_id, utilityId },
        select: { id: true, agreementNumber: true },
      });

      return reply.send({
        serviceAgreementId: row.service_agreement_id,
        agreementNumber: sa?.agreementNumber ?? null,
        accountId: row.account_id,
        premiseId: row.premise_id,
        asOfDate: as_of,
      });
    },
  );
}
