"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { PageHeader } from "@/components/ui/page-header";
import { FilterBar } from "@/components/ui/filter-bar";
import { DataTable } from "@/components/ui/data-table";
import { StatusBadge } from "@/components/ui/status-badge";
import { apiClient } from "@/lib/api-client";

interface Account {
  id: string;
  accountNumber: string;
  accountType: string;
  status: string;
  creditRating?: string;
  serviceAgreements?: Array<unknown>;
}

interface AccountsResponse {
  data: Account[];
  meta: { total: number; page: number; limit: number; pages: number };
}

const ACCOUNT_TYPE_OPTIONS = [
  { label: "Residential", value: "RESIDENTIAL" },
  { label: "Commercial", value: "COMMERCIAL" },
  { label: "Industrial", value: "INDUSTRIAL" },
  { label: "Government", value: "GOVERNMENT" },
];

const STATUS_OPTIONS = [
  { label: "Active", value: "ACTIVE" },
  { label: "Inactive", value: "INACTIVE" },
  { label: "Suspended", value: "SUSPENDED" },
  { label: "Closed", value: "CLOSED" },
];

export default function AccountsPage() {
  const router = useRouter();
  const [data, setData] = useState<Account[]>([]);
  const [meta, setMeta] = useState({ total: 0, page: 1, limit: 20, pages: 0 });
  const [loading, setLoading] = useState(true);
  const [accountType, setAccountType] = useState<string | undefined>(undefined);
  const [status, setStatus] = useState<string | undefined>(undefined);
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const params: Record<string, string> = { page: String(page), limit: "20" };
      if (accountType) params.accountType = accountType;
      if (status) params.status = status;
      if (search) params.accountNumber = search;
      const res = await apiClient.get<AccountsResponse>("/api/v1/accounts", params);
      setData(res.data);
      setMeta(res.meta);
    } catch (err) {
      console.error("Failed to fetch accounts", err);
    } finally {
      setLoading(false);
    }
  }, [page, accountType, status, search]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const columns = [
    {
      key: "accountNumber",
      header: "Account Number",
      render: (row: Account) => (
        <span style={{ fontFamily: "monospace", fontSize: "12px", fontWeight: 600 }}>
          {row.accountNumber}
        </span>
      ),
    },
    {
      key: "accountType",
      header: "Type",
      render: (row: Account) => (
        <span style={{ fontSize: "12px", color: "var(--text-secondary)" }}>{row.accountType}</span>
      ),
    },
    {
      key: "status",
      header: "Status",
      render: (row: Account) => <StatusBadge status={row.status} />,
    },
    {
      key: "creditRating",
      header: "Credit Rating",
      render: (row: Account) => (
        <span style={{ fontSize: "12px" }}>{row.creditRating ?? "—"}</span>
      ),
    },
    {
      key: "agreements",
      header: "Agreements",
      render: (row: Account) => (
        <span style={{ fontFamily: "monospace", fontSize: "12px" }}>
          {row.serviceAgreements?.length ?? 0}
        </span>
      ),
    },
  ];

  return (
    <div>
      <PageHeader
        title="Accounts"
        subtitle={`${meta.total.toLocaleString()} total accounts`}
        action={{ label: "Add Account", href: "/accounts/new" }}
      />

      <div style={{ marginBottom: "8px" }}>
        <input
          style={{
            padding: "7px 12px",
            borderRadius: "var(--radius)",
            border: "1px solid var(--border)",
            background: "var(--bg-elevated)",
            color: "var(--text-primary)",
            fontSize: "13px",
            fontFamily: "inherit",
            outline: "none",
            width: "260px",
          }}
          placeholder="Search by account number..."
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setPage(1);
          }}
        />
      </div>

      <FilterBar
        filters={[
          {
            key: "accountType",
            label: "Type",
            options: ACCOUNT_TYPE_OPTIONS,
            value: accountType,
            onChange: (v) => { setAccountType(v); setPage(1); },
          },
          {
            key: "status",
            label: "Status",
            options: STATUS_OPTIONS,
            value: status,
            onChange: (v) => { setStatus(v); setPage(1); },
          },
        ]}
      />

      <DataTable
        columns={columns as any}
        data={data as any}
        meta={meta}
        loading={loading}
        onPageChange={setPage}
        onRowClick={(row: any) => router.push(`/accounts/${row.id}`)}
      />
    </div>
  );
}
