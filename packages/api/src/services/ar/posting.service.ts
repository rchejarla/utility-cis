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
 *
 * **Locks the account row** (FOR UPDATE) before summing, and throws
 * ACCOUNT_NOT_FOUND if the row does not belong to this tenant. The lock
 * belongs here rather than in the callers: this function is the
 * read-then-write that needs it, so every caller gets it by
 * construction instead of having to remember an invariant documented
 * somewhere else.
 */
export async function recomputeAccountCache(
  tx: TxClient,
  utilityId: string,
  accountId: string,
): Promise<{ balance: string; lastDueDate: Date | null }> {
  // Asserting a row came back matters twice over: SELECT ... FOR UPDATE
  // takes no lock at all when it matches nothing, and proving the row is
  // this tenant's is what makes the `tx.account.update` below safe —
  // Prisma's `where: { id }` carries no utilityId, and RLS does not
  // currently enforce because the application role is a superuser.
  const locked = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM account
     WHERE id = ${accountId}::uuid AND utility_id = ${utilityId}::uuid
       FOR UPDATE`;
  if (locked.length === 0) {
    throw err("ACCOUNT_NOT_FOUND", `Account ${accountId} not found`, 404);
  }

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
 * Idempotency: the bill is claimed with an atomic
 * UPDATE ... WHERE posted_at IS NULL, under a row lock on the account.
 * A second attempt throws BILL_ALREADY_POSTED (409). The partial unique
 * index on (utility_id, bill_id) WHERE type = 'BILL_CHARGE' is a backstop.
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
    // Find the account, then lock it BEFORE writing anything. Recomputing
    // the cache is a read-then-write of SUM(open_amount); without a
    // per-account lock, two concurrent posts on one account each miss the
    // other's uncommitted entry and the later update overwrites with a
    // stale sum.
    //
    // recomputeAccountCache takes this same lock before its SUM, and
    // either lock alone is enough to prevent the stale sum. Keeping this
    // one is still deliberate: it fixes the lock order as
    // account-then-bill for every posting path, so a later caller that
    // locks in the other order cannot deadlock against this one.
    // Re-locking a row this transaction already holds costs nothing.
    // Do not delete either as redundant.
    //
    // What this lock does NOT do: it is not what guards against a double
    // post. That is the atomic claim below — UPDATE ... WHERE posted_at
    // IS NULL plus the claimed.count check. With both account locks
    // removed, the double-post test still passes.
    const owner = await tx.bill.findUnique({
      where: { id: billId, utilityId },
      select: { accountId: true },
    });
    if (!owner) throw err("BILL_NOT_FOUND", `Bill ${billId} not found`, 404);
    await tx.$queryRaw`SELECT id FROM account
                        WHERE id = ${owner.accountId}::uuid AND utility_id = ${utilityId}::uuid
                          FOR UPDATE`;

    // Re-read now that the lock is held, so total and dueDate are the
    // values as of acquiring it rather than as of the queue. This is not
    // the double-post guard — the claim below is.
    const bill = await tx.bill.findUnique({
      where: { id: billId, utilityId },
      select: { id: true, accountId: true, total: true, dueDate: true, billDate: true },
    });
    if (!bill) throw err("BILL_NOT_FOUND", `Bill ${billId} not found`, 404);

    // Claim the bill atomically rather than check-then-write: the credit
    // path has no unique-index backstop, so this is its only double-post guard.
    const claimed = await tx.bill.updateMany({
      where: { id: billId, utilityId, postedAt: null },
      data: { postedAt: new Date() },
    });
    if (claimed.count === 0) {
      throw err("BILL_ALREADY_POSTED", `Bill ${billId} was already posted`, 409);
    }

    const amount = roundToCents(bill.total.toString());
    const effectiveDate = new Date(input.effectiveDate ?? bill.billDate.toISOString().slice(0, 10));

    if (amount === "0.00") {
      const cache = await recomputeAccountCache(tx, utilityId, bill.accountId);
      return { billId, entryId: null, amount, balance: cache.balance, skippedZero: true };
    }

    // A bill that nets negative is a credit, not a debit with a negative
    // amount — keeps the type/sign constraint true and reads as what it is.
    const isCredit = amount.startsWith("-");
    // Every debit must carry a due date: the aging/allocation partial index
    // requires one, so a debit without it would be invisible to both.
    if (!isCredit && !bill.dueDate) {
      throw err("BILL_MISSING_DUE_DATE", `Bill ${billId} has no due date`, 422);
    }

    // Spec §6.1 step 4 — auto-applying this account's open credits
    // against a new debit — is deliberately slice 2, along with every
    // other LedgerApplication write. The balance is right either way:
    // it is SUM(open_amount) and an unapplied credit still sums into it.
    // Only the open-item detail is left unsettled.
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
        // Both sides carry the bill. Nothing stops a credit from naming
        // it — the type/sign CHECK constrains the amount, and the partial
        // unique index covers BILL_CHARGE rows only — and the link is
        // what lets a rebill find the entry to correct and the FK refuse
        // to delete a bill that produced one.
        billId: bill.id,
        createdBy: actorId,
        memo: isCredit ? `Net credit from bill ${billId}` : null,
      },
    });

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
        EVENT_TYPES.LEDGER_ENTRY_CREATED,
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

/**
 * Resolve whether a Bill posts automatically on generation.
 *
 * Tenant default, overridable per account. `??` not `||`, so an account
 * override of `false` beats a tenant default of `true` — which is the
 * entire point of having an override. Null on the account means inherit,
 * so flipping the tenant setting moves every account that has not
 * explicitly opted out.
 *
 * No tenant_config row means an unconfigured tenant, which takes the
 * column default: auto-post on.
 */
export async function resolveAutoPostBills(
  tx: TxClient,
  utilityId: string,
  accountId: string,
): Promise<boolean> {
  const [account, config] = await Promise.all([
    // findFirst, not findUnique: the lookup has to carry utilityId, so a
    // cross-tenant account id resolves to nothing rather than to its own
    // tenant's setting.
    tx.account.findFirst({ where: { id: accountId, utilityId }, select: { autoPostBills: true } }),
    tx.tenantConfig.findUnique({ where: { utilityId }, select: { autoPostBills: true } }),
  ]);
  return account?.autoPostBills ?? config?.autoPostBills ?? true;
}
