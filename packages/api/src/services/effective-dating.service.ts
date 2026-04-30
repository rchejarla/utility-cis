import { prisma } from "../lib/prisma.js";
import { auditUpdate, writeAuditRow } from "../lib/audit-wrap.js";
import { EVENT_TYPES } from "@utility-cis/shared";

type TxClient = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

/**
 * PENDING → ACTIVE transition. Status-only flip, no cascade. Lives
 * here (not in service-agreement.service.ts) so all lifecycle
 * transitions share one module + audit pattern.
 *
 * Per FR-EFF-006. Generic PATCH no longer accepts status, so this is
 * the only path to ACTIVE.
 */
export async function activateServiceAgreement(
  utilityId: string,
  actorId: string,
  actorName: string,
  saId: string,
) {
  const before = await prisma.serviceAgreement.findUniqueOrThrow({
    where: { id: saId, utilityId },
  });
  if (before.status !== "PENDING") {
    throw Object.assign(
      new Error(
        `Cannot activate a service agreement in status ${before.status}; activate is only valid from PENDING`,
      ),
      { statusCode: 409, code: "INVALID_STATUS_TRANSITION" },
    );
  }
  return auditUpdate(
    { utilityId, actorId, actorName, entityType: "ServiceAgreement" },
    EVENT_TYPES.SERVICE_AGREEMENT_UPDATED,
    before,
    (tx) =>
      tx.serviceAgreement.update({
        where: { id: saId, utilityId },
        data: { status: "ACTIVE" },
      }),
  );
}

export interface CloseServiceAgreementInput {
  saId: string;
  endDate: Date;
  status: "FINAL" | "CLOSED";
  reason?: string;
}

export interface CloseServiceAgreementResult {
  agreement: Awaited<ReturnType<typeof prisma.serviceAgreement.update>>;
  metersClosed: number;
}

/**
 * Cascading close of a service agreement. Marks the SA as terminal AND
 * end-dates every still-open ServicePoint AND sets `removed_date =
 * endDate` on every still-open `service_point_meter` child in the SAME
 * transaction. Replaces the silent-orphan bug in `transferService` /
 * `moveOut` where SA closure left SPM rows with `removed_date IS
 * NULL`. Per FR-EFF-004.
 *
 * Idempotent: re-closing an SA with the same terminal status + endDate
 * is a no-op (no audits emitted, no SAM updates). A different terminal
 * status (e.g., FINAL → CLOSED) raises SA_ALREADY_TERMINAL — callers
 * must reverse-and-reapply through a separate flow we don't support
 * yet.
 *
 * Why direct (not generic UPDATE): the lifecycle invariant trigger
 * (`enforce_sa_lifecycle_invariants`, migration
 * `20260427144400_sa_lifecycle_invariants`) rejects a "set status to
 * FINAL/CLOSED without endDate" UPDATE at the DB layer. Callers MUST
 * use this helper (or the transitional REST endpoint that wraps it)
 * to close an SA — generic PATCH cannot drift the entity into a
 * terminal state.
 */
