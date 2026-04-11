"use client";

import { useEffect, useState, use } from "react";
import Link from "next/link";
import { AccessDenied } from "@/components/ui/access-denied";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { apiClient } from "@/lib/api-client";
import { usePermission } from "@/lib/use-permission";
import { useAuth } from "@/lib/auth-context";
import { useToast } from "@/components/ui/toast";

/**
 * Service hold detail page.
 *
 * Shows the full suspension record, the owning service agreement, and
 * the lifecycle actions available given the current status and tenant
 * config:
 *  - Approve (only if tenant.requireHoldApproval AND status=PENDING AND
 *    the actor has APPROVE permission AND not already approved)
 *  - Activate (PENDING → ACTIVE; refused server-side if approval gate
 *    is not satisfied)
 *  - Complete (ACTIVE → COMPLETED; backfills endDate if open-ended)
 *  - Cancel (PENDING or ACTIVE → CANCELLED)
 *
 * The server-side scheduler also handles PENDING → ACTIVE and
 * ACTIVE → COMPLETED transitions on its hourly tick, so manual buttons
 * are for operators who don't want to wait.
 */

interface ServiceAgreementSummary {
  id: string;
  agreementNumber: string;
  status?: string;
  accountId?: string;
  premiseId?: string;
}

interface SuspensionDetail {
  id: string;
  suspensionType: string;
  status: "PENDING" | "ACTIVE" | "COMPLETED" | "CANCELLED";
  startDate: string;
  endDate: string | null;
  billingSuspended: boolean;
  prorateOnStart: boolean;
  prorateOnEnd: boolean;
  reason: string | null;
  requestedBy: string | null;
  requestedByName: string | null;
  approvedBy: string | null;
  approvedByName: string | null;
  ramsNotified: boolean;
  ramsNotifiedAt: string | null;
  createdAt: string;
  updatedAt: string;
  serviceAgreement?: ServiceAgreementSummary;
}

interface SuspensionTypeDef {
  id: string;
  code: string;
  label: string;
}

interface TenantConfig {
  requireHoldApproval: boolean;
}

interface PageProps {
  params: Promise<{ id: string }>;
}

/**
 * Status badge rendering — takes the stored status plus the approval
 * context so the top-right badge can distinguish between the three
 * flavors of PENDING the workflow actually has:
 *
 *   1. Approval required, not yet approved → "AWAITING APPROVAL" (red)
 *   2. Approval required, approved, not yet started → "APPROVED · AWAITING START" (blue)
 *   3. No approval required (or approved + ready to activate) → "PENDING" (neutral)
 *
 * The data model still has exactly four status values; this is purely
 * presentational. The detail page computes the compound label from
 * `status`, `approvedBy`, and the tenant's `requireHoldApproval` flag.
 */
const statusTone = (
  status: SuspensionDetail["status"],
  opts: { requireApproval: boolean; isApproved: boolean } = {
    requireApproval: false,
    isApproved: false,
  },
) => {
  switch (status) {
    case "PENDING": {
      if (opts.requireApproval && !opts.isApproved) {
        return {
          bg: "var(--danger-subtle)",
          fg: "var(--danger)",
          border: "var(--danger)",
          label: "AWAITING APPROVAL",
        };
      }
      if (opts.requireApproval && opts.isApproved) {
        return {
          bg: "var(--info-subtle)",
          fg: "var(--info)",
          border: "var(--info)",
          label: "APPROVED · AWAITING START",
        };
      }
      return {
        bg: "var(--bg-elevated)",
        fg: "var(--text-secondary)",
        border: "var(--border)",
        label: "PENDING",
      };
    }
    case "ACTIVE":
      return { bg: "var(--warning-subtle)", fg: "var(--warning)", border: "var(--warning)", label: "ACTIVE" };
    case "COMPLETED":
      return { bg: "var(--success-subtle)", fg: "var(--success)", border: "var(--success)", label: "COMPLETED" };
    case "CANCELLED":
      return { bg: "var(--bg-elevated)", fg: "var(--danger)", border: "var(--danger)", label: "CANCELLED" };
  }
};

