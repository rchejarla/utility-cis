import type { PrismaClient } from "@utility-cis/shared/src/generated/prisma";
import { Decimal } from "../rate-engine/decimal.js";
import type {
  BaseContext,
  RateComponentSnapshot,
  ResolvedAssignment,
} from "../rate-engine/types.js";

/**
 * Slice 4 task 7 — hydrate the rate engine's `BaseContext` for one SA in
 * one round-trip.
 *
 * The engine's typed loaders (account/meter/premise/...) handle the
 * variable map. This helper covers the side that is NOT key-based:
 * the SA / account / premise snapshots and the resolved schedule
 * assignments + their components, ordered for evaluation.
 *
 * Schema notes (the plan's snippet had a stale shape — corrected here):
 *   - `ServiceAgreement` does NOT carry `premiseId`; the premise is
 *     reached via the active `ServicePoint`. We pick the earliest
 *     non-end-dated SP and read its premise.
 *   - `Account.accountType` is the closest analog to "customer type"
 *     in the engine snapshot.
 *   - `Premise.eruCount` is `Decimal? @db.Decimal(8,2)` from Prisma; we
 *     coerce to `decimal.js` via `new Decimal(value.toString())` so the
 *     engine's arithmetic stays in one library.
 *
 * Period filtering on assignments matches "active at any point in
 * `[startDate, endDate]`": effectiveDate must be on/before the period
 * end AND (expirationDate is null OR expirationDate is on/after the
 * period start). Components are pre-sorted by `sortOrder` so the
 * evaluator can iterate without resorting.
 */
export async function loadBase(
  prisma: PrismaClient,
  saId: string,
  period: { startDate: Date; endDate: Date },
  utilityId: string,
): Promise<BaseContext> {
  const sa = await prisma.serviceAgreement.findUniqueOrThrow({
    where: { id: saId, utilityId },
    include: {
      account: true,
      rateServiceClass: { select: { code: true } },
      // Premise is reached via the active service point in this schema.
      servicePoints: {
        where: { endDate: null },
        include: { premise: true },
        orderBy: { startDate: "asc" },
        take: 1,
      },
      rateScheduleAssignments: {
        where: {
          AND: [
            { effectiveDate: { lte: period.endDate } },
            {
              OR: [
                { expirationDate: null },
                { expirationDate: { gte: period.startDate } },
              ],
            },
          ],
        },
        include: {
          rateSchedule: {
            include: {
              components: { orderBy: { sortOrder: "asc" } },
            },
          },
        },
      },
    },
  });

  const sp = sa.servicePoints[0];
  if (!sp?.premise) {
    throw new Error(
      `Service agreement ${saId} has no active service point with a premise`,
    );
  }
  const premiseRow = sp.premise;

  return {
    sa: {
      id: sa.id,
      utilityId: sa.utilityId,
      accountId: sa.accountId,
      premiseId: premiseRow.id,
      commodityId: sa.commodityId,
      rateServiceClassCode: sa.rateServiceClass?.code,
    },
    account: {
      id: sa.account.id,
      accountNumber: sa.account.accountNumber,
      customerType: sa.account.accountType,
    },
    premise: {
      id: premiseRow.id,
      premiseType: premiseRow.premiseType,
      eruCount: premiseRow.eruCount
        ? new Decimal(premiseRow.eruCount.toString())
        : null,
      hasStormwaterInfra: premiseRow.hasStormwaterInfra,
      impervioussSqft: premiseRow.impervioussSqft,
    },
    period,
    assignments: sa.rateScheduleAssignments.map<ResolvedAssignment>((a) => ({
      id: a.id,
      rateScheduleId: a.rateScheduleId,
      roleCode: a.roleCode,
      effectiveDate: a.effectiveDate,
      expirationDate: a.expirationDate,
      schedule: {
        id: a.rateSchedule.id,
        name: a.rateSchedule.name,
        code: a.rateSchedule.code,
        version: a.rateSchedule.version,
        components: a.rateSchedule.components.map<RateComponentSnapshot>(
          (c) => ({
            id: c.id,
            rateScheduleId: c.rateScheduleId,
            kindCode: c.kindCode,
            label: c.label,
            predicate: c.predicate,
            quantitySource: c.quantitySource,
            pricing: c.pricing,
            sortOrder: c.sortOrder,
            effectiveDate: c.effectiveDate,
            expirationDate: c.expirationDate,
          }),
        ),
      },
    })),
  };
}
