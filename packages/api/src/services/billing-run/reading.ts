/**
 * Everything a screen asks about a run after the fact.
 *
 * Reads only. Kept apart from the acts so a change to what the detail
 * screen shows cannot reach the pass that bills.
 */
import { Prisma } from "@utility-cis/shared/src/generated/prisma";
import { prisma } from "../../lib/prisma.js";
import { RUN_CYCLE_SELECT, toSummary, type BillingRunSummary } from "./summary.js";
import { displayCustomerName } from "./../ar/customer-name.js";

export async function listBillingRuns(utilityId: string): Promise<BillingRunSummary[]> {
  const runs = await prisma.billingRun.findMany({
    where: { utilityId },
    orderBy: { createdAt: "desc" },
    take: 100,
    include: { cycle: RUN_CYCLE_SELECT },
  });
  return runs.map(toSummary);
}

/**
 * One run, with what it would raise if posted.
 *
 * `billedTotal` is on the detail and not on the list, because the number
 * exists for one question — "what am I about to put on customers'
 * accounts?" — asked at the moment of posting. A column of run totals
 * would be read as revenue, which it is not: an unposted run's total is
 * owed by nobody, and a posted one's is already in the ledger.
 */
export interface BillingRunDetail extends BillingRunSummary {
  billedTotal: string;
  /**
   * How many of this run's bills have actually been delivered.
   *
   * Bills, not attempts: a resend is a second row against the same bill
   * and must not make the figure claim two went out. Derived on read
   * rather than stored, so it stays true as the outbox drains — the
   * send panel answers this for ten seconds and a reload loses it,
   * while a run is the thing an operator comes back to days later.
   */
  sentCount: number;
  /** How many of this run's bills are posted and so actually owed. */
  postedCount: number;
  /**
   * How many of this run's bills a Post would still act on.
   *
   * Not `billedCount - postedCount`: a held bill is deliberately
   * unposted, and a screen gating on the difference would offer a Post
   * whose only possible outcome is to report it held again. Nor can the
   * two be subtracted anyway — holding a bill after it posts is allowed,
   * so the sets overlap.
   *
   * This is the figure a Post button belongs on, in place of
   * `!postedAt`: that stamp says a posting pass ran, which is not the
   * same as nothing being left. It is written unconditionally at the end
   * of the loop, so a run where three bills threw is marked posted with
   * three unposted bills still in it — and the screen hid the only way
   * to finish them.
   */
  awaitingPostCount: number;
}

export async function getBillingRun(utilityId: string, runId: string): Promise<BillingRunDetail> {
  const run = await prisma.billingRun.findFirst({
    where: { id: runId, utilityId },
    include: { cycle: RUN_CYCLE_SELECT },
  });
  if (!run) {
    throw Object.assign(new Error(`Billing run ${runId} not found`), {
      statusCode: 404,
      code: "RUN_NOT_FOUND",
    });
  }
  const billed = await prisma.billingRunItem.aggregate({
    where: { utilityId, billingRunId: runId, status: "BILLED" },
    _sum: { total: true },
  });
  /*
   * Distinct bills with a delivery that reached a provider. Grouped
   * rather than counted, because `count` would total the attempts and
   * a resent bill would read as two.
   */
  const billIds = (
    await prisma.billingRunItem.findMany({
      where: { utilityId, billingRunId: runId, status: "BILLED", billId: { not: null } },
      select: { billId: true },
    })
  ).map((i) => i.billId!);
  const sent =
    billIds.length === 0
      ? []
      : await prisma.notification.groupBy({
          by: ["billId"],
          where: { utilityId, status: "SENT", billId: { in: billIds } },
        });

  /*
   * Counted with the same predicate `postBillingRun`'s loop skips on, so
   * the figure a Post button is gated on cannot disagree with what a
   * Post would actually do: posted bills are done, and a bill held
   * either on itself or through its account is somebody's decision
   * rather than work outstanding.
   */
  const [postedCount, awaitingPostCount] =
    billIds.length === 0
      ? [0, 0]
      : await Promise.all([
          prisma.bill.count({
            where: { utilityId, id: { in: billIds }, postedAt: { not: null } },
          }),
          prisma.bill.count({
            where: {
              utilityId,
              id: { in: billIds },
              postedAt: null,
              holdReason: null,
              account: { billingHoldReason: null },
            },
          }),
        ]);

  return {
    ...toSummary(run),
    // Summed at 4dp like the column, and rounded by whatever prints it —
    // the same order as a bill's own subtotals.
    billedTotal: (billed._sum.total ?? new Prisma.Decimal(0)).toFixed(4),
    sentCount: sent.length,
    postedCount,
    awaitingPostCount,
  };
}

