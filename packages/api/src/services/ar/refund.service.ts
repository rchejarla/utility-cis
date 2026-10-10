import { Prisma } from "@utility-cis/shared/src/generated/prisma";
import { prisma } from "../../lib/prisma.js";
import { writeAuditRow } from "../../lib/audit-wrap.js";
import { EVENT_TYPES, type DisbursementQuery } from "@utility-cis/shared";
import { lockAccount, recomputeAccountCache, type TxClient } from "./posting.service.js";
import { applyCreditsToDebit, type Application, type CreditPool } from "./allocation.service.js";
import { displayCustomerName } from "./customer-name.js";

/**
 * Giving money back.
 *
 * A refund is a **debit** — positive, like a charge. That reads wrong
 * until you see what it does: it consumes an open credit the customer
 * already held and brings the account back toward zero. Paying out an
 * overpayment does not grant them a new credit; it discharges the one
 * they had. The arithmetic is the same a bill performs when it absorbs
 * an overpayment, which is why the existing allocation walk does the
 * work rather than a second mechanism.
 *
 * **Which pool.** Receivable credits and security deposits are kept
 * apart everywhere in this module — in `Account.balance`, in allocation,
 * in the open-item count, in reconciliation — because one is money the
 * customer handed over against what they owe and the other is money the
 * utility holds. A refund therefore has to say which it is returning.
 * Drawing from "whatever credit is oldest" would let an overpayment
 * refund consume a security deposit, which is exactly the silent spend
 * the allocation exclusion exists to prevent.
 *
 * **Capped by refusal, not by truncation.** Asking to refund more than
 * is available fails with the figure that was available. Quietly
 * refunding less would leave an operator believing a customer had been
 * made whole, and a cheque for the wrong amount already written.
 *
 * **The disbursement record is on the entry.** `tender` is how the money
 * left, `externalRef` the cheque number, `effectiveDate` the day it
 * issued — the same three columns a payment and a deposit use for how
 * money arrived. No separate table: batching into a cheque run, an
 * issued/cleared/voided lifecycle and approved-but-unpaid state are what
 * one would add, and none is a stated need. Spec 10 already puts
 * approval outside the ledger, because posting is final.
 *
 * **Not on the receipts list.** That screen ties a day's takings to a
 * bank slip, and a slip is one-directional. A refund netted into it
 * would destroy the reconciliation rather than enrich it.
 */

export interface RecordRefundResult {
  entryId: string;
  /** Positive, as issued. */
  amount: string;
  /** Which pool it came out of. */
  source: CreditPool;
  balance: string;
  depositAmount: string;
  /** The credits this refund discharged. */
  applied: Application[];
}

export interface RecordRefundInput {
  /** Positive, in the customer's favour. Stored positive: a refund is a debit. */
  amount: string;
  /**
   * Which pool to draw from. Required, with no default, because the two
   * are different acts: returning an overpayment and releasing a
   * security deposit answer to different authority and different
   * triggers, and a default would quietly pick one.
   */
  source: CreditPool;
  tender?: "CARD" | "ACH" | "CASH" | "CHECK" | "LOCKBOX";
  /** Cheque number, ACH trace, card refund reference. */
  externalRef?: string;
  /** The day the money left. Defaults to today. */
  issuedOn?: string;
  memo?: string;
}

function err(code: string, message: string, statusCode: number): Error {
  return Object.assign(new Error(message), { code, statusCode });
}

/**
 * What is available to refund out of one pool, as a positive figure.
 *
 * Summed from the open entries rather than read from
 * `Account.balance`/`depositAmount`, for two reasons. The caches are
 * caches — a drifted one would authorise a refund the ledger cannot
 * back. And `balance` is a NET figure: an account with a $200 open
 * credit and a $500 unpaid bill has a balance of +$300 and nothing to
 * refund, while one with a $200 credit and no bill has -$200 and $200 to
 * give back. Only the open credits answer the question.
 */
export async function availableToRefund(
  tx: TxClient,
  utilityId: string,
  accountId: string,
  source: CreditPool,
): Promise<Prisma.Decimal> {
  const [agg] = await tx.$queryRaw<{ available: Prisma.Decimal | null }[]>`
    SELECT COALESCE(SUM(open_amount), 0) AS available
      FROM ledger_entry
     WHERE utility_id = ${utilityId}::uuid
       AND account_id = ${accountId}::uuid
       AND open_amount < 0
       AND ${source === "DEPOSIT" ? Prisma.sql`type = 'DEPOSIT'` : Prisma.sql`type <> 'DEPOSIT'`}`;
  // Stored negative because credits are negative; the caller thinks in
  // positive money.
  return new Prisma.Decimal(agg?.available ?? 0).negated();
}

