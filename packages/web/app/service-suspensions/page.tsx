"use client";

import { EntityListPage } from "@/components/ui/entity-list-page";
import { PageDescription } from "@/components/ui/page-description";
import type { Column } from "@/components/ui/data-table";

interface ServiceSuspension {
  id: string;
  suspensionType: string;
  status: string;
  startDate: string;
  endDate?: string | null;
  billingSuspended: boolean;
  ramsNotified: boolean;
  reason?: string | null;
  serviceAgreement?: { agreementNumber: string };
}

// Hold types come from the suspension_type_def reference table now,
// not from a hardcoded const. The EntityListPage dynamic filter fetches
// /api/v1/suspension-types on mount and populates the pill options.
const STATUS_OPTIONS = [
  { value: "PENDING", label: "Pending" },
  { value: "ACTIVE", label: "Active" },
  { value: "COMPLETED", label: "Completed" },
  { value: "CANCELLED", label: "Cancelled" },
];

const columns: Column<ServiceSuspension>[] = [
  {
    key: "suspensionType",
    header: "Type",
    render: (row) => (
      <span style={{ fontSize: "11px", fontWeight: 700, letterSpacing: "0.04em" }}>
        {row.suspensionType.replace("_", " ")}
      </span>
    ),
  },
  {
    key: "serviceAgreement",
    header: "Agreement",
    render: (row) => (
      <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: "12px" }}>
        {row.serviceAgreement?.agreementNumber ?? "—"}
      </span>
    ),
  },
  {
    key: "period",
    header: "Period",
    render: (row) => (
      <span style={{ fontSize: "12px" }}>
        {row.startDate?.slice(0, 10) ?? "?"} →{" "}
        {row.endDate ? row.endDate.slice(0, 10) : <em style={{ color: "var(--text-muted)" }}>open</em>}
      </span>
    ),
  },
  {
    key: "billingSuspended",
    header: "Billing",
    render: (row) => (
      <span
        style={{
          fontSize: "10px",
          fontWeight: 700,
          color: row.billingSuspended ? "var(--warning)" : "var(--text-muted)",
        }}
      >
        {row.billingSuspended ? "◉ SUSPENDED" : "○ ACTIVE"}
      </span>
    ),
  },
  {
    key: "ramsNotified",
    header: "Route Sync",
    render: (row) => (
      <span
        title="Synced to RAMS (Route and Asset Management System)"
        style={{
          fontSize: "10px",
          color: row.ramsNotified ? "var(--success)" : "var(--danger)",
        }}
      >
        {row.ramsNotified ? "✓ synced" : "✗ pending"}
      </span>
    ),
  },
  {
    key: "status",
    header: "Status",
    render: (row) => (
      <span
        style={{
          display: "inline-flex",
          padding: "2px 8px",
          borderRadius: "999px",
          fontSize: "10px",
          fontWeight: 700,
          letterSpacing: "0.04em",
          background: row.status === "ACTIVE" ? "var(--warning-subtle)" : "var(--bg-elevated)",
          color: row.status === "ACTIVE" ? "var(--warning)" : "var(--text-secondary)",
          border:
            row.status === "ACTIVE"
              ? "1px solid var(--warning)"
              : "1px solid var(--border)",
          width: "fit-content",
        }}
      >
        {row.status}
      </span>
    ),
  },
];

export default function SuspensionsPage() {
  return (
    <EntityListPage<ServiceSuspension>
      title="Service Holds"
      subject="holds"
      module="service_suspensions"
      endpoint="/api/v1/service-suspensions"
      getDetailHref={(row) => `/service-suspensions/${row.id}`}
      columns={columns}
      newAction={{ label: "+ New Hold", href: "/service-suspensions/new" }}
      emptyState={{
        headline: "No service holds in place",
        description:
          "Place a hold to temporarily pause billing on a service agreement — vacations, construction shutdowns, seasonal closures.",
      }}
      headerSlot={
        <PageDescription storageKey="service-suspensions">
          A <b>service hold</b> is a temporary pause on billing for a service
          agreement — vacation, construction shutdowns, seasonal closures.
          Billing is suspended for the covered period and the agreement rejoins
          the regular cycle when the hold ends or is cancelled. Hold
          <b> types</b> are configured in Settings so you can label them to
          match your own policy.
        </PageDescription>
      }
      filters={[
        { key: "status", label: "Status", options: STATUS_OPTIONS },
        {
          key: "suspensionType",
          label: "Type",
          optionsEndpoint: "/api/v1/suspension-types",
          mapOption: (t) => ({
            value: String(t.code),
            label: String(t.label),
          }),
        },
      ]}
    />
  );
}
