"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { StatCard } from "@/components/ui/stat-card";
import { StatusBadge } from "@/components/ui/status-badge";
import { apiClient } from "@/lib/api-client";

interface PortalDashboardData {
  customer: {
    id: string;
    firstName?: string;
    lastName?: string;
    organizationName?: string;
    customerType: string;
    email?: string;
  };
  accounts: Array<{
    id: string;
    accountNumber: string;
    accountType: string;
    status: string;
    serviceAgreements: Array<{
      id: string;
      agreementNumber: string;
      status: string;
      commodity?: { name: string };
      premise?: { addressLine1: string; city: string; state: string };
      billingCycle?: { name: string };
    }>;
  }>;
}

export default function PortalDashboardPage() {
  const [data, setData] = useState<PortalDashboardData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    apiClient.get<PortalDashboardData>("/portal/api/dashboard")
      .then(setData)
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
  const totalAgreements = accounts.reduce(
    (sum, a) => sum + a.serviceAgreements.length,
    0,
  );
  const activeAgreements = accounts.reduce(
    (sum, a) => sum + a.serviceAgreements.filter((s) => s.status === "ACTIVE").length,
    0,
  );

  return (
    <div>
      <div style={{ marginBottom: 24 }}>
        <h1
          style={{
            fontSize: 22,
            fontWeight: 600,
            color: "var(--text-primary)",
            margin: "0 0 4px",
          }}
        >
          Welcome back, {name || "Customer"}
        </h1>
        <p style={{ fontSize: 14, color: "var(--text-secondary)", margin: 0 }}>
          {customer.email ?? ""}
        </p>
      </div>

      <div
        style={{
          display: "flex",
          gap: 12,
          marginBottom: 24,
          flexWrap: "wrap",
        }}
      >
        <StatCard label="Accounts" value={accounts.length} icon="🏠" />
        <StatCard label="Active agreements" value={activeAgreements} icon="📄" />
        <StatCard label="Total agreements" value={totalAgreements} icon="📋" />
      </div>

      <div
        style={{
          display: "flex",
          gap: 12,
          marginBottom: 32,
          flexWrap: "wrap",
        }}
      >
        <QuickAction href="/portal/bills" label="View Bills" />
        <QuickAction href="/portal/usage" label="View Usage" />
        <QuickAction href="/portal/profile" label="Edit Profile" />
      </div>

      <h2
        style={{
          fontSize: 14,
          fontWeight: 600,
          color: "var(--text-primary)",
          textTransform: "uppercase",
          letterSpacing: "0.06em",
          margin: "0 0 16px",
        }}
      >
        Your service agreements
      </h2>

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
                    {sa.premise
                      ? `${sa.premise.addressLine1}, ${sa.premise.city}`
                      : "—"}
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
            {totalAgreements === 0 && (
              <tr>
                <td
                  colSpan={6}
                  style={{
                    padding: "32px 16px",
                    textAlign: "center",
                    color: "var(--text-muted)",
                    fontSize: 14,
                  }}
                >
                  No active service agreements found
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function QuickAction({ href, label }: { href: string; label: string }) {
  return (
    <Link
      href={href}
      style={{
        padding: "10px 20px",
        background: "var(--bg-card)",
        border: "1px solid var(--border)",
        borderRadius: "var(--radius)",
        color: "var(--text-primary)",
        fontSize: 13,
        fontWeight: 500,
        textDecoration: "none",
        transition: "background 0.12s",
      }}
    >
      {label} →
    </Link>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th
      style={{
        padding: "10px 16px",
        textAlign: "left",
        fontSize: 11,
        fontWeight: 600,
        textTransform: "uppercase",
        letterSpacing: "0.06em",
        color: "var(--text-muted)",
        borderBottom: "1px solid var(--border)",
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </th>
  );
}

function Td({ children }: { children: React.ReactNode }) {
  return (
    <td
      style={{
        padding: "12px 16px",
        fontSize: 13,
        color: "var(--text-primary)",
        borderBottom: "1px solid var(--border-subtle)",
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </td>
  );
}
