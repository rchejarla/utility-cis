"use client";

import { EntityListPage } from "@/components/ui/entity-list-page";
import type { Column } from "@/components/ui/data-table";

interface BillingCycle {
  id: string;
  name: string;
  cycleCode: string;
  readDayOfMonth?: number | null;
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
    /*
      Read day and bill day together, because the gap between them is
      the thing an operator is actually checking: reads have to be in
      before bills generate, and a cycle reading on the 8th and billing
      on the 10th has two days of slack for a late reader.
    */
    key: "billDayOfMonth",
    header: "Calendar",
    render: (row) => (
      <span style={{ fontSize: "12px" }}>
        {row.readDayOfMonth ? `read ${row.readDayOfMonth} → ` : ""}
        {row.billDayOfMonth ? `bill ${row.billDayOfMonth}` : "—"}
      </span>
    ),
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
      emptyState={{
        headline: "No billing cycles configured",
        description:
          "Billing cycles group accounts that share a read-and-bill calendar — monthly, bimonthly, quarterly — so the billing run processes them as a batch.",
      }}
      paginated={false}
    />
  );
}
