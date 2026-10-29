import { prisma } from "../../lib/prisma.js";

/**
 * An account's ledger, in the vocabulary a person needs.
 *
 * Read-only, and deliberately separate from the services that write.
 * Its job is to resolve what a row MEANS — the reason's label rather
 * than its id, the bill it came from rather than a uuid, whether
 * something has reversed it — so the screen never has to work that out
 * from foreign keys.
 *
 * `reversedByEntryId` and `reversesEntryId` are both filled in, in both
 * directions, because two rows that cancel each other are the thing a
 * reader most easily misreads as having been charged twice. Leaving the
 * UI to pair them up by scanning for a matching amount would be a bug
 * waiting to happen.
 *
 * `balance` comes from `Account.balance`, not from summing the rows the
 * page happens to contain: the page may be capped or filtered to open
 * items, while the header has to show what the account actually owes.
 * The two agree because the cache is written in the same transaction as
 * every entry (§3.6), and `GET /api/v1/ar/reconciliation` is the proof.
 */

function err(code: string, message: string, statusCode: number): Error {
  return Object.assign(new Error(message), { code, statusCode });
}

export interface LedgerRow {
  id: string;
  type: string;
  /** Signed, 2dp. Positive increases what the customer owes. */
  amount: string;
  /** Signed, 2dp. What remains unconsumed of `amount`. */
  openAmount: string;
  settled: boolean;
  effectiveDate: string;
  dueDate: string | null;
  postedAt: string;
  reasonCode: string | null;
  reasonLabel: string | null;
  billNumber: string | null;
  /**
   * The bill this entry charged, when it charged one. The document
   * endpoint addresses the bill rather than the entry, so an action on
   * this row needs the id; `billNumber` above is what to print.
   */
  billId: string | null;
  /**
   * The bill this entry was raised ON, which is a different question
   * from the one above.
   *
   * A late fee carries no `bill_id`: it is its own receivable, posted
   * when a delinquency tier fires rather than by a billing run, and it
   * prints on the next bill without belonging to it. `assessed_on_id`
   * names the overdue debit it punishes, and this resolves that debit's
   * bill. Null whenever no bill produced it — a tier may charge an
   * opening-balance adjustment, and a tap fee is assessed on nothing.
   *
   * Since the ladder went per-bill one sweep can raise several fees on
   * one account, so without this the screen shows rows that differ only
   * in their memo.
   */
  assessedOnBillNumber: string | null;
  assessedOnBillId: string | null;
  /**
   * This debt is covered by a plan the customer is still keeping to.
   *
   * Without it the ledger shows two overdue debts and gives no hint why
   * they are being treated differently from the rest, and a CSR scanning
   * the account has to open another screen to find out. Only an ACTIVE
   * plan counts: the join rows survive a default, and a marker keyed on
   * membership would say "in a payment plan" about a debt the ladder is
   * chasing hardest.
   *
   * **It does not mean no fee will be charged.** Fee suppression is a
   * separate term, `suppress_fees_while_kept`, frozen per plan — true by
   * default, but a tenant may agree plans that keep charging. So this
   * answers "is this debt in a plan", which is a fact about the debt,
   * and not "is anyone chasing it", which depends on that term.
   */
  inPaymentPlan: boolean;
  tender: string | null;
  memo: string | null;
  /** Set when something reverses THIS entry. */
  reversedByEntryId: string | null;
  /** Set when this entry IS a reversal. */
  reversesEntryId: string | null;
}

export interface LedgerPage {
  data: LedgerRow[];
  /** The account's cached balance, 2dp. Negative means in credit. */
  balance: string;
  /**
   * What the utility holds of the customer's, 2dp, positive.
   *
   * Reported beside the balance and never folded into it. A DEPOSIT row
   * appears in `data` like any other entry, so without this figure the
   * reader sees a $500 credit in the table under a header saying $169.25
   * is due, and no reason given for why the two do not cancel.
   */
  depositHeld: string;
  /**
   * Open **receivables**, across the whole account rather than this page.
   *
   * A deposit is not one. It carries a non-zero `openAmount` for as long
   * as the utility holds it, so counting by sign alone made an account
   * owing nothing report "1 open item" — a figure sitting beside
   * "Nothing owed" and contradicting it. It is excluded here for the
   * same reason it is excluded from `balance`: money held is not money
   * owed, and this count answers the owed question.
   */
  openCount: number;
}

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

/**
 * What "still open" means, as one definition both the filter and the
 * count read.
 *
 * Non-zero `openAmount` and not a deposit. The two have to agree: a
 * header saying "3 open items" over a filtered list of four rows is a
 * discrepancy the reader has to resolve, and the obvious resolution —
 * that one of them is wrong — is correct. Declared once so they cannot
 * drift apart.
 *
 * A deposit stays visible in the unfiltered ledger and in its own
 * "Deposit held" figure. It is not hidden; it is just not outstanding.
 */
