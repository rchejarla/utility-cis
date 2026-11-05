"use client";

import { useCallback, useEffect, useState } from "react";
import { PageHeader } from "@/components/ui/page-header";
import { PageDescription } from "@/components/ui/page-description";
import { AccessDenied } from "@/components/ui/access-denied";
import { DataTable, type Column } from "@/components/ui/data-table";
import { apiClient } from "@/lib/api-client";
import { usePermission } from "@/lib/use-permission";

/**
 * The tenant's TOU periods — its price tiers (spec 26, TOU-CAL-1).
 *
 * One screen for the whole utility, because that is what these are.
 * They were declared on each calendar until 2026-11-04, which meant
 * retyping `off_peak/mid_peak/peak` for every version and gave the
 * calendar editor a tab for a three-row table.
 *
 * `DataTable` for the chrome, so this reads as a list page like every
 * other one, but not `EntityListPage`: that shell navigates to a detail
 * screen per row, which for a code and a label would be three clicks to
 * rename "On-peak". The rows are edited where they sit, and the editor
 * is the row — `DataTable` renders whatever a column hands it, so the
 * cell holds an input while that row is being edited and plain text the
 * rest of the time.
 */

interface Period {
  id: string;
  peakCode: string;
  label: string;
  sortOrder: number;
  /** How many spans across all calendars charge at this code. */
  spanCount: number;
  calendarCount: number;
}

const inputStyle = {
  padding: "6px 10px",
  borderRadius: "var(--radius)",
  border: "1px solid var(--border)",
  background: "var(--bg-elevated)",
  color: "var(--text-primary)",
  fontSize: "13px",
  fontFamily: "inherit",
  width: "100%",
  boxSizing: "border-box" as const,
  outline: "none",
};

/**
 * The in-row button, at the size the other tables' row actions use
 * (`meters-tab.tsx`): 11px on a 3px/10px box, so a cell with two of
 * them still reads as one line of a table rather than a toolbar.
 */
const ROW_BUTTON_KINDS = {
  primary: { border: "none", background: "var(--accent-primary)", color: "#fff" },
  secondary: {
    border: "1px solid var(--border)",
    background: "transparent",
    color: "var(--text-secondary)",
  },
  danger: {
    border: "1px solid var(--danger)",
    background: "transparent",
    color: "var(--danger)",
  },
} as const;

const rowButton = (kind: keyof typeof ROW_BUTTON_KINDS, disabled = false) => ({
  padding: "3px 10px",
  fontSize: "11px",
  fontWeight: 500 as const,
  borderRadius: "var(--radius)",
  cursor: disabled ? "not-allowed" : "pointer",
  opacity: disabled ? 0.6 : 1,
  fontFamily: "inherit",
  ...ROW_BUTTON_KINDS[kind],
});

const panelButton = (kind: "primary" | "secondary", disabled = false) => ({
  ...rowButton(kind, disabled),
  padding: "6px 14px",
  fontSize: "12px",
});

