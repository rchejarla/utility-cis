"use client";

import { useState, useEffect, use } from "react";
import { useRouter } from "next/navigation";
import { PageHeader } from "@/components/ui/page-header";
import { Tabs } from "@/components/ui/tabs";
import { StatusBadge } from "@/components/ui/status-badge";
import { DataTable } from "@/components/ui/data-table";
import { apiClient } from "@/lib/api-client";

interface Account {
  id: string;
  accountNumber: string;
  accountType: string;
  status: string;
  creditRating?: string;
  depositAmount?: number;
  languagePref?: string;
  serviceAgreements?: Array<{
    id: string;
    agreementNumber: string;
    status: string;
    startDate: string;
    premise?: { addressLine1: string; city: string };
  }>;
  createdAt?: string;
  updatedAt?: string;
}

interface AuditEntry {
  id: string;
  action: string;
  actorId?: string;
  createdAt: string;
}

const fieldStyle = {
  display: "grid" as const,
  gridTemplateColumns: "160px 1fr",
  gap: "8px",
  padding: "10px 0",
  borderBottom: "1px solid var(--border-subtle)",
  alignItems: "start" as const,
};
const labelStyle = { fontSize: "12px", color: "var(--text-muted)", fontWeight: "500" as const };
const valueStyle = { fontSize: "13px", color: "var(--text-primary)" };

export default function AccountDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const [account, setAccount] = useState<Account | null>(null);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState("overview");

  useEffect(() => {
    apiClient
      .get<Account>(`/api/v1/accounts/${id}`)
      .then((data) => setAccount(data))
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [id]);

  useEffect(() => {
    if (activeTab === "audit") {
      apiClient
        .get<{ data: AuditEntry[] }>("/api/v1/audit-log", {
          entityType: "Account",
          entityId: id,
        })
        .then((res) => setAudit(res.data ?? []))
        .catch(console.error);
    }
  }, [activeTab, id]);

  if (loading) {
    return <div style={{ color: "var(--text-muted)", padding: "40px 0" }}>Loading...</div>;
  }
  if (!account) {
    return <div style={{ color: "var(--text-muted)", padding: "40px 0" }}>Account not found.</div>;
  }

  return (
    <div>
      <PageHeader
        title={account.accountNumber}
        subtitle={`${account.accountType} account`}
      />

      <Tabs
        tabs={[
          { key: "overview", label: "Overview" },
          { key: "agreements", label: `Agreements (${account.serviceAgreements?.length ?? 0})` },
          { key: "audit", label: "Audit" },
        ]}
        activeTab={activeTab}
        onTabChange={setActiveTab}
      >
        {activeTab === "overview" && (
          <div
            style={{
              background: "var(--bg-card)",
              border: "1px solid var(--border)",
              borderRadius: "var(--radius)",
              padding: "20px 24px",
            }}
          >
            <div style={fieldStyle}>
              <span style={labelStyle}>Status</span>
              <StatusBadge status={account.status} />
            </div>
            <div style={fieldStyle}>
              <span style={labelStyle}>Account Number</span>
              <span style={{ ...valueStyle, fontFamily: "monospace" }}>{account.accountNumber}</span>
            </div>
            <div style={fieldStyle}>
              <span style={labelStyle}>Account Type</span>
              <span style={valueStyle}>{account.accountType}</span>
            </div>
            <div style={fieldStyle}>
              <span style={labelStyle}>Credit Rating</span>
              <span style={valueStyle}>{account.creditRating ?? "—"}</span>
            </div>
            <div style={fieldStyle}>
              <span style={labelStyle}>Deposit Amount</span>
              <span style={valueStyle}>
                {account.depositAmount != null
                  ? `$${account.depositAmount.toFixed(2)}`
                  : "—"}
              </span>
            </div>
            <div style={fieldStyle}>
              <span style={labelStyle}>Language Pref</span>
              <span style={valueStyle}>{account.languagePref ?? "—"}</span>
            </div>
            {account.createdAt && (
              <div style={fieldStyle}>
                <span style={labelStyle}>Created</span>
                <span style={valueStyle}>{new Date(account.createdAt).toLocaleDateString()}</span>
              </div>
            )}
            <div style={{ ...fieldStyle, borderBottom: "none" }}>
              <span style={labelStyle}>Account ID</span>
              <span style={{ ...valueStyle, fontFamily: "monospace", fontSize: "11px", color: "var(--text-muted)" }}>
                {account.id}
              </span>
            </div>
          </div>
        )}

        {activeTab === "agreements" && (
          <DataTable
            columns={[
              { key: "agreementNumber", header: "Agreement Number" },
              {
                key: "premise",
                header: "Premise",
                render: (row: any) =>
                  row.premise ? `${row.premise.addressLine1}, ${row.premise.city}` : "—",
              },
              {
                key: "startDate",
                header: "Start Date",
                render: (row: any) => row.startDate?.slice(0, 10) ?? "—",
              },
              {
                key: "status",
                header: "Status",
                render: (row: any) => <StatusBadge status={row.status} />,
              },
            ]}
            data={(account.serviceAgreements ?? []) as any}
            onRowClick={(row: any) => router.push(`/service-agreements/${row.id}`)}
          />
        )}

        {activeTab === "audit" && (
          <DataTable
            columns={[
              {
                key: "createdAt",
                header: "Timestamp",
                render: (row: any) => new Date(row.createdAt).toLocaleString(),
              },
              { key: "action", header: "Action" },
              { key: "actorId", header: "Actor", render: (row: any) => row.actorId ?? "System" },
            ]}
            data={audit as any}
          />
        )}
      </Tabs>
    </div>
  );
}
