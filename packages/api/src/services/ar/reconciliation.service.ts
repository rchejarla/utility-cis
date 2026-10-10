import { withTenant } from "../../lib/prisma.js";

/**
 * Proof that Account.balance equals the ledger.
 *
 * The cache is written only inside posting transactions, never by a
 * background job, so it should never drift. "Should never" is not
 * evidence — this query is the evidence, and it runs both as an
 * integration test and as an admin endpoint.
 *
 * Runs inside withTenant so app.current_utility_id is set on the same
 * connection. Without it, once RLS is enforced for the connecting role
 * every account row would be filtered out and this check would report
 * "no drift" because it could see nothing.
 */

export interface BalanceDrift {
  accountId: string;
  accountNumber: string;
  cached: string;
  ledger: string;
  /**
   * Which cache disagreed.
   *
   * There are two now. `balance` is the receivable, every open entry bar
   * a deposit; `deposit` is what the utility holds. They are deliberately
   * not one number -- a deposit is a liability, not a negative
   * receivable -- so a check that proved only the first would let the
   * second drift silently, and the second is the one holding $3,000.
   */
  field: "balance" | "deposit";
}

export interface ReconciliationReport {
  /**
   * How many accounts the query examined.
   *
   * This is what makes an empty `drift` mean something. The failure mode
   * in the note above — tenant context missing, every account row
   * filtered away — produces no drift rows, which is indistinguishable
   * from a clean ledger unless you also know how many rows were looked
   * at. `checked: 0` on a tenant that has accounts says the check proved
   * nothing; it does not say the books balance.
   */
  checked: number;
  drift: BalanceDrift[];
}

export async function reconcileBalances(utilityId: string): Promise<ReconciliationReport> {
  // Both statements go inside one withTenant so they run on the same
  // connection under the same app.current_utility_id. A count fetched on
  // a different connection could be scoped differently from the drift
  // query, which would make `checked` reassure about a population the
  // drift query never saw.
  return withTenant(utilityId, async (tx) => {
    const rows = await tx.$queryRaw<
      { account_id: string; account_number: string; cached: string; ledger: string; field: string }[]
    >`
      WITH per_account AS (
        SELECT a.id,
               a.account_number,
               a.balance,
               a.deposit_amount,
               COALESCE(SUM(e.open_amount) FILTER (WHERE e.type <> 'DEPOSIT'), 0) AS ledger_balance,
               -- Negated: the entries are credits, the column is held
               -- positive, so they agree only after a sign flip.
               -COALESCE(SUM(e.open_amount) FILTER (WHERE e.type = 'DEPOSIT'), 0) AS ledger_deposit
          FROM account a
          LEFT JOIN ledger_entry e
                 ON e.account_id = a.id AND e.utility_id = a.utility_id
         WHERE a.utility_id = ${utilityId}::uuid
         GROUP BY a.id, a.account_number, a.balance, a.deposit_amount
      )
      SELECT id AS account_id, account_number,
             balance::text AS cached, ledger_balance::text AS ledger,
             'balance' AS field
        FROM per_account WHERE balance <> ledger_balance
      UNION ALL
      SELECT id, account_number,
             deposit_amount::text, ledger_deposit::text,
             'deposit'
        FROM per_account WHERE deposit_amount <> ledger_deposit
       ORDER BY account_number, field`;

    const [counted] = await tx.$queryRaw<{ checked: bigint }[]>`
      SELECT COUNT(*) AS checked
        FROM account
       WHERE utility_id = ${utilityId}::uuid`;

    return {
      // COUNT() comes back as bigint, which JSON.stringify refuses to
      // serialise. Narrow it here rather than at the route.
      checked: Number(counted?.checked ?? 0),
      drift: rows.map((r) => ({
        accountId: r.account_id,
        accountNumber: r.account_number,
        cached: Number(r.cached).toFixed(2),
        ledger: Number(r.ledger).toFixed(2),
        field: r.field as "balance" | "deposit",
      })),
    };
  });
}
