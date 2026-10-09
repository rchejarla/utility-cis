import { Prisma } from "@utility-cis/shared/src/generated/prisma";
import { DEBIT_ALLOCATION_ORDER } from "@utility-cis/shared";
import { lockAccount, type TxClient } from "./posting.service.js";

/**
 * Applying open credits to open debits.
 *
 * Two walks over one mechanic, because both directions are needed: a new
 * payment consumes existing debits (§6.2), and a newly posted debit
 * consumes existing credits (§6.1 step 4). Each application consumes
 * what it can; a shortfall stays as `openAmount` on whichever side ran
 * out, so partial payments and overpayments need no special case.
 *
 * Both walks take the account row lock as their first statement rather
 * than trusting the caller to hold it: they read open entries and then
 * write them, so two concurrent payments have to serialize before either
 * reads or the second overwrites the first's work.
 *
 * Neither function recomputes `Account.balance`. The caller does that
 * once, after allocating, so one operation writes the cache one time.
 */

export interface Application {
  applicationId: string;
  creditId: string;
  debitId: string;
  /** Always positive, per the CHECK on ledger_application. */
  amount: string;
}

/**
 * Where a debit type sits in the payment order. Lower is paid first.
 *
 * An unknown type ranks LAST. `indexOf` returns -1 for anything not in
 * the list, which would sort it ahead of a fee — the opposite of safe.
 * The only types that can reach here and are absent from the list are
 * credits (excluded by `openAmount > 0`) and REVERSAL, whose openAmount
 * is 0 by construction because `reverseEntry` applies it against the
 * entry it reverses.
 */
export function rankDebitType(type: string): number {
  const i = (DEBIT_ALLOCATION_ORDER as readonly string[]).indexOf(type);
  return i === -1 ? Number.MAX_SAFE_INTEGER : i;
}

interface DebitRow {
  id: string;
  type: string;
  openAmount: Prisma.Decimal;
  dueDate: Date | null;
  postedAt: Date;
}

/** Spec §6.3: type class, then oldest dueDate, then postedAt. */
function compareDebits(a: DebitRow, b: DebitRow): number {
  const rank = rankDebitType(a.type) - rankDebitType(b.type);
  if (rank !== 0) return rank;
  // A debit with no dueDate cannot age, so it sorts after ones that can.
  const da = a.dueDate ? a.dueDate.getTime() : Number.MAX_SAFE_INTEGER;
  const db = b.dueDate ? b.dueDate.getTime() : Number.MAX_SAFE_INTEGER;
  if (da !== db) return da - db;
  const pa = a.postedAt.getTime();
  const pb = b.postedAt.getTime();
  if (pa !== pb) return pa - pb;
  // Total order, so a tie never depends on the order rows came back in.
  return a.id.localeCompare(b.id);
}

async function apply(
  tx: TxClient,
  utilityId: string,
  creditId: string,
  debitId: string,
  amount: Prisma.Decimal,
): Promise<Application> {
  const row = await tx.ledgerApplication.create({
    data: { utilityId, creditId, debitId, amount },
  });
  // A debit's openAmount shrinks toward 0; a credit's grows toward 0.
  // Both are signed, so one decrements and the other increments by the
  // same positive amount. Spec §5.
  await tx.ledgerEntry.update({
    where: { id: debitId },
    data: { openAmount: { decrement: amount } },
  });
  await tx.ledgerEntry.update({
    where: { id: creditId },
    data: { openAmount: { increment: amount } },
  });
  return { applicationId: row.id, creditId, debitId, amount: amount.toFixed(2) };
}

/**
 * Consume one open credit against this account's open debits, in the
 * §6.3 order. Leftover stays open on the credit — which is what a
 * customer credit balance is.
 */
