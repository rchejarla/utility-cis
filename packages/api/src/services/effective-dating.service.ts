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
