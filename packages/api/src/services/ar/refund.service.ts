import { Prisma } from "@utility-cis/shared/src/generated/prisma";
import { prisma } from "../../lib/prisma.js";
import { writeAuditRow } from "../../lib/audit-wrap.js";
import { EVENT_TYPES } from "@utility-cis/shared";
import { lockAccount, recomputeAccountCache, type TxClient } from "./posting.service.js";
import { applyCreditsToDebit, type Application, type CreditPool } from "./allocation.service.js";

/**
 * Giving money back.
 *
 * A refund is a **debit** — positive, like a charge. That reads wrong
 * until you see what it does: it consumes an open credit the customer
 * already held and brings the account back toward zero. Paying out an
 * overpayment does not grant them a new credit; it discharges the one
 * they had. The arithmetic is the same a bill performs when it absorbs
 * an overpayment, which is why the existing allocation walk does the
 * work rather than a second mechanism.
 *
 * **Which pool.** Receivable credits and security deposits are kept
 * apart everywhere in this module — in `Account.balance`, in allocation,
 * in the open-item count, in reconciliation — because one is money the
 * customer handed over against what they owe and the other is money the
 * utility holds. A refund therefore has to say which it is returning.
 * Drawing from "whatever credit is oldest" would let an overpayment
 * refund consume a security deposit, which is exactly the silent spend
 * the allocation exclusion exists to prevent.
 *
 * **Capped by refusal, not by truncation.** Asking to refund more than
 * is available fails with the figure that was available. Quietly
 * refunding less would leave an operator believing a customer had been
 * made whole, and a cheque for the wrong amount already written.
 *
 * **The disbursement record is on the entry.** `tender` is how the money
 * left, `externalRef` the cheque number, `effectiveDate` the day it
 * issued — the same three columns a payment and a deposit use for how
 * money arrived. No separate table: batching into a cheque run, an
 * issued/cleared/voided lifecycle and approved-but-unpaid state are what
 * one would add, and none is a stated need. Spec 10 already puts
 * approval outside the ledger, because posting is final.
 *
 * **Not on the receipts list.** That screen ties a day's takings to a
 * bank slip, and a slip is one-directional. A refund netted into it
 * would destroy the reconciliation rather than enrich it.
 */

export interface RecordRefundResult {
  entryId: string;
  /** Positive, as issued. */
  amount: string;
  /** Which pool it came out of. */
  source: CreditPool;
  balance: string;
  depositAmount: string;
  /** The credits this refund discharged. */
  applied: Application[];
}

export interface RecordRefundInput {
  /** Positive, in the customer's favour. Stored positive: a refund is a debit. */
  amount: string;
  /**
   * Which pool to draw from. Required, with no default, because the two
   * are different acts: returning an overpayment and releasing a
   * security deposit answer to different authority and different
   * triggers, and a default would quietly pick one.
   */
  source: CreditPool;
  tender?: "CARD" | "ACH" | "CASH" | "CHECK" | "LOCKBOX";
  /** Cheque number, ACH trace, card refund reference. */
  externalRef?: string;
  /** The day the money left. Defaults to today. */
  issuedOn?: string;
  memo?: string;
}

function err(code: string, message: string, statusCode: number): Error {
  return Object.assign(new Error(message), { code, statusCode });
}

/**
 * What is available to refund out of one pool, as a positive figure.
 *
 * Summed from the open entries rather than read from
 * `Account.balance`/`depositAmount`, for two reasons. The caches are
 * caches — a drifted one would authorise a refund the ledger cannot
 * back. And `balance` is a NET figure: an account with a $200 open
 * credit and a $500 unpaid bill has a balance of +$300 and nothing to
 * refund, while one with a $200 credit and no bill has -$200 and $200 to
 * give back. Only the open credits answer the question.
 */
export async function availableToRefund(
  tx: TxClient,
  utilityId: string,
  accountId: string,
  source: CreditPool,
): Promise<Prisma.Decimal> {
  const [agg] = await tx.$queryRaw<{ available: Prisma.Decimal | null }[]>`
    SELECT COALESCE(SUM(open_amount), 0) AS available
      FROM ledger_entry
     WHERE utility_id = ${utilityId}::uuid
       AND account_id = ${accountId}::uuid
       AND open_amount < 0
       AND ${source === "DEPOSIT" ? Prisma.sql`type = 'DEPOSIT'` : Prisma.sql`type <> 'DEPOSIT'`}`;
  // Stored negative because credits are negative; the caller thinks in
  // positive money.
  return new Prisma.Decimal(agg?.available ?? 0).negated();
}

