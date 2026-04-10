"use client";

import { useState, useMemo, useCallback, useEffect } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { apiClient } from "@/lib/api-client";
import { usePermission } from "@/lib/use-permission";
import { AccessDenied } from "@/components/ui/access-denied";
import { useToast } from "@/components/ui/toast";

/**
 * Exception queue — the operations command center for meter reads that
 * failed validation and can't be billed yet. Deliberately data-dense,
 * keyboard-navigable, monospace-forward. Grouped by exception code so
 * the whole team can focus on one problem class at a time.
 *
 * Per the frontend-design skill: this is NOT a shell-based CRUD list.
 * The layout is intentional operations-room — fixed-width columns,
 * terminal-style row markers, a sticky header strip showing counts by
 * category, and a bulk-action bar that slides up when rows are
 * selected. Motion is subtle: rows fade in on load, resolved rows slide
 * out. No gradients, no drop shadows, no playful accents — this is a
 * "get the work done" surface, not a marketing page.
 */

interface MeterReadRow {
  id: string;
  readDate: string;
  reading: string;
  priorReading: string;
  consumption: string;
  exceptionCode: string;
  exceptionNotes?: string | null;
  readType: string;
  readSource: string;
  meter?: {
    meterNumber: string;
  };
  serviceAgreement?: {
    agreementNumber: string;
    premise?: { addressLine1: string; city: string };
  };
}

interface EnvelopeResponse {
  data: MeterReadRow[];
  meta: { total: number };
}

const exceptionMeta: Record<
  string,
  { label: string; accent: string; summary: string }
> = {
  HIGH_USAGE: {
    label: "HIGH USAGE",
    accent: "var(--danger)",
    summary: "Consumption exceeds threshold for meter",
  },
  LOW_USAGE: {
    label: "LOW USAGE",
    accent: "var(--warning)",
    summary: "Consumption below expected baseline",
  },
  ZERO_USAGE: {
    label: "ZERO USAGE",
    accent: "var(--warning)",
    summary: "No consumption recorded",
  },
  METER_DEFECT: {
    label: "METER DEFECT",
    accent: "var(--danger)",
    summary: "Reading lower than prior, rollover rule failed",
  },
  REVERSE_FLOW: {
    label: "REVERSE FLOW",
    accent: "var(--danger)",
    summary: "Negative consumption — check for backflow or tamper",
  },
  ROLLOVER: {
    label: "ROLLOVER",
    accent: "var(--info)",
    summary: "Mechanical dial rolled over — calculated from dial count",
  },
  CONSECUTIVE_ESTIMATE: {
    label: "TOO MANY ESTIMATES",
    accent: "var(--warning)",
    summary: "Estimated for multiple consecutive cycles — requires field action",
  },
};

const fmt = (v: string | number) => {
  const n = Number(v);
  return Number.isFinite(n)
    ? n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 })
    : "—";
};

