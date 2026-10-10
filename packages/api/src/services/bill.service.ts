import { Prisma } from "@utility-cis/shared/src/generated/prisma";
import { prisma } from "../lib/prisma.js";
import { auditCreate } from "../lib/audit-wrap.js";
import { paginatedTenantList } from "../lib/pagination.js";
import {
  EVENT_TYPES,
  billSortFields,
  type BillQuery,
  type PaginatedResponse,
} from "@utility-cis/shared";

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
  /**
   * When this bill became a receivable, or null if it has not. A bill is
   * a calculation until it is posted; only then does it move a balance.
   * Every consumer of a bill needs to tell those apart, so it belongs on
   * the summary rather than being fetched separately.
   */
  postedAt: Date | null;
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
    postedAt: bill.postedAt,
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

/** A bill in the tenant-wide list, carrying who it belongs to. */
export interface BillListRow extends BillSummary {
  account: {
    id: string;
    accountNumber: string;
    customerName: string | null;
  };
  billingCycleName: string | null;
}

/**
 * The tenant-wide bill list.
 *
 * Exists because every other bill route is account-scoped or single-id,
 * so a bill number could not be looked up without already knowing which
 * account it belonged to — the one thing a caller reading a bill aloud
 * does not know.
 *
 * Returns the account number and customer name per row rather than ids
 * alone: a list of bill numbers against account uuids is unusable for the
 * lookup this list exists to serve.
 */
export async function listBills(
  utilityId: string,
  query: BillQuery,
): Promise<PaginatedResponse<BillListRow>> {
  const where: Record<string, unknown> = { utilityId };

  if (query.accountId) where.accountId = query.accountId;
  if (query.billingCycleId) where.billingCycleId = query.billingCycleId;

  // Tri-state. `undefined` must not collapse to either branch, or the
  // list silently hides half the bills.
  if (query.posted !== undefined) {
    where.postedAt = query.posted ? { not: null } : null;
  }

  if (query.from || query.to) {
    const range: Record<string, Date> = {};
    if (query.from) range.gte = new Date(query.from);
    // Both bounds are inclusive. A plain `lte` is correct here only
    // because `bill.billDate` is `@db.Date` — it carries no time, so
    // midnight on the 30th is the whole of the 30th. If that column ever
    // becomes a timestamp this has to become `lt` the following day, or
    // the final day's bills drop out of every range query.
    if (query.to) range.lte = new Date(query.to);
    where.billDate = range;
  }

  if (query.search) {
    where.billNumber = { contains: query.search, mode: "insensitive" };
  }

  const page = await paginatedTenantList<
    Prisma.BillGetPayload<{
      include: {
        account: {
          select: {
            id: true;
            accountNumber: true;
            customer: {
              select: {
                customerType: true;
                firstName: true;
                lastName: true;
                organizationName: true;
              };
            };
          };
        };
        billingCycle: { select: { name: true } };
      };
    }>
  >(prisma.bill, where, query, {
    allowedSorts: billSortFields,
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
      billingCycle: { select: { name: true } },
    },
  });

  return {
    ...page,
    data: page.data.map((b) => ({
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
      postedAt: b.postedAt,
      account: {
        id: b.account.id,
        accountNumber: b.account.accountNumber,
        customerName: displayCustomerName(b.account.customer),
      },
      billingCycleName: b.billingCycle?.name ?? null,
    })),
  };
}

/**
 * One name for a customer who is either a person or an organisation.
 * Returns null rather than an empty string when neither is usable, so the
 * caller decides how to render "unknown" instead of inheriting a blank.
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
  if (customer.customerType === "ORGANIZATION") {
    return customer.organizationName ?? null;
  }
  const name = `${customer.firstName ?? ""} ${customer.lastName ?? ""}`.trim();
  return name === "" ? null : name;
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
    postedAt: b.postedAt,
  }));
}

export async function getBill(
  utilityId: string,
  id: string,
): Promise<BillWithSegments> {
  return assembleBillWithSegments(prisma as unknown as Prisma.TransactionClient, utilityId, id);
}
