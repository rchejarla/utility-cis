import { Prisma } from "@utility-cis/shared/src/generated/prisma";
import {
  EVENT_TYPES,
  type AdjustInput,
  type WaiveInput,
  type WriteOffInput,
} from "@utility-cis/shared";
import { prisma } from "../../lib/prisma.js";
import { writeAuditRow } from "../../lib/audit-wrap.js";
import { lockAccount, recomputeAccountCache, type TxClient } from "./posting.service.js";
import {
  applyCreditToOneDebit,
  applyCreditsToDebit,
  type Application,
} from "./allocation.service.js";
import { resolveReason } from "./reason.service.js";

/**
 * Manual charges, waivers and write-offs — what an operator does to a
 * receivable that is otherwise correct.
 *
 * `waive` and `writeOff` are separate exports although their mechanics
 * are identical, because §3.5 says they are different facts: a finance
 * department reports concessions and bad debt separately, and once
 * collapsed the distinction is unrecoverable from history. The third act
 * — the charge was WRONG — is not here at all; that is `reverseEntry`.
 * The short rule: wrong -> rebill, right but forgiven -> credit.
 *
 * Nothing here touches `bill.total`. The bill stands as issued and the
 * *receivable* is reduced. A bill computed wrongly is a rebill (slice
 * 5d), not a waiver, and there is a test asserting the bill is untouched.
 */

/**
 * How long a manual charge has to be paid when the caller does not say.
 *
 * Deliberately its own constant rather than shared with
 * `DEFAULT_FEE_DUE_DAYS` in fee.service.ts or `DEFAULT_DUE_DAYS` in
 * bill.service.ts. All three are 30 today, but they are three separate
 * policies that happen to agree — a utility could give a hand-raised
 * charge a different window from a bill — and merging them would assert
 * a sameness nothing has established. When any becomes
 * tenant-configurable they will need to move apart, not together.
 */
const DEFAULT_ADJUSTMENT_DUE_DAYS = 30;

function err(code: string, message: string, statusCode: number): Error {
  return Object.assign(new Error(message), { code, statusCode });
}

export interface AdjustmentResult {
  entryId: string;
  /** Signed: positive for a manual charge, negative for a credit. */
  amount: string;
  applied: Application[];
  balance: string;
}

export interface CreditResult extends AdjustmentResult {
  /** Absolute value left unapplied — a refund due. */
  unapplied: string;
}

/**
 * The shared core of waiving and writing off: a negative entry against
 * one nominated debit, citing a reason of the matching type.
 */
async function postCreditAgainstDebit(
  type: "ADJUSTMENT_CREDIT" | "WRITE_OFF",
  utilityId: string,
  actorId: string,
  actorName: string,
  accountId: string,
  input: WaiveInput | WriteOffInput,
  existingTx?: TxClient,
): Promise<CreditResult> {
  const run = async (tx: TxClient): Promise<CreditResult> => {
    await lockAccount(tx, utilityId, accountId);
    // The reason must be of THIS type, which is what keeps a concession
    // from being filed as a bad debt and vice versa.
    await resolveReason(tx, utilityId, input.reasonId, type);

    const target = await tx.ledgerEntry.findFirst({
      where: { id: input.debitId, utilityId, accountId },
      select: { id: true, amount: true },
    });
    if (!target) {
      throw err("ENTRY_NOT_FOUND", `Entry ${input.debitId} not found on this account`, 404);
    }
    // Forgiving a credit is meaningless, and applying one credit to
    // another would violate the application's own sign rules.
    if (target.amount.lte(0)) {
      throw err("NOT_A_DEBIT", `Entry ${input.debitId} is not a charge`, 422);
    }

    const signed = new Prisma.Decimal(input.amount).negated();
    const entry = await tx.ledgerEntry.create({
      data: {
        utilityId,
        accountId,
        type,
        amount: signed,
        openAmount: signed,
        dueDate: null, // a credit has nothing to fall due
        effectiveDate: new Date(input.effectiveDate ?? new Date().toISOString().slice(0, 10)),
        reasonId: input.reasonId,
        memo: input.memo ?? null,
        createdBy: actorId,
      },
    });

    // One nominated debit, no spill: the excess is a refund due (§6.5).
    const applied = await applyCreditToOneDebit(
      tx,
      utilityId,
      accountId,
      entry.id,
      input.debitId,
    );
    const cache = await recomputeAccountCache(tx, utilityId, accountId);
    const after = await tx.ledgerEntry.findUniqueOrThrow({
      where: { id: entry.id },
      select: { openAmount: true },
    });

    return {
      entryId: entry.id,
      amount: signed.toFixed(2),
      applied,
      unapplied: after.openAmount.negated().toFixed(2),
      balance: cache.balance,
    };
  };

  const runWithAudit = async (tx: TxClient): Promise<CreditResult> => {
    const result = await run(tx);
    await writeAuditRow(
      tx,
      { utilityId, actorId, actorName, entityType: "LedgerEntry" },
      EVENT_TYPES.LEDGER_ADJUSTMENT_CREATED,
      result.entryId,
      null,
      result,
    );
    return result;
  };

  if (existingTx) return runWithAudit(existingTx);
  return prisma.$transaction(runWithAudit);
}

