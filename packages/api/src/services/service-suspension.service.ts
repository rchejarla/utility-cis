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

interface AffectedSuspension {
  id: string;
  utility_id: string;
  service_agreement_id: string;
}

/**
 * BullMQ-worker entry point for the suspension scheduler. Single
 * cross-tenant pass — no Node-side per-tenant loop. Two `UPDATE ...
 * RETURNING` queries (one PENDING→ACTIVE, one ACTIVE→COMPLETED) plus
 * one batched `auditLog.createMany` per affected set, all in one
 * `$transaction` with `ReadCommitted` isolation. Atomicity guarantee:
 * audit rows land iff suspension rows flip.
 *
 * Tenant gating:
 *   - `tenant_config.suspension_enabled = true` — opted-in tenants
 *     only. Defaults to true so existing tenants keep their
 *     pre-migration behavior.
 *   - For activation: tenants with `require_hold_approval = true`
 *     only roll forward holds where `approved_by IS NOT NULL`.
 *
 * Open-ended holds (endDate IS NULL) are intentionally skipped on
 * the completion side — they require explicit operator action via
 * the detail page.
 *
 * Idempotent: re-running the same sweep with the same `now` flips
 * zero additional rows. Re-runs are safe under at-least-once
 * delivery.
 */
export async function sweepSuspensionsAllTenants(
  now: Date = new Date(),
): Promise<{ activated: number; completed: number }> {
  return prisma.$transaction(
    async (tx) => {
      // PENDING → ACTIVE. Two-clause approval gate handled in SQL so
      // we don't have to fan out per tenant: if `require_hold_approval`
      // is true on the tenant, require `approved_by IS NOT NULL`.
      const activated = await tx.$queryRaw<AffectedSuspension[]>`
        UPDATE service_suspension AS ss
        SET status = 'ACTIVE'
        FROM tenant_config AS tc
        WHERE tc.utility_id = ss.utility_id
          AND tc.suspension_enabled = true
          AND ss.status = 'PENDING'
          AND ss.start_date <= ${now}
          AND (tc.require_hold_approval = false OR ss.approved_by IS NOT NULL)
        RETURNING ss.id, ss.utility_id, ss.service_agreement_id
      `;

      // ACTIVE → COMPLETED. Open-ended holds (end_date IS NULL) skipped.
      const completed = await tx.$queryRaw<AffectedSuspension[]>`
        UPDATE service_suspension AS ss
        SET status = 'COMPLETED'
        FROM tenant_config AS tc
        WHERE tc.utility_id = ss.utility_id
          AND tc.suspension_enabled = true
          AND ss.status = 'ACTIVE'
          AND ss.end_date IS NOT NULL
          AND ss.end_date <= ${now}
        RETURNING ss.id, ss.utility_id, ss.service_agreement_id
      `;

      const SCHEDULER_SOURCE = "scheduler:suspension-transitions";
      const auditRows = [
        ...activated.map((row) => ({
          utilityId: row.utility_id,
          entityType: "service_suspension",
          entityId: row.id,
          action: "UPDATE" as const,
          actorId: null, // scheduler-emitted; no user principal
          actorName: "Suspension scheduler",
          source: SCHEDULER_SOURCE,
          beforeState: { status: "PENDING" },
          afterState: {
            status: "ACTIVE",
            transitionAt: now.toISOString(),
            serviceAgreementId: row.service_agreement_id,
          },
        })),
        ...completed.map((row) => ({
          utilityId: row.utility_id,
          entityType: "service_suspension",
          entityId: row.id,
          action: "UPDATE" as const,
          actorId: null,
          actorName: "Suspension scheduler",
          source: SCHEDULER_SOURCE,
          beforeState: { status: "ACTIVE" },
          afterState: {
            status: "COMPLETED",
            transitionAt: now.toISOString(),
            serviceAgreementId: row.service_agreement_id,
          },
        })),
      ];

      if (auditRows.length > 0) {
        await tx.auditLog.createMany({ data: auditRows });
      }

      return { activated: activated.length, completed: completed.length };
    },
    { timeout: 30_000, isolationLevel: "ReadCommitted" },
  );
}
