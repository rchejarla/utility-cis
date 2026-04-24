"use client";

import { useCallback, useEffect, useState } from "react";
import { apiClient } from "@/lib/api-client";
import { SettingsSection } from "@/components/settings/settings-shell";
import { useToast } from "@/components/ui/toast";
import { usePermission } from "@/lib/use-permission";
import { AccessDenied } from "@/components/ui/access-denied";

interface SlaRow {
  id: string;
  requestType: string;
  priority: string;
  responseHours: number;
  resolutionHours: number;
  escalationHours: number | null;
  escalationUserId: string | null;
  isActive: boolean;
}

interface TypeDef {
  code: string;
  label: string;
}

const PRIORITIES = ["EMERGENCY", "HIGH", "NORMAL", "LOW"] as const;

const cardStyle = {
  background: "var(--bg-card)",
  border: "1px solid var(--border)",
  borderRadius: 10,
  marginBottom: 14,
  overflow: "hidden",
};

const cardHeaderStyle = {
  padding: "12px 16px",
  borderBottom: "1px solid var(--border)",
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  fontSize: 13,
};

const thStyle = {
  textAlign: "left" as const,
  padding: "8px 12px",
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
  padding: "8px 12px",
  fontSize: 13,
  color: "var(--text-primary)",
  borderBottom: "1px solid var(--border-subtle)",
  verticalAlign: "middle" as const,
};

const hoursInputStyle = {
  width: 80,
  padding: "5px 8px",
  fontSize: 13,
  background: "var(--bg-surface)",
  border: "1px solid var(--border)",
  borderRadius: 6,
  color: "var(--text-primary)",
  fontFamily: "inherit",
  outline: "none",
  textAlign: "right" as const,
};

const addBtn = {
  padding: "5px 10px",
  fontSize: 12,
  background: "var(--bg-surface)",
  border: "1px solid var(--border)",
  borderRadius: 6,
  color: "var(--text-primary)",
  cursor: "pointer",
  fontFamily: "inherit",
};

const removeBtn = {
  padding: "4px 8px",
  fontSize: 12,
  background: "transparent",
  border: "1px solid var(--border)",
  borderRadius: 6,
  color: "var(--text-muted)",
  cursor: "pointer",
  fontFamily: "inherit",
};

