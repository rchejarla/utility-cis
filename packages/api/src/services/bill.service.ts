import { Prisma } from "@utility-cis/shared/src/generated/prisma";
import { prisma } from "../lib/prisma.js";
import { auditCreate } from "../lib/audit-wrap.js";
import { EVENT_TYPES } from "@utility-cis/shared";

/**
 * Slice 5b.2 — per-Account Bill aggregation.
 *
 * Picks unbilled BillSegments belonging to one Account whose
 * `period_end` falls in the computed Bill period, sums totals, persists
 * a new Bill row, and links the segments via `bill_segment.bill_id` —
 * all in one transaction with an audit row.
 *
 * Period derivation honors the Account's `BillCycle.billDayOfMonth` +
 * frequency (Option 2 from the spec). MONTHLY only in 5b; BIMONTHLY /
 * QUARTERLY throw `UNSUPPORTED_FREQUENCY` until a real customer needs
 * them.
 */

const DEFAULT_DUE_DAYS = 30; // Hardcoded for 5b; tenant-configurable is a follow-up.

export interface GenerateBillInput {
  asOfDate?: Date;
}

export interface BillSegmentRow {
  id: string;
  segmentNumber: string;
  serviceAgreementId: string;
  periodStart: Date;
  periodEnd: Date;
  subtotal: string;
  taxes: string;
  credits: string;
  total: string;
  lines: BillSegmentLineRow[];
}

export interface BillSegmentLineRow {
  id: string;
  label: string;
  kindCode: string;
  amount: string;
  quantity: string | null;
  sortOrder: number;
}

export interface BillSummary {
  id: string;
  utilityId: string;
  accountId: string;
  billingCycleId: string;
  periodStart: Date;
  periodEnd: Date;
  billDate: Date;
  dueDate: Date;
  subtotal: string;
  taxes: string;
  credits: string;
  total: string;
  billNumber: string;
  createdAt: Date;
}

export interface BillWithSegments extends BillSummary {
  segments: BillSegmentRow[];
}

function billNumberPrefix(d: Date): string {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  return `BILL-${yyyy}${mm}-`;
}

async function nextBillNumber(
  tx: Prisma.TransactionClient,
  utilityId: string,
  now: Date,
): Promise<string> {
  const prefix = billNumberPrefix(now);
  const count = await tx.bill.count({
    where: { utilityId, billNumber: { startsWith: prefix } },
  });
  return `${prefix}${count + 1}`;
}

interface BillPeriod {
  periodStart: Date;
  periodEnd: Date;
}

/**
 * Compute (periodStart, periodEnd) for an Account given an asOfDate.
 *
 * MONTHLY example: billDay=15, asOfDate=2026-05-15 → period
 * 2026-04-16 to 2026-05-15. If today's day-of-month ≥ billDay, the
 * period closes today; otherwise it closed on the prior month's billDay.
 *
 * Mid-period accounts: periodStart is clamped to account.createdAt so
 * Bills don't claim a period that pre-dates the account.
 */
export function computeBillPeriod(
  account: {
    createdAt: Date;
    billingCycle: { billDayOfMonth: number; frequency: string };
  },
  asOfDate: Date,
): BillPeriod {
  const { billDayOfMonth, frequency } = account.billingCycle;
  if (frequency !== "MONTHLY") {
    throw Object.assign(
      new Error(`Bill cycle frequency ${frequency} is not yet supported (5b ships MONTHLY only)`),
      { statusCode: 501, code: "UNSUPPORTED_FREQUENCY" },
    );
  }

  // periodEnd: the most recent date ≤ asOfDate that lands on billDay.
  const y = asOfDate.getUTCFullYear();
  const m = asOfDate.getUTCMonth();
  const d = asOfDate.getUTCDate();
  let periodEnd: Date;
  if (d >= billDayOfMonth) {
    periodEnd = new Date(Date.UTC(y, m, billDayOfMonth));
  } else {
    periodEnd = new Date(Date.UTC(y, m - 1, billDayOfMonth));
  }
  // periodStart: one month prior to periodEnd, plus 1 day.
  const psYear = periodEnd.getUTCFullYear();
  const psMonth = periodEnd.getUTCMonth() - 1;
  const psDay = periodEnd.getUTCDate() + 1;
  let periodStart = new Date(Date.UTC(psYear, psMonth, psDay));

  // Clamp to account creation date for partial-period accounts.
  const acctCreated = new Date(Date.UTC(
    account.createdAt.getUTCFullYear(),
    account.createdAt.getUTCMonth(),
    account.createdAt.getUTCDate(),
  ));
  if (acctCreated > periodStart) periodStart = acctCreated;

  return { periodStart, periodEnd };
}

