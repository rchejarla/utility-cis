import { Prisma } from "@utility-cis/shared/src/generated/prisma";
import { roundToCents } from "@utility-cis/shared";
import { lockAccount, type TxClient } from "./ar/posting.service.js";

/**
 * How much a delinquency tier charges.
 *
 * Kept out of `delinquency.service.ts` because it is the one question
 * here with an arithmetic answer, and the sweep around it is about
 * which accounts and which tiers.
 */

export interface TierFee {
  feeType: "FLAT_FEE" | "PERCENT_OF_BALANCE";
  /** An amount of money under FLAT_FEE; a rate under PERCENT_OF_BALANCE. */
  feeAmount: Prisma.Decimal;
  maxFee: Prisma.Decimal | null;
}

/**
 * What the account owes in principal — the base a percentage late fee
 * is charged on.
 *
 * Entries whose reason is a penalty are excluded and nothing else is.
 * Excluding every `FEE` would stop a late fee applying to an unpaid tap
 * fee, which is money owed for work actually done; including penalties
 * charges 1.5% of the previous tier's own late fee. `isPenalty` is the
 * only thing that separates those, and it cannot be a list of codes,
 * because reasons are tenant-configurable.
 *
 * `DEPOSIT` is excluded for the reason `recomputeAccountCache` excludes
 * it: a deposit is money the utility holds, not money the customer
 * owes. Open credits are included and reduce the base — money the
 * customer has handed over is debt they no longer have, and charging a
 * percentage on it would charge them for a debt they have paid.
 *
 * Clamped at zero, so an account in credit is charged nothing rather
 * than issued a negative fee.
 */
export async function penaltyBase(
  tx: TxClient,
  utilityId: string,
  accountId: string,
): Promise<Prisma.Decimal> {
  const [row] = await tx.$queryRaw<{ base: Prisma.Decimal | null }[]>`
    SELECT COALESCE(SUM(e.open_amount), 0) AS base
      FROM ledger_entry e
      LEFT JOIN ledger_reason_def r
        ON r.id = e.reason_id AND r.utility_id = e.utility_id
     WHERE e.utility_id = ${utilityId}::uuid
       AND e.account_id = ${accountId}::uuid
       AND e.type <> 'DEPOSIT'
       AND COALESCE(r.is_penalty, false) = false`;

  const base = new Prisma.Decimal(row?.base ?? 0);
  return base.isNegative() ? new Prisma.Decimal(0) : base;
}

/**
 * The fee this tier charges, as a 2dp string, or null when there is
 * nothing to charge.
 *
 * Null rather than "0.00" because the two are different events and the
 * caller treats them differently: the tier still happened and the
 * notice is still owed, there was simply nothing to bill. A zero entry
 * would also fail the ledger's `amount <> 0` CHECK, which is the right
 * constraint — a zero receivable is not a thing that can be paid.
 *
 * **Locks the account** before reading the base, so the figure the fee
 * is computed from is the figure that is still true when it is written.
 * Re-locking inside `assessFee` afterwards costs nothing.
 */
export async function tierFeeAmount(
  tx: TxClient,
  utilityId: string,
  accountId: string,
  rule: TierFee,
): Promise<string | null> {
  if (rule.feeType === "FLAT_FEE") {
    const flat = roundToCents(rule.feeAmount.toFixed(4));
    return flat === "0.00" ? null : flat;
  }

  await lockAccount(tx, utilityId, accountId);
  const base = await penaltyBase(tx, utilityId, accountId);

  // Six decimals is exact rather than a guess: a 2dp base times a 4dp
  // rate cannot produce more, so nothing is lost before the half-up.
  const computed = roundToCents(base.mul(rule.feeAmount).toFixed(6));
  const amount =
    rule.maxFee && new Prisma.Decimal(computed).gt(rule.maxFee)
      ? rule.maxFee.toFixed(2)
      : computed;

  return amount === "0.00" ? null : amount;
}
