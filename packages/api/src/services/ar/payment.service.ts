import { Prisma } from "@utility-cis/shared/src/generated/prisma";
import { EVENT_TYPES, type RecordPaymentInput, type PaymentQuery } from "@utility-cis/shared";
import { prisma } from "../../lib/prisma.js";
import { writeAuditRow } from "../../lib/audit-wrap.js";
import { lockAccount, recomputeAccountCache, type TxClient } from "./posting.service.js";
import { applyCreditToDebits, type Application } from "./allocation.service.js";

/**
 * Recording money received against an account.
 *
 * The request carries a POSITIVE amount — what the operator typed. This
 * function is where it becomes negative, because the ledger's sign
 * convention is the customer's obligation to the utility (§3.3a) and
 * money received reduces it. The validator refuses a negative input, so
 * there is exactly one negation on this path and it is here. Two
 * negations, or none, both produce a plausible-looking balance that is
 * wrong by twice the payment.
 *
 * Insert, allocate (§6.3), recompute the cache — one transaction, so the
 * payment and the balance it implies commit together or not at all.
 */

export interface RecordPaymentResult {
  paymentId: string;
  /** The signed ledger amount, so negative. */
  amount: string;
  applied: Application[];
  /** Absolute value left unapplied — a customer credit balance. */
  unapplied: string;
  balance: string;
}

export async function recordPayment(
  utilityId: string,
  actorId: string,
  actorName: string,
  accountId: string,
  input: RecordPaymentInput,
  existingTx?: TxClient,
): Promise<RecordPaymentResult> {
  const run = async (tx: TxClient): Promise<RecordPaymentResult> => {
    // Lock before anything is read or written. Allocation reads open
    // debits and then writes them, so two concurrent payments have to
    // serialize here or the second one allocates against a stale view.
    // It also proves the account is this tenant's before we insert a
    // row pointing at it.
    await lockAccount(tx, utilityId, accountId);

    const signed = new Prisma.Decimal(input.amount).negated();
    const effectiveDate = new Date(input.receivedAt ?? new Date().toISOString().slice(0, 10));

    const entry = await tx.ledgerEntry.create({
      data: {
        utilityId,
        accountId,
        type: "PAYMENT",
        amount: signed,
        openAmount: signed,
        // A credit has nothing to fall due.
        dueDate: null,
        effectiveDate,
        tender: input.tender,
        externalRef: input.externalRef ?? null,
        memo: input.memo ?? null,
        createdBy: actorId,
      },
    });

    const applied = await applyCreditToDebits(tx, utilityId, accountId, entry.id);
    const cache = await recomputeAccountCache(tx, utilityId, accountId);

    // Re-read rather than computing it: whatever allocation consumed is
    // already on the row, and deriving it a second time in here would be
    // a second place to get the sign wrong.
    const after = await tx.ledgerEntry.findUniqueOrThrow({
      where: { id: entry.id },
      select: { openAmount: true },
    });

    return {
      paymentId: entry.id,
      amount: signed.toFixed(2),
      applied,
      unapplied: after.openAmount.negated().toFixed(2),
      balance: cache.balance,
    };
  };

  const runWithAudit = async (tx: TxClient): Promise<RecordPaymentResult> => {
    const result = await run(tx);
    await writeAuditRow(
      tx,
      { utilityId, actorId, actorName, entityType: "LedgerEntry" },
      EVENT_TYPES.LEDGER_PAYMENT_CREATED,
      result.paymentId,
      null,
      result,
    );
    return result;
  };

  if (existingTx) return runWithAudit(existingTx);
  return prisma.$transaction(runWithAudit);
}

/** A payment in the tenant-wide list. */
export interface PaymentListRow {
  id: string;
  /** Positive. Stored negative, because a payment is a credit. */
  amount: string;
  tender: string | null;
  effectiveDate: Date;
  postedAt: Date;
  externalRef: string | null;
  memo: string | null;
  /** True once a REVERSAL names this entry — an NSF or a keying error. */
  reversed: boolean;
  account: { id: string; accountNumber: string; customerName: string | null };
}

export interface PaymentListPage {
  data: PaymentListRow[];
  meta: { total: number; page: number; limit: number; pages: number };
  /**
   * Gross taken in the filtered range, as recorded.
   *
   * Reversed payments are INCLUDED. A payment taken on Monday and
   * bounced on Wednesday was still in Monday's deposit, so netting it
   * out of Monday would stop the figure agreeing with the bank — which
   * is the one job this total has. The reversal is its own event on the
   * day it happened, and the row stays marked so nobody reads the total
   * as money still held.
   */
  totalReceived: string;
}

/**
 * The tenant-wide payments list.
 *
 * Answers "what did we take, and does it match the deposit" — a question
 * no screen could answer before, because every payment view was scoped
 * to one account.
 */
export async function listPayments(
  utilityId: string,
  query: PaymentQuery,
): Promise<PaymentListPage> {
  const where: Prisma.LedgerEntryWhereInput = { utilityId, type: "PAYMENT" };

  if (query.accountId) where.accountId = query.accountId;
  if (query.tender) where.tender = query.tender;
  if (query.search) where.externalRef = { contains: query.search, mode: "insensitive" };

  if (query.from || query.to) {
    const range: { gte?: Date; lte?: Date } = {};
    if (query.from) range.gte = new Date(query.from);
    // Inclusive, and safe as a plain `lte` only because effective_date is
    // a DATE column with no time component. See the note on the schema.
    if (query.to) range.lte = new Date(query.to);
    where.effectiveDate = range;
  }

  const [rows, total, sum] = await Promise.all([
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
      },
    }),
    prisma.ledgerEntry.count({ where }),
    // Summed over the whole filter, not the page: a daily total that
    // only covered the rows on screen would be wrong the moment the day
    // ran past one page, and silently so.
    prisma.ledgerEntry.aggregate({ where, _sum: { amount: true } }),
  ]);

  return {
    data: rows.map((r) => ({
      id: r.id,
      // Negated once, here. A payment is stored negative because it is a
      // credit; an operator reading a receipts list wants "41.50".
      amount: r.amount.negated().toFixed(2),
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
    totalReceived: new Prisma.Decimal(sum._sum.amount ?? 0).negated().toFixed(2),
  };
}

/**
 * One name for a customer who is either a person or an organisation.
 * Null rather than an empty string when neither is usable, so the caller
 * decides how to render "unknown" instead of inheriting a blank.
 */
function displayCustomerName(
  customer: {
    customerType: string;
    firstName: string | null;
    lastName: string | null;
    organizationName: string | null;
  } | null,
): string | null {
  if (!customer) return null;
  if (customer.customerType === "ORGANIZATION") return customer.organizationName ?? null;
  const name = `${customer.firstName ?? ""} ${customer.lastName ?? ""}`.trim();
  return name === "" ? null : name;
}
