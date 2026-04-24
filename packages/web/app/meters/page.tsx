"use client";

import { StatusBadge } from "@/components/ui/status-badge";
import { CommodityBadge } from "@/components/ui/commodity-badge";
import { EntityListPage } from "@/components/ui/entity-list-page";
import type { Column } from "@/components/ui/data-table";

interface Meter {
  id: string;
  meterNumber: string;
  meterType: string;
  status: string;
  premise?: { addressLine1: string; city: string; state: string };
  commodity?: { name: string };
}

const STATUS_OPTIONS = [
  { label: "Active", value: "ACTIVE" },
  { label: "Inactive", value: "INACTIVE" },
  { label: "Removed", value: "REMOVED" },
];

const columns: Column<Meter>[] = [
  {
    key: "meterNumber",
    header: "Meter Number",
    render: (row) => (
      <span style={{ fontFamily: "monospace", fontSize: "12px", fontWeight: 600 }}>
        {row.meterNumber}
      </span>
    ),
  },
  {
    key: "premise",
    header: "Premise",
    render: (row) =>
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
    render: (row) => <CommodityBadge commodity={row.commodity?.name ?? ""} />,
  },
  {
    key: "meterType",
    header: "Type",
    render: (row) => (
      <span style={{ fontSize: "12px", color: "var(--text-secondary)" }}>{row.meterType}</span>
    ),
  },
  {
    key: "status",
    header: "Status",
    render: (row) => <StatusBadge status={row.status} />,
  },
];

export default function MetersPage() {
  return (
    <EntityListPage<Meter>
      title="Meters"
      subject="meters"
      module="meters"
      endpoint="/api/v1/meters"
      getDetailHref={(row) => `/meters/${row.id}`}
      columns={columns}
      newAction={{ label: "Add Meter", href: "/meters/new" }}
      emptyState={{
        headline: "No meters installed",
        description:
          "Meters are the devices at premises that record consumption. Each one belongs to a commodity (water, gas, electric) and reports reads in a specific unit.",
      }}
      filters={[
        {
          key: "commodityId",
          label: "Commodity",
          optionsEndpoint: "/api/v1/commodities",
          mapOption: (c) => ({ label: String(c.name), value: String(c.id) }),
        },
        { key: "status", label: "Status", options: STATUS_OPTIONS },
      ]}
    />
  );
}
