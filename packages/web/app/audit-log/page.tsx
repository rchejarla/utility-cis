"use client";

import { useState, useEffect, useCallback } from "react";
import { PageHeader } from "@/components/ui/page-header";
import { FilterBar } from "@/components/ui/filter-bar";
import { DataTable } from "@/components/ui/data-table";
import { DatePicker } from "@/components/ui/date-picker";
import { apiClient } from "@/lib/api-client";
import { usePermission } from "@/lib/use-permission";
import { AccessDenied } from "@/components/ui/access-denied";
import { AUDIT_ACTIONS, type AuditActionValue } from "@utility-cis/shared";

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
   * name at the time of the change, which is why it renders muted and
   * italic rather than as the recorded value.
   */
  actorNameCurrent?: string | null;
  changes?: unknown;
  createdAt: string;
}

interface AuditResponse {
  data: AuditEntry[];
  meta: { total: number; page: number; limit: number; pages: number };
}

/*
 * Entity types are fetched from `/api/v1/audit-log/entity-types`, not
 * listed here. A hardcoded list of six had drifted while the API grew
 * to write 27 distinct types, so most of the log could not be filtered
 * for.
 */

/*
 * Actions come from the shared constant the query schema also uses.
 * This list read CREATED / UPDATED / DELETED / STATUS_CHANGED, none of
 * which the column holds or the `.strict()` schema accepts — so the
 * filter answered 400 and the colours below never matched a row.
 */
const ACTION_LABELS: Record<AuditActionValue, string> = {
  CREATE: "Created",
  UPDATE: "Updated",
  DELETE: "Deleted",
};

const ACTION_OPTIONS = AUDIT_ACTIONS.map((value) => ({
  label: ACTION_LABELS[value],
  value,
}));

/**
 * Makes the date triggers read as siblings of the filter pills beside
 * them. The picker's own default is `--bg-deep`, which in light mode is
 * indigo-50 (`#eef2ff`) — the page background, and the same token as
 * `--accent-primary-subtle` — so against the white (`--bg-card`) pills
 * the dates looked tinted and selected.
 *
 * `width` is set because the trigger defaults to `100%`, which stretches
 * inside a flex row. The picker applies its text colour after this
 * spread, on purpose, so the value/placeholder distinction stays with
 * the component.
 */
const DATE_TRIGGER_STYLE: React.CSSProperties = {
  width: "auto",
  minWidth: "132px",
  padding: "5px 12px",
  borderRadius: "999px",
  background: "var(--bg-card)",
  fontSize: "12px",
  fontWeight: 500,
};

/** Matched against `row.action`, so keyed on what the column holds. */
const ACTION_COLORS: Record<AuditActionValue, string> = {
  CREATE: "var(--success)",
  UPDATE: "var(--info)",
  DELETE: "var(--danger)",
};

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
  const [entityTypeOptions, setEntityTypeOptions] = useState<
    Array<{ label: string; value: string }>
  >([]);

  // The types this tenant's log actually holds, rather than a list kept
  // by hand here. Fetched once; the set only grows as entities are
  // audited.
  useEffect(() => {
    apiClient
      .get<{ data: string[] }>("/api/v1/audit-log/entity-types")
      .then((res) =>
        setEntityTypeOptions((res.data ?? []).map((t) => ({ label: t, value: t }))),
      )
      .catch((err) => console.error("Failed to fetch audit entity types", err));
  }, []);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const params: Record<string, string> = { page: String(page), limit: "20" };
      if (entityType) params.entityType = entityType;
      if (action) params.action = action;
      /*
       * `startDate` / `endDate` as ISO datetimes, which is what the
       * query schema takes. This sent `dateFrom` / `dateTo` as bare
       * `YYYY-MM-DD`, and the schema is `.strict()` with
       * `z.string().datetime()` — so the date range answered 400 on
       * both counts and had never filtered anything. (Spec 17
       * documented a third pair of names again, `from` / `to`.)
       *
       * Built from local midnight rather than by appending "Z", so a
       * calendar day means the user's day. The end bound runs to the
       * last millisecond because the comparison is `lte`: at
       * T00:00:00 picking today would exclude everything that happened
       * today.
       */
      if (dateFrom) params.startDate = new Date(`${dateFrom}T00:00:00`).toISOString();
      if (dateTo) params.endDate = new Date(`${dateTo}T23:59:59.999`).toISOString();
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
        return (
          <span
            style={{
              fontSize: "11px",
              fontWeight: "600",
              color:
                ACTION_COLORS[row.action as AuditActionValue] ?? "var(--text-secondary)",
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

      {/*
        One row: date range beside the filter pills. They were stacked,
        which gave two half-empty rows above a table that wants the
        height.
      */}
      <div
        style={{
          display: "flex",
          gap: "10px",
          alignItems: "center",
          flexWrap: "wrap",
          marginBottom: 16,
        }}
      >
        <span style={{ fontSize: "12px", color: "var(--text-muted)", fontWeight: "500" }}>
          Date range:
        </span>
        <DatePicker
          value={dateFrom}
          onChange={(v) => { setDateFrom(v); setPage(1); }}
          placeholder="Start date"
          triggerStyle={DATE_TRIGGER_STYLE}
        />
        <span style={{ color: "var(--text-muted)", fontSize: "12px" }}>to</span>
        <DatePicker
          value={dateTo}
          onChange={(v) => { setDateTo(v); setPage(1); }}
          placeholder="End date"
          triggerStyle={DATE_TRIGGER_STYLE}
        />
        {(dateFrom || dateTo) && (
          <button
            onClick={() => { setDateFrom(""); setDateTo(""); setPage(1); }}
            style={{
              padding: "5px 10px",
              borderRadius: "999px",
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
        <FilterBar
          filters={[
            {
              key: "entityType",
              label: "Entity Type",
              options: entityTypeOptions,
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
