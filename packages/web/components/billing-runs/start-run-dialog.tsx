"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { apiClient } from "@/lib/api-client";
import { useToast } from "@/components/ui/toast";
import { fmtDate, daysInclusive } from "./run-format";
import type { BillingRunPreview, BillingRunRow } from "./run-format";

/**
 * Start a billing run, after showing what it will do.
 *
 * The preview is not decoration. The window and both dates are derived
 * from the cycle's own calendar — the window always ends on the cycle's
 * bill day on or before the date asked for, so an operator who types the
 * 20th against a cycle that bills on the 15th gets the window ending the
 * 15th. Showing the resolved window before the click is the difference
 * between that being obvious and it being discovered afterwards, in a
 * run that cannot be started twice.
 *
 * The optional fields are left blank rather than pre-filled, so "blank"
 * means "use the cycle's own answer" and the preview below always states
 * what that answer is.
 */

interface Cycle {
  id: string;
  name: string;
  cycleCode: string;
  billDayOfMonth: number;
  readDayOfMonth: number;
  active: boolean;
}

export function StartRunDialog({
  onClose,
  onStarted,
}: {
  onClose: () => void;
  onStarted: (run: BillingRunRow) => void;
}) {
  const { toast } = useToast();
  const [cycles, setCycles] = useState<Cycle[]>([]);
  const [cycleId, setCycleId] = useState("");
  const [windowEnd, setWindowEnd] = useState("");
  const [billDate, setBillDate] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [preview, setPreview] = useState<BillingRunPreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    apiClient
      .get<Cycle[] | { data: Cycle[] }>("/api/v1/billing-cycles")
      .then((res) => {
        const all = Array.isArray(res) ? res : (res.data ?? []);
        // An inactive cycle has nothing due and the API refuses it with
        // CYCLE_INACTIVE, so offering it would only produce that error.
        setCycles(all.filter((c) => c.active));
      })
      .catch((err) =>
        toast(err instanceof Error ? err.message : "Failed to load billing cycles", "error"),
      );
  }, [toast]);

  useEffect(() => {
    if (!cycleId) {
      setPreview(null);
      setPreviewError(null);
      return;
    }
    let cancelled = false;
    setPreviewing(true);
    setPreviewError(null);
    const params: Record<string, string> = { billingCycleId: cycleId };
    if (windowEnd) params.windowEnd = windowEnd;
    if (billDate) params.billDate = billDate;
    if (dueDate) params.dueDate = dueDate;
    apiClient
      .get<BillingRunPreview>("/api/v1/billing-runs/preview", params)
      .then((p) => {
        if (cancelled) return;
        setPreview(p);
      })
      .catch((err) => {
        if (cancelled) return;
        setPreview(null);
        setPreviewError(err instanceof Error ? err.message : "Could not work out the run");
      })
      .finally(() => {
        if (!cancelled) setPreviewing(false);
      });
    return () => {
      cancelled = true;
    };
  }, [cycleId, windowEnd, billDate, dueDate]);

  const blocked =
    !preview || preview.accountCount === 0 || preview.existingRun !== null || submitting;

  const start = async () => {
    if (!preview) return;
    setSubmitting(true);
    try {
      const body: Record<string, string> = { billingCycleId: cycleId };
      if (windowEnd) body.windowEnd = windowEnd;
      if (billDate) body.billDate = billDate;
      if (dueDate) body.dueDate = dueDate;
      const run = await apiClient.post<BillingRunRow>("/api/v1/billing-runs", body);
      toast(
        `Run started for ${preview.billingCycleName} — ${preview.accountCount.toLocaleString()} accounts. Nothing is owed until it is posted.`,
        "success",
      );
      onStarted(run);
    } catch (err) {
      toast(err instanceof Error ? err.message : "Could not start the run", "error");
      setSubmitting(false);
    }
  };

  return (
    <ConfirmDialog
      title="Start a billing run"
      message="A run bills every account the cycle has due. It calculates only — nothing is owed, and no customer is asked for money, until the run is posted."
      confirmLabel={submitting ? "Starting…" : "Start the run"}
      cancelLabel="Cancel"
      confirmDisabled={blocked}
      destructive={false}
      onConfirm={() => void start()}
      onCancel={onClose}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <Field label="Billing cycle">
          <select
            value={cycleId}
            onChange={(e) => setCycleId(e.target.value)}
            aria-label="Billing cycle"
            style={INPUT}
          >
            <option value="">Choose a cycle…</option>
            {cycles.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} ({c.cycleCode}) — bills on day {c.billDayOfMonth}
              </option>
            ))}
          </select>
        </Field>

        <details>
          <summary
            style={{
              fontSize: 12,
              color: "var(--text-muted)",
              cursor: "pointer",
              marginBottom: 8,
            }}
          >
            Dates — leave blank to use the cycle's own
          </summary>
          <div style={{ display: "flex", flexDirection: "column", gap: 10, paddingTop: 4 }}>
            <Field label="Bill for the window ending">
              <input
                type="date"
                value={windowEnd}
                onChange={(e) => setWindowEnd(e.target.value)}
                aria-label="Window ending"
                style={INPUT}
              />
            </Field>
            <Field label="Bill date">
              <input
                type="date"
                value={billDate}
                onChange={(e) => setBillDate(e.target.value)}
                aria-label="Bill date"
                style={INPUT}
              />
            </Field>
            <Field label="Due date">
              <input
                type="date"
                value={dueDate}
                onChange={(e) => setDueDate(e.target.value)}
                aria-label="Due date"
                style={INPUT}
              />
            </Field>
          </div>
        </details>

        {previewing && (
          <p style={{ fontSize: 12, color: "var(--text-muted)", margin: 0 }}>
            Working out what is due…
          </p>
        )}

        {previewError && (
          <p style={{ fontSize: 12, color: "var(--danger)", margin: 0 }}>{previewError}</p>
        )}

        {preview && !previewing && (
          <div
            style={{
              background: "var(--bg-elevated)",
              border: "1px solid var(--border)",
              borderRadius: "var(--radius)",
              padding: "12px 14px",
              fontSize: 12.5,
              display: "flex",
              flexDirection: "column",
              gap: 6,
            }}
          >
            <Row
              k="Accounts due"
              v={
                <strong style={{ fontSize: 14 }}>
                  {preview.accountCount.toLocaleString()}
                </strong>
              }
            />
            <Row
              k="Window"
              v={`${fmtDate(preview.windowStart)} – ${fmtDate(preview.windowEnd)} (${daysInclusive(
                preview.windowStart,
                preview.windowEnd,
              )} days)`}
            />
            <Row k="Bill date" v={fmtDate(preview.billDate)} />
            <Row k="Due date" v={fmtDate(preview.dueDate)} />
            {/*
              The window is the cycle's, not the operator's. Said out
              loud only when they asked for a different date, since
              that is when the two can differ.
            */}
            {windowEnd && windowEnd !== preview.windowEnd.slice(0, 10) && (
              <p style={{ margin: "4px 0 0", color: "var(--text-muted)" }}>
                The cycle bills on its own day, so the window ends{" "}
                {fmtDate(preview.windowEnd)} rather than {fmtDate(windowEnd)}.
              </p>
            )}
            {preview.accountCount === 0 && (
              <p style={{ margin: "4px 0 0", color: "var(--warning)" }}>
                No account on this cycle has a service agreement covering this window, so
                there is nothing to bill.
              </p>
            )}
            {preview.existingRun && (
              <p style={{ margin: "4px 0 0", color: "var(--warning)" }}>
                This window has already been run ({preview.existingRun.status}).{" "}
                <Link
                  href={`/billing-runs/${preview.existingRun.id}`}
                  style={{ color: "var(--primary)" }}
                  onClick={onClose}
                >
                  Open that run
                </Link>{" "}
                rather than starting a second one.
              </p>
            )}
          </div>
        )}
      </div>
    </ConfirmDialog>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <span style={{ fontSize: 11, fontWeight: 600, color: "var(--text-muted)" }}>
        {label}
      </span>
      {children}
    </label>
  );
}

function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
      <span style={{ color: "var(--text-muted)" }}>{k}</span>
      <span style={{ textAlign: "right" }}>{v}</span>
    </div>
  );
}

const INPUT: React.CSSProperties = {
  padding: "7px 10px",
  fontSize: 13,
  background: "var(--bg-card)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius)",
  color: "var(--text-primary)",
  fontFamily: "inherit",
  width: "100%",
};