export async function applyCreditToDebits(
  tx: TxClient,
  utilityId: string,
  accountId: string,
  creditId: string,
): Promise<Application[]> {
  await lockAccount(tx, utilityId, accountId);

  const credit = await tx.ledgerEntry.findFirstOrThrow({
    where: { id: creditId, utilityId, accountId },
    select: { openAmount: true },
  });
  let remaining = credit.openAmount.negated();
  if (remaining.lte(0)) return [];

  const debits = await tx.ledgerEntry.findMany({
    where: { utilityId, accountId, openAmount: { gt: 0 } },
    // Fetch in a TOTAL order. This, not the comparator, is what makes
    // allocation deterministic: `Array.prototype.sort` is stable, so any
    // tie the comparator cannot separate keeps the order it arrived in,
    // and without an ORDER BY that order is whatever Postgres chose.
    // The comparator still runs, because the type-class ranking in
    // DEBIT_ALLOCATION_ORDER would need a CASE expression to do here.
    orderBy: [{ dueDate: "asc" }, { postedAt: "asc" }, { id: "asc" }],
    select: { id: true, type: true, openAmount: true, dueDate: true, postedAt: true },
  });
  debits.sort(compareDebits);

  const made: Application[] = [];
  for (const d of debits) {
    if (remaining.lte(0)) break;
    const amount = Prisma.Decimal.min(remaining, d.openAmount);
    made.push(await apply(tx, utilityId, creditId, d.id, amount));
    remaining = remaining.minus(amount);
  }
  return made;
}

/**
 * Apply one credit to one NOMINATED debit, up to what that debit owes,
 * leaving any excess open on the credit.
 *
 * Deliberately not `applyCreditToDebits`. A payment is money against the
 * account, so it walks every open debit in priority order. A waiver or a
 * write-off forgives a SPECIFIC charge (§6.5), so it must not spill:
 * waiving $30 of a $10 charge leaves a $20 refund due, not $20 off
 * whatever else is outstanding. Choosing the general walk here would
 * quietly turn a concession on one charge into a payment against
 * another, and the balance would look right either way.
 */
export async function applyCreditToOneDebit(
  tx: TxClient,
  utilityId: string,
  accountId: string,
  creditId: string,
  debitId: string,
): Promise<Application[]> {
  await lockAccount(tx, utilityId, accountId);

  const [credit, debit] = await Promise.all([
    tx.ledgerEntry.findFirstOrThrow({
      where: { id: creditId, utilityId, accountId },
      select: { openAmount: true },
    }),
    tx.ledgerEntry.findFirstOrThrow({
      where: { id: debitId, utilityId, accountId },
      select: { openAmount: true },
    }),
  ]);

  const available = credit.openAmount.negated();
  // Nothing to give, or nothing left owed on that charge — either way the
  // credit stays open as a refund due.
  if (available.lte(0) || debit.openAmount.lte(0)) return [];

  const amount = Prisma.Decimal.min(available, debit.openAmount);
  return [await apply(tx, utilityId, creditId, debitId, amount)];
}

/**
 * Consume this account's open credits against one open debit, oldest
 * `postedAt` first, so a credit balance is absorbed by the next charge
 * without a sweep job. Spec §6.1 step 4.
 */
export async function applyCreditsToDebit(
  tx: TxClient,
  utilityId: string,
  accountId: string,
  debitId: string,
): Promise<Application[]> {
  await lockAccount(tx, utilityId, accountId);

  const debit = await tx.ledgerEntry.findFirstOrThrow({
    where: { id: debitId, utilityId, accountId },
    select: { openAmount: true },
  });
  let remaining = debit.openAmount;
  if (remaining.lte(0)) return [];

  const credits = await tx.ledgerEntry.findMany({
    where: { utilityId, accountId, openAmount: { lt: 0 } },
    orderBy: [{ postedAt: "asc" }, { id: "asc" }],
    select: { id: true, openAmount: true },
  });

  const made: Application[] = [];
  for (const c of credits) {
    if (remaining.lte(0)) break;
    const amount = Prisma.Decimal.min(remaining, c.openAmount.negated());
    made.push(await apply(tx, utilityId, c.id, debitId, amount));
    remaining = remaining.minus(amount);
  }
  return made;
}
