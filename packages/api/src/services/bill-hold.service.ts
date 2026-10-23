import { prisma } from "../lib/prisma.js";
import { auditUpdate } from "../lib/audit-wrap.js";
import { EVENT_TYPES } from "@utility-cis/shared";

/**
 * Holding a bill — Bozeman #136, "bill holds for individual accounts or
 * events".
 *
 * A held bill cannot be posted and cannot be delivered. It still exists,
 * still carries its lines and its total; nothing further happens to it
 * until somebody releases it. It is not a cancellation, not a reversal,
 * and not a reason to skip calculating — an account on hold is still
 * billed, because a period that goes unbilled rolls up into the next one
 * and bills twenty-one months at once.
 *
 * Both gates rather than delivery alone, because posting is the
 * irreversible step: a wrong charge is undone by a reversal on the
 * ledger in full view, never by an edit. A hold that stopped only
 * delivery would let the bill somebody is unsure about become money
 * owed, move the balance, and reach the portal and delinquency while
 * they were still looking at it.
 *
 * The enforcement is not here. `postBill` and `deliverBill` each refuse
 * a held bill, because they are the two chokepoints every path goes
 * through — a run, an auto-post and a manual post all reach the same
 * `postBill`. This module is about placing and lifting.
 *
 * Both actions are `accounts:EDIT`. Placing is conservative and
 * releasing is the consequential direction, which argued for splitting
 * them; the simpler rule was chosen deliberately, and who did which is
 * on the audit log either way.
 */

export interface HeldBillRow {
  id: string;
  billNumber: string;
  accountNumber: string;
  holdReason: string;
  /** True when the account's standing rule is what holds it, not the bill. */
  heldByAccount: boolean;
  total: string;
  billDate: Date;
}

function refuse(code: string, statusCode: number, message: string): never {
  throw Object.assign(new Error(message), { statusCode, code });
}

/** A reason is required: a hold nobody can explain is one nobody can clear. */
function requireReason(reason: string): string {
  const trimmed = reason?.trim() ?? "";
  if (trimmed.length === 0) {
    refuse(
      "HOLD_REASON_REQUIRED",
      400,
      "A hold needs a reason. Whoever finds this bill next has to know why it stopped.",
    );
  }
  return trimmed;
}

/** Stop one bill. */
export async function holdBill(
  utilityId: string,
  actorId: string,
  actorName: string,
  billId: string,
  reason: string,
): Promise<void> {
  const why = requireReason(reason);
  const bill = await prisma.bill.findFirst({
    where: { id: billId, utilityId },
  });
  if (!bill) refuse("BILL_NOT_FOUND", 404, `Bill ${billId} not found`);

  /*
   * Holding an already-posted bill is allowed and useful: the charge is
   * made, and what the hold still stops is delivery. A dispute usually
   * arrives after posting.
   */
  await auditUpdate(
    { utilityId, actorId, actorName, entityType: "Bill" },
    EVENT_TYPES.BILL_HELD,
    bill,
    async (tx) => tx.bill.update({ where: { id: billId }, data: { holdReason: why } }),
  );
}

/** Let one bill go. */
export async function releaseBill(
  utilityId: string,
  actorId: string,
  actorName: string,
  billId: string,
): Promise<void> {
  const bill = await prisma.bill.findFirst({ where: { id: billId, utilityId } });
  if (!bill) refuse("BILL_NOT_FOUND", 404, `Bill ${billId} not found`);
  if (!bill.holdReason) {
    refuse("BILL_NOT_HELD", 409, `Bill ${bill.billNumber} is not on hold.`);
  }

  // No reason needed to release: the audit row records who and when, and
  // "it is fine now" adds nothing to it.
  await auditUpdate(
    { utilityId, actorId, actorName, entityType: "Bill" },
    EVENT_TYPES.BILL_RELEASED,
    bill,
    async (tx) => tx.bill.update({ where: { id: billId }, data: { holdReason: null } }),
  );
}

