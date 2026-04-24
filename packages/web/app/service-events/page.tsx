"use client";

import { EntityListPage } from "@/components/ui/entity-list-page";
import { PageDescription } from "@/components/ui/page-description";
import type { Column } from "@/components/ui/data-table";

interface ServiceEvent {
  id: string;
  eventType: string;
  eventDate: string;
  source: string;
  status: string;
  ramsEventId?: string | null;
  notes?: string | null;
  premise?: { addressLine1: string; city: string };
}

const TYPE_OPTIONS = [
  { value: "MISSED_COLLECTION", label: "Missed collection" },
  { value: "CONTAMINATION", label: "Contamination" },
  { value: "EXTRA_PICKUP", label: "Extra pickup" },
  { value: "BULKY_ITEM", label: "Bulky item" },
  { value: "CART_DAMAGED", label: "Cart damaged" },
  { value: "CART_STOLEN", label: "Cart stolen" },
  { value: "CART_SWAP", label: "Cart swap" },
];

const STATUS_OPTIONS = [
  { value: "RECEIVED", label: "Received" },
  { value: "REVIEWED", label: "Reviewed" },
  { value: "ADJUSTMENT_PENDING", label: "Adjustment pending" },
  { value: "RESOLVED", label: "Resolved" },
];

const SOURCE_OPTIONS = [
  { value: "RAMS", label: "RAMS" },
  { value: "MANUAL", label: "Manual" },
  { value: "DRIVER_APP", label: "Driver app" },
  { value: "CUSTOMER_REPORT", label: "Customer" },
];

const columns: Column<ServiceEvent>[] = [
  {
    key: "eventType",
    header: "Event",
    render: (row) => (
      <span style={{ fontSize: "11px", fontWeight: 700, letterSpacing: "0.04em" }}>
        {row.eventType.replace("_", " ")}
      </span>
    ),
  },
  {
    key: "premise",
    header: "Location",
    render: (row) =>
      row.premise ? (
        <span style={{ fontSize: "12px" }}>
          {row.premise.addressLine1}, {row.premise.city}
        </span>
      ) : (
        <span style={{ color: "var(--text-muted)" }}>—</span>
      ),
  },
  {
    key: "eventDate",
    header: "Date",
    render: (row) => <span style={{ fontSize: "12px" }}>{row.eventDate?.slice(0, 10) ?? "—"}</span>,
  },
  {
    key: "source",
    header: "Source",
    render: (row) => (
      <span style={{ fontSize: "10px", color: "var(--text-muted)", letterSpacing: "0.06em" }}>
        {row.source}
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
          background:
            row.status === "RECEIVED" ? "var(--warning-subtle)" : "var(--bg-elevated)",
          color:
            row.status === "RECEIVED" ? "var(--warning)" : "var(--text-secondary)",
          border:
            row.status === "RECEIVED"
              ? "1px solid var(--warning)"
              : "1px solid var(--border)",
          width: "fit-content",
        }}
      >
        {row.status.replace("_", " ")}
      </span>
    ),
  },
];

export default function ServiceEventsPage() {
  return (
    <EntityListPage<ServiceEvent>
      title="RAMS Events"
      subject="events"
      module="service_events"
      endpoint="/api/v1/service-events"
      getDetailHref={(row) => `/service-events/${row.id}`}
      columns={columns}
      emptyState={{
        headline: "No service events yet",
        description:
          "Service events are operational occurrences received from RAMS — the Route and Asset Management System your solid-waste crews run in the field. Missed pickups, contamination, and cart swaps will stream in as RAMS reports them.",
      }}
      headerSlot={
        <PageDescription storageKey="service-events">
          <b>Service events</b> are operational occurrences received from
          <b> RAMS</b> (Route and Asset Management System, the solid-waste
          field platform) — missed pickups, contamination flags, cart swaps,
          bulky-item requests. Some are informational and close after review;
          others trigger <b>billing credits or charges</b> on the related
          account once reviewed and resolved.
        </PageDescription>
      }
      filters={[
        { key: "status", label: "Status", options: STATUS_OPTIONS },
        { key: "eventType", label: "Type", options: TYPE_OPTIONS },
        { key: "source", label: "Source", options: SOURCE_OPTIONS },
      ]}
    />
  );
}
