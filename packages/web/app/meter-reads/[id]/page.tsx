"use client";

import { useEffect, useState, use } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { PageHeader } from "@/components/ui/page-header";
import { AccessDenied } from "@/components/ui/access-denied";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { FormField } from "@/components/ui/form-field";
import { formInputStyle } from "@/components/ui/entity-form-page";
import { apiClient } from "@/lib/api-client";
import { usePermission } from "@/lib/use-permission";
import { useToast } from "@/components/ui/toast";

/**
 * Meter read detail page.
 *
 * Shows the full record for a single read plus the context an operator
 * needs to decide whether it's correct: the consumption calculation
 * broken down step-by-step, the meter + agreement + premise this read
 * attributes to, exception info (if flagged), correction lineage (if
 * this is a CORRECTED read or has been corrected), and the read source
 * / reader / frozen state.
 *
 * Does not yet implement the correction workflow UI — that's a follow-up
 * that will POST to PATCH /api/v1/meter-reads/:id with the new value,
 * creating a fresh CORRECTED row. For now the detail page is read-only.
 */

interface MeterReadDetail {
  id: string;
  readDate: string;
  readDatetime: string;
  reading: string;
  priorReading: string;
  consumption: string;
  readType: string;
  readSource: string;
  exceptionCode?: string | null;
  exceptionNotes?: string | null;
  isFrozen: boolean;
  billedAt?: string | null;
  correctsReadId?: string | null;
  readEventId?: string | null;
  readerId?: string | null;
  createdAt: string;
  updatedAt: string;
  meter?: {
    id: string;
    meterNumber: string;
    multiplier: string;
    dialCount?: number | null;
  };
  serviceAgreement?: {
    id: string;
    agreementNumber: string;
    accountId?: string;
    premiseId?: string;
    account?: { id: string; accountNumber: string };
    premise?: {
      id: string;
      addressLine1: string;
      city: string;
      state: string;
      zip: string;
    };
    commodity?: { id: string; name: string };
  };
  register?: {
    id: string;
    registerNumber: string;
  } | null;
}

const fmtNumber = (v: string | number | null | undefined) => {
  if (v === null || v === undefined) return "—";
  const n = Number(v);
  return Number.isFinite(n)
    ? n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 })
    : "—";
};

const readTypeTone = (type: string): { accent: string; label: string } => {
  switch (type) {
    case "ACTUAL":
      return { accent: "var(--success)", label: "ACTUAL" };
    case "ESTIMATED":
      return { accent: "var(--warning)", label: "ESTIMATED" };
    case "CORRECTED":
      return { accent: "var(--info)", label: "CORRECTED" };
    case "FINAL":
      return { accent: "var(--accent-tertiary)", label: "FINAL" };
    case "AMI":
      return { accent: "var(--accent-primary)", label: "AMI" };
    default:
      return { accent: "var(--text-secondary)", label: type };
  }
};

interface PageProps {
  params: Promise<{ id: string }>;
}