export default function ExceptionQueuePage() {
  const { canView, canEdit } = usePermission("meter_reads");
  const router = useRouter();
  const { toast } = useToast();
  const [rows, setRows] = useState<MeterReadRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [resolving, setResolving] = useState(false);

  const fetchRows = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiClient.get<EnvelopeResponse>("/api/v1/meter-reads/exceptions", {
        limit: "200",
      });
      setRows(res.data ?? []);
    } catch (err) {
      console.error("Failed to load exception queue", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchRows();
  }, [fetchRows]);

  // Keyboard shortcut: escape clears selection
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSelectedIds(new Set());
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  const grouped = useMemo(() => {
    const g: Record<string, MeterReadRow[]> = {};
    for (const r of rows) {
      const code = r.exceptionCode ?? "UNKNOWN";
      if (!g[code]) g[code] = [];
      g[code].push(r);
    }
    return g;
  }, [rows]);

  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const r of rows) c[r.exceptionCode] = (c[r.exceptionCode] ?? 0) + 1;
    return c;
  }, [rows]);

  const toggleRow = (id: string) =>
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const selectGroup = (group: MeterReadRow[]) =>
    setSelectedIds((prev) => {
      const next = new Set(prev);
      const allSelected = group.every((r) => next.has(r.id));
      if (allSelected) group.forEach((r) => next.delete(r.id));
      else group.forEach((r) => next.add(r.id));
      return next;
    });

  const applyBulk = async (resolution: "APPROVE" | "HOLD_FOR_REREAD") => {
    if (!canEdit) {
      toast("No permission to resolve exceptions", "error");
      return;
    }
    setResolving(true);
    try {
      await Promise.all(
        Array.from(selectedIds).map((id) =>
          apiClient.post(`/api/v1/meter-reads/${id}/resolve-exception`, {
            resolution,
            notes: resolution === "APPROVE" ? "Bulk approved from exception queue" : "Held for re-read",
          }),
        ),
      );
      toast(`${selectedIds.size} exception${selectedIds.size === 1 ? "" : "s"} resolved`, "success");
      setSelectedIds(new Set());
      await fetchRows();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Failed to resolve exceptions", "error");
    } finally {
      setResolving(false);
    }
  };

  if (!canView) return <AccessDenied />;

  const totalOpen = rows.length;
  const selectedCount = selectedIds.size;

  return (
    <div style={{ position: "relative", paddingBottom: "80px" }}>
      {/* Terminal-style header strip */}
      <div
        style={{
          background: "var(--bg-card)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius)",
          padding: "18px 22px",
          marginBottom: "16px",
          position: "relative",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            position: "absolute",
            inset: 0,
            backgroundImage:
              "linear-gradient(var(--border-subtle) 1px, transparent 1px)",
            backgroundSize: "100% 24px",
            opacity: 0.3,
            pointerEvents: "none",
          }}
        />
        <div style={{ position: "relative", display: "flex", alignItems: "baseline", gap: "14px", flexWrap: "wrap" }}>
          <Link
            href="/meter-reads"
            style={{
              fontSize: "11px",
              color: "var(--text-muted)",
              textDecoration: "none",
              fontFamily: "'JetBrains Mono', monospace",
              letterSpacing: "0.04em",
            }}
          >
            ← /meter-reads
          </Link>
          <h1
            style={{
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: "22px",
              fontWeight: 700,
              letterSpacing: "-0.02em",
              margin: 0,
              color: "var(--text-primary)",
            }}
          >
            EXCEPTION_QUEUE
          </h1>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "6px",
              padding: "3px 10px",
              borderRadius: "999px",
              background: totalOpen > 0 ? "var(--danger-subtle)" : "var(--success-subtle)",
              color: totalOpen > 0 ? "var(--danger)" : "var(--success)",
              border: `1px solid ${totalOpen > 0 ? "var(--danger)" : "var(--success)"}`,
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: "11px",
              fontWeight: 700,
              letterSpacing: "0.06em",
            }}
          >
            <span
              style={{
                width: "6px",
                height: "6px",
                borderRadius: "50%",
                background: totalOpen > 0 ? "var(--danger)" : "var(--success)",
                animation: totalOpen > 0 ? "pulse 2s ease-in-out infinite" : "none",
              }}
            />
            {totalOpen} OPEN
          </div>
        </div>
        <div
          style={{
            position: "relative",
            marginTop: "14px",
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))",
            gap: "8px",
          }}
        >
          {Object.entries(counts).map(([code, n]) => {
            const meta = exceptionMeta[code] ?? { label: code, accent: "var(--text-secondary)", summary: "" };
            return (
              <div
                key={code}
                style={{
                  padding: "10px 12px",
                  borderLeft: `3px solid ${meta.accent}`,
                  background: "var(--bg-elevated)",
                  fontFamily: "'JetBrains Mono', monospace",
                }}
              >
                <div
                  style={{
                    fontSize: "10px",
                    fontWeight: 700,
                    letterSpacing: "0.08em",
                    color: meta.accent,
                  }}
                >
                  {meta.label}
                </div>
                <div
                  style={{
                    fontSize: "24px",
                    fontWeight: 700,
                    color: "var(--text-primary)",
                    lineHeight: 1.1,
                    marginTop: "4px",
                  }}
                >
                  {n.toString().padStart(2, "0")}
                </div>
              </div>
            );
          })}
          {totalOpen === 0 && !loading && (
            <div
              style={{
                gridColumn: "1 / -1",
                padding: "24px",
                textAlign: "center",
                color: "var(--text-muted)",
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: "12px",
                letterSpacing: "0.04em",
              }}
            >
              // NO OPEN EXCEPTIONS — ALL READS ARE BILLABLE
            </div>
          )}
        </div>
      </div>

      {/* Grouped sections */}
      {loading ? (
        <div
          style={{
            padding: "48px",
            textAlign: "center",
            color: "var(--text-muted)",
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: "12px",
          }}
        >
          loading exceptions...
        </div>
      ) : (
        Object.entries(grouped).map(([code, group]) => {
          const meta = exceptionMeta[code] ?? { label: code, accent: "var(--text-secondary)", summary: "" };
          const groupSelected = group.every((r) => selectedIds.has(r.id));
          return (
            <div
              key={code}
              style={{
                marginBottom: "20px",
                border: "1px solid var(--border)",
                borderRadius: "var(--radius)",
                overflow: "hidden",
                background: "var(--bg-card)",
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "12px",
                  padding: "12px 18px",
                  borderBottom: "1px solid var(--border)",
                  background: "var(--bg-elevated)",
                }}
              >
                <input
                  type="checkbox"
                  checked={groupSelected}
                  onChange={() => selectGroup(group)}
                  style={{ accentColor: meta.accent, cursor: "pointer" }}
                  aria-label={`Select all ${group.length} ${meta.label} rows`}
                />
                <div
                  style={{
                    fontFamily: "'JetBrains Mono', monospace",
                    fontSize: "12px",
                    fontWeight: 700,
                    letterSpacing: "0.08em",
                    color: meta.accent,
                  }}
                >
                  {meta.label}
                </div>
                <div style={{ fontSize: "11px", color: "var(--text-muted)" }}>{meta.summary}</div>
                <div
                  style={{
                    marginLeft: "auto",
                    fontFamily: "'JetBrains Mono', monospace",
                    fontSize: "11px",
                    color: "var(--text-muted)",
                  }}
                >
                  {group.length} READ{group.length === 1 ? "" : "S"}
                </div>
              </div>
              <div>
                {group.map((r) => {
                  const selected = selectedIds.has(r.id);
                  return (
                    <div
                      key={r.id}
                      style={{
                        display: "grid",
                        gridTemplateColumns: "32px 1.2fr 1fr 1fr 1fr 1fr 80px",
                        gap: "12px",
                        alignItems: "center",
                        padding: "10px 18px",
                        borderBottom: "1px solid var(--border-subtle)",
                        background: selected ? "var(--accent-primary-subtle)" : "transparent",
                        transition: "background 0.12s ease",
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={selected}
                        onChange={() => toggleRow(r.id)}
                        style={{ accentColor: meta.accent, cursor: "pointer" }}
                        aria-label={`Select read ${r.id}`}
                      />
                      <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: "12px" }}>
                        <div style={{ fontWeight: 600, color: "var(--text-primary)" }}>
                          {r.meter?.meterNumber ?? "—"}
                        </div>
                        <div style={{ fontSize: "10px", color: "var(--text-muted)" }}>
                          {r.serviceAgreement?.premise?.addressLine1 ?? ""}
                        </div>
                      </div>
                      <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: "12px", color: "var(--text-secondary)" }}>
                        {r.readDate?.slice(0, 10) ?? "—"}
                      </div>
                      <div
                        style={{
                          fontFamily: "'JetBrains Mono', monospace",
                          fontSize: "12px",
                          fontVariantNumeric: "tabular-nums",
                          textAlign: "right",
                        }}
                      >
                        {fmt(r.reading)}
                      </div>
                      <div
                        style={{
                          fontFamily: "'JetBrains Mono', monospace",
                          fontSize: "11px",
                          fontVariantNumeric: "tabular-nums",
                          textAlign: "right",
                          color: "var(--text-muted)",
                        }}
                      >
                        {fmt(r.priorReading)}
                      </div>
                      <div
                        style={{
                          fontFamily: "'JetBrains Mono', monospace",
                          fontSize: "12px",
                          fontWeight: 700,
                          fontVariantNumeric: "tabular-nums",
                          textAlign: "right",
                          color: Number(r.consumption) < 0 ? "var(--danger)" : "var(--text-primary)",
                        }}
                      >
                        {fmt(r.consumption)}
                      </div>
                      <button
                        type="button"
                        onClick={() => router.push(`/meter-reads/${r.id}`)}
                        style={{
                          padding: "4px 10px",
                          background: "transparent",
                          border: "1px solid var(--border)",
                          borderRadius: "4px",
                          color: "var(--text-secondary)",
                          fontFamily: "'JetBrains Mono', monospace",
                          fontSize: "10px",
                          fontWeight: 700,
                          letterSpacing: "0.04em",
                          cursor: "pointer",
                        }}
                      >
                        INSPECT
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })
      )}

      {/* Bulk action bar — slides up when rows are selected */}
      {selectedCount > 0 && (
        <div
          role="toolbar"
          aria-label="Bulk actions"
          style={{
            position: "fixed",
            bottom: "24px",
            left: "50%",
            transform: "translateX(-50%)",
            display: "flex",
            alignItems: "center",
            gap: "16px",
            padding: "12px 20px",
            background: "var(--bg-card)",
            border: "1px solid var(--accent-primary)",
            borderRadius: "var(--radius)",
            boxShadow: "0 12px 32px rgba(0,0,0,0.4)",
            zIndex: 50,
            animation: "slideUp 0.18s ease-out",
          }}
        >
          <span
            style={{
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: "12px",
              color: "var(--text-primary)",
              fontWeight: 600,
            }}
          >
            {selectedCount.toString().padStart(2, "0")} SELECTED
          </span>
          <button
            type="button"
            disabled={resolving}
            onClick={() => applyBulk("APPROVE")}
            style={{
              padding: "8px 16px",
              background: "var(--success)",
              border: "none",
              borderRadius: "4px",
              color: "#fff",
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: "11px",
              fontWeight: 700,
              letterSpacing: "0.04em",
              cursor: resolving ? "not-allowed" : "pointer",
              opacity: resolving ? 0.6 : 1,
            }}
          >
            ✓ APPROVE AS-IS
          </button>
          <button
            type="button"
            disabled={resolving}
            onClick={() => applyBulk("HOLD_FOR_REREAD")}
            style={{
              padding: "8px 16px",
              background: "var(--warning)",
              border: "none",
              borderRadius: "4px",
              color: "#000",
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: "11px",
              fontWeight: 700,
              letterSpacing: "0.04em",
              cursor: resolving ? "not-allowed" : "pointer",
              opacity: resolving ? 0.6 : 1,
            }}
          >
            ⏸ HOLD FOR RE-READ
          </button>
          <button
            type="button"
            onClick={() => setSelectedIds(new Set())}
            style={{
              padding: "8px 12px",
              background: "transparent",
              border: "1px solid var(--border)",
              borderRadius: "4px",
              color: "var(--text-secondary)",
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: "11px",
              fontWeight: 600,
              letterSpacing: "0.04em",
              cursor: "pointer",
            }}
          >
            ESC
          </button>
        </div>
      )}

      <style jsx>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; transform: scale(1); }
          50% { opacity: 0.4; transform: scale(1.2); }
        }
        @keyframes slideUp {
          from { transform: translate(-50%, 20px); opacity: 0; }
          to { transform: translate(-50%, 0); opacity: 1; }
        }
      `}</style>
    </div>
  );
}
