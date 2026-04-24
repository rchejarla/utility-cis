"use client";

import { CommodityBadge } from "@/components/ui/commodity-badge";
import { EntityListPage } from "@/components/ui/entity-list-page";
import type { Column } from "@/components/ui/data-table";

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

const columns: Column<RateSchedule>[] = [
  {
    key: "name",
    header: "Name",
    render: (row) => (
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
    render: (row) => <CommodityBadge commodity={row.commodity?.name ?? ""} />,
  },
  {
    key: "rateType",
    header: "Rate Type",
    render: (row) => (
      <span style={{ fontSize: "12px", color: "var(--text-secondary)" }}>{row.rateType}</span>
    ),
  },
  {
    key: "effectiveDate",
    header: "Effective Date",
    render: (row) => (
      <span style={{ fontSize: "12px" }}>{row.effectiveDate?.slice(0, 10) ?? "—"}</span>
    ),
  },
  {
    key: "expirationDate",
    header: "Expiration",
    render: (row) => (
      <span style={{ fontSize: "12px" }}>{row.expirationDate?.slice(0, 10) ?? "None"}</span>
    ),
  },
  {
    key: "version",
    header: "Version",
    render: (row) => (
      <span style={{ fontFamily: "monospace", fontSize: "12px" }}>v{row.version}</span>
    ),
  },
];

export default function RateSchedulesPage() {
  return (
    <EntityListPage<RateSchedule>
      title="Rate Schedules"
      subject="schedules"
      module="rate_schedules"
      endpoint="/api/v1/rate-schedules"
      getDetailHref={(row) => `/rate-schedules/${row.id}`}
      columns={columns}
      newAction={{ label: "Add Rate Schedule", href: "/rate-schedules/new" }}
      headerSlot={
        <div
          style={{
            padding: "12px 16px",
            marginBottom: "16px",
            background: "var(--bg-card)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius)",
            fontSize: 13,
            color: "var(--text-secondary)",
            lineHeight: 1.55,
            maxWidth: 820,
          }}
        >
          A <b>rate schedule</b> defines how a commodity is priced — base charges,
          tiered or time-of-use brackets, demand components — for a given
          effective date range. Schedules are <b>versioned</b>: published rates
          aren't edited in place because they drive billing history. To change
          pricing, open a schedule and click <b>Revise</b> — that creates a new
          version whose effective date is the day the old one expires, preserving
          the audit trail back to the original.
        </div>
      }
      filters={[
        {
          key: "commodityId",
          label: "Commodity",
          optionsEndpoint: "/api/v1/commodities",
          mapOption: (c) => ({ label: String(c.name), value: String(c.id) }),
        },
        { key: "rateType", label: "Rate Type", options: RATE_TYPE_OPTIONS },
        { key: "active", label: "Active", options: ACTIVE_OPTIONS },
      ]}
    />
  );
}
