"use client";

import { EntityListPage } from "@/components/ui/entity-list-page";
import { PageDescription } from "@/components/ui/page-description";
import { StatusBadge } from "@/components/ui/status-badge";
import type { Column } from "@/components/ui/data-table";

interface TouCalendar {
  id: string;
  name: string;
  effectiveDate: string;
  publishedAt?: string | null;
  timeZone: string;
  clockBasis: string;
  seasonSet?: { name: string };
  _count?: { periods: number; dayTypes: number; slots: number };
}

const STATUS_OPTIONS = [
  { label: "Draft", value: "draft" },
  { label: "Published", value: "published" },
];

const mono = { fontFamily: "monospace", fontSize: "12px" };

const columns: Column<TouCalendar>[] = [
  {
    key: "name",
    header: "Name",
    render: (row) => (
      <div>
        <div style={{ fontWeight: 500 }}>{row.name}</div>
        <div style={{ fontSize: "11px", color: "var(--text-muted)" }}>
          {row.seasonSet?.name ?? "—"}
        </div>
      </div>
    ),
  },
  {
    key: "status",
    header: "Status",
    render: (row) => <StatusBadge status={row.publishedAt ? "published" : "draft"} />,
  },
  {
    key: "effectiveDate",
    header: "In force from",
    /*
     * A version IS a (name, effective date): there is no version
     * column, because a calendar is never edited once it has priced a
     * bill. Two rows with one name and two dates are the two versions.
     */
    render: (row) => <span style={{ fontSize: "12px" }}>{row.effectiveDate?.slice(0, 10)}</span>,
  },
  {
    key: "timeZone",
    header: "Clock",
    render: (row) => (
      <div>
        <div style={mono}>{row.timeZone}</div>
        {row.clockBasis === "standard" && (
          <div style={{ fontSize: "11px", color: "var(--text-muted)" }}>standard time all year</div>
        )}
      </div>
    ),
  },
  {
    key: "hours",
    header: "Hours",
    /*
     * The count that makes a half-built calendar visible on the row. A
     * calendar with periods and day types but no spans looks finished
     * until it is opened, and it is exactly the one that cannot be
     * published.
     */
    render: (row) =>
      row._count?.slots ? (
        <span style={mono}>{row._count.slots}</span>
      ) : (
        <span style={{ fontSize: "12px", color: "var(--warning)" }}>No hours assigned</span>
      ),
  },
  {
    key: "periods",
    header: "Periods",
    render: (row) =>
      row._count?.periods ? (
        <span style={mono}>{row._count.periods}</span>
      ) : (
        <span style={{ fontSize: "12px", color: "var(--warning)" }}>None</span>
      ),
  },
];

export default function TouCalendarsPage() {
  return (
    <EntityListPage<TouCalendar>
      title="TOU Calendars"
      subject="calendars"
      module="rate_schedules"
      endpoint="/api/v1/tou-calendars"
      getDetailHref={(row) => `/tou-calendars/${row.id}`}
      columns={columns}
      newAction={{ label: "Add TOU Calendar", href: "/tou-calendars/new" }}
      emptyState={{
        headline: "No TOU calendars yet",
        description:
          "A TOU calendar says which hours are on-peak. A rate schedule prices against one, and cannot be published unless it prices every period the calendar defines.",
      }}
      headerSlot={
        <PageDescription storageKey="tou-calendars">
          A <b>TOU calendar</b> decides which hours cost what: its periods, its day
          types, and the spans of the day assigned to each. It is{" "}
          <b>versioned and published</b> like a rate schedule, and for the same
          reason — changing which hours are on-peak changes what a bill costs, so a
          change is a new version with its own effective date rather than an edit to
          the one that billed. A published calendar is read-only.
        </PageDescription>
      }
      filters={[{ key: "status", label: "Status", options: STATUS_OPTIONS }]}
    />
  );
}
