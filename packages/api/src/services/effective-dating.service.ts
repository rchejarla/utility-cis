import { prisma } from "../lib/prisma.js";
import { writeAuditRow } from "../lib/audit-wrap.js";
import { EVENT_TYPES } from "@utility-cis/shared";

type TxClient = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

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
 * sets `removed_date = endDate` on every still-open
 * `service_agreement_meter` child in the SAME transaction. Replaces the
 * silent-orphan bug in `transferService` / `moveOut` where SA closure
 * left SAM rows with `removed_date IS NULL`. Per FR-EFF-004.
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

    if (before.status === "FINAL" || before.status === "CLOSED") {
      const sameClose =
        before.status === input.status &&
        before.endDate !== null &&
        before.endDate.getTime() === input.endDate.getTime();
      if (sameClose) {
        return { agreement: before, metersClosed: 0 };
      }
      throw Object.assign(
        new Error(
          `Service agreement is already ${before.status}; cannot re-close as ${input.status}`,
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

    const openSams = await tx.serviceAgreementMeter.findMany({
      where: { utilityId, serviceAgreementId: input.saId, removedDate: null },
    });

    for (const sam of openSams) {
      const updatedSam = await tx.serviceAgreementMeter.update({
        where: { id: sam.id },
        data: { removedDate: input.endDate },
      });
      await writeAuditRow(
        tx,
        { utilityId, actorId, actorName, entityType: "ServiceAgreementMeter" },
        "service_agreement_meter.updated",
        updatedSam.id,
        sam,
        {
          ...updatedSam,
          _cascadeFromSaId: input.saId,
          ...(input.reason ? { _reason: input.reason } : {}),
        },
      );
    }

    return { agreement: updated, metersClosed: openSams.length };
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
    const before = await tx.serviceAgreementMeter.findFirstOrThrow({
      where: {
        utilityId,
        serviceAgreementId: input.saId,
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
        { statusCode: 409, code: "SAM_ALREADY_REMOVED" },
      );
    }

    const updated = await tx.serviceAgreementMeter.update({
      where: { id: before.id },
      data: { removedDate: input.removedDate },
    });

    await writeAuditRow(
      tx,
      { utilityId, actorId, actorName, entityType: "ServiceAgreementMeter" },
      "service_agreement_meter.updated",
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
    const oldSam = await tx.serviceAgreementMeter.findFirst({
      where: {
        utilityId,
        serviceAgreementId: input.saId,
        meterId: input.oldMeterId,
        removedDate: null,
      },
    });
    if (!oldSam) {
      throw Object.assign(
        new Error("Old meter is not currently assigned to this service agreement"),
        { statusCode: 400, code: "OLD_METER_NOT_ASSIGNED" },
      );
    }

    const newMeterConflict = await tx.serviceAgreementMeter.findFirst({
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

    const closedOld = await tx.serviceAgreementMeter.update({
      where: { id: oldSam.id },
      data: { removedDate: input.swapDate },
    });

    await writeAuditRow(
      tx,
      { utilityId, actorId, actorName, entityType: "ServiceAgreementMeter" },
      "service_agreement_meter.updated",
      closedOld.id,
      oldSam,
      input.reason ? { ...closedOld, _reason: input.reason } : closedOld,
    );

    const newSam = await tx.serviceAgreementMeter.create({
      data: {
        utilityId,
        serviceAgreementId: input.saId,
        meterId: input.newMeterId,
        isPrimary: oldSam.isPrimary,
        addedDate: input.swapDate,
      },
    });

    await writeAuditRow(
      tx,
      { utilityId, actorId, actorName, entityType: "ServiceAgreementMeter" },
      "service_agreement_meter.created",
      newSam.id,
      null,
      input.reason ? { ...newSam, _reason: input.reason } : newSam,
    );

    return { closedOld, newSam };
  };

  if (existingTx) return run(existingTx);
  return prisma.$transaction(run);
}
