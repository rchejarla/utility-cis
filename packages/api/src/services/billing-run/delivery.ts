/** Queuing a whole run's bills to their customers. */
import { prisma } from "../../lib/prisma.js";
import { deliverBill } from "./../bill-delivery.service.js";

/** One reason bills were not sent, and how much of the run it accounts for. */
export interface SendSkip {
  code: string;
  accountCount: number;
  sampleAccounts: string[];
  message: string;
}

/**
 * Queue every bill this run produced for delivery.
 *
 * Sending existed one bill at a time, and a run of twelve thousand
 * accounts cannot be worked that way — the same objection as a per-bill
 * hold button. The run already knows which bills it made, and posting
 * is already the act that precedes sending, so this is where the
 * trigger belongs.
 *
 * It does not stop at the first problem. A customer with no address, a
 * bill nobody rendered, a held account: each is one account's
 * exception, not a reason the other eleven thousand go unsent. Each
 * refusal `deliverBill` already makes is caught and counted by its
 * code, and the result reads like the pre-flight and the exception
 * list — by cause, with examples — because one fix usually clears a
 * whole group.
 *
 * Pressing it twice does not send twice: `deliverBill` refuses a bill
 * already queued, so the second pass reports every bill as in flight
 * and makes no copies.
 */
export async function sendBillingRun(
  utilityId: string,
  runId: string,
): Promise<{ queued: number; skipped: SendSkip[] }> {
  const run = await prisma.billingRun.findFirst({
    where: { id: runId, utilityId },
    select: { id: true, postedAt: true },
  });
  if (!run) {
    throw Object.assign(new Error(`Billing run ${runId} not found`), {
      statusCode: 404,
      code: "RUN_NOT_FOUND",
    });
  }
  /*
   * An unposted run is a calculation. Sending it would ask every
   * customer on the cycle for money the utility has not decided to
   * charge — the same rule `deliverBill` applies per bill, stated once
   * here so twelve thousand refusals are not how an operator finds out.
   */
  if (!run.postedAt) {
    throw Object.assign(
      new Error(
        "This run has not been posted. Nobody owes a bill until it is posted, so there is nothing to send. Post the run first.",
      ),
      { statusCode: 409, code: "RUN_NOT_POSTED" },
    );
  }

  const items = await prisma.billingRunItem.findMany({
    where: { utilityId, billingRunId: runId, status: "BILLED", billId: { not: null } },
    select: { billId: true, account: { select: { accountNumber: true } } },
    orderBy: { id: "asc" },
  });

  let queued = 0;
  const groups = new Map<string, { message: string; accounts: string[] }>();

  for (const item of items) {
    try {
      await deliverBill(utilityId, item.billId!);
      queued += 1;
    } catch (err) {
      const e = err as { code?: string; message?: string };
      // Anything without a code is a fault rather than a refusal, and
      // swallowing it would report a run as fully sent while a defect
      // ate half of it.
      if (!e.code) throw err;
      const group = groups.get(e.code) ?? { message: e.message ?? e.code, accounts: [] };
      group.accounts.push(item.account.accountNumber);
      groups.set(e.code, group);
    }
  }

  const skipped: SendSkip[] = [...groups.entries()]
    .map(([code, g]) => ({
      code,
      accountCount: g.accounts.length,
      sampleAccounts: g.accounts.slice(0, 3),
      message: g.message,
    }))
    .sort((a, b) => b.accountCount - a.accountCount);

  return { queued, skipped };
}
