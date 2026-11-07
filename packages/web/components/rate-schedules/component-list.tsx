"use client";

import { useEffect, useState } from "react";
import { apiClient } from "@/lib/api-client";
import { useToast } from "@/components/ui/toast";
import { usePermission } from "@/lib/use-permission";

export interface RateComponent {
  id: string;
  rateScheduleId: string;
  utilityId: string;
  kindCode: string;
  label: string;
  predicate: unknown;
  quantitySource: unknown;
  pricing: unknown;
  sortOrder: number;
  effectiveDate: string;
  expirationDate: string | null;
  createdAt: string;
  updatedAt: string;
}

interface Props {
  scheduleId: string;
  refreshKey: number;
  onEdit: (component: RateComponent) => void;
  onAdd: () => void;
  /**
   * When true, hides the Add / Edit / Delete buttons and renders an
   * explanatory note. Used by the schedule detail page after the
   * schedule has been published or superseded — components are
   * immutable in those states (slice 2 follow-up).
   */
  disabled?: boolean;
}

const thStyle = {
  textAlign: "left" as const,
  padding: "10px 16px",
  fontSize: 11,
  fontWeight: 600,
  color: "var(--text-muted)",
  textTransform: "uppercase" as const,
  letterSpacing: "0.06em",
  borderBottom: "1px solid var(--border)",
  background: "var(--bg-elevated)",
  whiteSpace: "nowrap" as const,
};

const tdStyle = {
  padding: "12px 16px",
  fontSize: 13,
  color: "var(--text-primary)",
  borderBottom: "1px solid var(--border-subtle)",
  verticalAlign: "middle" as const,
};

const addBtnStyle = {
  padding: "7px 16px",
  borderRadius: "var(--radius)",
  border: "none",
  background: "var(--accent-primary)",
  color: "#fff",
  fontSize: 12,
  fontWeight: 500,
  cursor: "pointer",
  fontFamily: "inherit",
};

const deleteBtnStyle = {
  padding: "4px 10px",
  fontSize: 12,
  background: "transparent",
  border: "1px solid var(--border)",
  borderRadius: 6,
  color: "var(--text-muted)",
  cursor: "pointer",
  fontFamily: "inherit",
};

const editBtnStyle = {
  padding: "4px 10px",
  fontSize: 12,
  background: "transparent",
  border: "1px solid var(--border)",
  borderRadius: 6,
  color: "var(--accent-primary)",
  cursor: "pointer",
  fontFamily: "inherit",
};

const kindBadgeStyle = {
  display: "inline-block",
  padding: "2px 8px",
  fontSize: 11,
  fontFamily: "monospace",
  background: "var(--bg-elevated)",
  border: "1px solid var(--border)",
  borderRadius: 4,
  color: "var(--text-secondary)",
};

function formatRange(effective: string, expiration: string | null) {
  const start = effective?.slice(0, 10) ?? "—";
  const end = expiration ? expiration.slice(0, 10) : "open";
  return `${start} → ${end}`;
}

/** Rates are printed as authored: 0.0741 must not round to 0.07. */
function num(v: unknown): string {
  return typeof v === "number" ? String(v) : "?";
}

function per(unit: unknown): string {
  return typeof unit === "string" && unit ? ` /${unit}` : "";
}

/**
 * Which other components a `percent_of` or `floor` is measured against.
 *
 * Selectors nest arbitrarily, so anything compound collapses to "a
 * selection" — the editor is where a selector is read in full. What
 * this cell owes the reader is the common case, which is one kind.
 */
function selectorSummary(selector: unknown): string {
  if (!selector || typeof selector !== "object") return "a selection";
  const s = selector as Record<string, unknown>;
  if (typeof s.kind === "string") return s.kind;
  if (Array.isArray(s.kind_in)) return s.kind_in.join(", ");
  if (Array.isArray(s.exclude_kind)) return `all but ${s.exclude_kind.join(", ")}`;
  if (typeof s.has_label_prefix === "string") return `labels "${s.has_label_prefix}"`;
  if (typeof s.component_id === "string") return "one component";
  return "a selection";
}

/**
 * What the charge costs, in one cell.
 *
 * The list used to print the *name* of the pricing shape — "flat" —
 * which is the one thing about a tariff nobody needs to look up. The
 * number is why the page is open. Every shape in the grammar gets a
 * summary that leads with its rate; the shape's name appears only
 * where the rate alone would be ambiguous ("3 tiers", "6.5% of").
 */
