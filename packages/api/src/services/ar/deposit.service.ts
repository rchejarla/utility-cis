import { Prisma } from "@utility-cis/shared/src/generated/prisma";
import { prisma } from "../../lib/prisma.js";
import { writeAuditRow } from "../../lib/audit-wrap.js";
import { EVENT_TYPES } from "@utility-cis/shared";
import { lockAccount, recomputeAccountCache, type TxClient } from "./posting.service.js";

/**
 * Taking a security deposit.
 *
 * A deposit is money the utility HOLDS for the customer, so it is
 * recorded as a credit — and then kept out of the two places an ordinary
 * credit would go. Allocation must not spend it on the next bill, and
 * `Account.balance` must not net it against arrears, because the
 * delinquency sweep reads `balance > 0` and a deposit is taken from
 * exactly the customers who need chasing. Both exclusions live in the
 * services that do those jobs; this one only writes the entry.
 *
 * `Account.depositAmount` is not set here. It is a cache, maintained by
 * `recomputeAccountCache` from the entries — the same arrangement as
 * `balance`, and the reason reconciliation can prove it.
 */

export interface RecordDepositResult {
  entryId: string;
  /** Positive: what the utility now holds. */
  depositAmount: string;
  balance: string;
}

function err(code: string, message: string, statusCode: number): Error {
  return Object.assign(new Error(message), { code, statusCode });
}

export interface RecordDepositInput {
  /** Positive. Negated here, exactly once, because a deposit is a credit. */
  amount: string;
  tender?: "CARD" | "ACH" | "CASH" | "CHECK" | "LOCKBOX";
  receivedAt?: string;
  externalRef?: string;
  memo?: string;
}

export async function recordDeposit(
  utilityId: string,
  actorId: string,
  actorName: string,
  accountId: string,
  input: RecordDepositInput,
  existingTx?: TxClient,
): Promise<RecordDepositResult> {
  const run = async (tx: TxClient): Promise<RecordDepositResult> => {
    // Proves the account is this tenant's before a row points at it, and
    // serialises against anything else changing the cached figures.
    await lockAccount(tx, utilityId, accountId);

    const signed = new Prisma.Decimal(input.amount).negated();
    if (signed.gte(0)) {
      throw err("DEPOSIT_AMOUNT_INVALID", "A deposit must be a positive amount", 400);
    }

    const entry = await tx.ledgerEntry.create({
      data: {
        utilityId,
        accountId,
        type: "DEPOSIT",
        amount: signed,
        openAmount: signed,
        // A credit has nothing to fall due, and a deposit is not owed
        // back on a date — it is released when the account closes or the
        // customer earns it.
        dueDate: null,
        effectiveDate: new Date(input.receivedAt ?? new Date().toISOString().slice(0, 10)),
        tender: input.tender ?? null,
        externalRef: input.externalRef ?? null,
        memo: input.memo ?? "Security deposit",
        createdBy: actorId,
      },
    });

    const cache = await recomputeAccountCache(tx, utilityId, accountId);
    return {
      entryId: entry.id,
      depositAmount: cache.depositAmount,
      balance: cache.balance,
    };
  };

  const runWithAudit = async (tx: TxClient): Promise<RecordDepositResult> => {
    const result = await run(tx);
    await writeAuditRow(
      tx,
      { utilityId, actorId, actorName, entityType: "LedgerEntry" },
      EVENT_TYPES.LEDGER_DEPOSIT_RECORDED,
      result.entryId,
      null,
      { accountId, amount: input.amount, tender: input.tender ?? null },
    );
    return result;
  };

  return existingTx
    ? runWithAudit(existingTx)
    : prisma.$transaction((tx) => runWithAudit(tx as TxClient));
}