export async function generateBillForAccount(
  utilityId: string,
  actorId: string,
  actorName: string,
  accountId: string,
  input: GenerateBillInput,
): Promise<BillWithSegments> {
  const account = await prisma.account.findUnique({
    where: { id: accountId, utilityId },
    include: { billingCycle: true },
  });
  if (!account) {
    throw Object.assign(new Error(`Account ${accountId} not found`), {
      statusCode: 404,
      code: "ACCOUNT_NOT_FOUND",
    });
  }

  const asOfDate = input.asOfDate ?? new Date();
  const period = computeBillPeriod(account, asOfDate);

  // Pre-check: refuse to create a second Bill for the same period.
  // Two bills overlap if one's start ≤ other's end and vice versa.
  const existing = await prisma.bill.findFirst({
    where: {
      utilityId,
      accountId,
      periodEnd: { gte: period.periodStart },
      periodStart: { lte: period.periodEnd },
    },
    select: { id: true, billNumber: true },
  });
  if (existing) {
    throw Object.assign(
      new Error(
        `Account already has Bill ${existing.billNumber} covering this period`,
      ),
      {
        statusCode: 409,
        code: "BILL_ALREADY_EXISTS_FOR_PERIOD",
        existingBillId: existing.id,
      },
    );
  }

  return auditCreate(
    { utilityId, actorId, actorName, entityType: "Bill" },
    EVENT_TYPES.BILL_CREATED,
    async (tx) => {
      // Find unbilled segments for this account in the period. Joined
      // through ServiceAgreement (no denorm column on segment).
      const segments = await tx.billSegment.findMany({
        where: {
          utilityId,
          billId: null,
          serviceAgreement: { accountId },
          periodEnd: { gte: period.periodStart, lte: period.periodEnd },
        },
        include: { lines: { orderBy: { sortOrder: "asc" } } },
        orderBy: [{ periodEnd: "asc" }, { id: "asc" }],
      });

      if (segments.length === 0) {
        throw Object.assign(
          new Error(
            `No unbilled BillSegments for account ${accountId} in period [${period.periodStart.toISOString().slice(0, 10)}, ${period.periodEnd.toISOString().slice(0, 10)}]`,
          ),
          { statusCode: 400, code: "NO_SEGMENTS_TO_BILL" },
        );
      }

      // Sum totals at decimal(14,4) precision.
      let subtotal = new Prisma.Decimal(0);
      let taxes = new Prisma.Decimal(0);
      let credits = new Prisma.Decimal(0);
      let total = new Prisma.Decimal(0);
      for (const s of segments) {
        subtotal = subtotal.plus(s.subtotal);
        taxes = taxes.plus(s.taxes);
        credits = credits.plus(s.credits);
        total = total.plus(s.total);
      }

      const now = new Date();
      const billDate = period.periodEnd;
      const dueDate = new Date(billDate);
      dueDate.setUTCDate(dueDate.getUTCDate() + DEFAULT_DUE_DAYS);
      const billNumber = await nextBillNumber(tx, utilityId, now);

      const bill = await tx.bill.create({
        data: {
          utilityId,
          accountId,
          billingCycleId: account.billingCycleId,
          periodStart: period.periodStart,
          periodEnd: period.periodEnd,
          billDate,
          dueDate,
          subtotal,
          taxes,
          credits,
          total,
          billNumber,
        },
      });

      await tx.billSegment.updateMany({
        where: { id: { in: segments.map((s) => s.id) } },
        data: { billId: bill.id },
      });

      // Post to the ledger in THIS transaction when auto-post is on, so
      // a Bill and its receivable commit together or not at all.
      const { resolveAutoPostBills, postBill } = await import("./ar/posting.service.js");
      if (await resolveAutoPostBills(tx, utilityId, accountId)) {
        await postBill(utilityId, actorId, actorName, bill.id, {}, tx);
      }

      return assembleBillWithSegments(tx, utilityId, bill.id);
    },
  );
}

async function assembleBillWithSegments(
  tx: Prisma.TransactionClient,
  utilityId: string,
  id: string,
): Promise<BillWithSegments> {
  const bill = await tx.bill.findUniqueOrThrow({
    where: { id, utilityId },
    include: {
      segments: {
        orderBy: [{ periodEnd: "asc" }, { id: "asc" }],
        include: { lines: { orderBy: { sortOrder: "asc" } } },
      },
    },
  });
  return {
    id: bill.id,
    utilityId: bill.utilityId,
    accountId: bill.accountId,
    billingCycleId: bill.billingCycleId,
    periodStart: bill.periodStart,
    periodEnd: bill.periodEnd,
    billDate: bill.billDate,
    dueDate: bill.dueDate,
    subtotal: bill.subtotal.toFixed(4),
    taxes: bill.taxes.toFixed(4),
    credits: bill.credits.toFixed(4),
    total: bill.total.toFixed(4),
    billNumber: bill.billNumber,
    createdAt: bill.createdAt,
    segments: bill.segments.map((s) => ({
      id: s.id,
      segmentNumber: s.segmentNumber,
      serviceAgreementId: s.serviceAgreementId,
      periodStart: s.periodStart,
      periodEnd: s.periodEnd,
      subtotal: s.subtotal.toFixed(4),
      taxes: s.taxes.toFixed(4),
      credits: s.credits.toFixed(4),
      total: s.total.toFixed(4),
      lines: s.lines.map((l) => ({
        id: l.id,
        label: l.label,
        kindCode: l.kindCode,
        amount: l.amount.toFixed(4),
        quantity: l.quantity ? l.quantity.toFixed(4) : null,
        sortOrder: l.sortOrder,
      })),
    })),
  };
}

export async function listBillsForAccount(
  utilityId: string,
  accountId: string,
): Promise<BillSummary[]> {
  const bills = await prisma.bill.findMany({
    where: { utilityId, accountId },
    orderBy: { periodEnd: "desc" },
  });
  return bills.map((b) => ({
    id: b.id,
    utilityId: b.utilityId,
    accountId: b.accountId,
    billingCycleId: b.billingCycleId,
    periodStart: b.periodStart,
    periodEnd: b.periodEnd,
    billDate: b.billDate,
    dueDate: b.dueDate,
    subtotal: b.subtotal.toFixed(4),
    taxes: b.taxes.toFixed(4),
    credits: b.credits.toFixed(4),
    total: b.total.toFixed(4),
    billNumber: b.billNumber,
    createdAt: b.createdAt,
  }));
}

export async function getBill(
  utilityId: string,
  id: string,
): Promise<BillWithSegments> {
  return assembleBillWithSegments(prisma as unknown as Prisma.TransactionClient, utilityId, id);
}