function priceSummary(pricing: unknown): string {
  if (!pricing || typeof pricing !== "object") return "—";
  const p = pricing as Record<string, unknown>;

  switch (p.type) {
    case "flat":
    case "per_unit":
      return `${num(p.rate)}${per(p.unit)}`;
    case "tiered": {
      const tiers = Array.isArray(p.tiers) ? (p.tiers as Record<string, unknown>[]) : [];
      if (tiers.length === 0) return "tiered (no tiers)";
      const first = num(tiers[0]!.rate);
      const last = num(tiers[tiers.length - 1]!.rate);
      // First → last in tier order, not min–max: a declining block
      // tariff would read backwards the other way round.
      const span = tiers.length === 1 ? first : `${first} → ${last}`;
      return `${tiers.length} tier${tiers.length === 1 ? "" : "s"} · ${span}${per(p.unit)}`;
    }
    case "lookup": {
      const rates = p.table && typeof p.table === "object" ? Object.keys(p.table).length : 0;
      return `by ${String(p.by)} · ${rates} rate${rates === 1 ? "" : "s"}${per(p.unit)}`;
    }
    case "catalog": {
      const rates = p.table && typeof p.table === "object" ? Object.keys(p.table).length : 0;
      const by = Array.isArray(p.by) ? p.by.join(" + ") : String(p.by);
      return `by ${by} · ${rates} price${rates === 1 ? "" : "s"}`;
    }
    case "percent_of":
      return `${num(p.percent)}% of ${selectorSummary(p.selector)}`;
    case "indexed": {
      const mult = typeof p.multiplier === "number" && p.multiplier !== 1 ? ` × ${p.multiplier}` : "";
      return `index ${String(p.index_name)}${mult}${per(p.unit)}`;
    }
    case "floor":
      return `floor ${num(p.amount)}${p.applies_to_subtotal === true ? " (subtotal)" : ""}`;
    default:
      return typeof p.type === "string" ? p.type : "—";
  }
}

/**
 * What the charge is measured on — and, for a TOU charge, which period.
 *
 * The peak code lived only inside the quantity source, so two charges
 * labelled "Off-peak energy" and "On-peak energy" with their codes
 * crossed over read identically here and billed at each other's rate.
 * Nothing compares a free-text label against the code, and nothing
 * can; printing the code next to the label is what makes the pair
 * checkable by the person who wrote it.
 */
function quantitySummary(source: unknown): { base: string; qualifier: string | null } {
  if (!source || typeof source !== "object") return { base: "—", qualifier: null };
  const q = source as Record<string, unknown>;
  const base = typeof q.base === "string" ? q.base : "—";
  if (base === "tou_period") {
    return { base, qualifier: typeof q.peak_code === "string" ? q.peak_code : "no period" };
  }
  if (base === "premise_attribute") {
    return { base, qualifier: typeof q.source_attr === "string" ? q.source_attr : null };
  }
  return { base, qualifier: null };
}

