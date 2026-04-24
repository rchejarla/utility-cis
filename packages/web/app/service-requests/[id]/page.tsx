"use client";

import { use, useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { apiClient } from "@/lib/api-client";
import { PageHeader } from "@/components/ui/page-header";
import { StatusBadge } from "@/components/ui/status-badge";
import { useToast } from "@/components/ui/toast";
import { usePermission } from "@/lib/use-permission";
import { AccessDenied } from "@/components/ui/access-denied";
import { SlaCountdown } from "@/components/service-requests/sla-countdown";
import { formatAgreementLabel } from "@utility-cis/shared";

// UI mirror of the server state machine — keep in sync with
// VALID_TRANSITIONS in packages/api/src/services/service-request.service.ts.
// We only surface "forward" actions here; COMPLETE/FAIL/CANCEL have their
// own dedicated buttons further down the page.
const UI_VALID_TRANSITIONS: Record<string, string[]> = {
  NEW: ["ASSIGNED"],
  ASSIGNED: ["IN_PROGRESS"],
  IN_PROGRESS: ["PENDING_FIELD"],
  PENDING_FIELD: ["IN_PROGRESS"],
  COMPLETED: [],
  CANCELLED: [],
  FAILED: [],
};

const TERMINAL = new Set(["COMPLETED", "CANCELLED", "FAILED"]);

interface ServiceRequestDetail {
  id: string;
  requestNumber: string;
  requestType: string;
  requestSubtype: string | null;
  priority: string;
  status: string;
  source: string;
  description: string;
  resolutionNotes: string | null;
  slaDueAt: string | null;
  slaBreached: boolean;
  createdAt: string;
  assignedTo: string | null;
  assignedTeam: string | null;
  account: { id: string; accountNumber: string } | null;
  premise: { id: string; addressLine1: string; city?: string; state?: string } | null;
  serviceAgreement: {
    id: string;
    agreementNumber: string;
    commodity?: { name: string } | null;
    premise?: { addressLine1: string } | null;
  } | null;
  assignee: { id: string; name: string; email?: string } | null;
  creator: { id: string; name: string } | null;
}

interface AuditEntry {
  id: string;
  action: string;
  actorName: string | null;
  actorId: string | null;
  createdAt: string;
  metadata: Record<string, unknown> | null;
}

const cardStyle = {
  background: "var(--bg-card)",
  border: "1px solid var(--border)",
  borderRadius: 10,
  padding: 16,
  marginBottom: 14,
};

const cardHeaderStyle = {
  margin: "0 0 12px",
  fontSize: 13,
  fontWeight: 600,
  color: "var(--text-primary)",
  letterSpacing: "-0.01em",
};

const fieldRow = {
  display: "grid",
  gridTemplateColumns: "110px 1fr",
  gap: 10,
  padding: "6px 0",
  borderBottom: "1px solid var(--border-subtle)",
  alignItems: "start" as const,
  fontSize: 13,
};

const fieldLabel = {
  fontSize: 12,
  color: "var(--text-muted)",
  fontWeight: 500,
};

const inputStyle = {
  padding: "7px 10px",
  fontSize: "13px",
  background: "var(--bg-surface)",
  border: "1px solid var(--border)",
  borderRadius: "8px",
  color: "var(--text-primary)",
  fontFamily: "inherit",
  outline: "none",
  width: "100%",
  boxSizing: "border-box" as const,
};

const secondaryBtn = {
  padding: "6px 12px",
  fontSize: 12,
  background: "var(--bg-surface)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius)",
  color: "var(--text-primary)",
  cursor: "pointer",
  fontFamily: "inherit",
};

const primaryBtn = {
  padding: "7px 14px",
  fontSize: 12,
  background: "var(--accent-primary)",
  color: "#fff",
  border: "none",
  borderRadius: "var(--radius)",
  cursor: "pointer",
  fontFamily: "inherit",
  fontWeight: 600,
};

const dangerBtn = {
  padding: "6px 12px",
  fontSize: 12,
  background: "transparent",
  border: "1px solid var(--danger)",
  borderRadius: "var(--radius)",
  color: "var(--danger)",
  cursor: "pointer",
  fontFamily: "inherit",
  fontWeight: 500,
};

export default function ServiceRequestDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const router = useRouter();
  const { toast } = useToast();
  const { canView, canEdit } = usePermission("service_requests");

  const [sr, setSr] = useState<ServiceRequestDetail | null>(null);
  const [timeline, setTimeline] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [resolutionNotes, setResolutionNotes] = useState("");
  const [assignTeam, setAssignTeam] = useState("");
  const [actionBusy, setActionBusy] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelReason, setCancelReason] = useState("");

  const reload = useCallback(async () => {
    try {
      const [detail, audit] = await Promise.all([
        apiClient.get<ServiceRequestDetail>(`/api/v1/service-requests/${id}`),
        apiClient.get<{ data: AuditEntry[] } | AuditEntry[]>("/api/v1/audit-log", {
          entityType: "ServiceRequest",
          entityId: id,
          limit: "50",
        }),
      ]);
      setSr(detail);
      setAssignTeam(detail.assignedTeam ?? "");
      const entries = Array.isArray(audit) ? audit : audit.data ?? [];
      setTimeline(entries);
    } catch (err) {
      console.error("Failed to load service request", err);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    reload();
  }, [reload]);

  const terminal = useMemo(() => (sr ? TERMINAL.has(sr.status) : false), [sr]);
  const nextStatuses = sr ? UI_VALID_TRANSITIONS[sr.status] ?? [] : [];

  async function complete() {
    if (!resolutionNotes.trim()) return;
    setActionBusy(true);
    try {
      await apiClient.post(`/api/v1/service-requests/${id}/complete`, {
        resolutionNotes: resolutionNotes.trim(),
      });
      setResolutionNotes("");
      toast("Request marked completed", "success");
      await reload();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Failed to complete", "error");
    } finally {
      setActionBusy(false);
    }
  }

  async function fail() {
    setActionBusy(true);
    try {
      await apiClient.post(`/api/v1/service-requests/${id}/transition`, {
        toStatus: "FAILED",
        notes: resolutionNotes.trim() || undefined,
      });
      setResolutionNotes("");
      toast("Request marked failed", "success");
      await reload();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Failed to transition", "error");
    } finally {
      setActionBusy(false);
    }
  }

  async function transitionTo(toStatus: string) {
    setActionBusy(true);
    try {
      await apiClient.post(`/api/v1/service-requests/${id}/transition`, { toStatus });
      toast(`Moved to ${toStatus.replace(/_/g, " ")}`, "success");
      await reload();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Failed to transition", "error");
    } finally {
      setActionBusy(false);
    }
  }

  async function saveAssignment() {
    setActionBusy(true);
    try {
      await apiClient.post(`/api/v1/service-requests/${id}/assign`, {
        assignedTeam: assignTeam.trim() ? assignTeam.trim() : null,
      });
      toast("Assignment saved", "success");
      await reload();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Failed to assign", "error");
    } finally {
      setActionBusy(false);
    }
  }

  async function confirmCancel() {
    if (!cancelReason.trim()) return;
    setActionBusy(true);
    try {
      await apiClient.post(`/api/v1/service-requests/${id}/cancel`, {
        reason: cancelReason.trim(),
      });
      toast("Request cancelled", "success");
      setCancelOpen(false);
      setCancelReason("");
      await reload();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Failed to cancel", "error");
    } finally {
      setActionBusy(false);
    }
  }

  if (!canView) return <AccessDenied />;
  if (loading) {
    return <div style={{ color: "var(--text-muted)", padding: "40px 0" }}>Loading…</div>;
  }
  if (!sr) {
    return (
      <div style={{ color: "var(--text-muted)", padding: "40px 0" }}>
        Service request not found.
      </div>
    );
  }

  return (
    <div>
      <div style={{ marginBottom: 8 }}>
        <Link
          href="/service-requests"
          style={{
            fontSize: 12,
            color: "var(--text-muted)",
            textDecoration: "none",
          }}
        >
          ← Back to queue
        </Link>
      </div>

      <PageHeader
        title={`${sr.requestNumber} · ${sr.requestType.replace(/_/g, " ")}`}
        subtitle={sr.requestSubtype ?? undefined}
      />

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          marginBottom: 20,
          flexWrap: "wrap",
        }}
      >
        <StatusBadge status={sr.status} />
        <StatusBadge status={sr.priority} />
        <SlaCountdown
          slaDueAt={sr.slaDueAt}
          slaBreached={sr.slaBreached}
          status={sr.status}
        />
        <div style={{ flex: 1 }} />
        {!terminal && canEdit && (
          <button
            type="button"
            onClick={() => setCancelOpen(true)}
            style={dangerBtn}
          >
            Cancel request
          </button>
        )}
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(0, 1.4fr) minmax(0, 1fr)",
          gap: 18,
        }}
      >
        <div style={{ minWidth: 0 }}>
          <section style={cardStyle}>
            <h4 style={cardHeaderStyle}>Context</h4>
            <div style={fieldRow}>
              <span style={fieldLabel}>Account</span>
              <span>
                {sr.account ? (
                  <Link
                    href={`/accounts/${sr.account.id}`}
                    style={{ color: "var(--accent-primary)", textDecoration: "none" }}
                  >
                    {sr.account.accountNumber}
                  </Link>
                ) : (
                  <span style={{ color: "var(--text-muted)" }}>—</span>
                )}
              </span>
            </div>
            <div style={fieldRow}>
              <span style={fieldLabel}>Premise</span>
              <span>{sr.premise?.addressLine1 ?? "—"}</span>
            </div>
            <div style={fieldRow}>
              <span style={fieldLabel}>Agreement</span>
              <span>
                {sr.serviceAgreement ? formatAgreementLabel(sr.serviceAgreement) : "—"}
              </span>
            </div>
            <div style={fieldRow}>
              <span style={fieldLabel}>Source</span>
              <span>{sr.source}</span>
            </div>
            <div style={fieldRow}>
              <span style={fieldLabel}>Created</span>
              <span>
                {new Date(sr.createdAt).toLocaleString()}
                {sr.creator?.name ? ` · ${sr.creator.name}` : ""}
              </span>
            </div>
            <div style={{ ...fieldRow, borderBottom: "none" }}>
              <span style={fieldLabel}>SLA due</span>
              <span>{sr.slaDueAt ? new Date(sr.slaDueAt).toLocaleString() : "—"}</span>
            </div>
          </section>

          <section style={cardStyle}>
            <h4 style={cardHeaderStyle}>Description</h4>
            <div style={{ whiteSpace: "pre-wrap", fontSize: 13, color: "var(--text-primary)" }}>
              {sr.description}
            </div>
          </section>

          <section style={cardStyle}>
            <h4 style={cardHeaderStyle}>Resolution</h4>
            {terminal ? (
              <div
                style={{
                  whiteSpace: "pre-wrap",
                  fontSize: 13,
                  color: "var(--text-primary)",
                }}
              >
                {sr.resolutionNotes ?? (
                  <span style={{ color: "var(--text-muted)", fontStyle: "italic" }}>
                    (no notes recorded)
                  </span>
                )}
              </div>
            ) : (
              <>
                <textarea
                  value={resolutionNotes}
                  onChange={(e) => setResolutionNotes(e.target.value)}
                  rows={4}
                  placeholder="Notes describing the fix / outcome"
                  style={{ ...inputStyle, resize: "vertical", minHeight: 84 }}
                  disabled={!canEdit || actionBusy}
                />
                <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
                  <button
                    type="button"
                    onClick={complete}
                    disabled={
                      !canEdit || actionBusy || !resolutionNotes.trim()
                    }
                    style={{
                      ...primaryBtn,
                      opacity:
                        !canEdit || actionBusy || !resolutionNotes.trim() ? 0.6 : 1,
                      cursor:
                        !canEdit || actionBusy || !resolutionNotes.trim()
                          ? "not-allowed"
                          : "pointer",
                    }}
                  >
                    Mark Completed
                  </button>
                  <button
                    type="button"
                    onClick={fail}
                    disabled={!canEdit || actionBusy}
                    style={{
                      ...secondaryBtn,
                      opacity: !canEdit || actionBusy ? 0.6 : 1,
                    }}
                  >
                    Mark Failed
                  </button>
                </div>
              </>
            )}
          </section>
        </div>

        <div style={{ minWidth: 0 }}>
          <section style={cardStyle}>
            <h4 style={cardHeaderStyle}>Assignment</h4>
            <div style={fieldRow}>
              <span style={fieldLabel}>Assignee</span>
              <span>
                {sr.assignee?.name ? (
                  sr.assignee.name
                ) : (
                  <span style={{ color: "var(--text-muted)", fontStyle: "italic" }}>
                    unassigned
                  </span>
                )}
              </span>
            </div>
            <div style={{ marginTop: 12 }}>
              <label
                style={{
                  display: "block",
                  fontSize: 11,
                  fontWeight: 600,
                  color: "var(--text-muted)",
                  textTransform: "uppercase",
                  letterSpacing: "0.06em",
                  marginBottom: 6,
                }}
              >
                Team
              </label>
              <input
                type="text"
                value={assignTeam}
                onChange={(e) => setAssignTeam(e.target.value)}
                placeholder="e.g. Field Crew A"
                disabled={!canEdit || terminal || actionBusy}
                style={inputStyle}
              />
              <button
                type="button"
                onClick={saveAssignment}
                disabled={!canEdit || terminal || actionBusy}
                style={{
                  ...secondaryBtn,
                  marginTop: 8,
                  opacity: !canEdit || terminal || actionBusy ? 0.6 : 1,
                }}
              >
                Save
              </button>
            </div>
          </section>

          {nextStatuses.length > 0 && (
            <section style={cardStyle}>
              <h4 style={cardHeaderStyle}>Status actions</h4>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {nextStatuses.map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => transitionTo(s)}
                    disabled={!canEdit || actionBusy}
                    style={{
                      ...primaryBtn,
                      opacity: !canEdit || actionBusy ? 0.6 : 1,
                    }}
                  >
                    Move to {s.replace(/_/g, " ")}
                  </button>
                ))}
              </div>
            </section>
          )}

          <section style={cardStyle}>
            <h4 style={cardHeaderStyle}>Timeline</h4>
            {timeline.length === 0 ? (
              <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
                No timeline entries yet.
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column" }}>
                {timeline.map((t) => (
                  <div
                    key={t.id}
                    style={{
                      fontSize: 12,
                      padding: "8px 0",
                      borderBottom: "1px solid var(--border-subtle)",
                    }}
                  >
                    <div style={{ fontWeight: 500, color: "var(--text-primary)" }}>
                      {t.actorName ?? "system"}
                      <span style={{ color: "var(--text-muted)", marginLeft: 8 }}>
                        {new Date(t.createdAt).toLocaleString()}
                      </span>
                    </div>
                    <div style={{ color: "var(--text-secondary)", marginTop: 2 }}>
                      {t.action}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>
      </div>

      {cancelOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="cancel-sr-title"
          onClick={(e) => {
            if (e.target === e.currentTarget && !actionBusy) {
              setCancelOpen(false);
              setCancelReason("");
            }
          }}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.5)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 100,
          }}
        >
          <div
            style={{
              background: "var(--bg-card)",
              border: "1px solid var(--border)",
              borderRadius: "var(--radius)",
              padding: 24,
              maxWidth: 460,
              width: "100%",
              boxShadow: "0 16px 48px rgba(0,0,0,0.45)",
            }}
          >
            <h2
              id="cancel-sr-title"
              style={{
                margin: 0,
                fontSize: 16,
                fontWeight: 600,
                color: "var(--text-primary)",
                marginBottom: 8,
              }}
            >
              Cancel service request
            </h2>
            <p
              style={{
                margin: 0,
                fontSize: 13,
                color: "var(--text-secondary)",
                marginBottom: 14,
                lineHeight: 1.5,
              }}
            >
              Provide a reason. This transitions the request to CANCELLED and
              cannot be undone.
            </p>
            <label
              htmlFor="cancel-reason"
              style={{
                display: "block",
                fontSize: 11,
                fontWeight: 600,
                color: "var(--text-muted)",
                textTransform: "uppercase",
                letterSpacing: "0.06em",
                marginBottom: 6,
              }}
            >
              Reason *
            </label>
            <textarea
              id="cancel-reason"
              value={cancelReason}
              onChange={(e) => setCancelReason(e.target.value)}
              rows={3}
              autoFocus
              placeholder="Why is this request being cancelled?"
              style={{ ...inputStyle, resize: "vertical", minHeight: 80 }}
            />
            <div
              style={{
                display: "flex",
                justifyContent: "flex-end",
                gap: 8,
                marginTop: 16,
              }}
            >
              <button
                type="button"
                disabled={actionBusy}
                onClick={() => {
                  setCancelOpen(false);
                  setCancelReason("");
                }}
                style={{
                  minHeight: 36,
                  padding: "6px 14px",
                  fontSize: 13,
                  background: "transparent",
                  border: "1px solid var(--border)",
                  borderRadius: "var(--radius)",
                  color: "var(--text-secondary)",
                  cursor: actionBusy ? "not-allowed" : "pointer",
                  fontFamily: "inherit",
                }}
              >
                Back
              </button>
              <button
                type="button"
                disabled={!cancelReason.trim() || actionBusy}
                onClick={confirmCancel}
                style={{
                  minHeight: 36,
                  padding: "6px 14px",
                  fontSize: 13,
                  background: "var(--danger)",
                  color: "#fff",
                  border: "none",
                  borderRadius: "var(--radius)",
                  cursor:
                    !cancelReason.trim() || actionBusy
                      ? "not-allowed"
                      : "pointer",
                  fontFamily: "inherit",
                  opacity: !cancelReason.trim() || actionBusy ? 0.7 : 1,
                  fontWeight: 500,
                }}
              >
                {actionBusy ? "Cancelling…" : "Confirm cancel"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