export default function TouPeriodsPage() {
  const { canView, canEdit, canCreate } = usePermission("rate_schedules");

  const [periods, setPeriods] = useState<Period[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** The row being edited, by id, and the values typed into it. */
  const [editing, setEditing] = useState<{ id: string; label: string; sortOrder: number } | null>(
    null,
  );
  const [adding, setAdding] = useState<{ peakCode: string; label: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await apiClient.get<{ data: Period[] }>("/api/v1/tou-periods");
      setPeriods(res.data ?? []);
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Could not load the periods");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const run = async (work: () => Promise<unknown>, whenItFails: string) => {
    setBusy(true);
    setActionError(null);
    try {
      await work();
      await load();
      setEditing(null);
      setAdding(null);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : whenItFails);
    } finally {
      setBusy(false);
    }
  };

  const columns: Column<Period>[] = [
    {
      key: "peakCode",
      header: "Code",
      render: (row) => (
        <span
          data-testid={`period-${row.peakCode}`}
          style={{ fontFamily: "monospace", fontSize: "12px", fontWeight: 600 }}
        >
          {row.peakCode}
        </span>
      ),
    },
    {
      key: "label",
      header: "Label",
      render: (row) =>
        editing?.id === row.id ? (
          <input
            aria-label="Period label"
            style={inputStyle}
            value={editing.label}
            onChange={(e) => setEditing({ ...editing, label: e.target.value })}
          />
        ) : (
          <span style={{ fontWeight: 500 }}>{row.label}</span>
        ),
    },
    {
      key: "sortOrder",
      header: "Order",
      render: (row) =>
        editing?.id === row.id ? (
          <input
            aria-label="Display order"
            type="number"
            min={0}
            max={100}
            style={{ ...inputStyle, width: "72px" }}
            value={editing.sortOrder}
            onChange={(e) => setEditing({ ...editing, sortOrder: Number(e.target.value) })}
          />
        ) : (
          <span style={{ fontFamily: "monospace", fontSize: "12px" }}>{row.sortOrder}</span>
        ),
    },
    {
      key: "usedBy",
      header: "Used by",
      /*
        What makes this row removable or not, said before somebody
        tries. A published calendar's hours can never be reassigned, so
        a code they use is permanent for as long as that version is in
        force.
      */
      render: (row) => (
        <span style={{ fontSize: "12px", color: "var(--text-muted)" }}>
          {row.spanCount === 0
            ? "nothing yet"
            : `${row.spanCount} ${row.spanCount === 1 ? "span" : "spans"} in ${row.calendarCount} ${row.calendarCount === 1 ? "calendar" : "calendars"}`}
        </span>
      ),
    },
  ];

  if (canEdit) {
    columns.push({
      key: "actions",
      header: "",
      /*
        Stated rather than left to column order: below tablet width
        `DataTable` renders each row as a card with its values
        right-aligned in a span, which an input and two buttons do not
        survive. So the page is read-only on a phone. Every other list
        hides a column and sends the reader to the row's detail view;
        this one has no detail view, by design — the row is the editor.
      */
      hideBelow: "tablet",
      render: (row) =>
        editing?.id === row.id ? (
          <div style={{ display: "flex", gap: "6px" }}>
            <button
              type="button"
              disabled={busy || editing.label.trim() === ""}
              style={rowButton("primary", busy || editing.label.trim() === "")}
              onClick={() =>
                run(
                  () =>
                    apiClient.patch(`/api/v1/tou-periods/${row.id}`, {
                      label: editing.label,
                      sortOrder: editing.sortOrder,
                    }),
                  "Could not save this period",
                )
              }
            >
              Save
            </button>
            <button type="button" style={rowButton("secondary")} onClick={() => setEditing(null)}>
              Cancel
            </button>
          </div>
        ) : (
          <div style={{ display: "flex", gap: "6px" }}>
            <button
              type="button"
              aria-label={`Rename ${row.peakCode}`}
              style={rowButton("secondary")}
              onClick={() =>
                setEditing({ id: row.id, label: row.label, sortOrder: row.sortOrder })
              }
            >
              Edit
            </button>
            <button
              type="button"
              aria-label={`Remove ${row.peakCode}`}
              disabled={busy || row.spanCount > 0}
              title={
                row.spanCount > 0
                  ? "Hours are charged at this code. Reassign them first."
                  : undefined
              }
              style={rowButton("danger", busy || row.spanCount > 0)}
              onClick={() =>
                run(
                  () => apiClient.delete(`/api/v1/tou-periods/${row.id}`),
                  "Could not remove this period",
                )
              }
            >
              Remove
            </button>
          </div>
        ),
    });
  }

  if (!canView) return <AccessDenied />;
  if (loadError) {
    return (
      <div style={{ padding: "24px", color: "var(--danger)" }} role="alert">
        {loadError}
      </div>
    );
  }

  const addDisabled =
    busy || !adding || adding.peakCode.trim() === "" || adding.label.trim() === "";

  return (
    <div>
      <PageHeader
        title="Periods"
        subtitle={`${periods.length} price ${periods.length === 1 ? "tier" : "tiers"} this utility's tariffs charge at`}
        action={
          canCreate && !adding
            ? { label: "Add a period", onClick: () => setAdding({ peakCode: "", label: "" }) }
            : undefined
        }
      />

      <PageDescription storageKey="tou-periods">
        A <b>period</b> is a price tier — <code>off_peak</code>, <code>peak</code>,{" "}
        <code>super_off_peak</code>. The names are yours. A <b>TOU calendar</b> says
        which hours fall in each; a <b>rate schedule</b> says what each costs, and
        cannot be published until it prices every period its calendar uses.
        <br />
        <br />
        These are defined once for the whole utility, so a calendar does not
        retype them. A calendar <i>uses</i> whichever of them its hours name — a
        two-period tariff in a four-period utility is perfectly ordinary. The{" "}
        <b>code cannot be changed</b> once it exists: it has been copied into the
        calendars&apos; hours, into rate components and onto meter registers.
      </PageDescription>

      {actionError && (
        <div
          data-testid="action-error"
          role="alert"
          style={{
            border: "1px solid var(--danger)",
            borderRadius: "var(--radius)",
            padding: "10px 12px",
            marginBottom: "16px",
            fontSize: "12px",
            color: "var(--danger)",
            whiteSpace: "pre-wrap",
          }}
        >
          {actionError}
        </div>
      )}

      {adding && (
        <div
          data-testid="new-period"
          style={{
            background: "var(--bg-card)",
            border: "1px solid var(--accent-primary)",
            borderRadius: "var(--radius)",
            padding: "20px",
            marginBottom: "16px",
          }}
        >
          <div
            style={{
              fontSize: "14px",
              fontWeight: 600,
              color: "var(--text-primary)",
              marginBottom: "4px",
            }}
          >
            Add a period
          </div>
          <div style={{ fontSize: "11px", color: "var(--text-muted)", marginBottom: "16px" }}>
            Lower case, digits and underscores. The code cannot be changed later.
          </div>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr) auto",
              gap: "12px",
              alignItems: "flex-end",
            }}
          >
            <div>
              <div
                style={{
                  fontSize: "11px",
                  color: "var(--text-muted)",
                  marginBottom: "4px",
                  fontWeight: 500,
                }}
              >
                Code *
              </div>
              <input
                aria-label="New period code"
                style={{ ...inputStyle, fontFamily: "monospace" }}
                value={adding.peakCode}
                placeholder="super_off_peak"
                onChange={(e) => setAdding({ ...adding, peakCode: e.target.value })}
              />
            </div>
            <div>
              <div
                style={{
                  fontSize: "11px",
                  color: "var(--text-muted)",
                  marginBottom: "4px",
                  fontWeight: 500,
                }}
              >
                Label *
              </div>
              <input
                aria-label="New period label"
                style={inputStyle}
                value={adding.label}
                placeholder="Super off-peak"
                onChange={(e) => setAdding({ ...adding, label: e.target.value })}
              />
            </div>
            <div style={{ display: "flex", gap: "8px" }}>
              <button
                type="button"
                style={panelButton("secondary")}
                onClick={() => setAdding(null)}
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={addDisabled}
                style={panelButton("primary", addDisabled)}
                onClick={() =>
                  run(
                    () =>
                      apiClient.post("/api/v1/tou-periods", {
                        peakCode: adding.peakCode.trim(),
                        label: adding.label.trim(),
                      }),
                    "Could not add this period",
                  )
                }
              >
                Add
              </button>
            </div>
          </div>
        </div>
      )}

      {/*
        `DataTable` is generic over `Record<string, unknown>`, because a
        column with no `render` reads `row[col.key]`. Every column here
        has one, so the cast gives up nothing — it is the same one
        `entity-list-page.tsx` makes on behalf of its callers.
      */}
      <DataTable
        columns={columns as unknown as Column<Record<string, unknown>>[]}
        data={periods as unknown as Record<string, unknown>[]}
        loading={loading}
      />
    </div>
  );
}
