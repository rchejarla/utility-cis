"use client";

import { useCallback, useEffect, useState } from "react";
import { PageHeader } from "@/components/ui/page-header";
import { PageDescription } from "@/components/ui/page-description";
import { AccessDenied } from "@/components/ui/access-denied";
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
 * Hand-rolled rather than `EntityListPage`: the whole point is editing
 * a handful of rows in place, and a list page that navigates to a
 * detail screen for a code and a label would be three clicks to rename
 * "On-peak".
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
  padding: "4px 8px",
  borderRadius: "var(--radius)",
  border: "1px solid var(--border)",
  background: "var(--bg-elevated)",
  color: "var(--text-primary)",
  fontSize: "12px",
  fontFamily: "inherit",
  width: "100%",
  boxSizing: "border-box" as const,
};

const button = (kind: "primary" | "secondary", disabled = false) => ({
  padding: "5px 12px",
  borderRadius: "var(--radius)",
  border: kind === "primary" ? "none" : "1px solid var(--border)",
  background: kind === "primary" ? "var(--accent-primary)" : "transparent",
  color: kind === "primary" ? "#fff" : "var(--text-secondary)",
  fontSize: "12px",
  fontWeight: kind === "primary" ? 500 : 400,
  cursor: disabled ? "not-allowed" : "pointer",
  opacity: disabled ? 0.6 : 1,
  fontFamily: "inherit",
});

