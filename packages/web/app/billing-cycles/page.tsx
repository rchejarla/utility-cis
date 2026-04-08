"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { PageHeader } from "@/components/ui/page-header";
import { DataTable } from "@/components/ui/data-table";
import { apiClient } from "@/lib/api-client";

interface BillingCycle {
  id: string;
  name: string;
  cycleCode: string;
  readDayOfMonth?: number;
  billDayOfMonth?: number;
  frequency: string;
  isActive: boolean;
}

interface BCResponse {
  data: BillingCycle[];
  meta: { total: number; page: number; limit: number; pages: number };
}

export default function BillingCyclesPage() {
  const router = useRouter();
  const [data, setData] = useState<BillingCycle[]>([]);
  const [meta, setMeta] = useState({ total: 0, page: 1, limit: 20, pages: 0 });
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiClient.get<BCResponse>("/api/v1/billing-cycles", {
        page: String(page),
        limit: "20",
      });
      setData(res.data);
      setMeta(res.meta);
    } catch (err) {
      console.error("Failed to fetch billing cycles", err);
    } finally {
      setLoading(false);
    }
  }, [page]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const columns = [
    {
      key: "name",
      header: "Name",
      render: (row: BillingCycle) => (
        <span style={{ fontWeight: 500 }}>{row.name}</span>
      ),
    },
    {
      key: "cycleCode",
      header: "Code",
      render: (row: BillingCycle) => (
        <span style={{ fontFamily: "monospace", fontSize: "12px" }}>{row.cycleCode}</span>
      ),
    },
    {
      key: "readDayOfMonth",
      header: "Read Day",
      render: (row: BillingCycle) => (
        <span style={{ fontSize: "12px" }}>{row.readDayOfMonth ?? "—"}</span>
      ),
    },
    {
      key: "billDayOfMonth",
      header: "Bill Day",
      render: (row: BillingCycle) => (
        <span style={{ fontSize: "12px" }}>{row.billDayOfMonth ?? "—"}</span>
      ),
    },
    {
      key: "frequency",
      header: "Frequency",
      render: (row: BillingCycle) => (
        <span style={{ fontSize: "12px", color: "var(--text-secondary)" }}>{row.frequency}</span>
      ),
    },
    {
      key: "isActive",
      header: "Active",
      render: (row: BillingCycle) => (
        <span
          style={{
            fontSize: "11px",
            fontWeight: "500",
            color: row.isActive ? "#4ade80" : "var(--text-muted)",
          }}
        >
          {row.isActive ? "✓ Active" : "Inactive"}
        </span>
      ),
    },
  ];

  return (
    <div>
      <PageHeader
        title="Billing Cycles"
        subtitle={`${meta.total.toLocaleString()} total cycles`}
        action={{ label: "Add Billing Cycle", href: "/billing-cycles/new" }}
      />

      <DataTable
        columns={columns as any}
        data={data as any}
        meta={meta}
        loading={loading}
        onPageChange={setPage}
        onRowClick={(row: any) => router.push(`/billing-cycles/${row.id}`)}
      />
    </div>
  );
}