export default function MeterReadDetailPage({ params }: PageProps) {
  const { id } = use(params);
  const router = useRouter();
  const { canView, canEdit, canDelete } = usePermission("meter_reads");
  const { toast } = useToast();
  const [read, setRead] = useState<MeterReadDetail | null>(null);
  const [siblings, setSiblings] = useState<Array<{
    id: string;
    reading: string;
    consumption: string;
    exceptionCode?: string | null;
    register?: { id: string; registerNumber: string } | null;
  }> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Correction state — inline form toggled by the "Correct" button.
  const [correcting, setCorrecting] = useState(false);
  const [correctionValue, setCorrectionValue] = useState("");
  const [correctionNotes, setCorrectionNotes] = useState("");
  const [correctionSubmitting, setCorrectionSubmitting] = useState(false);

  // Delete confirmation state.
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    setLoading(true);
    setError(null);
    setSiblings(null);
    apiClient
      .get<MeterReadDetail>(`/api/v1/meter-reads/${id}`)
      .then(async (r) => {
        setRead(r);
        // If this read is part of a multi-register event, fetch its
        // siblings so we can show which other registers were captured
        // at the same moment (demand vs. usage, etc.).
        if (r.readEventId) {
          try {
            const sibRes = await apiClient.get<{
              data: Array<{
                id: string;
                reading: string;
                consumption: string;
                exceptionCode?: string | null;
                register?: { id: string; registerNumber: string } | null;
              }>;
            }>(`/api/v1/meter-reads`, { readEventId: r.readEventId, limit: "50" });
            setSiblings(sibRes.data.filter((s) => s.id !== r.id));
          } catch {
            setSiblings([]);
          }
        }
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load meter read"))
      .finally(() => setLoading(false));
  }, [id]);

  if (!canView) return <AccessDenied />;

  const startCorrection = () => {
    if (!read) return;
    setCorrectionValue(read.reading);
    setCorrectionNotes("");
    setCorrecting(true);
  };

  const submitCorrection = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!read) return;
    if (!correctionNotes.trim()) {
      toast("Correction notes are required — explain why the reading is being changed", "error");
      return;
    }
    setCorrectionSubmitting(true);
    try {
      const newRead = await apiClient.patch<MeterReadDetail>(
        `/api/v1/meter-reads/${read.id}`,
        {
          reading: parseFloat(correctionValue),
          exceptionNotes: correctionNotes,
        },
      );
      toast("Correction recorded", "success");
      // Navigate to the new CORRECTED row so the operator can see it
      // and verify the calculation.
      router.push(`/meter-reads/${newRead.id}`);
    } catch (err) {
      toast(err instanceof Error ? err.message : "Correction failed", "error");
    } finally {
      setCorrectionSubmitting(false);
    }
  };

  const confirmDelete = async () => {
    if (!read) return;
    setDeleting(true);
    try {
      await apiClient.delete(`/api/v1/meter-reads/${read.id}`);
      toast("Meter read deleted", "success");
      router.push("/meter-reads");
    } catch (err) {
      toast(err instanceof Error ? err.message : "Delete failed", "error");
      setDeleting(false);
      setDeleteConfirm(false);
    }
  };

  if (loading) {
    return (
      <div style={{ padding: "48px", textAlign: "center", color: "var(--text-muted)", fontFamily: "'JetBrains Mono', monospace", fontSize: "12px" }}>
        loading meter read...
      </div>
    );
  }

  if (error || !read) {
    return (
      <div style={{ maxWidth: "640px" }}>
        <div style={{ marginBottom: "8px", fontFamily: "'JetBrains Mono', monospace", fontSize: "11px" }}>
          <Link href="/meter-reads" style={{ color: "var(--text-muted)", textDecoration: "none" }}>
            ← /meter-reads
          </Link>
        </div>
        <div
          role="alert"
          style={{
            padding: "16px 20px",
            background: "var(--danger-subtle)",
            border: "1px solid var(--danger)",
            borderRadius: "var(--radius)",
            color: "var(--danger)",
            fontSize: "13px",
          }}
        >
          {error ?? "Meter read not found"}
        </div>
      </div>
    );
  }

  const tone = readTypeTone(read.readType);
  const multiplier = read.meter?.multiplier ?? "1";
  const rawDelta = Number(read.reading) - Number(read.priorReading);

  return (
    <div style={{ maxWidth: "920px" }}>
      <div
        style={{
          marginBottom: "8px",
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: "11px",
          color: "var(--text-muted)",
          letterSpacing: "0.04em",
        }}
      >
        <Link href="/meter-reads" style={{ color: "var(--text-muted)", textDecoration: "none" }}>
          ← /meter-reads
        </Link>
      </div>

      {/* Header with meter number + action buttons. Correct and Delete
          are both disabled when the read is frozen (already billed);
          Phase 3 rebill workflow is the path for retroactive changes. */}
      <div
        style={{
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "space-between",
          gap: "16px",
          marginBottom: "24px",
        }}
      >
        <PageHeader
          title={read.meter?.meterNumber ?? "Meter Read"}
          subtitle={`${read.readDate?.slice(0, 10) ?? "—"} · ${read.readSource}`}
        />
        <div style={{ display: "flex", gap: "10px", flexShrink: 0, marginTop: "4px" }}>
          {canEdit && (
            <button
              type="button"
              onClick={startCorrection}
              disabled={read.isFrozen || correcting}
              title={
                read.isFrozen
                  ? "Frozen reads cannot be corrected in place — use the Phase 3 rebill workflow"
                  : "Create a CORRECTED row pointing at this original"
              }
              style={{
                padding: "8px 16px",
                background: "var(--bg-card)",
                border: "1px solid var(--info)",
                borderRadius: "var(--radius)",
                color: "var(--info)",
                fontSize: "12px",
                fontWeight: 600,
                fontFamily: "inherit",
                cursor: read.isFrozen || correcting ? "not-allowed" : "pointer",
                opacity: read.isFrozen || correcting ? 0.5 : 1,
              }}
            >
              ✎ Correct
            </button>
          )}
          {canDelete && (
            <button
              type="button"
              onClick={() => setDeleteConfirm(true)}
              disabled={read.isFrozen || deleting}
              title={
                read.isFrozen
                  ? "Frozen reads cannot be deleted"
                  : "Delete this read permanently"
              }
              style={{
                padding: "8px 16px",
                background: "var(--bg-card)",
                border: "1px solid var(--danger)",
                borderRadius: "var(--radius)",
                color: "var(--danger)",
                fontSize: "12px",
                fontWeight: 600,
                fontFamily: "inherit",
                cursor: read.isFrozen || deleting ? "not-allowed" : "pointer",
                opacity: read.isFrozen || deleting ? 0.5 : 1,
              }}
            >
              🗑 Delete
            </button>
          )}
        </div>
      </div>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "10px",
          marginBottom: "20px",
          flexWrap: "wrap",
        }}
      >
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "6px",
            padding: "4px 12px",
            borderRadius: "999px",
            background: tone.accent === "var(--success)" ? "var(--success-subtle)" : "var(--bg-elevated)",
            color: tone.accent,
            border: `1px solid ${tone.accent}`,
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: "11px",
            fontWeight: 700,
            letterSpacing: "0.06em",
          }}
        >
          {tone.label}
        </span>
        {read.isFrozen && (
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "6px",
              padding: "4px 12px",
              borderRadius: "999px",
              background: "var(--bg-elevated)",
              border: "1px solid var(--border)",
              color: "var(--text-muted)",
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: "11px",
              fontWeight: 700,
              letterSpacing: "0.06em",
            }}
            title={`Billed at ${read.billedAt}`}
          >
            ❄ FROZEN
          </span>
        )}
        {read.exceptionCode && (
          <span
            style={{
              display: "inline-flex",
              padding: "4px 12px",
              borderRadius: "4px",
              background: "var(--danger-subtle)",
              border: "1px solid var(--danger)",
              color: "var(--danger)",
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: "11px",
              fontWeight: 700,
              letterSpacing: "0.06em",
            }}
          >
            ⚠ {read.exceptionCode}
          </span>
        )}
      </div>

      {/* Inline correction form — shown when the user clicks "Correct".
          Creates a new CORRECTED row via PATCH rather than mutating
          this original. Required notes explain WHY the value changed,
          which lands in the audit log as free text. */}
      {correcting && read.meter && (
        <form
          onSubmit={submitCorrection}
          style={{
            background: "var(--bg-card)",
            border: "1px solid var(--info)",
            borderLeft: "3px solid var(--info)",
            borderRadius: "var(--radius)",
            padding: "20px",
            marginBottom: "20px",
          }}
        >
          <div
            style={{
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: "10px",
              fontWeight: 700,
              letterSpacing: "0.08em",
              color: "var(--info)",
              marginBottom: "14px",
            }}
          >
            ✎ CORRECT READING
          </div>
          <p
            style={{
              fontSize: "12px",
              color: "var(--text-secondary)",
              margin: "0 0 16px 0",
              lineHeight: 1.5,
            }}
          >
            This creates a new <strong>CORRECTED</strong> row that points at the current
            read via <code>corrects_read_id</code>. The original record below is preserved
            unchanged for audit purposes.
          </p>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 2fr", gap: "12px" }}>
            <FormField label="Corrected Reading" required>
              <input
                type="number"
                step="any"
                min="0"
                value={correctionValue}
                onChange={(e) => setCorrectionValue(e.target.value)}
                style={{
                  ...formInputStyle,
                  fontFamily: "'JetBrains Mono', monospace",
                  fontVariantNumeric: "tabular-nums",
                }}
                required
              />
            </FormField>
            <FormField label="Reason / Notes" required>
              <input
                type="text"
                value={correctionNotes}
                onChange={(e) => setCorrectionNotes(e.target.value)}
                placeholder="e.g. misread dial — field tech re-verified"
                style={formInputStyle}
                required
              />
            </FormField>
          </div>
          <div
            style={{
              marginTop: "16px",
              display: "flex",
              gap: "10px",
              justifyContent: "flex-end",
            }}
          >
            <button
              type="button"
              onClick={() => setCorrecting(false)}
              style={{
                padding: "8px 16px",
                background: "transparent",
                border: "1px solid var(--border)",
                borderRadius: "var(--radius)",
                color: "var(--text-secondary)",
                fontSize: "12px",
                fontWeight: 500,
                fontFamily: "inherit",
                cursor: "pointer",
              }}
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={correctionSubmitting || !correctionValue || !correctionNotes.trim()}
              style={{
                padding: "8px 20px",
                background: "var(--info)",
                border: "none",
                borderRadius: "var(--radius)",
                color: "#fff",
                fontSize: "12px",
                fontWeight: 600,
                fontFamily: "inherit",
                cursor: correctionSubmitting ? "not-allowed" : "pointer",
                opacity:
                  correctionSubmitting || !correctionValue || !correctionNotes.trim() ? 0.5 : 1,
              }}
            >
              {correctionSubmitting ? "Submitting..." : "Record Correction"}
            </button>
          </div>
        </form>
      )}

      {/* Consumption calculation card — the thing operators care about most */}
      <div
        style={{
          background: "var(--bg-card)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius)",
          padding: "24px",
          marginBottom: "20px",
        }}
      >
        <div
          style={{
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: "10px",
            fontWeight: 700,
            letterSpacing: "0.08em",
            color: "var(--text-muted)",
            marginBottom: "16px",
          }}
        >
          CONSUMPTION CALCULATION
        </div>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(4, 1fr)",
            gap: "16px",
            fontFamily: "'JetBrains Mono', monospace",
          }}
        >
          <KeyValue label="READING" value={fmtNumber(read.reading)} emphasis />
          <KeyValue label="PRIOR" value={fmtNumber(read.priorReading)} muted />
          <KeyValue label="× MULTIPLIER" value={multiplier} muted />
          <KeyValue label="= CONSUMPTION" value={fmtNumber(read.consumption)} emphasis accent="var(--success)" />
        </div>
        <div
          style={{
            marginTop: "16px",
            paddingTop: "14px",
            borderTop: "1px solid var(--border)",
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: "11px",
            color: "var(--text-muted)",
          }}
        >
          ({fmtNumber(read.reading)} − {fmtNumber(read.priorReading)}) × {multiplier} ={" "}
          {fmtNumber(rawDelta * Number(multiplier))}
          {Number(read.consumption) < 0 && (
            <span style={{ color: "var(--danger)", marginLeft: 8 }}>
              · NEGATIVE — possible reverse flow or meter rollover
            </span>
          )}
        </div>
      </div>

      {/* Sibling registers card — only rendered when this read is part
          of a multi-register read event. Shows the other registers that
          were captured at the same read_datetime under the same event. */}
      {read.readEventId && siblings && siblings.length > 0 && (
        <div
          style={{
            background: "var(--bg-card)",
            border: "1px solid var(--border)",
            borderLeft: "3px solid var(--accent-primary)",
            borderRadius: "var(--radius)",
            padding: "18px",
            marginBottom: "20px",
          }}
        >
          <SectionLabel>SIBLING REGISTERS</SectionLabel>
          <div style={{ fontSize: "11px", color: "var(--text-muted)", marginBottom: "10px", fontFamily: "'JetBrains Mono', monospace" }}>
            event {read.readEventId.slice(0, 8)}… · captured at the same read_datetime as this row
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
            {siblings.map((s) => (
              <div
                key={s.id}
                style={{
                  display: "grid",
                  gridTemplateColumns: "80px 1fr 1fr 80px",
                  gap: "12px",
                  alignItems: "center",
                  padding: "8px 12px",
                  background: "var(--bg-elevated)",
                  borderRadius: "var(--radius)",
                  fontFamily: "'JetBrains Mono', monospace",
                  fontSize: "12px",
                }}
              >
                <div style={{ color: "var(--text-muted)" }}>
                  R{s.register?.registerNumber ?? "—"}
                </div>
                <div style={{ fontVariantNumeric: "tabular-nums", color: "var(--text-primary)" }}>
                  reading {fmtNumber(s.reading)}
                </div>
                <div style={{ fontVariantNumeric: "tabular-nums", color: "var(--text-secondary)" }}>
                  consumption {fmtNumber(s.consumption)}
                </div>
                <Link
                  href={`/meter-reads/${s.id}`}
                  style={{ color: "var(--accent-primary)", textDecoration: "none", textAlign: "right" }}
                >
                  view →
                </Link>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Context grid: meter, agreement, premise, account */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(2, 1fr)",
          gap: "16px",
          marginBottom: "20px",
        }}
      >
        <div
          style={{
            background: "var(--bg-card)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius)",
            padding: "18px",
          }}
        >
          <SectionLabel>METER</SectionLabel>
          <DetailRow label="Number">
            {read.meter ? (
              <Link
                href={`/meters/${read.meter.id}`}
                style={{ color: "var(--accent-primary)", textDecoration: "none", fontFamily: "'JetBrains Mono', monospace" }}
              >
                {read.meter.meterNumber}
              </Link>
            ) : (
              "—"
            )}
          </DetailRow>
          <DetailRow label="Multiplier">{multiplier}</DetailRow>
          {read.meter?.dialCount && (
            <DetailRow label="Dial count">{read.meter.dialCount}</DetailRow>
          )}
          {read.register && (
            <DetailRow label="Register">{read.register.registerNumber}</DetailRow>
          )}
        </div>

        <div
          style={{
            background: "var(--bg-card)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius)",
            padding: "18px",
          }}
        >
          <SectionLabel>SERVICE AGREEMENT</SectionLabel>
          <DetailRow label="Agreement">
            {read.serviceAgreement ? (
              <Link
                href={`/service-agreements/${read.serviceAgreement.id}`}
                style={{ color: "var(--accent-primary)", textDecoration: "none", fontFamily: "'JetBrains Mono', monospace" }}
              >
                {read.serviceAgreement.agreementNumber}
              </Link>
            ) : (
              "—"
            )}
          </DetailRow>
          {read.serviceAgreement?.account && (
            <DetailRow label="Account">
              <Link
                href={`/accounts/${read.serviceAgreement.account.id}`}
                style={{ color: "var(--accent-primary)", textDecoration: "none", fontFamily: "'JetBrains Mono', monospace" }}
              >
                {read.serviceAgreement.account.accountNumber}
              </Link>
            </DetailRow>
          )}
          {read.serviceAgreement?.commodity && (
            <DetailRow label="Commodity">{read.serviceAgreement.commodity.name}</DetailRow>
          )}
          {read.serviceAgreement?.premise && (
            <DetailRow label="Premise">
              <Link
                href={`/premises/${read.serviceAgreement.premise.id}`}
                style={{ color: "var(--accent-primary)", textDecoration: "none" }}
              >
                {read.serviceAgreement.premise.addressLine1}, {read.serviceAgreement.premise.city}
              </Link>
            </DetailRow>
          )}
        </div>

        <div
          style={{
            background: "var(--bg-card)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius)",
            padding: "18px",
          }}
        >
          <SectionLabel>READ METADATA</SectionLabel>
          <DetailRow label="Type">{read.readType}</DetailRow>
          <DetailRow label="Source">{read.readSource}</DetailRow>
          <DetailRow label="Read date">{read.readDate?.slice(0, 10) ?? "—"}</DetailRow>
          <DetailRow label="Read time">
            {new Date(read.readDatetime).toLocaleString()}
          </DetailRow>
          {read.readerId && <DetailRow label="Reader">{read.readerId.slice(0, 8)}…</DetailRow>}
        </div>

        <div
          style={{
            background: "var(--bg-card)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius)",
            padding: "18px",
          }}
        >
          <SectionLabel>AUDIT</SectionLabel>
          <DetailRow label="Created">
            {new Date(read.createdAt).toLocaleString()}
          </DetailRow>
          <DetailRow label="Updated">
            {new Date(read.updatedAt).toLocaleString()}
          </DetailRow>
          <DetailRow label="Frozen">
            {read.isFrozen ? (
              <span style={{ color: "var(--text-muted)" }}>
                ❄ billed at{" "}
                {read.billedAt ? new Date(read.billedAt).toLocaleDateString() : "—"}
              </span>
            ) : (
              <span style={{ color: "var(--success)" }}>editable</span>
            )}
          </DetailRow>
          {read.correctsReadId && (
            <DetailRow label="Corrects">
              <Link
                href={`/meter-reads/${read.correctsReadId}`}
                style={{ color: "var(--info)", textDecoration: "none", fontFamily: "'JetBrains Mono', monospace" }}
              >
                {read.correctsReadId.slice(0, 8)}… →
              </Link>
            </DetailRow>
          )}
        </div>
      </div>

      {/* Exception details if present */}
      {read.exceptionCode && (
        <div
          style={{
            background: "var(--danger-subtle)",
            border: "1px solid var(--danger)",
            borderRadius: "var(--radius)",
            padding: "18px",
            marginBottom: "20px",
          }}
        >
          <div
            style={{
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: "10px",
              fontWeight: 700,
              letterSpacing: "0.08em",
              color: "var(--danger)",
              marginBottom: "10px",
            }}
          >
            ⚠ EXCEPTION — {read.exceptionCode}
          </div>
          {read.exceptionNotes ? (
            <div
              style={{
                fontSize: "13px",
                color: "var(--text-primary)",
                lineHeight: 1.6,
                whiteSpace: "pre-wrap",
              }}
            >
              {read.exceptionNotes}
            </div>
          ) : (
            <div
              style={{
                fontSize: "12px",
                color: "var(--text-muted)",
                fontStyle: "italic",
              }}
            >
              No notes recorded. Resolve from the{" "}
              <Link
                href="/meter-reads/exceptions"
                style={{ color: "var(--danger)", textDecoration: "underline" }}
              >
                exception queue
              </Link>
              .
            </div>
          )}
        </div>
      )}

      {deleteConfirm && (
        <ConfirmDialog
          title="Delete meter read?"
          message={`This will permanently delete the read of ${fmtNumber(
            read.reading,
          )} recorded on ${read.readDate?.slice(0, 10) ?? "—"} for meter ${
            read.meter?.meterNumber ?? ""
          }. This cannot be undone. The audit log will retain a record of the deletion.`}
          confirmLabel={deleting ? "Deleting..." : "Delete permanently"}
          confirmDisabled={deleting}
          destructive
          onConfirm={confirmDelete}
          onCancel={() => setDeleteConfirm(false)}
        />
      )}
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        fontFamily: "'JetBrains Mono', monospace",
        fontSize: "10px",
        fontWeight: 700,
        letterSpacing: "0.08em",
        color: "var(--text-muted)",
        marginBottom: "12px",
      }}
    >
      {children}
    </div>
  );
}

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "120px 1fr",
        gap: "12px",
        padding: "6px 0",
        fontSize: "13px",
        color: "var(--text-primary)",
        borderBottom: "1px solid var(--border-subtle)",
      }}
    >
      <div style={{ color: "var(--text-muted)", fontSize: "12px" }}>{label}</div>
      <div>{children}</div>
    </div>
  );
}

function KeyValue({
  label,
  value,
  emphasis,
  muted,
  accent,
}: {
  label: string;
  value: string;
  emphasis?: boolean;
  muted?: boolean;
  accent?: string;
}) {
  return (
    <div>
      <div
        style={{
          fontSize: "10px",
          fontWeight: 700,
          letterSpacing: "0.08em",
          color: "var(--text-muted)",
          marginBottom: "6px",
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontSize: emphasis ? "22px" : "14px",
          fontWeight: emphasis ? 700 : 500,
          fontVariantNumeric: "tabular-nums",
          color: accent ?? (muted ? "var(--text-muted)" : "var(--text-primary)"),
        }}
      >
        {value}
      </div>
    </div>
  );
}
