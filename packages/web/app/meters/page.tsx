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

interface Meter {
  id: string;
  meterNumber: string;
  meterType: string;
  status: string;
  premise?: { addressLine1: string; city: string; state: string };
  commodity?: { name: string };
}

interface MetersResponse {
  data: Meter[];
  meta: { total: number; page: number; limit: number; pages: number };
}

interface Commodity {
  id: string;
  name: string;
}

const STATUS_OPTIONS = [
  { label: "Active", value: "ACTIVE" },
  { label: "Inactive", value: "INACTIVE" },
  { label: "Removed", value: "REMOVED" },
];

export default function MetersPage() {
  const router = useRouter();
  const { canView, canCreate } = usePermission("meters");
  if (!canView) return <AccessDenied />;
  const [data, setData] = useState<Meter[]>([]);
  const [meta, setMeta] = useState({ total: 0, page: 1, limit: 20, pages: 0 });
  const [loading, setLoading] = useState(true);
  const [commodities, setCommodities] = useState<Commodity[]>([]);
  const [commodityId, setCommodityId] = useState<string | undefined>(undefined);
  const [status, setStatus] = useState<string | undefined>(undefined);
  const [page, setPage] = useState(1);

  useEffect(() => {
    apiClient
      .get<{ data: Commodity[] }>("/api/v1/commodities")
      .then((res) => setCommodities(res.data ?? []))
      .catch(console.error);
  }, []);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const params: Record<string, string> = { page: String(page), limit: "20" };
      if (commodityId) params.commodityId = commodityId;
      if (status) params.status = status;
      const res = await apiClient.get<MetersResponse>("/api/v1/meters", params);
      setData(res.data);
      setMeta(res.meta);
    } catch (err) {
      console.error("Failed to fetch meters", err);
    } finally {
      setLoading(false);
    }
  }, [page, commodityId, status]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const columns = [
    {
      key: "meterNumber",
      header: "Meter Number",
      render: (row: Meter) => (
        <span style={{ fontFamily: "monospace", fontSize: "12px", fontWeight: 600 }}>
          {row.meterNumber}
        </span>
      ),
    },
    {
      key: "premise",
      header: "Premise",
      render: (row: Meter) =>
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
      render: (row: Meter) => <CommodityBadge commodity={row.commodity?.name ?? ""} />,
    },
    {
      key: "meterType",
      header: "Type",
      render: (row: Meter) => (
        <span style={{ fontSize: "12px", color: "var(--text-secondary)" }}>{row.meterType}</span>
      ),
    },
    {
      key: "status",
      header: "Status",
      render: (row: Meter) => <StatusBadge status={row.status} />,
    },
  ];

  const commodityOptions = commodities.map((c) => ({ label: c.name, value: c.id }));

  return (
    <div>
      <PageHeader
        title="Meters"
        subtitle={`${meta.total.toLocaleString()} total meters`}
        action={canCreate ? { label: "Add Meter", href: "/meters/new" } : undefined}
      />

      <FilterBar
        filters={[
          {
            key: "commodityId",
            label: "Commodity",
            options: commodityOptions,
            value: commodityId,
            onChange: (v) => { setCommodityId(v); setPage(1); },
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
        onRowClick={(row: any) => router.push(`/meters/${row.id}`)}
      />
    </div>
  );
}
