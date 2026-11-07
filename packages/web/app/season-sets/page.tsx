"use client";

import { EntityListPage } from "@/components/ui/entity-list-page";
import { PageDescription } from "@/components/ui/page-description";
import { StatusBadge } from "@/components/ui/status-badge";
import type { Column } from "@/components/ui/data-table";

interface SeasonSet {
  id: string;
  name: string;
  effectiveDate: string;
  publishedAt?: string | null;
  spanRule: string;
  seasons?: Array<{ seasonCode: string; label: string }>;
  _count?: { touCalendars: number };
}

const STATUS_OPTIONS = [
  { label: "Draft", value: "draft" },
  { label: "Published", value: "published" },
];

const columns: Column<SeasonSet>[] = [
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
    key: "seasons",
    header: "Seasons",
    render: (row) =>
      row.seasons?.length ? (
        <span style={{ fontSize: "12px" }}>{row.seasons.map((s) => s.label).join(", ")}</span>
      ) : (
        <span style={{ fontSize: "12px", color: "var(--warning)" }}>None yet</span>
      ),
  },
  {
    key: "calendars",
    header: "TOU calendars",
    /*
     * How many calendars are keyed on this set's codes. It is the
     * number that says whether a boundary can still be moved: a set no
     * calendar names can be deleted, and one that several name cannot.
     */
    render: (row) => (
      <span style={{ fontFamily: "monospace", fontSize: "12px" }}>
        {row._count?.touCalendars ?? 0}
      </span>
    ),
  },
];

export default function SeasonSetsPage() {
  return (
    <EntityListPage<SeasonSet>
      title="Seasons"
      subject="season sets"
      module="rate_schedules"
      endpoint="/api/v1/season-sets"
      getDetailHref={(row) => `/season-sets/${row.id}`}
      columns={columns}
      newAction={{ label: "Add Season Set", href: "/season-sets/new" }}
      emptyState={{
        headline: "No season sets yet",
        description:
          "A season set says which months are summer. Rate components compare against its codes, and a TOU calendar's hours are keyed on them — so a set has to exist before a TOU calendar can be created.",
      }}
      headerSlot={
        <PageDescription storageKey="season-sets">
          A <b>season set</b> divides the year, and must cover every day of it
          exactly once — a season may wrap the year end, so 1 November to 31 March
          is one season. Sets are <b>versioned and published</b> like rate
          schedules, because moving summer&apos;s start changes what April costs.
          Only one set is in force at a time, and that is the one non-TOU charges
          follow; a published <b>TOU calendar</b> keeps the set it names.
        </PageDescription>
      }
      filters={[{ key: "status", label: "Status", options: STATUS_OPTIONS }]}
    />
  );
}