const OPEN_RECEIVABLE = {
  NOT: { openAmount: 0 },
  type: { not: "DEPOSIT" },
} as const;

export async function listLedger(
  utilityId: string,
  accountId: string,
  opts: { limit?: number; openOnly?: boolean } = {},
): Promise<LedgerPage> {
  // Resolve the account first: it proves the tenant owns it, and the
  // balance in the header must come from the same read as the rows.
  const account = await prisma.account.findFirst({
    where: { id: accountId, utilityId },
    select: { balance: true, depositAmount: true },
  });
  if (!account) throw err("ACCOUNT_NOT_FOUND", `Account ${accountId} not found`, 404);

  // Capped, because an account with years of history would otherwise
  // return everything to a browser.
  const take = Math.min(Math.max(opts.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);

  const rows = await prisma.ledgerEntry.findMany({
    where: {
      utilityId,
      accountId,
      ...(opts.openOnly ? OPEN_RECEIVABLE : {}),
    },
    /*
     * Newest first **by the date the screen shows**, which is
     * `effectiveDate` — when the money happened, not when the row was
     * written.
     *
     * Ordering by `postedAt` made the two disagree whenever anything was
     * back-dated: a correction, or a delinquency sweep charging a bill
     * that fell due weeks ago. On an account seeded in one pass every
     * row shares a `postedAt` and `id` decided, so the table was sorted
     * by nothing a reader could see — the oldest entry seventh and a
     * $412.80 opening balance last.
     *
     * `postedAt` and `id` stay as tiebreaks, so the order is total and a
     * page boundary is stable between calls. `effectiveDate` is written
     * once and never updated, which is what makes it safe to page on.
     */
    orderBy: [{ effectiveDate: "desc" }, { postedAt: "desc" }, { id: "desc" }],
    take,
    select: {
      id: true,
      type: true,
      amount: true,
      openAmount: true,
      effectiveDate: true,
      dueDate: true,
      postedAt: true,
      tender: true,
      memo: true,
      reversesId: true,
      reason: { select: { code: true, label: true } },
      bill: { select: { id: true, billNumber: true } },
      assessedOn: { select: { bill: { select: { id: true, billNumber: true } } } },
      // At most one: reverseEntry refuses a second reversal of the same
      // entry, so this is a list only because the relation is one.
      reversedBy: { select: { id: true }, take: 1 },
    },
  });

  // Across the account, not the page — "3 open items" must not change
  // because the caller asked for 10 rows.
  const openCount = await prisma.ledgerEntry.count({
    where: { utilityId, accountId, ...OPEN_RECEIVABLE },
  });

  // Which of these rows a live plan covers. One query for the page
  // rather than a join on the row query, because the answer is about
  // the plan's status rather than about the entry.
  const covered = new Set(
    (
      await prisma.$queryRaw<Array<{ entry_id: string }>>`
        SELECT pd.entry_id
          FROM payment_plan_debit pd
          JOIN payment_plan p
            ON p.utility_id = pd.utility_id AND p.id = pd.plan_id
         WHERE pd.utility_id = ${utilityId}::uuid
           AND p.account_id = ${accountId}::uuid
           AND p.status = 'ACTIVE'`
    ).map((r) => r.entry_id),
  );

  return {
    balance: account.balance.toFixed(2),
    depositHeld: account.depositAmount.toFixed(2),
    openCount,
    data: rows.map((e) => ({
      id: e.id,
      type: e.type,
      amount: e.amount.toFixed(2),
      openAmount: e.openAmount.toFixed(2),
      settled: e.openAmount.isZero(),
      effectiveDate: e.effectiveDate.toISOString().slice(0, 10),
      dueDate: e.dueDate ? e.dueDate.toISOString().slice(0, 10) : null,
      postedAt: e.postedAt.toISOString(),
      reasonCode: e.reason?.code ?? null,
      reasonLabel: e.reason?.label ?? null,
      billNumber: e.bill?.billNumber ?? null,
      billId: e.bill?.id ?? null,
      assessedOnBillNumber: e.assessedOn?.bill?.billNumber ?? null,
      assessedOnBillId: e.assessedOn?.bill?.id ?? null,
      tender: e.tender ?? null,
      memo: e.memo ?? null,
      reversedByEntryId: e.reversedBy[0]?.id ?? null,
      reversesEntryId: e.reversesId ?? null,
      inPaymentPlan: covered.has(e.id),
    })),
  };
}
