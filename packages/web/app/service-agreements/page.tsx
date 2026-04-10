"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { PageHeader } from "@/components/ui/page-header";
import { FilterBar } from "@/components/ui/filter-bar";
import { DataTable } from "@/components/ui/data-table";
import { StatusBadge } from "@/components/ui/status-badge";
import { CommodityBadge } from "@/components/ui/commodity-badge";
import { apiClient } from "@/lib/api-client";
import { usePermission } from "@/lib/use-permission";
import { AccessDenied } from "@/components/ui/access-denied";

interface ServiceAgreement {
  id: string;
  agreementNumber: string;
  status: string;
  startDate: string;
  account?: { accountNumber: string };
  premise?: { addressLine1: string; city: string; state: string };
  commodity?: { name: string };
}

interface SAResponse {
  data: ServiceAgreement[];
  meta: { total: number; page: number; limit: number; pages: number };
}

interface Account {
  id: string;
  accountNumber: string;
}

const STATUS_OPTIONS = [
  { label: "Pending", value: "PENDING" },
  { label: "Active", value: "ACTIVE" },
  { label: "Inactive", value: "INACTIVE" },
  { label: "Closed", value: "CLOSED" },
];

export default function ServiceAgreementsPage() {
  const router = useRouter();
  const { canView, canCreate } = usePermission("agreements");
  const [data, setData] = useState<ServiceAgreement[]>([]);
  const [meta, setMeta] = useState({ total: 0, page: 1, limit: 20, pages: 0 });
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState<string | undefined>(undefined);
  const [accountId, setAccountId] = useState<string | undefined>(undefined);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [page, setPage] = useState(1);

  useEffect(() => {
    apiClient
      .get<{ data: Account[] }>("/api/v1/accounts", { limit: "200" })
      .then((res) => setAccounts(res.data ?? []))
      .catch(console.error);
  }, []);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const params: Record<string, string> = { page: String(page), limit: "20" };
      if (status) params.status = status;
      if (accountId) params.accountId = accountId;
      const res = await apiClient.get<SAResponse>("/api/v1/service-agreements", params);
      setData(res.data);
      setMeta(res.meta);
    } catch (err) {
      console.error("Failed to fetch service agreements", err);
    } finally {
      setLoading(false);
    }
  }, [page, status, accountId]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  if (!canView) return <AccessDenied />;

  const accountOptions = accounts.map((a) => ({ label: a.accountNumber, value: a.id }));

  const columns = [
    {
      key: "agreementNumber",
      header: "Agreement Number",
      render: (row: ServiceAgreement) => (
        <span style={{ fontFamily: "monospace", fontSize: "12px", fontWeight: 600 }}>
          {row.agreementNumber}
        </span>
      ),
    },
    {
      key: "account",
      header: "Account",
      render: (row: ServiceAgreement) => (
        <span style={{ fontSize: "12px" }}>{row.account?.accountNumber ?? "—"}</span>
      ),
    },
    {
      key: "premise",
      header: "Premise",
      render: (row: ServiceAgreement) =>
        row.premise ? (
          <span style={{ fontSize: "12px" }}>
            {row.premise.addressLine1}, {row.premise.city}
          </span>
        ) : (
          <span style={{ color: "var(--text-muted)", fontSize: "12px" }}>—</span>
        ),
    },
    {
      key: "commodity",
      header: "Commodity",
      render: (row: ServiceAgreement) => <CommodityBadge commodity={row.commodity?.name ?? ""} />,
    },
    {
      key: "status",
      header: "Status",
      render: (row: ServiceAgreement) => <StatusBadge status={row.status} />,
    },
    {
      key: "startDate",
      header: "Start Date",
      render: (row: ServiceAgreement) => (
        <span style={{ fontSize: "12px" }}>{row.startDate?.slice(0, 10) ?? "—"}</span>
      ),
    },
  ];

  return (
    <div>
      <PageHeader
        title="Service Agreements"
        subtitle={`${meta.total.toLocaleString()} total agreements`}
        action={canCreate ? { label: "Add Agreement", href: "/service-agreements/new" } : undefined}
      />

      <FilterBar
        filters={[
          {
            key: "status",
            label: "Status",
            options: STATUS_OPTIONS,
            value: status,
            onChange: (v) => { setStatus(v); setPage(1); },
          },
          {
            key: "accountId",
            label: "Account",
            options: accountOptions,
            value: accountId,
            onChange: (v) => { setAccountId(v); setPage(1); },
          },
        ]}
      />

      <DataTable
        columns={columns as any}
        data={data as any}
        meta={meta}
        loading={loading}
        onPageChange={setPage}
        onRowClick={(row: any) => router.push(`/service-agreements/${row.id}`)}
      />
    </div>
  );
}