/** One cause, and how much of the run it accounts for. */
export interface RunExceptionGroup {
  /** FAILED or SKIPPED — never merged, since only one of them is work. */
  status: string;
  code: string;
  accountCount: number;
  /** A few account numbers, to recognise the group by. */
  sampleAccounts: string[];
  /** One account's sentence, as the reason in full. */
  message: string;
}

/**
 * A run's exceptions by cause.
 *
 * The item list answers "what happened to this account". An operator
 * working a run needs the other question first — "how many things do I
 * have to fix" — and the two differ by orders of magnitude: twelve
 * thousand accounts failing on one unpublished schedule is one job
 * reported forty times. `billing-runs/[id]/page.tsx` already says as
 * much next to the reason column, and `previewBillingRun` groups the
 * same way before a run, so this is that view after the fact.
 *
 * Grouped on `errorCode`, not the message: the messages name the account
 * they belong to, so grouping by sentence would reproduce the list it
 * replaces. Counted in the database rather than over the fetched page,
 * because the list is capped and the whole point is the size of the
 * group.
 */
export async function summariseRunExceptions(
  utilityId: string,
  runId: string,
): Promise<RunExceptionGroup[]> {
  const groups = await prisma.billingRunItem.groupBy({
    by: ["status", "errorCode"],
    where: {
      utilityId,
      billingRunId: runId,
      status: { in: ["FAILED", "SKIPPED"] },
    },
    _count: { _all: true },
    orderBy: { _count: { id: "desc" } },
  });

  // One query per group for its examples. Bounded by the number of
  // distinct codes, which is small by construction — a run with forty
  // different causes has a problem no grouping will help with.
  return Promise.all(
    groups.map(async (group) => {
      const samples = await prisma.billingRunItem.findMany({
        where: {
          utilityId,
          billingRunId: runId,
          status: group.status,
          errorCode: group.errorCode,
        },
        select: { errorMessage: true, account: { select: { accountNumber: true } } },
        orderBy: { id: "asc" },
        take: 3,
      });
      return {
        status: group.status,
        code: group.errorCode ?? "UNKNOWN",
        accountCount: group._count._all,
        sampleAccounts: samples.map((s) => s.account.accountNumber),
        message: samples[0]?.errorMessage ?? "",
      };
    }),
  );
}

export async function listBillingRunItems(
  utilityId: string,
  runId: string,
  query: { status?: string; limit: number; offset: number },
) {
  const items = await prisma.billingRunItem.findMany({
    where: {
      utilityId,
      billingRunId: runId,
      ...(query.status ? { status: query.status as "PENDING" } : {}),
    },
    include: {
      /*
       * The customer's name, because "who is this?" is the next question
       * after an account number on every exception an operator works,
       * and one join answers it rather than a page of lookups.
       */
      account: {
        select: {
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
    },
    orderBy: [{ status: "asc" }, { id: "asc" }],
    take: query.limit,
    skip: query.offset,
  });
  return items.map((i) => ({
    id: i.id,
    accountId: i.accountId,
    accountNumber: i.account.accountNumber,
    customerName: displayCustomerName(i.account.customer),
    status: i.status,
    billId: i.billId,
    servicePeriodStart: i.servicePeriodStart,
    servicePeriodEnd: i.servicePeriodEnd,
    segmentCount: i.segmentCount,
    total: i.total === null ? null : i.total.toFixed(4),
    errorCode: i.errorCode,
    errorMessage: i.errorMessage,
    processedAt: i.processedAt,
  }));
}
