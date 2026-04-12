/**
 * Mock data for the Phase 3 billing UI. No real invoice / line-item /
 * SaaSLogic entities exist on the backend yet, so the new Bills and
 * Billing tabs render this deterministic fake data until Phase 3 ships.
 *
 * Every export is a pure function seeded by the entity ID so a given
 * customer or agreement always sees the same numbers, which is useful
 * for screenshotting, reviewing, and demoing.
 *
 * When Phase 3 lands, these functions should be deleted in favor of
 * real apiClient.get() calls — the return shapes were chosen to match
 * what the actual endpoints in docs/specs/21-saaslogic-billing.md will
 * eventually return.
 */

export type InvoiceStatus = "DRAFT" | "SENT" | "PARTIAL" | "OVERDUE" | "PAID";

export interface MockInvoice {
  id: string;
  invoiceNumber: string;
  periodStart: string; // ISO date
  periodEnd: string;
  commodities: string[];
  premiseLabel: string;
  total: number;
  amountPaid: number;
  status: InvoiceStatus;
  hostedUrl: string;
  issuedAt: string;
}

export interface MockBillsSummary {
  balanceDue: number;
  yearToDate: number;
  lifetimePaid: number;
  onTimeRate: number; // 0..1
  openInvoiceCount: number;
  totalInvoiceCount: number;
}

export interface MockCustomerBills {
  summary: MockBillsSummary;
  invoices: MockInvoice[];
  lastSyncedMinutesAgo: number;
}

export interface MockAgreementBilling {
  subscription: {
    id: string;
    planId: string;
    provisionedAt: string;
    linkStatus: "SYNCED" | "OUT_OF_SYNC" | "UNLINKED";
    lastReconciledSecondsAgo: number;
  };
  currentCycle: {
    period: string;
    closesInDays: number;
    usage: string;
    estimatedCharge: number;
    lastIntervalReadAt: string;
    lineItemState: "PENDING_CLOSE" | "SENT" | "ACKED";
  };
  recentActivity: Array<{
    when: string;
    event: string;
    detail: string;
    amount?: number;
    status: InvoiceStatus | "SYNCED";
  }>;
}

// ─── Determinism helpers ─────────────────────────────────────────────

/** Simple 32-bit hash so a given entity ID always produces the same
 *  mock numbers. Not cryptographic — just enough to make screenshots
 *  stable across renders. */
function hash(seed: string): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = (h * 16777619) >>> 0;
  }
  return h;
}

function seededRandom(seed: string, index = 0): () => number {
  let s = hash(seed + ":" + index);
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function isoMonth(monthsAgo: number, day = 1): string {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() - monthsAgo);
  d.setDate(day);
  return d.toISOString().slice(0, 10);
}

function lastDayOfMonth(monthsAgo: number): string {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() - monthsAgo + 1);
  d.setDate(0);
  return d.toISOString().slice(0, 10);
}

// ─── Exported builders ───────────────────────────────────────────────

export function mockCustomerBills(customerId: string, premiseLabel: string): MockCustomerBills {
  const rand = seededRandom(customerId);
  const invoiceCount = 7;
  const base = 320 + Math.floor(rand() * 180);

  const commodityRotation: string[][] = [
    ["electric"],
    ["electric", "water"],
    ["electric", "water"],
    ["electric", "water", "waste"],
    ["electric"],
    ["electric", "water"],
    ["electric"],
  ];

  // Status pattern matches what the mockup showed: one overdue, one
  // partial, one sent, a couple of paid, and an old draft.
  const statusPattern: InvoiceStatus[] = [
    "OVERDUE",
    "PAID",
    "PARTIAL",
    "PAID",
    "SENT",
    "PAID",
    "DRAFT",
  ];

  const invoices: MockInvoice[] = Array.from({ length: invoiceCount }).map((_, i) => {
    const total = round2(base + rand() * 220 - 100);
    const status = statusPattern[i] ?? "PAID";
    const amountPaid =
      status === "PAID"
        ? total
        : status === "PARTIAL"
          ? round2(total - 80)
          : 0;
    const issuedAt = isoMonth(i, 3);
    return {
      id: `inv-${customerId}-${i}`,
      invoiceNumber: `INV-${2604 - i}-${String(412 - i * 17).padStart(4, "0")}`,
      periodStart: isoMonth(i, 1),
      periodEnd: lastDayOfMonth(i),
      commodities: commodityRotation[i] ?? ["electric"],
      premiseLabel,
      total,
      amountPaid,
      status,
      hostedUrl: "#",
      issuedAt,
    };
  });

  const paidTotals = invoices
    .filter((i) => i.status === "PAID" || i.status === "PARTIAL")
    .reduce((sum, i) => sum + i.amountPaid, 0);
  const yearTotals = invoices
    .slice(0, 4)
    .reduce((sum, i) => sum + i.total, 0);

  return {
    summary: {
      balanceDue: invoices
        .filter((i) => i.status === "OVERDUE" || i.status === "PARTIAL")
        .reduce((sum, i) => sum + (i.total - i.amountPaid), 0),
      yearToDate: round2(yearTotals),
      lifetimePaid: round2(paidTotals + 47000 + rand() * 1000),
      onTimeRate: 0.984,
      openInvoiceCount: invoices.filter((i) => i.status !== "PAID").length,
      totalInvoiceCount: 56,
    },
    invoices,
    lastSyncedMinutesAgo: 2,
  };
}

export function mockAgreementBilling(agreementId: string): MockAgreementBilling {
  const rand = seededRandom(agreementId);
  const subId = "sub_" + agreementId.slice(0, 12).replace(/-/g, "");
  const estimatedCharge = round2(380 + rand() * 80);
  const usage = `${Math.floor(700 + rand() * 300)} kWh · ${(2.5 + rand() * 2).toFixed(1)} kgal · 1 cart`;

  return {
    subscription: {
      id: subId,
      planId: "plan_res_tier_2",
      provisionedAt: "Jan 14, 2026 · 14:22 UTC",
      linkStatus: "SYNCED",
      lastReconciledSecondsAgo: 36,
    },
    currentCycle: {
      period: "Apr 01 – Apr 30, 2026",
      closesInDays: 3,
      usage,
      estimatedCharge,
      lastIntervalReadAt: "Apr 11, 2026 · 06:00",
      lineItemState: "PENDING_CLOSE",
    },
    recentActivity: [
      {
        when: "Apr 11 · 02:16",
        event: "Line item pushed",
        detail: "April cycle · electric · 847 kWh",
        amount: estimatedCharge,
        status: "SENT",
      },
      {
        when: "Apr 03 · 09:12",
        event: "Invoice settled",
        detail: "INV-2603-0398 · auto-pay · card **** 4721",
        amount: 389.42,
        status: "PAID",
      },
      {
        when: "Mar 14 · 10:05",
        event: "Invoice settled",
        detail: "INV-2602-0301 · $80.00 follow-up paid",
        amount: 420.0,
        status: "PAID",
      },
      {
        when: "Jan 14 · 14:22",
        event: "Subscription provisioned",
        detail: `${subId} · plan plan_res_tier_2`,
        status: "SYNCED",
      },
    ],
  };
}

export function fmtMoney(n: number): string {
  return `$${n.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export function fmtDateRange(start: string, end: string): string {
  const s = new Date(start);
  const e = new Date(end);
  const opts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" };
  return `${s.toLocaleDateString(undefined, opts)} – ${e.toLocaleDateString(undefined, { ...opts, year: "numeric" })}`;
}
