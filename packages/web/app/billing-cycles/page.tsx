"use client";

import { EntityListPage } from "@/components/ui/entity-list-page";
import type { Column } from "@/components/ui/data-table";

interface BillingCycle {
  id: string;
  name: string;
  cycleCode: string;
  readDayOfMonth?: number;
  billDayOfMonth?: number;
  frequency: string;
  isActive: boolean;
}

const columns: Column<BillingCycle>[] = [
  {
    key: "name",
    header: "Name",
    render: (row) => <span style={{ fontWeight: 500 }}>{row.name}</span>,
  },
  {
    key: "cycleCode",
    header: "Code",
    render: (row) => (
      <span style={{ fontFamily: "monospace", fontSize: "12px" }}>{row.cycleCode}</span>
    ),
  },
  {
    key: "readDayOfMonth",
    header: "Read Day",
    render: (row) => <span style={{ fontSize: "12px" }}>{row.readDayOfMonth ?? "—"}</span>,
  },
  {
    key: "billDayOfMonth",
    header: "Bill Day",
    render: (row) => <span style={{ fontSize: "12px" }}>{row.billDayOfMonth ?? "—"}</span>,
  },
  {
    key: "frequency",
    header: "Frequency",
    render: (row) => (
      <span style={{ fontSize: "12px", color: "var(--text-secondary)" }}>{row.frequency}</span>
    ),
  },
  {
    key: "isActive",
    header: "Active",
    render: (row) => (
      <span
        style={{
          fontSize: "11px",
          fontWeight: 500,
          color: row.isActive ? "var(--success)" : "var(--text-muted)",
        }}
      >
        {row.isActive ? "✓ Active" : "Inactive"}
      </span>
    ),
  },
];

export default function BillingCyclesPage() {
  return (
    <EntityListPage<BillingCycle>
      title="Billing Cycles"
      subject="cycles"
      module="billing_cycles"
      endpoint="/api/v1/billing-cycles"
      getDetailHref={(row) => `/billing-cycles/${row.id}`}
      columns={columns}
      newAction={{ label: "Add Billing Cycle", href: "/billing-cycles/new" }}
      paginated={false}
    />
  );
}
