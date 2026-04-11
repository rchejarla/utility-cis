import { prisma } from "../lib/prisma.js";
import { EVENT_TYPES } from "@utility-cis/shared";
import type {
  CreateSuspensionInput,
  UpdateSuspensionInput,
  SuspensionQuery,
} from "@utility-cis/shared";
import { paginatedTenantList } from "../lib/pagination.js";
import { auditCreate, auditUpdate } from "../lib/audit-wrap.js";
import { assertSuspensionTypeCode } from "./suspension-type-def.service.js";
import { getTenantConfig } from "./tenant-config.service.js";

const fullInclude = {
  serviceAgreement: {
    select: {
      id: true,
      agreementNumber: true,
      accountId: true,
      premiseId: true,
      status: true,
    },
  },
} as const;

export async function listSuspensions(
  utilityId: string,
  query: SuspensionQuery,
) {
  const where: Record<string, unknown> = { utilityId };
  if (query.serviceAgreementId) where.serviceAgreementId = query.serviceAgreementId;
  if (query.suspensionType) where.suspensionType = query.suspensionType;
  if (query.status) where.status = query.status;
  if (query.activeOn) {
    const activeOn = new Date(query.activeOn);
    where.AND = [
      { startDate: { lte: activeOn } },
      {
        OR: [
          { endDate: null },
          { endDate: { gte: activeOn } },
        ],
      },
    ];
  }

  return paginatedTenantList(prisma.serviceSuspension, where, query, {
    include: fullInclude,
  });
}

/**
 * Resolve requestedBy/approvedBy UUIDs to display names by looking up
 * the cis_user rows in a single query. We store the actor IDs as bare
 * UUIDs (not Prisma relations) so a deleted user doesn't cascade-
 * destroy the hold audit history. The tradeoff is this extra lookup
 * on read; the set is tiny (at most two IDs per hold) and the whole
 * tenant's active user table is small, so a single findMany is fine.
 */
async function attachActorNames<T extends { requestedBy: string | null; approvedBy: string | null }>(
  utilityId: string,
  hold: T,
): Promise<T & { requestedByName: string | null; approvedByName: string | null }> {
  const ids = [hold.requestedBy, hold.approvedBy].filter((v): v is string => v !== null);
  const uniqueIds = Array.from(new Set(ids));
  if (uniqueIds.length === 0) {
    return { ...hold, requestedByName: null, approvedByName: null };
  }
  const users = await prisma.cisUser.findMany({
    where: { utilityId, id: { in: uniqueIds } },
    select: { id: true, name: true },
  });
  const byId = new Map(users.map((u) => [u.id, u.name]));
  return {
    ...hold,
    requestedByName: hold.requestedBy ? byId.get(hold.requestedBy) ?? null : null,
    approvedByName: hold.approvedBy ? byId.get(hold.approvedBy) ?? null : null,
  };
}

export async function getSuspension(id: string, utilityId: string) {
  const hold = await prisma.serviceSuspension.findFirstOrThrow({
    where: { id, utilityId },
    include: fullInclude,
  });
  return attachActorNames(utilityId, hold);
}

export async function suspensionsForAgreement(
  utilityId: string,
  serviceAgreementId: string,
) {
  return prisma.serviceSuspension.findMany({
    where: { utilityId, serviceAgreementId },
    orderBy: { startDate: "desc" },
  });
}

export async function createSuspension(
  utilityId: string,
  actorId: string,
  actorName: string,
  data: CreateSuspensionInput,
) {
  // Sanity check: endDate (if provided) must not be before startDate —
  // the DB CHECK constraint would catch this but a clearer 400 is nicer.
  if (data.endDate && new Date(data.endDate) < new Date(data.startDate)) {
    throw Object.assign(new Error("end_date must be on or after start_date"), {
      statusCode: 400,
      code: "SUSPENSION_DATES_INVALID",
    });
  }

  // FK-style check against the reference table. suspension_type is now
  // a string code (formerly a Prisma enum), so the service has to
  // enforce existence of the code for this tenant.
  await assertSuspensionTypeCode(utilityId, data.suspensionType);

  return auditCreate(
    { utilityId, actorId, actorName, entityType: "ServiceSuspension" },
    EVENT_TYPES.SERVICE_AGREEMENT_CREATED,
    () =>
      prisma.serviceSuspension.create({
        data: {
          utilityId,
          serviceAgreementId: data.serviceAgreementId,
          suspensionType: data.suspensionType,
          status: "PENDING",
          startDate: new Date(data.startDate),
          endDate: data.endDate ? new Date(data.endDate) : null,
          billingSuspended: data.billingSuspended ?? true,
          prorateOnStart: data.prorateOnStart ?? true,
          prorateOnEnd: data.prorateOnEnd ?? true,
          reason: data.reason ?? null,
          requestedBy: actorId,
        },
        include: fullInclude,
      }),
  );
}