export function ComponentList({ scheduleId, refreshKey, onEdit, onAdd, disabled = false }: Props) {
  const { toast } = useToast();
  const { canEdit: rawCanEdit, canDelete: rawCanDelete } = usePermission("rate_schedules");
  const canEdit = rawCanEdit && !disabled;
  const canDelete = rawCanDelete && !disabled;
  const [components, setComponents] = useState<RateComponent[]>([]);
  const [loading, setLoading] = useState(true);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    apiClient
      .get<RateComponent[]>(`/api/v1/rate-schedules/${scheduleId}/components`)
      .then((data) => {
        if (!cancelled) setComponents(Array.isArray(data) ? data : []);
      })
      .catch((err) => {
        console.error("Failed to load components", err);
        if (!cancelled) {
          toast(
            err instanceof Error ? err.message : "Failed to load components",
            "error",
          );
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // toast is stable from context; intentionally excluded
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scheduleId, refreshKey]);

  async function handleDelete(id: string) {
    setDeleting(true);
    try {
      await apiClient.delete(`/api/v1/rate-components/${id}`);
      setComponents((prev) => prev.filter((c) => c.id !== id));
      toast("Component deleted", "success");
      setConfirmDeleteId(null);
    } catch (err) {
      toast(
        err instanceof Error
          ? err.message.replace(/^API error \d+:\s*/, "")
          : "Failed to delete component",
        "error",
      );
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div
      style={{
        background: "var(--bg-card)",
        border: "1px solid var(--border)",
        borderRadius: "var(--radius)",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "14px 20px",
          borderBottom: "1px solid var(--border)",
        }}
      >
        <div>
          <h3
            style={{
              margin: 0,
              fontSize: 14,
              fontWeight: 600,
              color: "var(--text-primary)",
            }}
          >
            Components
          </h3>
          <p
            style={{
              margin: "2px 0 0",
              fontSize: 12,
              color: "var(--text-muted)",
            }}
          >
            Charges, taxes, credits, and other line items applied during rating.
          </p>
          {disabled && (
            <p
              style={{
                margin: "6px 0 0",
                fontSize: 12,
                color: "var(--warning, #b45309)",
              }}
            >
              Schedule is published — components are immutable. Revise to make changes.
            </p>
          )}
        </div>
        {canEdit && (
          <button type="button" onClick={onAdd} style={addBtnStyle}>
            + Add Component
          </button>
        )}
      </div>

      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              <th style={{ ...thStyle, width: 80 }}>Order</th>
              <th style={thStyle}>Label</th>
              <th style={thStyle}>Price</th>
              <th style={thStyle}>Charged on</th>
              <th style={thStyle}>Kind</th>
              <th style={thStyle}>Effective Range</th>
              <th style={{ ...thStyle, textAlign: "right" as const, width: 160 }} />
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td
                  colSpan={7}
                  style={{
                    ...tdStyle,
                    textAlign: "center",
                    color: "var(--text-muted)",
                    padding: "32px 16px",
                  }}
                >
                  Loading components…
                </td>
              </tr>
            ) : components.length === 0 ? (
              <tr>
                <td
                  colSpan={7}
                  style={{
                    ...tdStyle,
                    textAlign: "center",
                    color: "var(--text-muted)",
                    padding: "32px 16px",
                  }}
                >
                  No components yet. Add one to start configuring this schedule.
                </td>
              </tr>
            ) : (
              components
                .slice()
                .sort((a, b) => a.sortOrder - b.sortOrder)
                .map((c) => (
                  <tr
                    key={c.id}
                    onClick={canEdit ? () => onEdit(c) : undefined}
                    style={{
                      cursor: canEdit ? "pointer" : "default",
                      transition: "background 0.1s ease",
                    }}
                    onMouseEnter={(e) => {
                      if (canEdit) {
                        (e.currentTarget as HTMLTableRowElement).style.background =
                          "var(--bg-hover)";
                      }
                    }}
                    onMouseLeave={(e) => {
                      (e.currentTarget as HTMLTableRowElement).style.background =
                        "transparent";
                    }}
                  >
                    <td style={{ ...tdStyle, fontFamily: "monospace" }}>
                      {c.sortOrder}
                    </td>
                    <td style={tdStyle}>{c.label}</td>
                    <td
                      style={{
                        ...tdStyle,
                        fontFamily: "monospace",
                        fontSize: 12,
                        fontWeight: 600,
                        whiteSpace: "nowrap",
                      }}
                    >
                      {priceSummary(c.pricing)}
                    </td>
                    <td style={{ ...tdStyle, fontFamily: "monospace", fontSize: 12 }}>
                      {(() => {
                        const { base, qualifier } = quantitySummary(c.quantitySource);
                        return (
                          <>
                            <span style={{ color: "var(--text-muted)" }}>{base}</span>
                            {qualifier && (
                              <>
                                <span style={{ color: "var(--text-muted)" }}>: </span>
                                <span style={{ color: "var(--text-primary)", fontWeight: 600 }}>
                                  {qualifier}
                                </span>
                              </>
                            )}
                          </>
                        );
                      })()}
                    </td>
                    <td style={tdStyle}>
                      <span style={kindBadgeStyle}>{c.kindCode}</span>
                    </td>
                    <td style={{ ...tdStyle, color: "var(--text-secondary)", fontSize: 12 }}>
                      {formatRange(c.effectiveDate, c.expirationDate)}
                    </td>
                    <td style={{ ...tdStyle, textAlign: "right" as const }}>
                      <div
                        style={{
                          display: "inline-flex",
                          gap: 6,
                          justifyContent: "flex-end",
                        }}
                        onClick={(e) => e.stopPropagation()}
                      >
                        {canEdit && (
                          <button
                            type="button"
                            onClick={() => onEdit(c)}
                            style={editBtnStyle}
                          >
                            Edit
                          </button>
                        )}
                        {canDelete && (
                          <button
                            type="button"
                            onClick={() => setConfirmDeleteId(c.id)}
                            style={deleteBtnStyle}
                          >
                            Delete
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))
            )}
          </tbody>
        </table>
      </div>

      {confirmDeleteId && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.6)",
            zIndex: 100,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <div
            style={{
              background: "var(--bg-card)",
              border: "1px solid var(--border)",
              borderRadius: "var(--radius)",
              padding: "24px",
              width: 380,
            }}
          >
            <h3
              style={{
                margin: "0 0 12px",
                fontSize: 16,
                color: "var(--text-primary)",
              }}
            >
              Delete component?
            </h3>
            <p
              style={{
                fontSize: 13,
                color: "var(--text-secondary)",
                marginBottom: 20,
              }}
            >
              This removes the component from the schedule. This action cannot be undone.
            </p>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button
                type="button"
                onClick={() => setConfirmDeleteId(null)}
                disabled={deleting}
                style={{
                  padding: "7px 16px",
                  borderRadius: "var(--radius)",
                  border: "1px solid var(--border)",
                  background: "transparent",
                  color: "var(--text-secondary)",
                  fontSize: 12,
                  cursor: deleting ? "not-allowed" : "pointer",
                  fontFamily: "inherit",
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => handleDelete(confirmDeleteId)}
                disabled={deleting}
                style={{
                  padding: "7px 16px",
                  borderRadius: "var(--radius)",
                  border: "none",
                  background: "var(--danger, #dc2626)",
                  color: "#fff",
                  fontSize: 12,
                  fontWeight: 500,
                  cursor: deleting ? "not-allowed" : "pointer",
                  opacity: deleting ? 0.6 : 1,
                  fontFamily: "inherit",
                }}
              >
                {deleting ? "Deleting…" : "Delete"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