/** One refund in the tenant-wide disbursements list. */
export interface DisbursementRow {
  id: string;
  /** Positive, as issued. A refund is stored positive: it is a debit. */
  amount: string;
  /**
   * Which pool it came out of.
   *
   * Derived from the credits it consumed, not stored on the entry. It can
   * be: a refund is capped at one pool and fully allocated before it
   * returns, and the pools are kept apart everywhere, so every
   * application on a refund points at credits of one kind. Storing it
   * too would be a second copy of a fact the ledger already holds, free
   * to disagree with it.
   *
   * Null only for a refund with no applications, which the service
   * refuses to create — present so a hand-written row shows as unknown
   * rather than silently as a credit refund.
   */
  source: CreditPool | null;
  tender: string | null;
  /** The day the money left. */
  effectiveDate: Date;
  postedAt: Date;
  externalRef: string | null;
  memo: string | null;
  /** True once a REVERSAL names this refund — a voided cheque. */
  reversed: boolean;
  account: { id: string; accountNumber: string; customerName: string | null };
}

export interface DisbursementListPage {
  data: DisbursementRow[];
  meta: { total: number; page: number; limit: number; pages: number };
  /**
   * Gross paid out over the filter, as issued.
   *
   * Reversed refunds are INCLUDED, for the same reason a bounced cheque
   * stays in the day it was banked: a refund cheque written on Monday
   * and voided on Wednesday left the building on Monday, and the cheque
   * run for that day has to agree. The row is marked instead.
   */
  totalPaidOut: string;
  /** The same money by pool, every pool spelled out even at zero. */
  subtotals: Record<CreditPool, string>;
}

/**
 * The tenant-wide disbursements list — money that LEFT.
 *
 * The mirror of the receipts list, and deliberately a separate screen
 * rather than a direction column on that one: a receipts total is tied
 * out against a bank deposit slip, which only contains money in, and a
 * disbursements total against a cheque run. Netting the two would
 * destroy both reconciliations.
 *
 * Only `REFUND` today. The type filter is the shape, not the limit: if
 * something else ever leaves the building it joins this list rather than
 * getting a third screen.
 */
export async function listDisbursements(
  utilityId: string,
  query: DisbursementQuery,
): Promise<DisbursementListPage> {
  const where: Prisma.LedgerEntryWhereInput = { utilityId, type: "REFUND" };

  if (query.accountId) where.accountId = query.accountId;
  if (query.tender) where.tender = query.tender;
  if (query.search) where.externalRef = { contains: query.search, mode: "insensitive" };

  if (query.from || query.to) {
    const range: { gte?: Date; lte?: Date } = {};
    if (query.from) range.gte = new Date(query.from);
    // Inclusive, safe as a plain `lte` only because effective_date is a
    // DATE column with no time component.
    if (query.to) range.lte = new Date(query.to);
    where.effectiveDate = range;
  }

  // Which pool a refund drew from is a property of the credits it
  // consumed, and Prisma can filter on that relation — so both
  // subtotals cover the whole FILTER, like the total, rather than the
  // page. A split that silently covered only the rows on screen would
  // stop adding up to the total the moment a day ran past one page,
  // which is the same failure the page-versus-filter rule exists to
  // prevent.
  const drewFrom = (pool: CreditPool): Prisma.LedgerEntryWhereInput => ({
    ...where,
    debitsIn:
      pool === "DEPOSIT"
        ? { some: { credit: { is: { type: "DEPOSIT" } } } }
        : { some: { credit: { is: { type: { not: "DEPOSIT" } } } } },
  });

  const [rows, total, sum, fromCredit, fromDeposit] = await Promise.all([
    prisma.ledgerEntry.findMany({
      where,
      orderBy: { [query.sort]: query.order },
      skip: (query.page - 1) * query.limit,
      take: query.limit,
      include: {
        account: {
          select: {
            id: true,
            accountNumber: true,
            customer: {
              select: {
                customerType: true,
                firstName: true,
                lastName: true,
                organizationName: true,
              },
            },
          },
        },
        _count: { select: { reversedBy: true } },
        // What this refund discharged, which is what says which pool it
        // drew from.
        debitsIn: { select: { credit: { select: { type: true } } } },
      },
    }),
    prisma.ledgerEntry.count({ where }),
    // Over the whole filter, not the page: a cheque-run total that
    // stopped at the page boundary would be wrong past 25 rows, silently.
    prisma.ledgerEntry.aggregate({ where, _sum: { amount: true } }),
    prisma.ledgerEntry.aggregate({ where: drewFrom("CREDIT"), _sum: { amount: true } }),
    prisma.ledgerEntry.aggregate({ where: drewFrom("DEPOSIT"), _sum: { amount: true } }),
  ]);

  const poolOf = (apps: { credit: { type: string } }[]): CreditPool | null => {
    if (apps.length === 0) return null;
    return apps.some((a) => a.credit.type === "DEPOSIT") ? "DEPOSIT" : "CREDIT";
  };

  return {
    data: rows.map((r) => ({
      id: r.id,
      amount: r.amount.toFixed(2),
      source: poolOf(r.debitsIn),
      tender: r.tender,
      effectiveDate: r.effectiveDate,
      postedAt: r.postedAt,
      externalRef: r.externalRef,
      memo: r.memo,
      reversed: r._count.reversedBy > 0,
      account: {
        id: r.account.id,
        accountNumber: r.account.accountNumber,
        customerName: displayCustomerName(r.account.customer),
      },
    })),
    meta: {
      total,
      page: query.page,
      limit: query.limit,
      pages: Math.ceil(total / query.limit),
    },
    totalPaidOut: new Prisma.Decimal(sum._sum.amount ?? 0).toFixed(2),
    subtotals: {
      CREDIT: new Prisma.Decimal(fromCredit._sum.amount ?? 0).toFixed(2),
      DEPOSIT: new Prisma.Decimal(fromDeposit._sum.amount ?? 0).toFixed(2),
    },
  };
}

