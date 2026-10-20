"use client";

import { CommodityBadge } from "@/components/ui/commodity-badge";
import { EntityListPage } from "@/components/ui/entity-list-page";
import { PageDescription } from "@/components/ui/page-description";
import { StatusBadge } from "@/components/ui/status-badge";
import { rateScheduleLifecycle } from "@/lib/rate-schedule-lifecycle";
import type { Column } from "@/components/ui/data-table";

interface RateSchedule {
  id: string;
  name: string;
  code: string;
  effectiveDate: string;
  expirationDate?: string;
  version: number;
  /**
   * The two columns that decide the lifecycle badge. They were already
   * in every response — the list service includes no `select`, so Prisma
   * returns both — and this interface simply never named them, which is
   * why the column could not be written.
   */
  publishedAt?: string | null;
  supersededById?: string | null;
  commodity?: { name: string };
  _count?: { components: number };
}

/**
 * The lifecycle, which is what this list is read for.
 *
 * It replaced Active/Inactive, which was broken in both halves: the API
 * translated `active` to "has no expiration date" rather than anything
 * the label claimed, and the value a select box sends for Inactive —
 * the string "false" — parsed as `true` through `z.coerce.boolean()`, so
 * both options returned the same rows. These three are the states the
 * Status column shows, by the same definitions.
 */
const STATUS_OPTIONS = [
  { label: "Draft", value: "draft" },
  { label: "Published", value: "published" },
  { label: "Superseded", value: "superseded" },
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
    key: "status",
    header: "Status",
    /*
     * Publishing is what decides whether a schedule can price a bill,
     * and this list showed Draft, Published and Superseded alike. The
     * badge the detail page has always carried, read through the one
     * shared derivation so the two screens cannot disagree.
     */
    render: (row) => <StatusBadge status={rateScheduleLifecycle(row)} />,
  },
  {
    key: "commodity",
    header: "Commodity",
    render: (row) => <CommodityBadge commodity={row.commodity?.name ?? ""} />,
  },
  {
    key: "components",
    header: "Charges",
    /*
     * A published schedule carrying no components prices nothing —
     * `publishRateSchedule` does not require any — so "none" is the
     * state worth seeing here, and this column used to read "Components
     * (coming soon)" while the count was one `_count` away. Worded "No
     * charges" rather than "None" so it cannot be mistaken for the
     * Expiration column beside it.
     */
    render: (row) =>
      row._count?.components ? (
        <span style={{ fontFamily: "monospace", fontSize: "12px" }}>
          {row._count.components}
        </span>
      ) : (
        <span style={{ fontSize: "12px", color: "var(--warning)" }}>No charges</span>
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
      emptyState={{
        headline: "No rate schedules yet",
        description:
          "Rate schedules define how a commodity is priced. Add one per commodity before signing up service agreements that will bill against it.",
      }}
      headerSlot={
        <PageDescription storageKey="rate-schedules">
          A <b>rate schedule</b> defines how a commodity is priced — base charges,
          tiered or time-of-use brackets, demand components — for a given
          effective date range. Schedules are <b>versioned</b>: published rates
          aren't edited in place because they drive billing history. To change
          pricing, open a schedule and click <b>Revise</b> — that creates a new
          version whose effective date is the day the old one expires, preserving
          the audit trail back to the original.
        </PageDescription>
      }
      filters={[
        {
          key: "commodityId",
          label: "Commodity",
          optionsEndpoint: "/api/v1/commodities",
          mapOption: (c) => ({ label: String(c.name), value: String(c.id) }),
        },
        { key: "status", label: "Status", options: STATUS_OPTIONS },
      ]}
    />
  );
}