export async function updateSuspension(
  utilityId: string,
  actorId: string,
  actorName: string,
  id: string,
  data: UpdateSuspensionInput,
) {
  const before = await prisma.serviceSuspension.findFirstOrThrow({
    where: { id, utilityId },
  });

  const updateData: Record<string, unknown> = {};
  if (data.startDate !== undefined) updateData.startDate = new Date(data.startDate);
  if (data.endDate !== undefined) {
    updateData.endDate = data.endDate ? new Date(data.endDate) : null;
  }
  if (data.billingSuspended !== undefined) updateData.billingSuspended = data.billingSuspended;
  if (data.reason !== undefined) updateData.reason = data.reason;
  if (data.status !== undefined) updateData.status = data.status;

  return auditUpdate(
    { utilityId, actorId, actorName, entityType: "ServiceSuspension" },
    EVENT_TYPES.SERVICE_AGREEMENT_UPDATED,
    before,
    () =>
      prisma.serviceSuspension.update({
        where: { id },
        data: updateData,
        include: fullInclude,
      }),
  );
}

/**
 * Explicit completion endpoint — more intentional than a status-only
 * update because it may backfill the end_date if one wasn't set.
 */
export async function completeSuspension(
  utilityId: string,
  actorId: string,
  actorName: string,
  id: string,
  endDate?: string,
) {
  const before = await prisma.serviceSuspension.findFirstOrThrow({
    where: { id, utilityId },
  });

  if (before.status === "COMPLETED") {
    throw Object.assign(new Error("Hold is already completed"), {
      statusCode: 400,
      code: "HOLD_ALREADY_COMPLETED",
    });
  }
  if (before.status === "CANCELLED") {
    throw Object.assign(new Error("Cannot complete a cancelled hold"), {
      statusCode: 400,
      code: "HOLD_CANCELLED",
    });
  }

  return auditUpdate(
    { utilityId, actorId, actorName, entityType: "ServiceSuspension" },
    EVENT_TYPES.SERVICE_AGREEMENT_UPDATED,
    before,
    () =>
      prisma.serviceSuspension.update({
        where: { id },
        data: {
          status: "COMPLETED",
          endDate: endDate ? new Date(endDate) : (before.endDate ?? new Date()),
        },
        include: fullInclude,
      }),
  );
}

/**
 * Approve a pending hold. Stamps approved_by with the actor id. Does
 * NOT flip the status — the scheduler (or a manual activate call) will
 * move PENDING → ACTIVE once startDate is reached. Gated at the route
 * level by service_suspensions.APPROVE permission.
 */
export async function approveSuspension(
  utilityId: string,
  actorId: string,
  actorName: string,
  id: string,
) {
  const before = await prisma.serviceSuspension.findFirstOrThrow({
    where: { id, utilityId },
  });

  if (before.status !== "PENDING") {
    throw Object.assign(new Error("Only PENDING holds can be approved"), {
      statusCode: 400,
      code: "HOLD_NOT_PENDING",
    });
  }
  if (before.approvedBy) {
    throw Object.assign(new Error("Hold is already approved"), {
      statusCode: 400,
      code: "HOLD_ALREADY_APPROVED",
    });
  }

  return auditUpdate(
    { utilityId, actorId, actorName, entityType: "ServiceSuspension" },
    EVENT_TYPES.SERVICE_AGREEMENT_UPDATED,
    before,
    () =>
      prisma.serviceSuspension.update({
        where: { id },
        data: { approvedBy: actorId },
        include: fullInclude,
      }),
  );
}

/**
 * Manual activation — PENDING → ACTIVE. Refuses if the tenant requires
 * approval and the hold has not yet been approved. The scheduler uses
 * the same guard via canActivate().
 */
