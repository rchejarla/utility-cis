"use client";

import { EntityListPage } from "@/components/ui/entity-list-page";
import type { Column } from "@/components/ui/data-table";

interface MeterEvent {
  id: string;
  eventType: string;
  status: string;
  severity: number;
  eventDatetime: string;
  source: string;
  description?: string | null;
  meter?: { meterNumber: string };
}

const EVENT_TYPE_OPTIONS = [
  "LEAK",
  "TAMPER",
  "REVERSE_FLOW",
  "HIGH_USAGE",
  "NO_SIGNAL",
  "BATTERY_LOW",
  "COVER_OPEN",
  "BURST_PIPE",
  "FREEZE",
  "OTHER",
].map((v) => ({ value: v, label: v.replace("_", " ") }));

const STATUS_OPTIONS = [
  { value: "OPEN", label: "Open" },
  { value: "ACKNOWLEDGED", label: "Acknowledged" },
  { value: "RESOLVED", label: "Resolved" },
  { value: "DISMISSED", label: "Dismissed" },
];

const severityPip = (n: number): { color: string; label: string } => {
  if (n >= 3) return { color: "var(--danger)", label: "HIGH" };
  if (n === 2) return { color: "var(--warning)", label: "MED" };
  return { color: "var(--info)", label: "LOW" };
};

const columns: Column<MeterEvent>[] = [
  {
    key: "eventType",
    header: "Event",
    render: (row) => (
      <span
        style={{
          fontSize: "11px",
          fontWeight: 700,
          letterSpacing: "0.06em",
          color: "var(--text-primary)",
        }}
      >
        {row.eventType.replace("_", " ")}
      </span>
    ),
  },
  {
    key: "severity",
    header: "Severity",
    render: (row) => {
      const s = severityPip(row.severity);
      return (
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "6px",
            fontSize: "11px",
            fontWeight: 600,
            color: s.color,
          }}
        >
          <span
            style={{
              width: "8px",
              height: "8px",
              borderRadius: "50%",
              background: s.color,
            }}
          />
          {s.label}
        </span>
      );
    },
  },
  {
    key: "meter",
    header: "Meter",
    render: (row) => (
      <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: "12px" }}>
        {row.meter?.meterNumber ?? "—"}
      </span>
    ),
  },
  {
    key: "eventDatetime",
    header: "When",
    render: (row) => (
      <span style={{ fontSize: "12px" }}>
        {new Date(row.eventDatetime).toLocaleString()}
      </span>
    ),
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
          background: row.status === "OPEN" ? "var(--danger-subtle)" : "var(--bg-elevated)",
          color: row.status === "OPEN" ? "var(--danger)" : "var(--text-secondary)",
          border:
            row.status === "OPEN"
              ? "1px solid var(--danger)"
              : "1px solid var(--border)",
          width: "fit-content",
        }}
      >
        {row.status}
      </span>
    ),
  },
];

export default function MeterEventsPage() {
  return (
    <EntityListPage<MeterEvent>
      title="Meter Events"
      subject="events"
      module="meter_events"
      endpoint="/api/v1/meter-events"
      getDetailHref={(row) => `/meter-events/${row.id}`}
      columns={columns}
      newAction={{ label: "+ Log Event", href: "/meter-events/new" }}
      emptyState={{
        headline: "No meter events reported",
        description:
          "Events are anomalies flagged against a meter — tampering, leak detection, register rollover, communication faults — usually raised by the meter itself or during validation.",
      }}
      filters={[
        { key: "status", label: "Status", options: STATUS_OPTIONS },
        { key: "eventType", label: "Event Type", options: EVENT_TYPE_OPTIONS },
        {
          key: "minSeverity",
          label: "Severity",
          options: [
            { label: "High only", value: "3" },
            { label: "Medium+", value: "2" },
            { label: "All", value: "1" },
          ],
        },
      ]}
    />
  );
}
