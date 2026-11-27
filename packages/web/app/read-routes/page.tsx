"use client";

import Link from "next/link";
import type { ReadRouteSummary } from "@utility-cis/shared";
import { EntityListPage } from "@/components/ui/entity-list-page";
import { PageDescription } from "@/components/ui/page-description";
import { RouteSheetButton } from "@/components/read-routes/route-sheet-button";
import type { Column } from "@/components/ui/data-table";

/**
 * /read-routes — the named walks a meter reader makes (spec 30, §5.1).
 *
 * Two things the list says that the rows do not say by themselves.
 *
 * **How many stops.** A route with none is half-built: it has a code, a
 * name and a cycle, so it reads as finished, and the sheet it prints is
 * an empty page. The count is the only thing on the row that gives that
 * away, so a zero says so in words rather than as a digit — "0" in a
 * count column reads as data that failed to load.
 *
 * **Who owns the itinerary.** A LOCAL route is built here, stop by stop.
 * An EXTERNAL one was named by a vendor's reading system and exists as a
 * row so imported reads can point at something (§5.4): it has no stops,
 * no sheet to print and nothing to type in. Rendering the two alike
 * invites all three, and the server refuses each with an error that then
 * looks like a fault rather than the design.
 *
 * The row type is `ReadRouteSummary` from `@utility-cis/shared` — the
 * same schema the routes' integration suite parses a real response
 * through, so a field this page reads and the API stops sending fails
 * there rather than rendering blank here.
 */

/** Today, UTC, as the sheet's date. A reader's walk is today's walk. */
// Local calendar day, not UTC's — see the entry page's `todayIso`.
const today = () => new Date().toLocaleDateString("en-CA");

const ORIGIN_OPTIONS = [
  { label: "Ours", value: "LOCAL" },
  { label: "Vendor's system", value: "EXTERNAL" },
];

const ACTIVE_OPTIONS = [
  { label: "In use", value: "true" },
  { label: "Retired", value: "false" },
];

const mono = { fontFamily: "'JetBrains Mono', monospace", fontSize: 12 };
const muted = { fontSize: 11, color: "var(--text-muted)" };

const columns: Column<ReadRouteSummary>[] = [
  {
    key: "code",
    header: "Code",
    /*
     * A link, though the whole row navigates there too. The code is how
     * anybody refers to a route out loud, so it is the thing to open,
     * copy or middle-click — and a row-click alone offers none of those.
     */
    render: (row) => (
      <Link
        href={`/read-routes/${row.id}`}
        style={{ ...mono, fontWeight: 600, color: "var(--accent-primary)" }}
      >
        {row.code}
      </Link>
    ),
  },
  {
    key: "name",
    header: "Name",
    render: (row) => (
      <div>
        <div style={{ fontWeight: 500 }}>{row.name}</div>
        {!row.active && <div style={muted}>Retired — kept for the reads that point at it</div>}
      </div>
    ),
  },
  {
    key: "cycleCode",
    header: "Cycle",
    render: (row) => <span style={mono}>{row.cycleCode}</span>,
  },
  {
    key: "stopCount",
    header: "Stops",
    render: (row) =>
      row.origin !== "LOCAL" ? (
        // Not "0": a vendor's route is not an empty route, and a count
        // here would read as one somebody forgot to fill in.
        <span style={muted}>—</span>
      ) : row.stopCount > 0 ? (
        <span style={mono}>{row.stopCount}</span>
      ) : (
        <span style={{ fontSize: 12, color: "var(--warning)" }}>No stops yet</span>
      ),
  },
  {
    key: "origin",
    header: "Owner",
    render: (row) =>
      row.origin === "LOCAL" ? (
        <span style={{ fontSize: 12 }}>Ours</span>
      ) : (
        <span
          style={{ fontSize: 12, color: "var(--text-secondary)" }}
          title="Named by a vendor's reading system. Its stops are not kept here, so there is no sheet and nothing to type in."
        >
          Vendor-owned
        </span>
      ),
  },
  {
    key: "sheet",
    header: "",
    render: (row) =>
      row.origin === "LOCAL" && row.stopCount > 0 ? (
        <RouteSheetButton routeId={row.id} routeCode={row.code} onDate={today()} size="row" />
      ) : null,
  },
];

export default function ReadRoutesPage() {
  return (
    <EntityListPage<ReadRouteSummary>
      title="Read Routes"
      subject="routes"
      module="meter_reads"
      endpoint="/api/v1/read-routes"
      getDetailHref={(row) => `/read-routes/${row.id}`}
      columns={columns}
      newAction={{ label: "Add Read Route", href: "/read-routes/new" }}
      search={{ paramKey: "search", placeholder: "Search by code or name...", variant: "compact" }}
      emptyState={{
        headline: "No read routes yet",
        description:
          "A read route is an ordered list of addresses a meter reader walks. Build one and it prints as a sheet, takes the day's readings back in, and tells you how much of a cycle is still unread. Routes a vendor's reading system names appear here on their own, the first time one of their reads arrives.",
      }}
      headerSlot={
        <PageDescription storageKey="read-routes">
          A <b>read route</b> is an ordered list of premises — a reader walks it in
          sequence, and the order is the route&apos;s own, not the order the addresses
          were added. Each route belongs to one <b>billing cycle</b>, which is what
          gives its reads a day they are due by. A route marked{" "}
          <b>vendor-owned</b> was named by somebody else&apos;s reading system: it
          exists so an imported read can say which route it came off, and its stops
          are kept over there.
        </PageDescription>
      }
      filters={[
        { key: "origin", label: "Owner", options: ORIGIN_OPTIONS, allLabel: "Any owner" },
        { key: "active", label: "In use", options: ACTIVE_OPTIONS, allLabel: "All routes" },
        {
          key: "billingCycleId",
          label: "Cycle",
          optionsEndpoint: "/api/v1/billing-cycles",
          allLabel: "All cycles",
          mapOption: (row) => ({
            label: `${String(row.cycleCode)} — ${String(row.name)}`,
            value: String(row.id),
          }),
        },
      ]}
    />
  );
}
