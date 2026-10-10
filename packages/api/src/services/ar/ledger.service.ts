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
  /** Entries still open, across the whole account rather than this page. */
  openCount: number;
}

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

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
      ...(opts.openOnly ? { NOT: { openAmount: 0 } } : {}),
    },
    // Newest first, with id as a total order so a page boundary is
    // stable between calls.
    orderBy: [{ postedAt: "desc" }, { id: "desc" }],
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
      bill: { select: { billNumber: true } },
      // At most one: reverseEntry refuses a second reversal of the same
      // entry, so this is a list only because the relation is one.
      reversedBy: { select: { id: true }, take: 1 },
    },
  });

  // Across the account, not the page — "3 open items" must not change
  // because the caller asked for 10 rows.
  const openCount = await prisma.ledgerEntry.count({
    where: { utilityId, accountId, NOT: { openAmount: 0 } },
  });

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
      tender: e.tender ?? null,
      memo: e.memo ?? null,
      reversedByEntryId: e.reversedBy[0]?.id ?? null,
      reversesEntryId: e.reversesId ?? null,
    })),
  };
}
