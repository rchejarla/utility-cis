import { Prisma } from "@utility-cis/shared/src/generated/prisma";
import { EVENT_TYPES, type AssessFeeInput } from "@utility-cis/shared";
import { prisma } from "../../lib/prisma.js";
import { writeAuditRow } from "../../lib/audit-wrap.js";
import { lockAccount, recomputeAccountCache, type TxClient } from "./posting.service.js";
import { applyCreditsToDebit, type Application } from "./allocation.service.js";
import { resolveReason } from "./reason.service.js";

/**
 * Raising a fee — an off-cycle charge that ages on its own clock (§6.4).
 *
 * Fee GENERATION is out of scope: nothing here decides when a late fee
 * falls due or how much it is. This is the entry point that slice 6's
 * late-fee job and the operator screen both call, which is why the
 * amount, the reason and the dates all arrive from the caller.
 *
 * `assessedOnId` is optional and usually absent. A late fee names the
 * debit that went unpaid; a tap fee or a meter test fee is assessed on
 * nothing. That asymmetry is why the database constraint is "only a FEE
 * may name one" rather than "every FEE must".
 */

/**
 * How long a fee has to be paid when the caller does not say.
 *
 * §6.4 wants the next bill's due date. That is not knowable here — the
 * next bill may not exist yet, and deriving it would duplicate
 * computeBillPeriod for a value the operator can see — so it arrives
 * with slice 6, where late fees are raised against a known cycle.
 */
const DEFAULT_FEE_DUE_DAYS = 30;

function err(code: string, message: string, statusCode: number): Error {
  return Object.assign(new Error(message), { code, statusCode });
}

export interface AssessFeeResult {
  feeId: string;
  /** Signed, and a fee is a debit, so positive. */
  amount: string;
  /** Open credits this fee absorbed on the way in. */
  applied: Application[];
  balance: string;
}

export async function assessFee(
  utilityId: string,
  actorId: string,
  actorName: string,
  accountId: string,
  input: AssessFeeInput,
  existingTx?: TxClient,
): Promise<AssessFeeResult> {
  const run = async (tx: TxClient): Promise<AssessFeeResult> => {
    await lockAccount(tx, utilityId, accountId);
    // Before anything is written: the reason has to exist, belong to this
    // tenant, be active, and be a FEE reason.
    await resolveReason(tx, utilityId, input.reasonId, "FEE");

    if (input.assessedOnId) {
      // It has to be this account's entry, or the fee claims a
      // provenance it does not have — and `assessedOnId` has no tenant
      // column of its own to check it against later.
      const anchor = await tx.ledgerEntry.findFirst({
        where: { id: input.assessedOnId, utilityId, accountId },
        select: { id: true },
      });
      if (!anchor) {
        throw err(
          "ENTRY_NOT_FOUND",
          `Entry ${input.assessedOnId} not found on this account`,
          404,
        );
      }
    }

    const amount = new Prisma.Decimal(input.amount);
    const effectiveDate = new Date(input.effectiveDate ?? new Date().toISOString().slice(0, 10));
    const dueDate = input.dueDate
      ? new Date(input.dueDate)
      : new Date(effectiveDate.getTime() + DEFAULT_FEE_DUE_DAYS * 86_400_000);

    const entry = await tx.ledgerEntry.create({
      data: {
        utilityId,
        accountId,
        type: "FEE",
        amount,
        openAmount: amount,
        // Every debit carries a due date, or the aging and allocation
        // partial index cannot see it at all (slice 1's R8).
        dueDate,
        effectiveDate,
        reasonId: input.reasonId,
        assessedOnId: input.assessedOnId ?? null,
        memo: input.memo ?? null,
        createdBy: actorId,
      },
    });

    // A new debit absorbs open credits, the same as a posted bill does.
    const applied = await applyCreditsToDebit(tx, utilityId, accountId, entry.id);
    const cache = await recomputeAccountCache(tx, utilityId, accountId);

    return { feeId: entry.id, amount: amount.toFixed(2), applied, balance: cache.balance };
  };

  const runWithAudit = async (tx: TxClient): Promise<AssessFeeResult> => {
    const result = await run(tx);
    await writeAuditRow(
      tx,
      { utilityId, actorId, actorName, entityType: "LedgerEntry" },
      EVENT_TYPES.LEDGER_FEE_CREATED,
      result.feeId,
      null,
      result,
    );
    return result;
  };

  if (existingTx) return runWithAudit(existingTx);
  return prisma.$transaction(runWithAudit);
}
