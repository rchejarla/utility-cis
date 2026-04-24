"use client";

import Link from "next/link";
import { EntityListPage, type EntityListFilter } from "@/components/ui/entity-list-page";
import type { Column } from "@/components/ui/data-table";
import { StatusBadge } from "@/components/ui/status-badge";
import { SlaCountdown } from "./sla-countdown";

export interface ServiceRequestRow {
  id: string;
  requestNumber: string;
  requestType: string;
  status: string;
  priority: string;
  slaDueAt: string | null;
  slaBreached: boolean;
  createdAt: string;
  account: { id: string; accountNumber: string } | null;
  premise: { id: string; addressLine1: string } | null;
  assignee: { id: string; name: string } | null;
  assignedTeam: string | null;
}

const STATUS_OPTIONS = [
  { value: "NEW", label: "New" },
  { value: "ASSIGNED", label: "Assigned" },
  { value: "IN_PROGRESS", label: "In Progress" },
  { value: "PENDING_FIELD", label: "Pending Field" },
  { value: "COMPLETED", label: "Completed" },
  { value: "CANCELLED", label: "Cancelled" },
  { value: "FAILED", label: "Failed" },
];

const PRIORITY_OPTIONS = [
  { value: "EMERGENCY", label: "Emergency" },
  { value: "HIGH", label: "High" },
  { value: "NORMAL", label: "Normal" },
  { value: "LOW", label: "Low" },
];

const SLA_STATUS_OPTIONS = [
  { value: "on_time", label: "On time" },
  { value: "at_risk", label: "At risk" },
  { value: "breached", label: "Breached" },
];

const columns: Column<ServiceRequestRow>[] = [
  {
    key: "requestNumber",
    header: "Request #",
    render: (row) => (
      <span style={{ fontFamily: "monospace", fontSize: 12, fontWeight: 600 }}>
        {row.requestNumber}
      </span>
    ),
  },
  {
    key: "requestType",
    header: "Type",
    render: (row) => (
      <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.04em" }}>
        {row.requestType.replace(/_/g, " ")}
      </span>
    ),
  },
  {
    key: "account",
    header: "Account",
    render: (row) =>
      row.account ? (
        <Link
          href={`/accounts/${row.account.id}`}
          style={{
            fontSize: 12,
            color: "var(--accent-primary)",
            textDecoration: "none",
          }}
          onClick={(e) => e.stopPropagation()}
        >
          {row.account.accountNumber}
        </Link>
      ) : (
        <span style={{ color: "var(--text-muted)", fontSize: 12 }}>—</span>
      ),
  },
  {
    key: "premise",
    header: "Premise",
    render: (row) =>
      row.premise ? (
        <span style={{ fontSize: 12 }}>{row.premise.addressLine1}</span>
      ) : (
        <span style={{ color: "var(--text-muted)", fontSize: 12 }}>—</span>
      ),
  },
  {
    key: "priority",
    header: "Priority",
    render: (row) => <StatusBadge status={row.priority} />,
  },
  {
    key: "status",
    header: "Status",
    render: (row) => <StatusBadge status={row.status} />,
  },
  {
    key: "assignee",
    header: "Assigned",
    render: (row) =>
      row.assignee?.name ? (
        <span style={{ fontSize: 12 }}>{row.assignee.name}</span>
      ) : row.assignedTeam ? (
        <span style={{ fontSize: 12 }}>{row.assignedTeam}</span>
      ) : (
        <span style={{ color: "var(--text-muted)", fontSize: 12 }}>unassigned</span>
      ),
  },
  {
    key: "sla",
    header: "SLA",
    render: (row) => (
      <SlaCountdown
        slaDueAt={row.slaDueAt}
        slaBreached={row.slaBreached}
        status={row.status}
      />
    ),
  },
  {
    key: "createdAt",
    header: "Created",
    render: (row) => (
      <span style={{ fontSize: 12 }}>
        {new Date(row.createdAt).toLocaleDateString()}
      </span>
    ),
  },
];

export interface ServiceRequestListProps {
  /**
   * If set, fetches from `/api/v1/accounts/:id/service-requests` instead of
   * the global queue. Used by the account-detail tab.
   */
  accountScope?: string;
  /** Hide filter bar when embedded in scoped contexts (account tab). */
  showFilters?: boolean;
  /** Optional "+ New Request" button href; hidden when omitted. */
  createHref?: string;
}

/**
 * Thin wrapper around EntityListPage — the same declarative shell the
 * other admin list pages use. The queue page passes `createHref` and
 * shows filters; the embedded account-detail tab hides filters and
 * points the create link at a prefilled form.
 *
 * The `accountScope` variant hits a different backend endpoint that
 * returns a plain array (not a paginated envelope), so we flip the
 * `paginated` flag accordingly.
 */
export function ServiceRequestList({
  accountScope,
  showFilters = true,
  createHref,
}: ServiceRequestListProps) {
  const filters: EntityListFilter[] = showFilters
    ? [
        { key: "status", label: "Status", options: STATUS_OPTIONS },
        { key: "priority", label: "Priority", options: PRIORITY_OPTIONS },
        { key: "slaStatus", label: "SLA", options: SLA_STATUS_OPTIONS },
      ]
    : [];

  // Both the global `/api/v1/service-requests` handler and the per-account
  // handler return plain array-shaped payloads (global returns
  // {data,total} which `usePaginatedList` unwraps in non-paginated mode;
  // the per-account endpoint returns a bare array). Neither returns the
  // {data,meta} envelope that `paginated: true` expects — so we run the
  // list in non-paginated mode and rely on its built-in array fallback.
  return (
    <EntityListPage<ServiceRequestRow>
      title="Service Requests"
      subject="service requests"
      module="service_requests"
      endpoint={
        accountScope
          ? `/api/v1/accounts/${accountScope}/service-requests`
          : "/api/v1/service-requests"
      }
      getDetailHref={(row) => `/service-requests/${row.id}`}
      columns={columns}
      filters={filters}
      newAction={createHref ? { label: "+ New Request", href: createHref } : undefined}
      paginated={false}
    />
  );
}
