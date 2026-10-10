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
      { account_id: string; account_number: string; cached: string; ledger: string }[]
    >`
      SELECT a.id            AS account_id,
             a.account_number,
             a.balance::text AS cached,
             COALESCE(SUM(e.open_amount), 0)::text AS ledger
        FROM account a
        LEFT JOIN ledger_entry e
               ON e.account_id = a.id AND e.utility_id = a.utility_id
       WHERE a.utility_id = ${utilityId}::uuid
       GROUP BY a.id, a.account_number, a.balance
      HAVING a.balance <> COALESCE(SUM(e.open_amount), 0)
       ORDER BY a.account_number`;

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
      })),
    };
  });
}
