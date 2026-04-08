"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { PageHeader } from "@/components/ui/page-header";
import { FilterBar } from "@/components/ui/filter-bar";
import { DataTable } from "@/components/ui/data-table";
import { CommodityBadge } from "@/components/ui/commodity-badge";
import { apiClient } from "@/lib/api-client";

interface RateSchedule {
  id: string;
  name: string;
  code: string;
  rateType: string;
  effectiveDate: string;
  expirationDate?: string;
  version: number;
  isActive?: boolean;
  commodity?: { name: string };
}

interface RSResponse {
  data: RateSchedule[];
  meta: { total: number; page: number; limit: number; pages: number };
}

interface Commodity {
  id: string;
  name: string;
}

const RATE_TYPE_OPTIONS = [
  { label: "Flat", value: "FLAT" },
  { label: "Tiered", value: "TIERED" },
  { label: "Time of Use", value: "TOU" },
  { label: "Demand", value: "DEMAND" },
  { label: "Budget", value: "BUDGET" },
];

const ACTIVE_OPTIONS = [
  { label: "Active", value: "true" },
  { label: "Inactive", value: "false" },
];

export default function RateSchedulesPage() {
  const router = useRouter();
  const [data, setData] = useState<RateSchedule[]>([]);
  const [meta, setMeta] = useState({ total: 0, page: 1, limit: 20, pages: 0 });
  const [loading, setLoading] = useState(true);
  const [commodities, setCommodities] = useState<Commodity[]>([]);
  const [commodityId, setCommodityId] = useState<string | undefined>(undefined);
  const [rateType, setRateType] = useState<string | undefined>(undefined);
  const [active, setActive] = useState<string | undefined>(undefined);
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
      if (rateType) params.rateType = rateType;
      if (active !== undefined) params.active = active;
      const res = await apiClient.get<RSResponse>("/api/v1/rate-schedules", params);
      setData(res.data);
      setMeta(res.meta);
    } catch (err) {
      console.error("Failed to fetch rate schedules", err);
    } finally {
      setLoading(false);
    }
  }, [page, commodityId, rateType, active]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const commodityOptions = commodities.map((c) => ({ label: c.name, value: c.id }));

  const columns = [
    {
      key: "name",
      header: "Name",
      render: (row: RateSchedule) => (
        <div>
          <div style={{ fontWeight: 500 }}>{row.name}</div>
          <div style={{ fontSize: "11px", color: "var(--text-muted)", fontFamily: "monospace" }}>
            {row.code}
          </div>
        </div>
      ),
    },
    {
      key: "commodity",
      header: "Commodity",
      render: (row: RateSchedule) => <CommodityBadge commodity={row.commodity?.name ?? ""} />,
    },
    {
      key: "rateType",
      header: "Rate Type",
      render: (row: RateSchedule) => (
        <span style={{ fontSize: "12px", color: "var(--text-secondary)" }}>{row.rateType}</span>
      ),
    },
    {
      key: "effectiveDate",
      header: "Effective Date",
      render: (row: RateSchedule) => (
        <span style={{ fontSize: "12px" }}>{row.effectiveDate?.slice(0, 10) ?? "—"}</span>
      ),
    },
    {
      key: "expirationDate",
      header: "Expiration",
      render: (row: RateSchedule) => (
        <span style={{ fontSize: "12px" }}>{row.expirationDate?.slice(0, 10) ?? "None"}</span>
      ),
    },
    {
      key: "version",
      header: "Version",
      render: (row: RateSchedule) => (
        <span style={{ fontFamily: "monospace", fontSize: "12px" }}>v{row.version}</span>
      ),
    },
  ];

  return (
    <div>
      <PageHeader
        title="Rate Schedules"
        subtitle={`${meta.total.toLocaleString()} total schedules`}
        action={{ label: "Add Rate Schedule", href: "/rate-schedules/new" }}
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
            key: "rateType",
            label: "Rate Type",
            options: RATE_TYPE_OPTIONS,
            value: rateType,
            onChange: (v) => { setRateType(v); setPage(1); },
          },
          {
            key: "active",
            label: "Active",
            options: ACTIVE_OPTIONS,
            value: active,
            onChange: (v) => { setActive(v); setPage(1); },
          },
        ]}
      />

      <DataTable
        columns={columns as any}
        data={data as any}
        meta={meta}
        loading={loading}
        onPageChange={setPage}
        onRowClick={(row: any) => router.push(`/rate-schedules/${row.id}`)}
      />
    </div>
  );
}