/** The charge was right and we are forgiving it. A concession. */
export function waive(
  utilityId: string,
  actorId: string,
  actorName: string,
  accountId: string,
  input: WaiveInput,
  existingTx?: TxClient,
): Promise<CreditResult> {
  return postCreditAgainstDebit(
    "ADJUSTMENT_CREDIT",
    utilityId,
    actorId,
    actorName,
    accountId,
    input,
    existingTx,
  );
}

/** The charge was right and we are never collecting it. Bad debt. */
export function writeOff(
  utilityId: string,
  actorId: string,
  actorName: string,
  accountId: string,
  input: WriteOffInput,
  existingTx?: TxClient,
): Promise<CreditResult> {
  return postCreditAgainstDebit(
    "WRITE_OFF",
    utilityId,
    actorId,
    actorName,
    accountId,
    input,
    existingTx,
  );
}

/** A charge raised by hand, outside billing. */
export async function adjustDebit(
  utilityId: string,
  actorId: string,
  actorName: string,
  accountId: string,
  input: AdjustInput,
  existingTx?: TxClient,
): Promise<AdjustmentResult> {
  const run = async (tx: TxClient): Promise<AdjustmentResult> => {
    await lockAccount(tx, utilityId, accountId);
    await resolveReason(tx, utilityId, input.reasonId, "ADJUSTMENT_DEBIT");

    const amount = new Prisma.Decimal(input.amount);
    const effectiveDate = new Date(input.effectiveDate ?? new Date().toISOString().slice(0, 10));

    const entry = await tx.ledgerEntry.create({
      data: {
        utilityId,
        accountId,
        type: "ADJUSTMENT_DEBIT",
        amount,
        openAmount: amount,
        // Every debit carries a due date or the aging index cannot see it.
        dueDate: input.dueDate
          ? new Date(input.dueDate)
          : new Date(effectiveDate.getTime() + DEFAULT_ADJUSTMENT_DUE_DAYS * 86_400_000),
        effectiveDate,
        reasonId: input.reasonId,
        memo: input.memo ?? null,
        createdBy: actorId,
      },
    });

    // A new debit absorbs open credits, the same as a posted bill or fee.
    const applied = await applyCreditsToDebit(tx, utilityId, accountId, entry.id);
    const cache = await recomputeAccountCache(tx, utilityId, accountId);

    return { entryId: entry.id, amount: amount.toFixed(2), applied, balance: cache.balance };
  };

  const runWithAudit = async (tx: TxClient): Promise<AdjustmentResult> => {
    const result = await run(tx);
    await writeAuditRow(
      tx,
      { utilityId, actorId, actorName, entityType: "LedgerEntry" },
      EVENT_TYPES.LEDGER_ADJUSTMENT_CREATED,
      result.entryId,
      null,
      result,
    );
    return result;
  };

  if (existingTx) return runWithAudit(existingTx);
  return prisma.$transaction(runWithAudit);
}