export async function closeServiceAgreement(
  utilityId: string,
  actorId: string,
  actorName: string,
  input: CloseServiceAgreementInput,
  existingTx?: TxClient,
): Promise<CloseServiceAgreementResult> {
  const run = async (tx: TxClient): Promise<CloseServiceAgreementResult> => {
    const before = await tx.serviceAgreement.findFirstOrThrow({
      where: { id: input.saId, utilityId },
    });

    if (before.status === "CLOSED") {
      // CLOSED is the absolute terminal state; nothing further is
      // allowed, even an idempotent re-application.
      throw Object.assign(
        new Error("Service agreement is already CLOSED"),
        { statusCode: 409, code: "SA_ALREADY_TERMINAL" },
      );
    }

    if (before.status === "FINAL") {
      const sameEnd =
        before.endDate !== null &&
        before.endDate.getTime() === input.endDate.getTime();
      // Idempotent re-application of FINAL.
      if (input.status === "FINAL" && sameEnd) {
        return { agreement: before, metersClosed: 0 };
      }
      // FINAL → CLOSED is a legitimate billing-lifecycle step (final
      // bill issued). It's a status-only update — meter assignments
      // were closed at the FINAL step, so the cascade is a no-op. The
      // endDate must match what was set at FINAL: it represents the
      // service-stop date and CLOSED doesn't change that.
      if (input.status === "CLOSED" && sameEnd) {
        const updated = await tx.serviceAgreement.update({
          where: { id: input.saId, utilityId },
          data: { status: "CLOSED" },
        });
        await writeAuditRow(
          tx,
          { utilityId, actorId, actorName, entityType: "ServiceAgreement" },
          EVENT_TYPES.SERVICE_AGREEMENT_UPDATED,
          updated.id,
          before,
          input.reason ? { ...updated, _reason: input.reason } : updated,
        );
        return { agreement: updated, metersClosed: 0 };
      }
      throw Object.assign(
        new Error(
          `Service agreement is FINAL with endDate=${before.endDate?.toISOString().slice(0, 10)}; ` +
            `cannot apply close with status=${input.status} endDate=${input.endDate.toISOString().slice(0, 10)}`,
        ),
        { statusCode: 409, code: "SA_ALREADY_TERMINAL" },
      );
    }

    const updated = await tx.serviceAgreement.update({
      where: { id: input.saId, utilityId },
      data: { status: input.status, endDate: input.endDate },
    });

    await writeAuditRow(
      tx,
      { utilityId, actorId, actorName, entityType: "ServiceAgreement" },
      EVENT_TYPES.SERVICE_AGREEMENT_UPDATED,
      updated.id,
      before,
      input.reason ? { ...updated, _reason: input.reason } : updated,
    );

    // End-date open ServicePoints attached to this SA (status mirrors
    // the SA's terminal state). The SP→SPM relation has onDelete:
    // Cascade but we don't delete here; we soft-close by setting
    // endDate so the history is preserved.
    await tx.servicePoint.updateMany({
      where: { serviceAgreementId: input.saId, endDate: null },
      data: { status: "CLOSED", endDate: input.endDate },
    });

    // Then close every still-open SPM for this SA, traversing through SP.
    const openSpms = await tx.servicePointMeter.findMany({
      where: {
        utilityId,
        servicePoint: { serviceAgreementId: input.saId },
        removedDate: null,
      },
    });

    for (const spm of openSpms) {
      const updatedSpm = await tx.servicePointMeter.update({
        where: { id: spm.id },
        data: { removedDate: input.endDate },
      });
      await writeAuditRow(
        tx,
        { utilityId, actorId, actorName, entityType: "ServicePointMeter" },
        "service_point_meter.updated",
        updatedSpm.id,
        spm,
        {
          ...updatedSpm,
          _cascadeFromSaId: input.saId,
          ...(input.reason ? { _reason: input.reason } : {}),
        },
      );
    }

    return { agreement: updated, metersClosed: openSpms.length };
  };

  if (existingTx) return run(existingTx);
  return prisma.$transaction(run);
}

export interface RemoveMeterFromAgreementInput {
  saId: string;
  meterId: string;
  removedDate: Date;
  reason?: string;
}

/**
 * Closes a single meter assignment on an SA. Emits one audit row.
 * Idempotent: removing an already-removed assignment with the SAME
 * removedDate is a no-op; a different removedDate raises
 * SAM_ALREADY_REMOVED.
 *
 * Per FR-EFF-013. Resolves the (saId, meterId) pair to the SAM row
 * server-side rather than asking callers to track the junction-table
 * PK — `meter_id` is what they actually know.
 */
