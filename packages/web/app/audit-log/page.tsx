"use client";

import { useState, useEffect, useCallback } from "react";
import { PageHeader } from "@/components/ui/page-header";
import { FilterBar } from "@/components/ui/filter-bar";
import { DataTable } from "@/components/ui/data-table";
import { DatePicker } from "@/components/ui/date-picker";
import { apiClient } from "@/lib/api-client";
import { usePermission } from "@/lib/use-permission";
import { AccessDenied } from "@/components/ui/access-denied";

interface AuditEntry {
  id: string;
  entityType: string;
  entityId: string;
  action: string;
  actorId?: string;
  actorName?: string;
  /**
   * The actor's name as it stands today, supplied only when the row
   * recorded none. Not interchangeable with `actorName`, which is the
   * name at the time of the change — hence the "(current)" marker
   * where it is shown.
   */
  actorNameCurrent?: string | null;
  changes?: unknown;
  createdAt: string;
}

interface AuditResponse {
  data: AuditEntry[];
  meta: { total: number; page: number; limit: number; pages: number };
}

const ENTITY_TYPE_OPTIONS = [
  { label: "Premise", value: "Premise" },
  { label: "Meter", value: "Meter" },
  { label: "Account", value: "Account" },
  { label: "ServiceAgreement", value: "ServiceAgreement" },
  { label: "RateSchedule", value: "RateSchedule" },
  { label: "BillingCycle", value: "BillingCycle" },
];

const ACTION_OPTIONS = [
  { label: "Created", value: "CREATED" },
  { label: "Updated", value: "UPDATED" },
  { label: "Deleted", value: "DELETED" },
  { label: "Status Changed", value: "STATUS_CHANGED" },
];

const inputStyle = {
  padding: "7px 12px",
  borderRadius: "var(--radius)",
  border: "1px solid var(--border)",
  background: "var(--bg-elevated)",
  color: "var(--text-primary)",
  fontSize: "13px",
  fontFamily: "inherit",
  outline: "none",
};

