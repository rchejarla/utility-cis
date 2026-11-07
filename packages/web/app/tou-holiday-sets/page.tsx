"use client";

import { EntityListPage } from "@/components/ui/entity-list-page";
import { PageDescription } from "@/components/ui/page-description";
import { StatusBadge } from "@/components/ui/status-badge";
import type { Column } from "@/components/ui/data-table";

/**
 * Holiday sets (spec 26, TOU-CAL-4).
 *
 * The column that matters is the last date. A set covers a horizon and
 * runs out, and a calendar in force past its set's last date prices
 * every holiday after that as an ordinary weekday — peak hours on a day
 * the tariff calls off-peak. That is the cost of explicit dates instead
 * of rules, and the only honest way to pay it is to show the horizon
 * where somebody will see it.
 */

interface HolidaySet {
  id: string;
  name: string;
  effectiveDate: string;
  publishedAt?: string | null;
  firstDate?: string | null;
  lastDate?: string | null;
  calendarCount?: number;
  _count?: { holidays: number };
}

const STATUS_OPTIONS = [
  { label: "Draft", value: "draft" },
  { label: "Published", value: "published" },
];

/** The year a set runs out, which is the question the column answers. */
function horizon(row: HolidaySet) {
  if (!row.lastDate) {
    return <span style={{ fontSize: "12px", color: "var(--warning)" }}>No dates yet</span>;
  }
  const last = row.lastDate.slice(0, 10);
  const ranOut = last < new Date().toISOString().slice(0, 10);
  return (
    <span style={{ fontSize: "12px", color: ranOut ? "var(--warning)" : undefined }}>
      {row.firstDate?.slice(0, 10)} – {last}
      {ranOut && " (ran out)"}
    </span>
  );
}

const columns: Column<HolidaySet>[] = [
  {
    key: "name",
    header: "Name",
    render: (row) => <span style={{ fontWeight: 500 }}>{row.name}</span>,
  },
  {
    key: "status",
    header: "Status",
    render: (row) => <StatusBadge status={row.publishedAt ? "published" : "draft"} />,
  },
  {
    key: "effectiveDate",
    header: "In force from",
    render: (row) => <span style={{ fontSize: "12px" }}>{row.effectiveDate?.slice(0, 10)}</span>,
  },
  {
    key: "holidays",
    header: "Dates",
    render: (row) => (
      <span style={{ fontFamily: "monospace", fontSize: "12px" }}>
        {row._count?.holidays ?? 0}
      </span>
    ),
  },
  { key: "covers", header: "Covers", render: horizon },
  {
    key: "calendars",
    header: "TOU calendars",
    render: (row) => (
      <span style={{ fontFamily: "monospace", fontSize: "12px" }}>{row.calendarCount ?? 0}</span>
    ),
  },
];

export default function TouHolidaySetsPage() {
  return (
    <EntityListPage<HolidaySet>
      title="Holidays"
      subject="holiday sets"
      module="rate_schedules"
      endpoint="/api/v1/tou-holiday-sets"
      getDetailHref={(row) => `/tou-holiday-sets/${row.id}`}
      columns={columns}
      newAction={{ label: "Add Holiday Set", href: "/tou-holiday-sets/new" }}
      emptyState={{
        headline: "No holiday sets yet",
        description:
          "A holiday set is the dates a tariff prices differently. A TOU calendar that names one gets a holiday day type, and the hours given to it are what those dates cost. A tariff that does not distinguish holidays needs none of this.",
      }}
      headerSlot={
        <PageDescription storageKey="tou-holiday-sets">
          A <b>holiday set</b> holds the dates themselves, <b>observed</b> — if the
          4th falls on a Saturday and the utility takes the Friday, the Friday is
          what goes in. Not rules: &quot;4 July, nearest weekday&quot; is a
          computation nobody checked, and nobody reading the tariff could see
          which day their bill will be cheap. Sets are{" "}
          <b>versioned and published</b> like season sets, so editing one cannot
          change which days got holiday hours on bills already issued, and they
          are shared across calendars because a utility&apos;s holidays do not
          vary by tariff. The cost is that a set <b>runs out</b> — watch the
          Covers column.
        </PageDescription>
      }
      filters={[{ key: "status", label: "Status", options: STATUS_OPTIONS }]}
    />
  );
}