export default function SuspensionDetailPage({ params }: PageProps) {
  const { id } = use(params);
  const { canView, canEdit } = usePermission("service_suspensions");
  // APPROVE isn't part of the standard permission hook return, so read
  // it straight from the auth context.
  const { permissions } = useAuth();
  const canApprove = (permissions["service_suspensions"] ?? []).includes("APPROVE");
  const { toast } = useToast();

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [hold, setHold] = useState<SuspensionDetail | null>(null);
  const [typeDefs, setTypeDefs] = useState<SuspensionTypeDef[]>([]);
  const [tenantConfig, setTenantConfig] = useState<TenantConfig | null>(null);
  const [confirmOpen, setConfirmOpen] = useState<null | "cancel" | "complete" | "activate" | "approve">(null);
  const [actionLoading, setActionLoading] = useState(false);

  async function load() {
    try {
      setLoading(true);
      setError(null);
      const [detail, types, config] = await Promise.all([
        apiClient.get<SuspensionDetail>(`/api/v1/service-suspensions/${id}`),
        apiClient.get<{ data: SuspensionTypeDef[] }>("/api/v1/suspension-types"),
        apiClient.get<TenantConfig>("/api/v1/tenant-config"),
      ]);
      setHold(detail);
      setTypeDefs(types.data ?? []);
      setTenantConfig(config);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load hold");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (canView) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, canView]);

  async function runAction(kind: "approve" | "activate" | "complete" | "cancel") {
    setActionLoading(true);
    try {
      await apiClient.post(`/api/v1/service-suspensions/${id}/${kind}`, {});
      toast(`Hold ${kind}d`, "success");
      setConfirmOpen(null);
      await load();
    } catch (e) {
      toast(e instanceof Error ? e.message : `Failed to ${kind}`, "error");
    } finally {
      setActionLoading(false);
    }
  }

  if (!canView) {
    return <AccessDenied />;
  }

  if (loading) {
    return (
      <div>
        <p style={{ color: "var(--text-muted)" }}>Loading hold...</p>
      </div>
    );
  }

  if (error || !hold) {
    return (
      <div>
        <h1 style={{ fontSize: 20, fontWeight: 700, marginBottom: 16 }}>Service Hold</h1>
        <p style={{ color: "var(--danger)" }}>{error ?? "Hold not found"}</p>
        <Link href="/service-suspensions" style={{ color: "var(--accent-primary)" }}>
          ← Back to holds
        </Link>
      </div>
    );
  }

  const typeLabel = typeDefs.find((t) => t.code === hold.suspensionType)?.label ?? hold.suspensionType;
  const requiresApproval = tenantConfig?.requireHoldApproval ?? false;
  const isApproved = hold.approvedBy !== null;
  // Compound tone: the badge reflects the combined status + approval
  // state so PENDING isn't presented identically before and after an
  // approve action.
  const tone = statusTone(hold.status, { requireApproval: requiresApproval, isApproved });

  // Visibility rules for the four action buttons.
  const showApprove = canApprove && requiresApproval && hold.status === "PENDING" && !isApproved;
  const showActivate = canEdit && hold.status === "PENDING" && (!requiresApproval || isApproved);
  const showComplete = canEdit && hold.status === "ACTIVE";
  const showCancel = canEdit && (hold.status === "PENDING" || hold.status === "ACTIVE");

  return (
    // Card-grid detail pages need a content max-width so the two-column
    // grid and the title row don't stretch across ultra-wide monitors.
    // Tab-based detail pages (accounts, customers, etc.) get away with
    // full-width because the tab bar wants to span the main area; we
    // don't have a tab bar here, so cap the content column explicitly.
    // Left-aligned like other editor pages — no `margin: 0 auto`.
    <div style={{ maxWidth: 960 }}>
      <Link href="/service-suspensions" style={{ color: "var(--text-muted)", fontSize: 13 }}>
        ← All holds
      </Link>

      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 16, marginBottom: 24 }}>
        <div>
          <div style={{ fontSize: 11, color: "var(--text-muted)", letterSpacing: "0.06em", textTransform: "uppercase" }}>
            Service Hold
          </div>
          <h1 style={{ fontSize: 24, fontWeight: 700, margin: "4px 0 0 0" }}>
            {typeLabel}
          </h1>
        </div>
        <span
          style={{
            display: "inline-flex",
            padding: "4px 12px",
            borderRadius: 999,
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: "0.04em",
            background: tone.bg,
            color: tone.fg,
            border: `1px solid ${tone.border}`,
          }}
        >
          {tone.label}
        </span>
      </div>

      {/* Core facts */}
      <section style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 24 }}>
        <Card label="Agreement">
          {hold.serviceAgreement ? (
            <Link
              href={`/service-agreements/${hold.serviceAgreement.id}`}
              style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 14, color: "var(--accent-primary)" }}
            >
              {hold.serviceAgreement.agreementNumber}
            </Link>
          ) : (
            <span style={{ color: "var(--text-muted)" }}>—</span>
          )}
        </Card>

        <Card label="Period">
          <span style={{ fontSize: 14 }}>
            {hold.startDate.slice(0, 10)} →{" "}
            {hold.endDate ? (
              hold.endDate.slice(0, 10)
            ) : (
              <em style={{ color: "var(--text-muted)" }}>open-ended</em>
            )}
          </span>
        </Card>

        <Card label="Billing">
          <span
            style={{
              fontSize: 12,
              fontWeight: 700,
              color: hold.billingSuspended ? "var(--warning)" : "var(--text-secondary)",
            }}
          >
            {hold.billingSuspended ? "◉ Suspended" : "○ Active"}
          </span>
          <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 4 }}>
            Prorate start: {hold.prorateOnStart ? "yes" : "no"} · Prorate end: {hold.prorateOnEnd ? "yes" : "no"}
          </div>
        </Card>

        <Card label="Approval">
          {requiresApproval ? (
            isApproved ? (
              <span style={{ fontSize: 12, color: "var(--success)" }}>✓ Approved</span>
            ) : (
              <span style={{ fontSize: 12, color: "var(--danger)" }}>✗ Awaiting approval</span>
            )
          ) : (
            <span style={{ fontSize: 12, color: "var(--text-muted)" }}>Not required</span>
          )}
        </Card>
      </section>

      {hold.reason && (
        <Card label="Reason" fullWidth>
          <p style={{ fontSize: 13, margin: 0, whiteSpace: "pre-wrap" }}>{hold.reason}</p>
        </Card>
      )}

      {/* Metadata footer */}
      <section style={{ marginTop: 24, fontSize: 11, color: "var(--text-muted)" }}>
        Created {new Date(hold.createdAt).toLocaleString()} · Updated {new Date(hold.updatedAt).toLocaleString()}
        {hold.requestedBy &&
          ` · Requested by ${hold.requestedByName ?? hold.requestedBy.slice(0, 8)}`}
        {hold.approvedBy &&
          ` · Approved by ${hold.approvedByName ?? hold.approvedBy.slice(0, 8)}`}
      </section>

      {/* Actions */}
      {(showApprove || showActivate || showComplete || showCancel) && (
        <div
          style={{
            display: "flex",
            gap: 8,
            marginTop: 24,
            paddingTop: 24,
            borderTop: "1px solid var(--border)",
          }}
        >
          {showApprove && (
            <ActionButton onClick={() => setConfirmOpen("approve")} tone="primary">
              Approve
            </ActionButton>
          )}
          {showActivate && (
            <ActionButton onClick={() => setConfirmOpen("activate")} tone="primary">
              Activate now
            </ActionButton>
          )}
          {showComplete && (
            <ActionButton onClick={() => setConfirmOpen("complete")} tone="success">
              Complete
            </ActionButton>
          )}
          {showCancel && (
            <ActionButton onClick={() => setConfirmOpen("cancel")} tone="danger">
              Cancel hold
            </ActionButton>
          )}
        </div>
      )}

      {confirmOpen && (
        <ConfirmDialog
          title={`${confirmOpen[0].toUpperCase() + confirmOpen.slice(1)} hold?`}
          message={
            confirmOpen === "cancel"
              ? "Cancelling sets the hold to CANCELLED. This is recorded in the audit log."
              : confirmOpen === "complete"
                ? "Completing marks the hold as finished. If no end date is set, today's date will be used."
                : confirmOpen === "activate"
                  ? "Activating starts the hold right now instead of waiting for the scheduler."
                  : "Approving unblocks the hold so the scheduler (or a manual activate) can move it to ACTIVE."
          }
          confirmLabel={actionLoading ? "Working..." : "Confirm"}
          confirmDisabled={actionLoading}
          destructive={confirmOpen === "cancel"}
          onConfirm={() => runAction(confirmOpen)}
          onCancel={() => setConfirmOpen(null)}
        />
      )}
    </div>
  );
}

function Card({
  label,
  children,
  fullWidth,
}: {
  label: string;
  children: React.ReactNode;
  fullWidth?: boolean;
}) {
  return (
    <div
      style={{
        background: "var(--bg-surface)",
        border: "1px solid var(--border)",
        borderRadius: 8,
        padding: 16,
        gridColumn: fullWidth ? "1 / -1" : undefined,
      }}
    >
      <div style={{ fontSize: 10, color: "var(--text-muted)", letterSpacing: "0.06em", textTransform: "uppercase", marginBottom: 8 }}>
        {label}
      </div>
      {children}
    </div>
  );
}

function ActionButton({
  children,
  onClick,
  tone,
}: {
  children: React.ReactNode;
  onClick: () => void;
  tone: "primary" | "success" | "danger";
}) {
  const bg =
    tone === "primary" ? "var(--accent-primary)" :
    tone === "success" ? "var(--success)" :
    "var(--danger)";
  return (
    <button
      onClick={onClick}
      style={{
        background: bg,
        color: "white",
        border: "none",
        padding: "8px 16px",
        borderRadius: 6,
        fontSize: 13,
        fontWeight: 600,
        cursor: "pointer",
      }}
    >
      {children}
    </button>
  );
}
