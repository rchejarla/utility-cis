"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { StatCard } from "@/components/ui/stat-card";
import { StatusBadge } from "@/components/ui/status-badge";
import { apiClient } from "@/lib/api-client";
import {
  mockCustomerBills,
  fmtMoney,
  fmtDateRange,
  type MockInvoice,
} from "@/lib/mock-billing";

interface Agreement {
  id: string;
  agreementNumber: string;
  status: string;
  commodity?: { name: string };
  premise?: { addressLine1: string; city: string; state: string };
}

interface AccountWithAgreements {
  id: string;
  accountNumber: string;
  accountType: string;
  status: string;
  serviceAgreements: Agreement[];
}

interface PortalDashboardData {
  customer: {
    id: string;
    firstName?: string;
    lastName?: string;
    organizationName?: string;
    customerType: string;
    email?: string;
  };
  accounts: AccountWithAgreements[];
}

interface ReadRow {
  id: string;
  readDate: string;
  consumption: string;
  meter: { meterNumber: string };
  uom?: { code: string; name: string };
}

export default function PortalDashboardPage() {
  const router = useRouter();
  const [data, setData] = useState<PortalDashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [latestReads, setLatestReads] = useState<Map<string, ReadRow>>(new Map());
  const [expandedInvoice, setExpandedInvoice] = useState<string | null>(null);

  useEffect(() => {
    apiClient.get<PortalDashboardData>("/portal/api/dashboard")
      .then((d) => {
        setData(d);
        const active = (d.accounts ?? [])
          .flatMap((a) => a.serviceAgreements)
          .filter((sa) => sa.status === "ACTIVE");
        for (const sa of active) {
          apiClient
            .get<{ data: ReadRow[] }>(`/portal/api/agreements/${sa.id}/usage`, { from: "2020-01", to: "2099-12" })
            .then((res) => {
              const reads = res.data ?? [];
              if (reads.length > 0) {
                setLatestReads((prev) => new Map(prev).set(sa.id, reads[reads.length - 1]));
              }
            })
            .catch(() => {});
        }
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <p style={{ color: "var(--text-muted)", padding: 24 }}>Loading dashboard…</p>;
  if (!data) return <p style={{ color: "var(--danger)", padding: 24 }}>Failed to load dashboard.</p>;

  const { customer, accounts } = data;
  const name =
    customer.customerType === "ORGANIZATION"
      ? customer.organizationName
      : `${customer.firstName ?? ""} ${customer.lastName ?? ""}`.trim();
  const activeAgreements = accounts.flatMap((a) => a.serviceAgreements).filter((s) => s.status === "ACTIVE");
  const mockBills = mockCustomerBills(customer.id, "");
  const pendingInvoices = mockBills.invoices.filter((i) => i.status === "OVERDUE" || i.status === "SENT" || i.status === "PARTIAL");
  const totalDue = pendingInvoices.reduce((sum, i) => sum + (i.total - i.amountPaid), 0);

  // If only one account, clicking should go straight to it
  const singleAccount = accounts.length === 1 ? accounts[0] : null;

  return (
    <div>
      <div style={{ marginBottom: 24 }}>
        <h1 style={{ fontSize: 22, fontWeight: 600, color: "var(--text-primary)", margin: "0 0 4px" }}>
          Welcome back, {name || "Customer"}
        </h1>
        <p style={{ fontSize: 14, color: "var(--text-secondary)", margin: 0 }}>{customer.email ?? ""}</p>
      </div>

      <div style={{ display: "flex", gap: 12, marginBottom: 24, flexWrap: "wrap" }}>
        <StatCard label="Balance due" value={totalDue > 0 ? fmtMoney(totalDue) : "$0.00"} icon="💰" />
        <StatCard label="Active services" value={activeAgreements.length} icon="📄" />
        <StatCard label="Accounts" value={accounts.length} icon="🏠" />
      </div>

      {/* Two-column: pending payments + current usage */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 32 }}>

        {/* Pending payments — expandable rows */}
        <div style={{ background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: "var(--radius)", overflow: "hidden" }}>
          <div style={sectionHeadStyle}>Pending Payments</div>
          {pendingInvoices.length === 0 ? (
            <div style={{ padding: "24px 16px", textAlign: "center", color: "var(--text-muted)", fontSize: 13 }}>
              No outstanding payments
            </div>
          ) : (
            <div>
              {pendingInvoices.map((inv) => (
                <InvoiceRow
                  key={inv.id}
                  invoice={inv}
                  expanded={expandedInvoice === inv.id}
                  onToggle={() => setExpandedInvoice(expandedInvoice === inv.id ? null : inv.id)}
                />
              ))}
              <div style={{ padding: "10px 16px", borderTop: "1px solid var(--border)", display: "flex", justifyContent: "space-between", fontSize: 13, fontWeight: 600 }}>
                <span style={{ color: "var(--text-secondary)" }}>Total due</span>
                <span style={{ fontFamily: "'JetBrains Mono', monospace", color: "var(--danger)" }}>{fmtMoney(totalDue)}</span>
              </div>
            </div>
          )}
        </div>

        {/* Current usage — clickable rows */}
        <div style={{ background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: "var(--radius)", overflow: "hidden" }}>
          <div style={sectionHeadStyle}>Current Usage</div>
          {activeAgreements.length === 0 ? (
            <div style={{ padding: "24px 16px", textAlign: "center", color: "var(--text-muted)", fontSize: 13 }}>No active services</div>
          ) : (
            <div>
              {activeAgreements.map((sa) => {
                const read = latestReads.get(sa.id);
                return (
                  <div
                    key={sa.id}
                    onClick={() => router.push(`/portal/usage?agreement=${sa.id}`)}
                    style={{
                      padding: "12px 16px",
                      borderBottom: "1px solid var(--border-subtle)",
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      cursor: "pointer",
                      transition: "background 0.1s",
                    }}
                    onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = "var(--bg-hover)"; }}
                    onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = "transparent"; }}
                  >
                    <div>
                      <div style={{ fontSize: 13, fontWeight: 500, color: "var(--text-primary)" }}>
                        {sa.commodity?.name ?? "Service"}
                        <span style={{ fontSize: 11, color: "var(--text-muted)" }}> · {sa.premise?.addressLine1 ?? sa.agreementNumber}</span>
                      </div>
                      {read && (
                        <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 2 }}>
                          Last read: {new Date(read.readDate).toLocaleDateString()}
                        </div>
                      )}
                    </div>
                    <div style={{ textAlign: "right", display: "flex", alignItems: "center", gap: 8 }}>
                      {read ? (
                        <>
                          <div>
                            <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 15, fontWeight: 600, color: "var(--text-primary)" }}>
                              {Number(read.consumption).toLocaleString()}
                            </div>
                            <div style={{ fontSize: 11, color: "var(--text-muted)" }}>{read.uom?.code ?? "units"}</div>
                          </div>
                        </>
                      ) : (
                        <span style={{ fontSize: 12, color: "var(--text-muted)" }}>No data</span>
                      )}
                      <span style={{ fontSize: 12, color: "var(--text-muted)" }}>→</span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* Accounts section */}
      <h2 style={sectionTitleStyle}>Your Accounts</h2>
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {accounts.map((acct) => {
          const premises = new Set(acct.serviceAgreements.map((sa) => sa.premise?.addressLine1).filter(Boolean));
          const commodities = new Set(acct.serviceAgreements.map((sa) => sa.commodity?.name).filter(Boolean));

          return (
            <div
              key={acct.id}
              onClick={() => router.push(`/portal/accounts/${acct.id}`)}
              style={{
                background: "var(--bg-card)",
                border: "1px solid var(--border)",
                borderRadius: "var(--radius)",
                padding: "16px 20px",
                cursor: "pointer",
                transition: "border-color 0.15s",
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
              }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.borderColor = "var(--accent-primary)"; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.borderColor = "var(--border)"; }}
            >
              <div>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <span style={{ fontSize: 15, fontWeight: 600, color: "var(--text-primary)", fontFamily: "'JetBrains Mono', monospace" }}>
                    {acct.accountNumber}
                  </span>
                  <StatusBadge status={acct.status} />
                </div>
                <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 4 }}>
                  {acct.accountType} · {acct.serviceAgreements.length} service{acct.serviceAgreements.length !== 1 ? "s" : ""}
                  {premises.size > 0 && <> · {Array.from(premises).join(", ")}</>}
                </div>
                {commodities.size > 0 && (
                  <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
                    {Array.from(commodities).map((c) => (
                      <span
                        key={c}
                        style={{
                          padding: "2px 8px",
                          borderRadius: 999,
                          fontSize: 11,
                          fontWeight: 500,
                          background: "var(--accent-primary-subtle)",
                          color: "var(--accent-primary)",
                          border: "1px solid var(--accent-primary)",
                        }}
                      >
                        {c}
                      </span>
                    ))}
                  </div>
                )}
              </div>
              <span style={{ fontSize: 14, color: "var(--text-muted)" }}>→</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function InvoiceRow({
  invoice,
  expanded,
  onToggle,
}: {
  invoice: MockInvoice;
  expanded: boolean;
  onToggle: () => void;
}) {
  const due = invoice.total - invoice.amountPaid;
  const statusColor = invoice.status === "OVERDUE" ? "var(--danger)" : invoice.status === "PARTIAL" ? "var(--warning)" : "var(--info)";
  const statusLabel = invoice.status === "OVERDUE" ? "Overdue" : invoice.status === "PARTIAL" ? "Partial" : "Due";

  return (
    <div>
      <div
        onClick={onToggle}
        style={{
          padding: "12px 16px",
          borderBottom: "1px solid var(--border-subtle)",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          cursor: "pointer",
          transition: "background 0.1s",
        }}
        onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = "var(--bg-hover)"; }}
        onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = "transparent"; }}
      >
        <div>
          <div style={{ fontSize: 12, fontWeight: 500, color: "var(--text-primary)" }}>{invoice.invoiceNumber}</div>
          <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 1 }}>{invoice.commodities.join(" · ")}</div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ fontSize: 10, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.04em", color: statusColor }}>{statusLabel}</span>
          <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 14, fontWeight: 600, color: "var(--text-primary)" }}>{fmtMoney(due)}</span>
          <span style={{ fontSize: 12, color: "var(--text-muted)", transition: "transform 0.15s", transform: expanded ? "rotate(90deg)" : "none" }}>›</span>
        </div>
      </div>

      {expanded && (
        <div style={{ padding: "12px 16px 16px", background: "var(--bg-surface)", borderBottom: "1px solid var(--border-subtle)" }}>
          <div style={{ display: "grid", gridTemplateColumns: "120px 1fr", gap: "6px 12px", fontSize: 12, marginBottom: 12 }}>
            <span style={{ color: "var(--text-muted)" }}>Period</span>
            <span style={{ color: "var(--text-primary)" }}>{fmtDateRange(invoice.periodStart, invoice.periodEnd)}</span>
            <span style={{ color: "var(--text-muted)" }}>Total</span>
            <span style={{ color: "var(--text-primary)", fontFamily: "'JetBrains Mono', monospace" }}>{fmtMoney(invoice.total)}</span>
            {invoice.amountPaid > 0 && (
              <>
                <span style={{ color: "var(--text-muted)" }}>Paid</span>
                <span style={{ color: "var(--success)", fontFamily: "'JetBrains Mono', monospace" }}>{fmtMoney(invoice.amountPaid)}</span>
              </>
            )}
            <span style={{ color: "var(--text-muted)" }}>Amount due</span>
            <span style={{ color: "var(--danger)", fontWeight: 600, fontFamily: "'JetBrains Mono', monospace" }}>{fmtMoney(due)}</span>
          </div>
          <button
            disabled
            title="Payment via SaaSLogic — coming in Phase 3"
            style={{
              padding: "8px 16px",
              fontSize: 12,
              fontWeight: 600,
              background: "var(--bg-elevated)",
              color: "var(--text-muted)",
              border: "1px solid var(--border)",
              borderRadius: "var(--radius)",
              cursor: "not-allowed",
              fontFamily: "inherit",
            }}
          >
            Pay Now (Phase 3)
          </button>
        </div>
      )}
    </div>
  );
}

const sectionHeadStyle: React.CSSProperties = {
  padding: "10px 16px",
  background: "var(--bg-elevated)",
  borderBottom: "1px solid var(--border)",
  fontSize: 11,
  fontWeight: 600,
  textTransform: "uppercase",
  letterSpacing: "0.06em",
  color: "var(--text-muted)",
};

const sectionTitleStyle: React.CSSProperties = {
  fontSize: 14,
  fontWeight: 600,
  color: "var(--text-primary)",
  textTransform: "uppercase",
  letterSpacing: "0.06em",
  margin: "0 0 16px",
};
