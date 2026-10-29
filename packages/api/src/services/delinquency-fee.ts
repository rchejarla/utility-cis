import { Prisma } from "@utility-cis/shared/src/generated/prisma";
import { roundToCents } from "@utility-cis/shared";
import { lockAccount, type TxClient } from "./ar/posting.service.js";

/**
 * What a delinquency tier charges, and on what.
 *
 * One ladder per unpaid bill. The account-level clock was the defect it
 * replaces: `days_past_due` comes from the oldest open debit, so a bill
 * posted last week was charged a late fee because an older one had
 * reached 40 days, and a percentage tier took its rate against the whole
 * balance — money the customer had not yet been asked to pay.
 *
 * Kept out of `delinquency.service.ts` because it is the one question
 * here with an arithmetic answer; the sweep around it is about which
 * accounts and which tiers.
 */

export interface TierFee {
  feeType: "FLAT_FEE" | "PERCENT_OF_BALANCE";
  /** An amount of money under FLAT_FEE; a rate under PERCENT_OF_BALANCE. */
  feeAmount: Prisma.Decimal;
  maxFee: Prisma.Decimal | null;
}

/** An unpaid bill a tier may charge on. */
export interface ChargeableDebit {
  id: string;
  openAmount: Prisma.Decimal;
  daysPastDue: number;
}

/**
 * The account's unpaid debits that have come due, oldest first, with
 * each one's own age.
 *
 * **Penalties are excluded**, which is the work `isPenalty` now does:
 * not deciding what an account-wide base sums, but deciding which bills
 * may be charged on at all. An unpaid tap fee is money owed for work
 * actually done and a late fee applies to it; an unpaid late fee is not,
 * and charging one on it compounds. `DEPOSIT` is excluded for the reason
 * `recomputeAccountCache` excludes it from the balance: a deposit is
 * money the utility holds, not money the customer owes.
 *
 * **A debt covered by a live payment plan is excluded.** Charging a late
 * fee on a debt the utility agreed to wait for is the thing a plan
 * exists to stop.
 *
 * The predicate joins through to `payment_plan` and reads its status; it
 * does **not** test membership of `payment_plan_debit`. Those rows
 * survive the plan — they are history, and the key is RESTRICT — so a
 * `NOT EXISTS` over the join table alone would suppress a debt forever,
 * including after default, *and would pass every test written while the
 * plan is still running*. Only `ACTIVE` suppresses: a DEFAULTED plan
 * must expose its debts, which is the whole of what defaulting does,
 * and a COMPLETED one has no open debits left to suppress.
 *
 * `suppress_fees_while_kept` is read from the plan row rather than from
 * `resolvePlanTerms`, because the term was frozen when the customer
 * agreed it. A tenant turning suppression off next month must not
 * thereby start charging fees on plans agreed under the old policy.
 *
 * **Locks the account** first, so the figures a fee is computed from are
 * the figures that are still true when it is written. Re-locking inside
 * `assessFee` afterwards costs nothing.
 */
export async function chargeableDebits(
  tx: TxClient,
  utilityId: string,
  accountId: string,
  now: Date,
): Promise<ChargeableDebit[]> {
  await lockAccount(tx, utilityId, accountId);

  const rows = await tx.$queryRaw<
    Array<{ id: string; open_amount: Prisma.Decimal; days_past_due: number }>
  >`
    SELECT e.id,
           e.open_amount,
           FLOOR(EXTRACT(EPOCH FROM (${now}::timestamptz - e.due_date::timestamptz)) / 86400)::int
             AS days_past_due
      FROM ledger_entry e
      LEFT JOIN ledger_reason_def r
        ON r.id = e.reason_id AND r.utility_id = e.utility_id
     WHERE e.utility_id = ${utilityId}::uuid
       AND e.account_id = ${accountId}::uuid
       AND e.open_amount > 0
       AND e.due_date IS NOT NULL
       AND e.due_date < ${now}::timestamptz
       AND e.type <> 'DEPOSIT'
       AND COALESCE(r.is_penalty, false) = false
       AND NOT EXISTS (
         SELECT 1
           FROM payment_plan_debit pd
           JOIN payment_plan p
             ON p.utility_id = pd.utility_id AND p.id = pd.plan_id
          WHERE pd.utility_id = e.utility_id
            AND pd.entry_id = e.id
            AND p.status = 'ACTIVE'
            AND p.suppress_fees_while_kept
       )
     ORDER BY e.due_date ASC, e.id ASC`;

  return rows.map((row) => ({
    id: row.id,
    openAmount: new Prisma.Decimal(row.open_amount),
    daysPastDue: Number(row.days_past_due),
  }));
}

/**
 * What this tier charges on one bill, as a 2dp string, or null when
 * there is nothing to charge.
 *
 * Null rather than "0.00" because the two are different events and the
 * caller treats them differently: the tier still happened and the notice
 * is still owed, there was simply nothing to bill. A zero entry would
 * also fail the ledger's `amount <> 0` CHECK, which is the right
 * constraint — a zero receivable is not a thing that can be paid.
 *
 * A percentage is taken against the bill's own open amount, so a
 * part-paid bill is charged on what is left of it. The cap applies per
 * bill, because the fee does.
 */
export function tierFeeAmount(rule: TierFee, debit: ChargeableDebit): string | null {
  const gross =
    rule.feeType === "FLAT_FEE"
      ? roundToCents(rule.feeAmount.toFixed(4))
      : // Six decimals is exact rather than a guess: a 2dp open amount
        // times a 4dp rate cannot produce more, so nothing is lost
        // before the half-up.
        roundToCents(debit.openAmount.mul(rule.feeAmount).toFixed(6));

  const amount =
    rule.maxFee && new Prisma.Decimal(gross).gt(rule.maxFee) ? rule.maxFee.toFixed(2) : gross;

  return amount === "0.00" ? null : amount;
}
