"use client";

import { useEffect, useState } from "react";
import { StatCard } from "@/components/ui/stat-card";
import { StatusBadge } from "@/components/ui/status-badge";
import { apiClient } from "@/lib/api-client";
import {
  mockCustomerBills,
  fmtMoney,
  type MockInvoice,
} from "@/lib/mock-billing";

interface Agreement {
  id: string;
  agreementNumber: string;
  status: string;
  commodity?: { name: string };
  premise?: { addressLine1: string; city: string; state: string };
  billingCycle?: { name: string };
}

interface AccountWithAgreements {
  id: string;
  accountNumber: string;
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
  reading: string;
  consumption: string;
  readType: string;
  meter: { meterNumber: string };
  uom?: { code: string; name: string };
}

export default function PortalDashboardPage() {
  const [data, setData] = useState<PortalDashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [latestReads, setLatestReads] = useState<Map<string, ReadRow>>(new Map());

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
                const latest = reads[reads.length - 1];
                setLatestReads((prev) => new Map(prev).set(sa.id, latest));
              }
            })
            .catch(() => {});
        }
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return <p style={{ color: "var(--text-muted)", padding: 24 }}>Loading dashboard…</p>;
  }

  if (!data) {
    return <p style={{ color: "var(--danger)", padding: 24 }}>Failed to load dashboard. Are you logged in?</p>;
  }

  const { customer, accounts } = data;
  const name =
    customer.customerType === "ORGANIZATION"
      ? customer.organizationName
      : `${customer.firstName ?? ""} ${customer.lastName ?? ""}`.trim();
  const activeAgreements = accounts
    .flatMap((a) => a.serviceAgreements)
    .filter((s) => s.status === "ACTIVE");

  // Mock pending payments (from the same mock-billing module the Bills tab uses)
  const mockBills = mockCustomerBills(customer.id, "");
  const pendingInvoices = mockBills.invoices.filter(
    (i) => i.status === "OVERDUE" || i.status === "SENT" || i.status === "PARTIAL",
  );
  const totalDue = pendingInvoices.reduce((sum, i) => sum + (i.total - i.amountPaid), 0);

  return (
    <div>
      {/* Welcome header */}
      <div style={{ marginBottom: 24 }}>
        <h1 style={{ fontSize: 22, fontWeight: 600, color: "var(--text-primary)", margin: "0 0 4px" }}>
          Welcome back, {name || "Customer"}
        </h1>
        <p style={{ fontSize: 14, color: "var(--text-secondary)", margin: 0 }}>
          {customer.email ?? ""}
        </p>
      </div>

      {/* Stat cards */}
      <div style={{ display: "flex", gap: 12, marginBottom: 24, flexWrap: "wrap" }}>
        <StatCard
          label="Balance due"
          value={totalDue > 0 ? fmtMoney(totalDue) : "$0.00"}
          icon="💰"
        />
        <StatCard label="Active services" value={activeAgreements.length} icon="📄" />
        <StatCard label="Accounts" value={accounts.length} icon="🏠" />
      </div>

      {/* Two-column layout: pending payments + current usage */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 32 }}>

        {/* Pending payments */}
        <div
          style={{
            background: "var(--bg-card)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius)",
            overflow: "hidden",
          }}
        >
          <div style={sectionHeadStyle}>Pending Payments</div>
          {pendingInvoices.length === 0 ? (
            <div style={{ padding: "24px 16px", textAlign: "center", color: "var(--text-muted)", fontSize: 13 }}>
              No outstanding payments
            </div>
          ) : (
            <div>
              {pendingInvoices.map((inv) => (
                <PendingPaymentRow key={inv.id} invoice={inv} />
              ))}
              <div
                style={{
                  padding: "10px 16px",
                  borderTop: "1px solid var(--border)",
                  display: "flex",
                  justifyContent: "space-between",
                  fontSize: 13,
                  fontWeight: 600,
                }}
              >
                <span style={{ color: "var(--text-secondary)" }}>Total due</span>
                <span
                  style={{
                    fontFamily: "'JetBrains Mono', monospace",
                    color: "var(--danger)",
                  }}
                >
                  {fmtMoney(totalDue)}
                </span>
              </div>
            </div>
          )}
        </div>

        {/* Current usage */}
        <div
          style={{
            background: "var(--bg-card)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius)",
            overflow: "hidden",
          }}
        >
          <div style={sectionHeadStyle}>Current Usage</div>
          {activeAgreements.length === 0 ? (
            <div style={{ padding: "24px 16px", textAlign: "center", color: "var(--text-muted)", fontSize: 13 }}>
              No active services
            </div>
          ) : (
            <div>
              {activeAgreements.map((sa) => {
                const read = latestReads.get(sa.id);
                return (
                  <div
                    key={sa.id}
                    style={{
                      padding: "12px 16px",
                      borderBottom: "1px solid var(--border-subtle)",
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                    }}
                  >
                    <div>
                      <div style={{ fontSize: 13, fontWeight: 500, color: "var(--text-primary)" }}>
                        {sa.commodity?.name ?? "Service"}{" "}
                        <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
                          · {sa.premise ? `${sa.premise.addressLine1}` : sa.agreementNumber}
                        </span>
                      </div>
                      {read && (
                        <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 2 }}>
                          Last read: {new Date(read.readDate).toLocaleDateString()}
                        </div>
                      )}
                    </div>
                    <div style={{ textAlign: "right" }}>
                      {read ? (
                        <>
                          <div
                            style={{
                              fontFamily: "'JetBrains Mono', monospace",
                              fontSize: 15,
                              fontWeight: 600,
                              color: "var(--text-primary)",
                            }}
                          >
                            {Number(read.consumption).toLocaleString()}
                          </div>
                          <div style={{ fontSize: 11, color: "var(--text-muted)" }}>
                            {read.uom?.code ?? "units"}
                          </div>
                        </>
                      ) : (
                        <span style={{ fontSize: 12, color: "var(--text-muted)" }}>No data</span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* Agreements table */}
      <h2 style={sectionTitleStyle}>Your service agreements</h2>
      <div
        style={{
          background: "var(--bg-card)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius)",
          overflow: "hidden",
        }}
      >
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ background: "var(--bg-elevated)" }}>
              <Th>Agreement</Th>
              <Th>Account</Th>
              <Th>Premise</Th>
              <Th>Commodity</Th>
              <Th>Cycle</Th>
              <Th>Status</Th>
            </tr>
          </thead>
          <tbody>
            {accounts.flatMap((acct) =>
              acct.serviceAgreements.map((sa) => (
                <tr key={sa.id}>
                  <Td>
                    <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 12, fontWeight: 600 }}>
                      {sa.agreementNumber}
                    </span>
                  </Td>
                  <Td>
                    <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>
                      {acct.accountNumber}
                    </span>
                  </Td>
                  <Td>
                    {sa.premise ? `${sa.premise.addressLine1}, ${sa.premise.city}` : "—"}
                  </Td>
                  <Td>{sa.commodity?.name ?? "—"}</Td>
                  <Td>
                    <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
                      {sa.billingCycle?.name ?? "—"}
                    </span>
                  </Td>
                  <Td><StatusBadge status={sa.status} /></Td>
                </tr>
              )),
            )}
            {accounts.flatMap((a) => a.serviceAgreements).length === 0 && (
              <tr>
                <td colSpan={6} style={{ padding: "32px 16px", textAlign: "center", color: "var(--text-muted)", fontSize: 14 }}>
                  No service agreements found
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function PendingPaymentRow({ invoice }: { invoice: MockInvoice }) {
  const due = invoice.total - invoice.amountPaid;
  const statusColor =
    invoice.status === "OVERDUE"
      ? "var(--danger)"
      : invoice.status === "PARTIAL"
        ? "var(--warning)"
        : "var(--info)";
  const statusLabel =
    invoice.status === "OVERDUE"
      ? "Overdue"
      : invoice.status === "PARTIAL"
        ? "Partial"
        : "Due";

  return (
    <div
      style={{
        padding: "12px 16px",
        borderBottom: "1px solid var(--border-subtle)",
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
      }}
    >
      <div>
        <div style={{ fontSize: 12, fontWeight: 500, color: "var(--text-primary)" }}>
          {invoice.invoiceNumber}
        </div>
        <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 1 }}>
          {invoice.commodities.join(" · ")}
        </div>
      </div>
      <div style={{ textAlign: "right", display: "flex", alignItems: "center", gap: 10 }}>
        <span
          style={{
            fontSize: 10,
            fontWeight: 600,
            textTransform: "uppercase",
            letterSpacing: "0.04em",
            color: statusColor,
          }}
        >
          {statusLabel}
        </span>
        <span
          style={{
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: 14,
            fontWeight: 600,
            color: "var(--text-primary)",
          }}
        >
          {fmtMoney(due)}
        </span>
      </div>
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

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th style={{ padding: "10px 16px", textAlign: "left", fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--text-muted)", borderBottom: "1px solid var(--border)", whiteSpace: "nowrap" }}>
      {children}
    </th>
  );
}

function Td({ children }: { children: React.ReactNode }) {
  return (
    <td style={{ padding: "12px 16px", fontSize: 13, color: "var(--text-primary)", borderBottom: "1px solid var(--border-subtle)", whiteSpace: "nowrap" }}>
      {children}
    </td>
  );
}