/**
 * A standing hold on the account.
 *
 * The rule, as against a bill's own state. It has to reach bills that do
 * not exist yet — move-out pending a final read, a bankruptcy, a legal
 * hold — which is exactly what a per-bill hold cannot express.
 *
 * Nothing is stamped onto the bills. `postBill` and `deliverBill` read
 * the account's reason alongside the bill's, so lifting the rule frees
 * everything it was holding at once, with nothing to reconcile. The
 * first version of this copied the reason onto each unposted bill and
 * released by matching that string back — which breaks the moment
 * somebody edits the reason, and was doing by convention what a join
 * does by construction.
 */
export async function holdAccountBilling(
  utilityId: string,
  actorId: string,
  actorName: string,
  accountId: string,
  reason: string,
): Promise<{ billsAffected: number }> {
  const why = requireReason(reason);
  const account = await prisma.account.findFirst({ where: { id: accountId, utilityId } });
  if (!account) refuse("ACCOUNT_NOT_FOUND", 404, `Account ${accountId} not found`);

  await auditUpdate(
    { utilityId, actorId, actorName, entityType: "Account" },
    EVENT_TYPES.ACCOUNT_BILLING_HELD,
    account,
    async (tx) =>
      tx.account.update({ where: { id: accountId }, data: { billingHoldReason: why } }),
  );

  // A read, for the operator's benefit — "3 bills are now held" — not a
  // write. Nothing was stamped.
  return {
    billsAffected: await prisma.bill.count({
      where: { utilityId, accountId, postedAt: null },
    }),
  };
}

/**
 * Lift an account's standing hold.
 *
 * One column, and every bill it was holding is free — there is nothing
 * to reconcile, because nothing was copied. A bill held on its own terms
 * keeps its own reason and stays held, by construction rather than by
 * matching strings: releasing an account was never a decision about that
 * bill.
 */
export async function releaseAccountBilling(
  utilityId: string,
  actorId: string,
  actorName: string,
  accountId: string,
): Promise<{ billsAffected: number }> {
  const account = await prisma.account.findFirst({ where: { id: accountId, utilityId } });
  if (!account) refuse("ACCOUNT_NOT_FOUND", 404, `Account ${accountId} not found`);
  if (!account.billingHoldReason) {
    refuse("ACCOUNT_NOT_HELD", 409, `Account ${account.accountNumber} is not on billing hold.`);
  }

  await auditUpdate(
    { utilityId, actorId, actorName, entityType: "Account" },
    EVENT_TYPES.ACCOUNT_BILLING_RELEASED,
    account,
    async (tx) =>
      tx.account.update({ where: { id: accountId }, data: { billingHoldReason: null } }),
  );

  return {
    billsAffected: await prisma.bill.count({
      where: { utilityId, accountId, postedAt: null, holdReason: null },
    }),
  };
}

/**
 * Every held bill — by its own reason, or by its account's rule.
 *
 * The OR is the whole point of not stamping: one query answers "what is
 * held" without the two ever having to agree about a copy.
 */
export async function listHeldBills(utilityId: string): Promise<HeldBillRow[]> {
  const rows = await prisma.bill.findMany({
    where: {
      utilityId,
      OR: [
        { holdReason: { not: null } },
        { account: { billingHoldReason: { not: null } } },
      ],
    },
    orderBy: { billDate: "desc" },
    select: {
      id: true,
      billNumber: true,
      holdReason: true,
      total: true,
      billDate: true,
      account: { select: { accountNumber: true, billingHoldReason: true } },
    },
  });
  return rows.map((b) => ({
    id: b.id,
    billNumber: b.billNumber,
    accountNumber: b.account.accountNumber,
    // The bill's own reason wins: it is the more specific decision, and
    // the one somebody made about this bill.
    holdReason: b.holdReason ?? b.account.billingHoldReason!,
    heldByAccount: b.holdReason === null,
    total: b.total.toFixed(4),
    billDate: b.billDate,
  }));
}
