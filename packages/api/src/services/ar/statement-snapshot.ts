import { Prisma } from "@utility-cis/shared/src/generated/prisma";
import type { TxClient } from "./posting.service.js";

/**
 * Where the account stood when a bill was issued.
 *
 * Frozen onto the bill at posting, because one of the three figures
 * cannot be recomputed later — see `past_due_amount` below. Design:
 * `docs/superpowers/specs/2026-10-26-bill-statement-layout-design.md`.
 *
 * Computed **before** the bill's own charge is written, which is what
 * makes "previous" and "past due" mean what they say: the account as the
 * bill was issued, not as the bill left it.
 */
export interface StatementSnapshot {
  /**
   * Owed as of the previous bill's date, or zero when there is none.
   *
   * A plain `SUM(amount)`: an allocation moves value between a debit and
   * a credit without changing the sum, so a balance needs no allocation
   * history. May be **negative** — an account in credit at the last bill
   * carried that credit forward, and clamping it would overstate what is
   * owed.
   */
  previousBalance: Prisma.Decimal;
  /**
   * Every credit between the two bill dates, as a positive figure.
   *
   * Payments, waivers, write-offs and credit adjustments alike: the
   * layout subtracts this from the previous balance, and all of them
   * reduce what is owed. Hence "payments and credits" on the page rather
   * than "payments" — a waiver is not a payment and still belongs here.
   */
  paymentsSince: Prisma.Decimal;
  /**
   * Of what is owed, how much was already due on the bill date.
   *
   * **The figure that forces the snapshot.** It reads `open_amount`,
   * which is allocation state: a debit fully paid is not past due. The
   * allocation-free shortcut — balance less the not-yet-due debits —
   * is wrong as soon as a credit lands on something not yet due, and
   * `reverseEntry` deletes the `ledger_application` rows it undoes, so a
   * reconstruction after a reversal cannot see the allocation at all.
   *
   * Exact here because posting happens while that state is current. It
   * is therefore "as at posting", which for a bill posted promptly is
   * also as at the bill date.
   */
  pastDueAmount: Prisma.Decimal;
}

/**
 * `DEPOSIT` is excluded throughout, for the reason
 * `recomputeAccountCache` excludes it from the balance: money the
 * utility holds is not money the customer owes.
 *
 * The previous bill is the account's most recent one dated strictly
 * earlier, which is the same rule the fees window opens on — so the two
 * halves of the page cannot disagree about where the period began. With
 * no previous bill every figure opens at the account's beginning, and
 * `previousBalance` is zero because nothing was carried.
 */
export async function billStatementSnapshot(
  tx: TxClient,
  utilityId: string,
  accountId: string,
  billId: string,
  billDate: Date,
): Promise<StatementSnapshot> {
  const [row] = await tx.$queryRaw<
    Array<{
      previous_balance: Prisma.Decimal;
      payments_since: Prisma.Decimal;
      past_due_amount: Prisma.Decimal;
    }>
  >`
    WITH prev AS (
      SELECT b.bill_date
        FROM bill b
       WHERE b.utility_id = ${utilityId}::uuid
         AND b.account_id = ${accountId}::uuid
         AND b.bill_date < ${billDate}::date
         AND b.id <> ${billId}::uuid
       ORDER BY b.bill_date DESC, b.bill_number DESC
       LIMIT 1
    )
    SELECT
      COALESCE((
        SELECT SUM(e.amount) FROM ledger_entry e
         WHERE e.utility_id = ${utilityId}::uuid
           AND e.account_id = ${accountId}::uuid
           AND e.type <> 'DEPOSIT'
           AND e.effective_date <= (SELECT bill_date FROM prev)
      ), 0) AS previous_balance,
      COALESCE((
        SELECT -SUM(e.amount) FROM ledger_entry e
         WHERE e.utility_id = ${utilityId}::uuid
           AND e.account_id = ${accountId}::uuid
           AND e.type <> 'DEPOSIT'
           AND e.amount < 0
           AND e.effective_date <= ${billDate}::date
           AND (
             NOT EXISTS (SELECT 1 FROM prev)
             OR e.effective_date > (SELECT bill_date FROM prev)
           )
      ), 0) AS payments_since,
      COALESCE((
        SELECT SUM(e.open_amount) FROM ledger_entry e
         WHERE e.utility_id = ${utilityId}::uuid
           AND e.account_id = ${accountId}::uuid
           AND e.type <> 'DEPOSIT'
           AND e.amount > 0
           AND e.due_date IS NOT NULL
           AND e.due_date <= ${billDate}::date
      ), 0) AS past_due_amount`;

  return {
    previousBalance: new Prisma.Decimal(row.previous_balance),
    paymentsSince: new Prisma.Decimal(row.payments_since),
    pastDueAmount: new Prisma.Decimal(row.past_due_amount),
  };
}
