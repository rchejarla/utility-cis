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

function pricingType(pricing: unknown): string {
  if (pricing && typeof pricing === "object" && "type" in pricing) {
    const t = (pricing as { type: unknown }).type;
    if (typeof t === "string") return t;
  }
  return "—";
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
              <th style={thStyle}>Kind</th>
              <th style={thStyle}>Pricing</th>
              <th style={thStyle}>Effective Range</th>
              <th style={{ ...thStyle, textAlign: "right" as const, width: 160 }} />
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td
                  colSpan={6}
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
                  colSpan={6}
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
                    <td style={tdStyle}>
                      <span style={kindBadgeStyle}>{c.kindCode}</span>
                    </td>
                    <td style={{ ...tdStyle, fontFamily: "monospace", fontSize: 12 }}>
                      {pricingType(c.pricing)}
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