export default function SlaSettingsPage() {
  const { toast } = useToast();
  const { canView, canEdit } = usePermission("service_request_slas");
  const [types, setTypes] = useState<TypeDef[]>([]);
  const [slas, setSlas] = useState<SlaRow[]>([]);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    try {
      const [t, s] = await Promise.all([
        apiClient.get<TypeDef[] | { data: TypeDef[] }>("/api/v1/service-request-types"),
        apiClient.get<SlaRow[] | { data: SlaRow[] }>("/api/v1/slas", {
          includeInactive: "false",
          limit: "200",
        }),
      ]);
      const typeList = Array.isArray(t) ? t : t.data ?? [];
      const slaList = Array.isArray(s) ? s : s.data ?? [];
      setTypes(typeList);
      setSlas(slaList.filter((r) => r.isActive));
    } catch (err) {
      console.error("Failed to load SLA settings", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  async function addRow(requestType: string, priority: string) {
    try {
      await apiClient.post("/api/v1/slas", {
        requestType,
        priority,
        responseHours: 1,
        resolutionHours: 24,
      });
      toast("Priority coverage added", "success");
      reload();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Failed to add SLA", "error");
    }
  }

  async function updateField(id: string, patch: Partial<SlaRow>) {
    try {
      await apiClient.patch(`/api/v1/slas/${id}`, patch);
      reload();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Failed to update SLA", "error");
    }
  }

  async function remove(id: string) {
    try {
      await apiClient.delete(`/api/v1/slas/${id}`);
      toast("SLA deactivated", "success");
      reload();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Failed to deactivate SLA", "error");
    }
  }

  if (!canView) return <AccessDenied />;

  if (loading) {
    return (
      <SettingsSection
        title="Service Level Agreements"
        description="Define response and resolution targets per request type and priority. Requests without a matching SLA skip the countdown entirely."
      >
        <p style={{ color: "var(--text-muted)", padding: "24px 0" }}>Loading…</p>
      </SettingsSection>
    );
  }

  const byType = types.reduce<Record<string, SlaRow[]>>((acc, t) => {
    acc[t.code] = slas.filter((s) => s.requestType === t.code);
    return acc;
  }, {});

  return (
    <SettingsSection
      title="Service Level Agreements"
      description="Define response and resolution targets per request type and priority. Requests without a matching SLA skip the countdown entirely."
    >
      {types.map((t) => {
        const rows = byType[t.code] ?? [];
        const covered = rows.map((r) => r.priority);
        const missing = PRIORITIES.filter((p) => !covered.includes(p));
        return (
          <div key={t.code} style={cardStyle}>
            <div style={cardHeaderStyle}>
              <div>
                <b style={{ color: "var(--text-primary)" }}>{t.code}</b>
                <span style={{ color: "var(--text-muted)", marginLeft: 8 }}>
                  {t.label}
                </span>
              </div>
              <span style={{ color: "var(--text-muted)", fontSize: 12 }}>
                {rows.length} / 4 priorities
              </span>
            </div>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  <th style={thStyle}>Priority</th>
                  <th style={thStyle}>Response (hrs)</th>
                  <th style={thStyle}>Resolution (hrs)</th>
                  <th style={thStyle}>Escalate after (hrs)</th>
                  <th style={{ ...thStyle, textAlign: "right" as const }} />
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 ? (
                  <tr>
                    <td
                      colSpan={5}
                      style={{
                        ...tdStyle,
                        textAlign: "center",
                        color: "var(--text-muted)",
                      }}
                    >
                      No SLAs configured for this type yet.
                    </td>
                  </tr>
                ) : (
                  rows.map((r) => (
                    <tr key={r.id}>
                      <td style={tdStyle}>{r.priority}</td>
                      <td style={tdStyle}>
                        <input
                          type="number"
                          min={0.01}
                          step={0.25}
                          defaultValue={r.responseHours}
                          disabled={!canEdit}
                          onBlur={(e) => {
                            const n = Number(e.target.value);
                            if (Number.isFinite(n) && n !== r.responseHours) {
                              updateField(r.id, { responseHours: n });
                            }
                          }}
                          style={hoursInputStyle}
                        />
                      </td>
                      <td style={tdStyle}>
                        <input
                          type="number"
                          min={0.01}
                          step={0.25}
                          defaultValue={r.resolutionHours}
                          disabled={!canEdit}
                          onBlur={(e) => {
                            const n = Number(e.target.value);
                            if (Number.isFinite(n) && n !== r.resolutionHours) {
                              updateField(r.id, { resolutionHours: n });
                            }
                          }}
                          style={hoursInputStyle}
                        />
                      </td>
                      <td style={tdStyle}>
                        <input
                          type="number"
                          min={0}
                          step={0.25}
                          defaultValue={r.escalationHours ?? ""}
                          disabled={!canEdit}
                          onBlur={(e) => {
                            const raw = e.target.value.trim();
                            const next = raw === "" ? null : Number(raw);
                            if (next === null) {
                              if (r.escalationHours !== null) {
                                updateField(r.id, { escalationHours: null });
                              }
                            } else if (Number.isFinite(next) && next !== r.escalationHours) {
                              updateField(r.id, { escalationHours: next });
                            }
                          }}
                          style={hoursInputStyle}
                        />
                      </td>
                      <td style={{ ...tdStyle, textAlign: "right" as const }}>
                        {canEdit && (
                          <button
                            type="button"
                            onClick={() => remove(r.id)}
                            aria-label={`Deactivate ${r.priority}`}
                            style={removeBtn}
                          >
                            Remove
                          </button>
                        )}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
            {missing.length > 0 && canEdit && (
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "10px 16px",
                  borderTop: "1px solid var(--border-subtle)",
                  flexWrap: "wrap",
                }}
              >
                <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
                  Add priority:
                </span>
                {missing.map((p) => (
                  <button
                    key={p}
                    type="button"
                    onClick={() => addRow(t.code, p)}
                    style={addBtn}
                  >
                    + {p}
                  </button>
                ))}
              </div>
            )}
          </div>
        );
      })}

      <p
        style={{
          fontSize: 12,
          color: "var(--text-muted)",
          marginTop: 18,
          lineHeight: 1.6,
        }}
      >
        <b>Note for this slice:</b> SLA breach detection runs at request creation
        only. The background breach-sweep job and escalation notifications are
        deferred to a later slice.
      </p>
    </SettingsSection>
  );
}