export async function recordRefund(
  utilityId: string,
  actorId: string,
  actorName: string,
  accountId: string,
  input: RecordRefundInput,
  existingTx?: TxClient,
): Promise<RecordRefundResult> {
  const run = async (tx: TxClient): Promise<RecordRefundResult> => {
    // Proves the account is this tenant's before a row points at it, and
    // serialises against anything else changing these figures. It has to
    // precede the availability read: without it two refunds could each
    // see the same $200 credit and both pay it out.
    await lockAccount(tx, utilityId, accountId);

    const amount = new Prisma.Decimal(input.amount);
    if (!amount.isFinite() || amount.lte(0)) {
      throw err("REFUND_AMOUNT_INVALID", "A refund must be a positive amount", 400);
    }
    if (amount.decimalPlaces() > 2) {
      throw err("REFUND_AMOUNT_INVALID", "A refund must be a whole number of cents", 400);
    }

    const available = await availableToRefund(tx, utilityId, accountId, input.source);
    if (available.lte(0)) {
      throw err(
        "REFUND_NOTHING_AVAILABLE",
        input.source === "DEPOSIT"
          ? "This account holds no deposit to return"
          : "This account has no credit to refund",
        422,
      );
    }
    if (amount.gt(available)) {
      // Names the figure. Refunding the smaller amount silently would
      // leave the operator believing the customer was made whole.
      throw err(
        "REFUND_EXCEEDS_AVAILABLE",
        `Cannot refund ${amount.toFixed(2)}: only ${available.toFixed(2)} is available from ${
          input.source === "DEPOSIT" ? "the deposit held" : "the credit balance"
        }`,
        422,
      );
    }

    const entry = await tx.ledgerEntry.create({
      data: {
        utilityId,
        accountId,
        type: "REFUND",
        // Positive: a refund is a debit. See the note at the top.
        amount,
        openAmount: amount,
        // A refund is not owed BY the customer, so it cannot fall due.
        // Leaving this null also keeps it out of the aging index and the
        // delinquency sweep, which select on `open_amount > 0 AND
        // due_date IS NOT NULL` -- a refund awaiting allocation must not
        // look like arrears.
        dueDate: null,
        effectiveDate: new Date(input.issuedOn ?? new Date().toISOString().slice(0, 10)),
        tender: input.tender ?? null,
        externalRef: input.externalRef ?? null,
        memo:
          input.memo ??
          (input.source === "DEPOSIT" ? "Deposit returned" : "Credit balance refunded"),
        createdBy: actorId,
      },
    });

    // Discharge the credits this refund pays out, oldest first, from the
    // named pool only. Capped above, so this always consumes the refund
    // in full and leaves openAmount at 0 -- a refund with anything left
    // open would mean money sent with no credit behind it.
    const applied = await applyCreditsToDebit(tx, utilityId, accountId, entry.id, input.source);

    const settled = await tx.ledgerEntry.findUniqueOrThrow({
      where: { id: entry.id },
      select: { openAmount: true },
    });
    if (!settled.openAmount.isZero()) {
      // Unreachable given the cap, and asserted rather than trusted: the
      // alternative is a refund that paid out more than it discharged,
      // which shows up later as a balance nobody can explain.
      throw err(
        "REFUND_NOT_FULLY_BACKED",
        `Refund ${entry.id} left ${settled.openAmount.toFixed(2)} unbacked`,
        500,
      );
    }

    const cache = await recomputeAccountCache(tx, utilityId, accountId);
    return {
      entryId: entry.id,
      amount: amount.toFixed(2),
      source: input.source,
      balance: cache.balance,
      depositAmount: cache.depositAmount,
      applied,
    };
  };

  const runWithAudit = async (tx: TxClient): Promise<RecordRefundResult> => {
    const result = await run(tx);
    await writeAuditRow(
      tx,
      { utilityId, actorId, actorName, entityType: "LedgerEntry" },
      EVENT_TYPES.LEDGER_REFUND_ISSUED,
      result.entryId,
      null,
      {
        accountId,
        amount: result.amount,
        source: result.source,
        tender: input.tender ?? null,
        externalRef: input.externalRef ?? null,
      },
    );
    return result;
  };

  return existingTx
    ? runWithAudit(existingTx)
    : prisma.$transaction((tx) => runWithAudit(tx as TxClient));
}