async function canActivate(
  utilityId: string,
  suspension: { status: string; approvedBy: string | null },
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (suspension.status !== "PENDING") {
    return { ok: false, reason: "Only PENDING holds can be activated" };
  }
  const config = await getTenantConfig(utilityId);
  if (config.requireHoldApproval && !suspension.approvedBy) {
    return { ok: false, reason: "Hold requires approval before activation" };
  }
  return { ok: true };
}

export async function activateSuspension(
  utilityId: string,
  actorId: string,
  actorName: string,
  id: string,
) {
  const before = await prisma.serviceSuspension.findFirstOrThrow({
    where: { id, utilityId },
  });

  const check = await canActivate(utilityId, before);
  if (!check.ok) {
    throw Object.assign(new Error(check.reason), {
      statusCode: 400,
      code: "HOLD_NOT_ACTIVATABLE",
    });
  }

  return auditUpdate(
    { utilityId, actorId, actorName, entityType: "ServiceSuspension" },
    EVENT_TYPES.SERVICE_AGREEMENT_UPDATED,
    before,
    () =>
      prisma.serviceSuspension.update({
        where: { id },
        data: { status: "ACTIVE" },
        include: fullInclude,
      }),
  );
}

/**
 * Cancel a hold. Allowed from PENDING or ACTIVE. Refuses from
 * COMPLETED (use the audit trail to see prior state).
 */
export async function cancelSuspension(
  utilityId: string,
  actorId: string,
  actorName: string,
  id: string,
) {
  const before = await prisma.serviceSuspension.findFirstOrThrow({
    where: { id, utilityId },
  });

  if (before.status === "COMPLETED") {
    throw Object.assign(new Error("Cannot cancel a completed hold"), {
      statusCode: 400,
      code: "HOLD_COMPLETED",
    });
  }
  if (before.status === "CANCELLED") {
    throw Object.assign(new Error("Hold is already cancelled"), {
      statusCode: 400,
      code: "HOLD_ALREADY_CANCELLED",
    });
  }

  return auditUpdate(
    { utilityId, actorId, actorName, entityType: "ServiceSuspension" },
    EVENT_TYPES.SERVICE_AGREEMENT_UPDATED,
    before,
    () =>
      prisma.serviceSuspension.update({
        where: { id },
        data: { status: "CANCELLED" },
        include: fullInclude,
      }),
  );
}

/**
 * Transition helper shared by the scheduler and (implicitly) manual
 * endpoints. Flips PENDING → ACTIVE for any hold whose startDate has
 * arrived and whose approval gate is satisfied, then flips ACTIVE →
 * COMPLETED for any hold whose endDate has arrived. Returns a summary
 * of what changed so the scheduler can log it.
 *
 * Scoped to a single utility so the scheduler can iterate tenants
 * cheaply without leaking rows across RLS boundaries.
 */
export async function transitionSuspensions(
  utilityId: string,
  now: Date = new Date(),
): Promise<{ activated: number; completed: number }> {
  const config = await getTenantConfig(utilityId);

  // PENDING → ACTIVE. Respect the approval gate: if the tenant requires
  // approval, only approved holds roll forward automatically.
  const activateWhere: Record<string, unknown> = {
    utilityId,
    status: "PENDING",
    startDate: { lte: now },
  };
  if (config.requireHoldApproval) {
    activateWhere.approvedBy = { not: null };
  }
  const activated = await prisma.serviceSuspension.updateMany({
    where: activateWhere,
    data: { status: "ACTIVE" },
  });

  // ACTIVE → COMPLETED when endDate has passed. Open-ended holds
  // (endDate IS NULL) are intentionally skipped — they require manual
  // completion via the detail page.
  const completed = await prisma.serviceSuspension.updateMany({
    where: {
      utilityId,
      status: "ACTIVE",
      endDate: { not: null, lte: now },
    },
    data: { status: "COMPLETED" },
  });

  return {
    activated: activated.count,
    completed: completed.count,
  };
}

/**
 * List distinct tenants that have holds the scheduler might need to
 * touch. Cheaper than iterating every tenant in the system — the
 * scheduler only does work for tenants with at least one active or
 * pending hold.
 */
export async function listTenantsWithActiveHolds(): Promise<string[]> {
  const rows = await prisma.serviceSuspension.findMany({
    where: { status: { in: ["PENDING", "ACTIVE"] } },
    select: { utilityId: true },
    distinct: ["utilityId"],
  });
  return rows.map((r) => r.utilityId);
}