export default function AuditLogPage() {
  const { canView } = usePermission("audit_log");
  const [data, setData] = useState<AuditEntry[]>([]);
  const [meta, setMeta] = useState({ total: 0, page: 1, limit: 20, pages: 0 });
  const [loading, setLoading] = useState(true);
  const [entityType, setEntityType] = useState<string | undefined>(undefined);
  const [action, setAction] = useState<string | undefined>(undefined);
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [page, setPage] = useState(1);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const params: Record<string, string> = { page: String(page), limit: "20" };
      if (entityType) params.entityType = entityType;
      if (action) params.action = action;
      if (dateFrom) params.dateFrom = dateFrom;
      if (dateTo) params.dateTo = dateTo;
      const res = await apiClient.get<AuditResponse>("/api/v1/audit-log", params);
      setData(res.data);
      setMeta(res.meta);
    } catch (err) {
      console.error("Failed to fetch audit log", err);
    } finally {
      setLoading(false);
    }
  }, [page, entityType, action, dateFrom, dateTo]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  if (!canView) return <AccessDenied />;

  const columns = [
    {
      key: "createdAt",
      header: "Timestamp",
      render: (row: AuditEntry) => (
        <span style={{ fontSize: "12px", fontFamily: "monospace" }}>
          {new Date(row.createdAt).toLocaleString()}
        </span>
      ),
    },
    {
      key: "entityType",
      header: "Entity Type",
      render: (row: AuditEntry) => (
        <span style={{ fontSize: "12px", color: "var(--text-secondary)" }}>{row.entityType}</span>
      ),
    },
    {
      key: "entityId",
      header: "Entity ID",
      render: (row: AuditEntry) => (
        <span style={{ fontFamily: "monospace", fontSize: "11px", color: "var(--text-muted)" }}>
          {row.entityId.slice(0, 8)}...
        </span>
      ),
    },
    {
      key: "action",
      header: "Action",
      render: (row: AuditEntry) => {
        const colors: Record<string, string> = {
          CREATED: "var(--success)",
          UPDATED: "var(--info)",
          DELETED: "var(--danger)",
          STATUS_CHANGED: "var(--warning)",
        };
        return (
          <span
            style={{
              fontSize: "11px",
              fontWeight: "600",
              color: colors[row.action] ?? "var(--text-secondary)",
              fontFamily: "monospace",
            }}
          >
            {row.action}
          </span>
        );
      },
    },
    {
      key: "actorId",
      header: "Actor",
      render: (row: AuditEntry) => {
        /*
         * Three cases, in order of how much the row knows:
         *   - a recorded name: what the actor was called at the time;
         *   - no recorded name but a known actor: today's name, shown
         *     muted and italic because it is a lookup rather than a
         *     record — the tooltip says so;
         *   - no actor at all: a scheduler, which names itself in
         *     `actorName`, so reaching "System" means neither was set.
         *
         * Rows written before `AuditContext.actorName` was required fall
         * into the second case — every BillDocument row did — and used
         * to render a raw 36-character uuid here.
         *
         * The second case carried a visible "(current)" suffix at first.
         * It went because this is the column that was overflowing, and
         * ten characters of label worked against the clipping fix for a
         * distinction that only ever applies to rows written before the
         * field became required. Muted italic keeps it discoverable
         * without widening the cell.
         */
        if (row.actorName) {
          return (
            <span style={{ fontSize: "12px" }} title={row.actorName}>
              {row.actorName}
            </span>
          );
        }
        if (row.actorNameCurrent) {
          return (
            <span
              style={{
                fontSize: "12px",
                color: "var(--text-secondary)",
                fontStyle: "italic",
              }}
              title={`This entry did not record a name. ${row.actorNameCurrent} is what this user is called today, which may differ from the name they had at the time.`}
            >
              {row.actorNameCurrent}
            </span>
          );
        }
        const fallback = row.actorId ?? "System";
        return (
          <span style={{ fontSize: "12px" }} title={fallback}>
            {fallback}
          </span>
        );
      },
    },
  ];

  return (
    <div>
      <PageHeader
        title="Audit Log"
        subtitle={`${meta.total.toLocaleString()} total entries`}
      />

      {/* Date range filter */}
      <div style={{ display: "flex", gap: "10px", alignItems: "center", marginBottom: "8px" }}>
        <span style={{ fontSize: "12px", color: "var(--text-muted)", fontWeight: "500" }}>
          Date range:
        </span>
        <DatePicker
          value={dateFrom}
          onChange={(v) => { setDateFrom(v); setPage(1); }}
          placeholder="Start date"
        />
        <span style={{ color: "var(--text-muted)", fontSize: "12px" }}>to</span>
        <DatePicker
          value={dateTo}
          onChange={(v) => { setDateTo(v); setPage(1); }}
          placeholder="End date"
        />
        {(dateFrom || dateTo) && (
          <button
            onClick={() => { setDateFrom(""); setDateTo(""); setPage(1); }}
            style={{
              padding: "5px 10px",
              borderRadius: "var(--radius)",
              border: "1px solid var(--border)",
              background: "transparent",
              color: "var(--text-muted)",
              fontSize: "11px",
              cursor: "pointer",
              fontFamily: "inherit",
            }}
          >
            Clear
          </button>
        )}
      </div>

      <div style={{ marginBottom: 16 }}>
      <FilterBar
        filters={[
          {
            key: "entityType",
            label: "Entity Type",
            options: ENTITY_TYPE_OPTIONS,
            value: entityType,
            onChange: (v) => { setEntityType(v); setPage(1); },
          },
          {
            key: "action",
            label: "Action",
            options: ACTION_OPTIONS,
            value: action,
            onChange: (v) => { setAction(v); setPage(1); },
          },
        ]}
      />
      </div>

      <DataTable
        columns={columns as any}
        data={data as any}
        meta={meta}
        loading={loading}
        onPageChange={setPage}
      />
    </div>
  );
}