export async function removeMeterFromAgreement(
  utilityId: string,
  actorId: string,
  actorName: string,
  input: RemoveMeterFromAgreementInput,
  existingTx?: TxClient,
) {
  const run = async (tx: TxClient) => {
    const before = await tx.servicePointMeter.findFirstOrThrow({
      where: {
        utilityId,
        servicePoint: { serviceAgreementId: input.saId },
        meterId: input.meterId,
        removedDate: null,
      },
    });

    if (before.removedDate !== null) {
      const sameRemove =
        (before.removedDate as Date).getTime() === input.removedDate.getTime();
      if (sameRemove) return before;
      throw Object.assign(
        new Error("Meter assignment is already removed"),
        { statusCode: 409, code: "SPM_ALREADY_REMOVED" },
      );
    }

    const updated = await tx.servicePointMeter.update({
      where: { id: before.id },
      data: { removedDate: input.removedDate },
    });

    await writeAuditRow(
      tx,
      { utilityId, actorId, actorName, entityType: "ServicePointMeter" },
      "service_point_meter.updated",
      updated.id,
      before,
      input.reason ? { ...updated, _reason: input.reason } : updated,
    );

    return updated;
  };

  if (existingTx) return run(existingTx);
  return prisma.$transaction(run);
}

export interface SwapMeterInput {
  saId: string;
  oldMeterId: string;
  newMeterId: string;
  swapDate: Date;
  reason?: string;
}

/**
 * Atomic swap: closes the old meter assignment AND opens a new one for
 * the same SA on the same date. The exclusion constraint
 * `no_double_assigned_meter` (migration
 * `20260427143900_sam_effective_range_exclusion`) is the source of
 * truth — the pre-check below produces friendlier errors before commit
 * but does not replace the constraint.
 *
 * Returns both the closed-old SAM and the freshly-inserted new SAM.
 *
 * Per FR-EFF-014.
 */
export async function swapMeter(
  utilityId: string,
  actorId: string,
  actorName: string,
  input: SwapMeterInput,
  existingTx?: TxClient,
) {
  const run = async (tx: TxClient) => {
    const oldSpm = await tx.servicePointMeter.findFirst({
      where: {
        utilityId,
        servicePoint: { serviceAgreementId: input.saId },
        meterId: input.oldMeterId,
        removedDate: null,
      },
    });
    if (!oldSpm) {
      throw Object.assign(
        new Error("Old meter is not currently assigned to this service agreement"),
        { statusCode: 400, code: "OLD_METER_NOT_ASSIGNED" },
      );
    }

    const newMeterConflict = await tx.servicePointMeter.findFirst({
      where: {
        utilityId,
        meterId: input.newMeterId,
        removedDate: null,
      },
    });
    if (newMeterConflict) {
      throw Object.assign(
        new Error(
          "New meter is already assigned to an active service agreement (BR-SA-004)",
        ),
        { statusCode: 409, code: "NEW_METER_ALREADY_ASSIGNED" },
      );
    }

    const closedOld = await tx.servicePointMeter.update({
      where: { id: oldSpm.id },
      data: { removedDate: input.swapDate },
    });

    await writeAuditRow(
      tx,
      { utilityId, actorId, actorName, entityType: "ServicePointMeter" },
      "service_point_meter.updated",
      closedOld.id,
      oldSpm,
      input.reason ? { ...closedOld, _reason: input.reason } : closedOld,
    );

    // The new SPM hangs off the SAME ServicePoint the old one did —
    // primacy is implicit (one meter at a time per SP).
    const newSpm = await tx.servicePointMeter.create({
      data: {
        utilityId,
        servicePointId: oldSpm.servicePointId,
        meterId: input.newMeterId,
        addedDate: input.swapDate,
      },
    });

    await writeAuditRow(
      tx,
      { utilityId, actorId, actorName, entityType: "ServicePointMeter" },
      "service_point_meter.created",
      newSpm.id,
      null,
      input.reason ? { ...newSpm, _reason: input.reason } : newSpm,
    );

    return { closedOld, newSpm };
  };

  if (existingTx) return run(existingTx);
  return prisma.$transaction(run);
}