export default function TouPeriodsPage() {
  const { canView, canEdit, canCreate } = usePermission("rate_schedules");

  const [periods, setPeriods] = useState<Period[]>([]);
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

  if (!canView) return <AccessDenied />;
  if (loadError) {
    return (
      <div style={{ padding: "24px", color: "var(--danger)" }} role="alert">
        {loadError}
      </div>
    );
  }

  return (
    <div style={{ maxWidth: "820px", display: "flex", flexDirection: "column", gap: "16px" }}>
      <PageHeader
        title="Periods"
        subtitle={`${periods.length} price ${periods.length === 1 ? "tier" : "tiers"} this utility's tariffs charge at`}
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
            fontSize: "12px",
            color: "var(--danger)",
            whiteSpace: "pre-wrap",
          }}
        >
          {actionError}
        </div>
      )}

      <div
        style={{
          border: "1px solid var(--border)",
          borderRadius: "var(--radius)",
          padding: "14px",
          background: "var(--bg-card)",
          display: "flex",
          flexDirection: "column",
          gap: "12px",
        }}
      >
        <table style={{ width: "100%", fontSize: "12px", borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ textAlign: "left", color: "var(--text-muted)" }}>
              <th style={{ padding: "2px 4px 6px 0", fontWeight: 400, width: "22%" }}>Code</th>
              <th style={{ padding: "2px 4px 6px", fontWeight: 400, width: "28%" }}>Label</th>
              <th style={{ padding: "2px 4px 6px", fontWeight: 400, width: "10%" }}>Order</th>
              <th style={{ padding: "2px 4px 6px", fontWeight: 400 }}>Used by</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {periods.map((period) => {
              const edit = editing?.id === period.id ? editing : null;
              return (
                <tr key={period.id} data-testid={`period-${period.peakCode}`}>
                  <td style={{ padding: "4px 4px 4px 0", fontFamily: "monospace" }}>
                    {period.peakCode}
                  </td>
                  <td style={{ padding: "4px" }}>
                    {edit ? (
                      <input
                        aria-label="Period label"
                        style={inputStyle}
                        value={edit.label}
                        onChange={(e) => setEditing({ ...edit, label: e.target.value })}
                      />
                    ) : (
                      period.label
                    )}
                  </td>
                  <td style={{ padding: "4px" }}>
                    {edit ? (
                      <input
                        aria-label="Display order"
                        type="number"
                        min={0}
                        max={100}
                        style={inputStyle}
                        value={edit.sortOrder}
                        onChange={(e) =>
                          setEditing({ ...edit, sortOrder: Number(e.target.value) })
                        }
                      />
                    ) : (
                      period.sortOrder
                    )}
                  </td>
                  <td style={{ padding: "4px", color: "var(--text-muted)" }}>
                    {/*
                      What makes this row removable or not, said before
                      somebody tries. A published calendar's hours can
                      never be reassigned, so a code they use is
                      permanent for as long as that version is in force.
                    */}
                    {period.spanCount === 0
                      ? "nothing yet"
                      : `${period.spanCount} ${period.spanCount === 1 ? "span" : "spans"} in ${period.calendarCount} ${period.calendarCount === 1 ? "calendar" : "calendars"}`}
                  </td>
                  <td style={{ padding: "4px 0 4px 4px", textAlign: "right", whiteSpace: "nowrap" }}>
                    {canEdit &&
                      (edit ? (
                        <>
                          <button
                            type="button"
                            disabled={busy || edit.label.trim() === ""}
                            style={button("primary", busy || edit.label.trim() === "")}
                            onClick={() =>
                              run(
                                () =>
                                  apiClient.patch(`/api/v1/tou-periods/${period.id}`, {
                                    label: edit.label,
                                    sortOrder: edit.sortOrder,
                                  }),
                                "Could not save this period",
                              )
                            }
                          >
                            Save
                          </button>{" "}
                          <button
                            type="button"
                            style={button("secondary")}
                            onClick={() => setEditing(null)}
                          >
                            Cancel
                          </button>
                        </>
                      ) : (
                        <>
                          <button
                            type="button"
                            aria-label={`Rename ${period.peakCode}`}
                            style={button("secondary")}
                            onClick={() =>
                              setEditing({
                                id: period.id,
                                label: period.label,
                                sortOrder: period.sortOrder,
                              })
                            }
                          >
                            Edit
                          </button>{" "}
                          <button
                            type="button"
                            aria-label={`Remove ${period.peakCode}`}
                            disabled={busy || period.spanCount > 0}
                            title={
                              period.spanCount > 0
                                ? "Hours are charged at this code. Reassign them first."
                                : undefined
                            }
                            style={{
                              ...button("secondary", busy || period.spanCount > 0),
                              color: "var(--danger)",
                            }}
                            onClick={() =>
                              run(
                                () => apiClient.delete(`/api/v1/tou-periods/${period.id}`),
                                "Could not remove this period",
                              )
                            }
                          >
                            Remove
                          </button>
                        </>
                      ))}
                  </td>
                </tr>
              );
            })}

            {adding && (
              <tr data-testid="new-period">
                <td style={{ padding: "4px 4px 4px 0" }}>
                  <input
                    aria-label="New period code"
                    style={{ ...inputStyle, fontFamily: "monospace" }}
                    value={adding.peakCode}
                    placeholder="super_off_peak"
                    onChange={(e) => setAdding({ ...adding, peakCode: e.target.value })}
                  />
                </td>
                <td style={{ padding: "4px" }}>
                  <input
                    aria-label="New period label"
                    style={inputStyle}
                    value={adding.label}
                    placeholder="Super off-peak"
                    onChange={(e) => setAdding({ ...adding, label: e.target.value })}
                  />
                </td>
                <td colSpan={2} style={{ padding: "4px", color: "var(--text-muted)" }}>
                  Lower case, digits and underscores. The code cannot be changed later.
                </td>
                <td style={{ padding: "4px 0 4px 4px", textAlign: "right", whiteSpace: "nowrap" }}>
                  <button
                    type="button"
                    disabled={
                      busy || adding.peakCode.trim() === "" || adding.label.trim() === ""
                    }
                    style={button(
                      "primary",
                      busy || adding.peakCode.trim() === "" || adding.label.trim() === "",
                    )}
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
                  </button>{" "}
                  <button
                    type="button"
                    style={button("secondary")}
                    onClick={() => setAdding(null)}
                  >
                    Cancel
                  </button>
                </td>
              </tr>
            )}
          </tbody>
        </table>

        {canCreate && !adding && (
          <div>
            <button
              type="button"
              style={button("secondary")}
              onClick={() => setAdding({ peakCode: "", label: "" })}
            >
              Add a period
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