export async function recordRefund(
  utilityId: string,
  actorId: string,
  actorName: string,
  accountId: string,
  input: RecordRefundInput,
  existingTx?: TxClient,
): Promise<RecordRefundResult> {
  const run = async (tx: TxClient): Promise<RecordRefundResult> => {
    // Proves the account is this tenant's before a row points at it, and
    // serialises against anything else changing these figures. It has to
    // precede the availability read: without it two refunds could each
    // see the same $200 credit and both pay it out.
    await lockAccount(tx, utilityId, accountId);

    const amount = new Prisma.Decimal(input.amount);
    if (!amount.isFinite() || amount.lte(0)) {
      throw err("REFUND_AMOUNT_INVALID", "A refund must be a positive amount", 400);
    }
    if (amount.decimalPlaces() > 2) {
      throw err("REFUND_AMOUNT_INVALID", "A refund must be a whole number of cents", 400);
    }

    const available = await availableToRefund(tx, utilityId, accountId, input.source);
    if (available.lte(0)) {
      throw err(
        "REFUND_NOTHING_AVAILABLE",
        input.source === "DEPOSIT"
          ? "This account holds no deposit to return"
          : "This account has no credit to refund",
        422,
      );
    }
    if (amount.gt(available)) {
      // Names the figure. Refunding the smaller amount silently would
      // leave the operator believing the customer was made whole.
      throw err(
        "REFUND_EXCEEDS_AVAILABLE",
        `Cannot refund ${amount.toFixed(2)}: only ${available.toFixed(2)} is available from ${
          input.source === "DEPOSIT" ? "the deposit held" : "the credit balance"
        }`,
        422,
      );
    }

    const entry = await tx.ledgerEntry.create({
      data: {
        utilityId,
        accountId,
        type: "REFUND",
        // Positive: a refund is a debit. See the note at the top.
        amount,
        openAmount: amount,
        // A refund is not owed BY the customer, so it cannot fall due.
        // Leaving this null also keeps it out of the aging index and the
        // delinquency sweep, which select on `open_amount > 0 AND
        // due_date IS NOT NULL` -- a refund awaiting allocation must not
        // look like arrears.
        dueDate: null,
        effectiveDate: new Date(input.issuedOn ?? new Date().toISOString().slice(0, 10)),
        tender: input.tender ?? null,
        externalRef: input.externalRef ?? null,
        memo:
          input.memo ??
          (input.source === "DEPOSIT" ? "Deposit returned" : "Credit balance refunded"),
        createdBy: actorId,
      },
    });

    // Discharge the credits this refund pays out, oldest first, from the
    // named pool only. Capped above, so this always consumes the refund
    // in full and leaves openAmount at 0 -- a refund with anything left
    // open would mean money sent with no credit behind it.
    const applied = await applyCreditsToDebit(tx, utilityId, accountId, entry.id, input.source);

    const settled = await tx.ledgerEntry.findUniqueOrThrow({
      where: { id: entry.id },
      select: { openAmount: true },
    });
    if (!settled.openAmount.isZero()) {
      // Unreachable given the cap, and asserted rather than trusted: the
      // alternative is a refund that paid out more than it discharged,
      // which shows up later as a balance nobody can explain.
      throw err(
        "REFUND_NOT_FULLY_BACKED",
        `Refund ${entry.id} left ${settled.openAmount.toFixed(2)} unbacked`,
        500,
      );
    }

    const cache = await recomputeAccountCache(tx, utilityId, accountId);
    return {
      entryId: entry.id,
      amount: amount.toFixed(2),
      source: input.source,
      balance: cache.balance,
      depositAmount: cache.depositAmount,
      applied,
    };
  };

  const runWithAudit = async (tx: TxClient): Promise<RecordRefundResult> => {
    const result = await run(tx);
    await writeAuditRow(
      tx,
      { utilityId, actorId, actorName, entityType: "LedgerEntry" },
      EVENT_TYPES.LEDGER_REFUND_ISSUED,
      result.entryId,
      null,
      {
        accountId,
        amount: result.amount,
        source: result.source,
        tender: input.tender ?? null,
        externalRef: input.externalRef ?? null,
      },
    );
    return result;
  };

  return existingTx
    ? runWithAudit(existingTx)
    : prisma.$transaction((tx) => runWithAudit(tx as TxClient));
}
