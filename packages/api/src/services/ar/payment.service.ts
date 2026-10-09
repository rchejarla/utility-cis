import { Prisma } from "@utility-cis/shared/src/generated/prisma";
import { EVENT_TYPES, type RecordPaymentInput } from "@utility-cis/shared";
import { prisma } from "../../lib/prisma.js";
import { writeAuditRow } from "../../lib/audit-wrap.js";
import { lockAccount, recomputeAccountCache, type TxClient } from "./posting.service.js";
import { applyCreditToDebits, type Application } from "./allocation.service.js";

/**
 * Recording money received against an account.
 *
 * The request carries a POSITIVE amount — what the operator typed. This
 * function is where it becomes negative, because the ledger's sign
 * convention is the customer's obligation to the utility (§3.3a) and
 * money received reduces it. The validator refuses a negative input, so
 * there is exactly one negation on this path and it is here. Two
 * negations, or none, both produce a plausible-looking balance that is
 * wrong by twice the payment.
 *
 * Insert, allocate (§6.3), recompute the cache — one transaction, so the
 * payment and the balance it implies commit together or not at all.
 */

export interface RecordPaymentResult {
  paymentId: string;
  /** The signed ledger amount, so negative. */
  amount: string;
  applied: Application[];
  /** Absolute value left unapplied — a customer credit balance. */
  unapplied: string;
  balance: string;
}

export async function recordPayment(
  utilityId: string,
  actorId: string,
  actorName: string,
  accountId: string,
  input: RecordPaymentInput,
  existingTx?: TxClient,
): Promise<RecordPaymentResult> {
  const run = async (tx: TxClient): Promise<RecordPaymentResult> => {
    // Lock before anything is read or written. Allocation reads open
    // debits and then writes them, so two concurrent payments have to
    // serialize here or the second one allocates against a stale view.
    // It also proves the account is this tenant's before we insert a
    // row pointing at it.
    await lockAccount(tx, utilityId, accountId);

    const signed = new Prisma.Decimal(input.amount).negated();
    const effectiveDate = new Date(input.receivedAt ?? new Date().toISOString().slice(0, 10));

    const entry = await tx.ledgerEntry.create({
      data: {
        utilityId,
        accountId,
        type: "PAYMENT",
        amount: signed,
        openAmount: signed,
        // A credit has nothing to fall due.
        dueDate: null,
        effectiveDate,
        tender: input.tender,
        externalRef: input.externalRef ?? null,
        memo: input.memo ?? null,
        createdBy: actorId,
      },
    });

    const applied = await applyCreditToDebits(tx, utilityId, accountId, entry.id);
    const cache = await recomputeAccountCache(tx, utilityId, accountId);

    // Re-read rather than computing it: whatever allocation consumed is
    // already on the row, and deriving it a second time in here would be
    // a second place to get the sign wrong.
    const after = await tx.ledgerEntry.findUniqueOrThrow({
      where: { id: entry.id },
      select: { openAmount: true },
    });

    return {
      paymentId: entry.id,
      amount: signed.toFixed(2),
      applied,
      unapplied: after.openAmount.negated().toFixed(2),
      balance: cache.balance,
    };
  };

  const runWithAudit = async (tx: TxClient): Promise<RecordPaymentResult> => {
    const result = await run(tx);
    await writeAuditRow(
      tx,
      { utilityId, actorId, actorName, entityType: "LedgerEntry" },
      EVENT_TYPES.LEDGER_PAYMENT_CREATED,
      result.paymentId,
      null,
      result,
    );
    return result;
  };

  if (existingTx) return runWithAudit(existingTx);
  return prisma.$transaction(runWithAudit);
}
