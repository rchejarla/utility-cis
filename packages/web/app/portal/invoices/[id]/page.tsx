"use client";

import { use, useMemo } from "react";
import Link from "next/link";
import { getStoredUser } from "@/lib/api-client";
import {
  mockCustomerBills,
  fmtMoney,
  fmtDateRange,
  type MockInvoice,
  type InvoiceStatus,
} from "@/lib/mock-billing";

const STATUS_TONES: Record<
  InvoiceStatus,
  { bg: string; fg: string; border: string; label: string }
> = {
  DRAFT: { bg: "var(--bg-elevated)", fg: "var(--text-secondary)", border: "var(--border)", label: "Draft" },
  SENT: { bg: "var(--info-subtle)", fg: "var(--info)", border: "var(--info)", label: "Sent" },
  PARTIAL: { bg: "var(--warning-subtle)", fg: "var(--warning)", border: "var(--warning)", label: "Partially Paid" },
  OVERDUE: { bg: "var(--danger-subtle)", fg: "var(--danger)", border: "var(--danger)", label: "Overdue" },
  PAID: { bg: "var(--success-subtle)", fg: "var(--success)", border: "var(--success)", label: "Paid" },
};

const fieldStyle = {
  display: "grid" as const,
  gridTemplateColumns: "160px 1fr",
  gap: 8,
  padding: "10px 0",
  borderBottom: "1px solid var(--border-subtle)",
  alignItems: "start" as const,
};
const labelStyle = { fontSize: 12, color: "var(--text-muted)", fontWeight: 500 as const };
const valueStyle = { fontSize: 13, color: "var(--text-primary)" };

export default function PortalInvoiceDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const user = getStoredUser();
  const customerId = (user?.customerId as string) ?? "portal-mock";

  const invoice = useMemo<MockInvoice | null>(() => {
    const bills = mockCustomerBills(customerId, "");
    return bills.invoices.find((i) => i.id === id) ?? null;
  }, [id, customerId]);

  if (!invoice) {
    return (
      <div style={{ padding: 24 }}>
        <Link href="/portal/bills" style={{ fontSize: 12, color: "var(--text-muted)", textDecoration: "none" }}>
          ← Back to bills
        </Link>
        <p style={{ color: "var(--danger)", marginTop: 16 }}>Invoice not found.</p>
        <p style={{ fontSize: 13, color: "var(--text-muted)" }}>
          Invoice data is currently mocked. When the SaaSLogic billing integration is live, real invoices with full charge breakdowns will be displayed here.
        </p>
      </div>
    );
  }

  const due = invoice.total - invoice.amountPaid;
  const tone = STATUS_TONES[invoice.status];

  return (
    <div>
      <Link href="/portal/bills" style={{ fontSize: 12, color: "var(--text-muted)", textDecoration: "none", display: "inline-block", marginBottom: 16 }}>
        ← Back to bills
      </Link>

      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 24 }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 600, color: "var(--text-primary)", margin: "0 0 6px" }}>
            {invoice.invoiceNumber}
          </h1>
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 5,
              padding: "3px 10px",
              borderRadius: 999,
              fontSize: 11,
              fontWeight: 600,
              background: tone.bg,
              border: `1px solid ${tone.border}`,
              color: tone.fg,
            }}
          >
            <span style={{ width: 6, height: 6, borderRadius: "50%", background: tone.fg }} />
            {tone.label}
          </span>
        </div>

        {/* Pay now button */}
        <button
          disabled
          title="Payment via SaaSLogic — coming in Phase 3"
          style={{
            padding: "10px 24px",
            fontSize: 14,
            fontWeight: 600,
            background: "var(--bg-elevated)",
            color: "var(--text-muted)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius)",
            cursor: "not-allowed",
            fontFamily: "inherit",
          }}
        >
          Pay Now
        </button>
      </div>

      {/* Invoice details */}
      <div
        style={{
          background: "var(--bg-card)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius)",
          padding: "20px 24px",
          maxWidth: 600,
          marginBottom: 24,
        }}
      >
        <div style={fieldStyle}>
          <span style={labelStyle}>Billing period</span>
          <span style={valueStyle}>{fmtDateRange(invoice.periodStart, invoice.periodEnd)}</span>
        </div>
        <div style={fieldStyle}>
          <span style={labelStyle}>Premise</span>
          <span style={valueStyle}>{invoice.premiseLabel || "—"}</span>
        </div>
        <div style={fieldStyle}>
          <span style={labelStyle}>Commodities</span>
          <span style={valueStyle}>{invoice.commodities.join(", ")}</span>
        </div>
        <div style={fieldStyle}>
          <span style={labelStyle}>Issued</span>
          <span style={valueStyle}>{new Date(invoice.issuedAt).toLocaleDateString()}</span>
        </div>
        <div style={{ ...fieldStyle, borderBottom: "none" }}>
          <span style={labelStyle}>Invoice total</span>
          <span style={{ ...valueStyle, fontFamily: "'JetBrains Mono', monospace", fontSize: 18, fontWeight: 600 }}>
            {fmtMoney(invoice.total)}
          </span>
        </div>
      </div>

      {/* Payment summary */}
      <div
        style={{
          background: "var(--bg-card)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius)",
          padding: "20px 24px",
          maxWidth: 600,
          marginBottom: 24,
        }}
      >
        <h3 style={{ fontSize: 13, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--text-muted)", margin: "0 0 14px" }}>
          Payment Summary
        </h3>
        <div style={fieldStyle}>
          <span style={labelStyle}>Total charged</span>
          <span style={{ ...valueStyle, fontFamily: "'JetBrains Mono', monospace" }}>{fmtMoney(invoice.total)}</span>
        </div>
        {invoice.amountPaid > 0 && (
          <div style={fieldStyle}>
            <span style={labelStyle}>Amount paid</span>
            <span style={{ ...valueStyle, fontFamily: "'JetBrains Mono', monospace", color: "var(--success)" }}>{fmtMoney(invoice.amountPaid)}</span>
          </div>
        )}
        <div style={{ ...fieldStyle, borderBottom: "none" }}>
          <span style={{ ...labelStyle, fontWeight: 600 }}>Amount due</span>
          <span
            style={{
              ...valueStyle,
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: 18,
              fontWeight: 600,
              color: due > 0 ? "var(--danger)" : "var(--success)",
            }}
          >
            {fmtMoney(due)}
          </span>
        </div>
      </div>

      {/* Charge breakdown placeholder */}
      <div
        style={{
          padding: "16px 20px",
          background: "var(--bg-card)",
          border: "1px dashed var(--border)",
          borderRadius: "var(--radius)",
          fontSize: 12,
          color: "var(--text-muted)",
          lineHeight: 1.6,
          maxWidth: 600,
        }}
      >
        Itemized charge breakdown will be available when the SaaSLogic billing integration is live. This will include per-commodity charges, tiered pricing details, taxes, and any adjustments.
      </div>
    </div>
  );
}
