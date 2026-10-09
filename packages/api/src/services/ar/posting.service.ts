import { Prisma } from "@utility-cis/shared/src/generated/prisma";
import { prisma } from "../../lib/prisma.js";
import { writeAuditRow } from "../../lib/audit-wrap.js";
import { EVENT_TYPES, roundToCents } from "@utility-cis/shared";

type TxClient = Omit<
  typeof prisma,
  "$connect" | "$disconnect" | "$on" | "$transaction" | "$use" | "$extends"
>;

/**
 * AR posting — turning an issued Bill into a receivable.
 *
 * One LedgerEntry per Bill (not per segment or line): see spec §3.1.
 * The entry's amount is a snapshot, deliberately copied rather than
 * derived, because rebills will change bill totals and a receivable
 * must be frozen at posting (§3.2).
 *
 * Posting and the Account.balance update happen in ONE transaction.
 * No event, no queue — an async balance update would reopen exactly
 * the atomicity gap the EventEmitter audit pipeline had.
 */

export interface PostBillResult {
  billId: string;
  entryId: string | null;
  amount: string;
  balance: string;
  skippedZero: boolean;
}

function err(code: string, message: string, statusCode: number): Error {
  return Object.assign(new Error(message), { code, statusCode });
}

/**
 * Recompute the cached Account.balance and lastDueDate from the ledger.
 *
 * balance is SUM(open_amount) — a plain sum, because both amount and
 * openAmount are signed. lastDueDate is the oldest open debit's due
 * date, and clears to null when nothing is open, so the delinquency
 * sweep stops seeing an account that owes nothing.
 */
export async function recomputeAccountCache(
  tx: TxClient,
  utilityId: string,
  accountId: string,
): Promise<{ balance: string; lastDueDate: Date | null }> {
  const [agg] = await tx.$queryRaw<{ balance: Prisma.Decimal | null }[]>`
    SELECT COALESCE(SUM(open_amount), 0) AS balance
      FROM ledger_entry
     WHERE utility_id = ${utilityId}::uuid AND account_id = ${accountId}::uuid`;
  const balance = new Prisma.Decimal(agg?.balance ?? 0).toFixed(2);

  const [oldest] = await tx.$queryRaw<{ due_date: Date | null }[]>`
    SELECT due_date
      FROM ledger_entry
     WHERE utility_id = ${utilityId}::uuid AND account_id = ${accountId}::uuid
       AND open_amount > 0 AND due_date IS NOT NULL
     ORDER BY due_date ASC
     LIMIT 1`;
  const lastDueDate = oldest?.due_date ?? null;

  await tx.account.update({
    where: { id: accountId },
    data: { balance, lastDueDate },
  });
  return { balance, lastDueDate };
}

/**
 * Post an issued Bill to the ledger.
 *
 * Idempotency is structural: a partial unique index on
 * (utility_id, bill_id) WHERE type = 'BILL_CHARGE'. A second attempt
 * raises P2002, which the route maps to 409.
 *
 * A bill whose total rounds to 0.00 is marked posted and writes no
 * entry — CHECK (amount <> 0) would reject it, and a zero receivable
 * is not a thing that can be paid. The spec is silent here; this is
 * the decision.
 */
export async function postBill(
  utilityId: string,
  actorId: string,
  actorName: string,
  billId: string,
  input: { effectiveDate?: string } = {},
  existingTx?: TxClient,
): Promise<PostBillResult> {
  const run = async (tx: TxClient): Promise<PostBillResult> => {
    const bill = await tx.bill.findUnique({
      where: { id: billId, utilityId },
      select: { id: true, accountId: true, total: true, dueDate: true, billDate: true, postedAt: true },
    });
    if (!bill) throw err("BILL_NOT_FOUND", `Bill ${billId} not found`, 404);
    if (bill.postedAt) {
      throw err("BILL_ALREADY_POSTED", `Bill ${billId} was already posted`, 409);
    }

    const amount = roundToCents(bill.total.toString());
    const effectiveDate = new Date(input.effectiveDate ?? bill.billDate.toISOString().slice(0, 10));

    if (amount === "0.00") {
      await tx.bill.update({ where: { id: billId }, data: { postedAt: new Date() } });
      const cache = await recomputeAccountCache(tx, utilityId, bill.accountId);
      return { billId, entryId: null, amount, balance: cache.balance, skippedZero: true };
    }

    // A bill that nets negative is a credit, not a debit with a negative
    // amount — keeps the type/sign constraint true and reads as what it is.
    const isCredit = amount.startsWith("-");

    const entry = await tx.ledgerEntry.create({
      data: {
        utilityId,
        accountId: bill.accountId,
        type: isCredit ? "ADJUSTMENT_CREDIT" : "BILL_CHARGE",
        amount,
        openAmount: amount,
        // Only a debit ages; a credit has nothing to fall due.
        dueDate: isCredit ? null : bill.dueDate,
        effectiveDate,
        billId: isCredit ? null : bill.id,
        createdBy: actorId,
        memo: isCredit ? `Net credit from bill ${billId}` : null,
      },
    });

    await tx.bill.update({ where: { id: billId }, data: { postedAt: new Date() } });
    const cache = await recomputeAccountCache(tx, utilityId, bill.accountId);

    return { billId, entryId: entry.id, amount, balance: cache.balance, skippedZero: false };
  };

  // `auditCreate` requires an entity with an id to audit; the
  // zero-amount path produces none, so use the lower-level
  // `writeAuditRow` and emit only when an entry was actually written.
  const runWithAudit = async (tx: TxClient): Promise<PostBillResult> => {
    const result = await run(tx);
    if (result.entryId) {
      await writeAuditRow(
        tx,
        { utilityId, actorId, actorName, entityType: "LedgerEntry" },
        EVENT_TYPES.LEDGER_ENTRY_POSTED,
        result.entryId,
        null,
        result,
      );
    }
    return result;
  };

  if (existingTx) return runWithAudit(existingTx);
  return prisma.$transaction(runWithAudit);
}

export type { TxClient };
