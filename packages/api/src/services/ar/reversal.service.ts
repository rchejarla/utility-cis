import { EVENT_TYPES, type ReverseEntryInput } from "@utility-cis/shared";
import { prisma } from "../../lib/prisma.js";
import { writeAuditRow } from "../../lib/audit-wrap.js";
import { lockAccount, recomputeAccountCache, type TxClient } from "./posting.service.js";

/**
 * Negating a posted entry and restoring what it consumed.
 *
 * `amount`, `type` and the dates are immutable once posted (§5), so a
 * correction is a new entry and never an edit. The REVERSAL carries the
 * opposite sign and names its target in `reversesId`.
 *
 * Three steps, and the third is the one the spec leaves open:
 *
 *  1. Undo the original's applications — give back exactly what each one
 *     consumed, then delete it. Exactly: restoring the original's full
 *     `amount` to the counterparties instead would invent money.
 *  2. Write the REVERSAL, opposite sign, pointing at the original.
 *  3. Apply the reversal against the original, in full, which closes
 *     both. Without this the balance is still correct, but a reversed
 *     payment stays an open credit that allocation will spend on the
 *     next bill — a bounced cheque paying twice.
 *
 * Dependent fees are REPORTED, never reversed. §6.6: if we billed wrong
 * the late fee probably should go, and if the corrected amount was also
 * unpaid it probably should stand. Only a human knows which.
 */

function err(code: string, message: string, statusCode: number): Error {
  return Object.assign(new Error(message), { code, statusCode });
}

export interface ReverseEntryResult {
  reversalId: string;
  reversedId: string;
  /** The reversal's signed amount — the opposite of the original's. */
  amount: string;
  /** Counterparties whose openAmount was given back, and its new value. */
  restored: Array<{ entryId: string; openAmount: string }>;
  dependentFees: Array<{ id: string; amount: string; dueDate: string | null }>;
  balance: string;
}

export async function reverseEntry(
  utilityId: string,
  actorId: string,
  actorName: string,
  entryId: string,
  input: ReverseEntryInput,
  existingTx?: TxClient,
): Promise<ReverseEntryResult> {
  const run = async (tx: TxClient): Promise<ReverseEntryResult> => {
    const original = await tx.ledgerEntry.findFirst({
      where: { id: entryId, utilityId },
      select: { id: true, accountId: true, type: true, amount: true, dueDate: true },
    });
    if (!original) throw err("ENTRY_NOT_FOUND", `Ledger entry ${entryId} not found`, 404);
    if (original.type === "REVERSAL") {
      throw err("CANNOT_REVERSE_REVERSAL", "A reversal cannot itself be reversed", 409);
    }

    await lockAccount(tx, utilityId, original.accountId);

    // Re-read under the lock, so a reversal that committed meanwhile is
    // seen rather than doubled.
    const already = await tx.ledgerEntry.count({ where: { utilityId, reversesId: entryId } });
    if (already > 0) {
      throw err("ENTRY_ALREADY_REVERSED", `Ledger entry ${entryId} is already reversed`, 409);
    }

    // 1. Undo the applications this entry took part in.
    const apps = await tx.ledgerApplication.findMany({
      where: { utilityId, OR: [{ creditId: entryId }, { debitId: entryId }] },
      orderBy: { appliedAt: "asc" },
      select: { id: true, creditId: true, debitId: true, amount: true },
    });
    const restored: Array<{ entryId: string; openAmount: string }> = [];
    for (const a of apps) {
      const wasCredit = a.creditId === entryId;
      const counterpartyId = wasCredit ? a.debitId : a.creditId;
      // Give back exactly what THIS application consumed: a debit's
      // openAmount goes back up, a credit's back down.
      const updated = await tx.ledgerEntry.update({
        where: { id: counterpartyId },
        data: wasCredit
          ? { openAmount: { increment: a.amount } }
          : { openAmount: { decrement: a.amount } },
        select: { id: true, openAmount: true },
      });
      restored.push({ entryId: updated.id, openAmount: updated.openAmount.toFixed(2) });
      await tx.ledgerApplication.delete({ where: { id: a.id } });
    }

    // 2. The reversal. A REVERSAL's sign follows its target, so the
    //    type/sign CHECK asks only that reversesId is set.
    const amount = original.amount.negated();
    const reversal = await tx.ledgerEntry.create({
      data: {
        utilityId,
        accountId: original.accountId,
        type: "REVERSAL",
        amount,
        openAmount: amount,
        // A positive reversal is owed again, and ages on the original's
        // clock; a negative one has nothing to fall due.
        dueDate: amount.gt(0) ? original.dueDate : null,
        effectiveDate: new Date(new Date().toISOString().slice(0, 10)),
        reversesId: entryId,
        reasonId: input.reasonId ?? null,
        memo: input.memo ?? `Reversal of ${original.type} ${entryId}`,
        createdBy: actorId,
      },
    });

    // 3. Settle the reversal against the original. The positive side is
    //    the debit and the negative side the credit, whichever way round
    //    they fall, because ledger_application.amount is always positive.
    await tx.ledgerApplication.create({
      data: {
        utilityId,
        creditId: amount.gt(0) ? entryId : reversal.id,
        debitId: amount.gt(0) ? reversal.id : entryId,
        amount: original.amount.abs(),
      },
    });
    // Both land on exactly zero: the original's own applications are gone
    // and this one consumes it in full, so §5's
    // `amount − Σ(as debit) + Σ(as credit)` is 0 on each side.
    await tx.ledgerEntry.updateMany({
      where: { id: { in: [entryId, reversal.id] } },
      data: { openAmount: 0 },
    });

    const dependents = await tx.ledgerEntry.findMany({
      where: { utilityId, assessedOnId: entryId },
      orderBy: { postedAt: "asc" },
      select: { id: true, amount: true, dueDate: true },
    });

    const cache = await recomputeAccountCache(tx, utilityId, original.accountId);

    return {
      reversalId: reversal.id,
      reversedId: entryId,
      amount: amount.toFixed(2),
      restored,
      dependentFees: dependents.map((f) => ({
        id: f.id,
        amount: f.amount.toFixed(2),
        dueDate: f.dueDate ? f.dueDate.toISOString().slice(0, 10) : null,
      })),
      balance: cache.balance,
    };
  };

  const runWithAudit = async (tx: TxClient): Promise<ReverseEntryResult> => {
    const result = await run(tx);
    await writeAuditRow(
      tx,
      { utilityId, actorId, actorName, entityType: "LedgerEntry" },
      EVENT_TYPES.LEDGER_REVERSAL_CREATED,
      result.reversalId,
      null,
      result,
    );
    return result;
  };

  if (existingTx) return runWithAudit(existingTx);
  return prisma.$transaction(runWithAudit);
}
