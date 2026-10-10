"use client";

import { useState } from "react";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { apiClient } from "@/lib/api-client";
import { useToast } from "@/components/ui/toast";

/**
 * Take a payment against an account.
 *
 * Wraps `ConfirmDialog` rather than building a modal: that component
 * already traps focus, closes on Escape and on backdrop click, and wires
 * up aria-labelledby / aria-describedby. A second dialog implementation
 * would be a second one to get those wrong in.
 *
 * The amount is entered POSITIVE — money received, as the operator sees
 * it. The service negates it exactly once when it writes the entry, and
 * the database refuses a positive PAYMENT outright, so there is nowhere
 * for a sign error to hide. The form does not pre-sign anything.
 *
 * On failure the dialog STAYS OPEN with the message shown. Closing it
 * would discard what the operator typed, and a payment is the one thing
 * on this screen they may have taken in cash already.
 */

const TENDERS = ["CASH", "CHECK", "CARD", "ACH", "LOCKBOX"] as const;

interface RecordPaymentResult {
  paymentId: string;
  amount: string;
  unapplied: string;
  balance: string;
  applied: unknown[];
}

export function RecordPaymentDialog({
  accountId,
  onClose,
  onRecorded,
}: {
  accountId: string;
  onClose: () => void;
  onRecorded: () => void;
}) {
  const { toast } = useToast();
  const [amount, setAmount] = useState("");
  const [tender, setTender] = useState<string>("CHECK");
  const [receivedAt, setReceivedAt] = useState(() => new Date().toISOString().slice(0, 10));
  const [externalRef, setExternalRef] = useState("");
  const [memo, setMemo] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A positive, well-formed amount is the only thing the API will accept,
  // so the button is disabled until there is one rather than letting the
  // operator submit into a 400.
  const parsed = parseFloat(amount);
  const valid = /^\d+(\.\d{1,2})?$/.test(amount) && parsed > 0;

  async function submit() {
    if (!valid || saving) return;
    setSaving(true);
    setError(null);
    try {
      const res = await apiClient.post<RecordPaymentResult>(
        `/api/v1/accounts/${accountId}/payments`,
        {
          amount,
          tender,
          ...(receivedAt ? { receivedAt } : {}),
          ...(externalRef ? { externalRef } : {}),
          ...(memo ? { memo } : {}),
        },
      );
      const credit = parseFloat(res.unapplied) > 0;
      toast(
        credit
          ? `Payment recorded. $${res.unapplied} is unapplied and sits as a credit.`
          : `Payment recorded. Balance is now $${res.balance}.`,
        "success",
      );
      onRecorded();
      onClose();
    } catch (e: unknown) {
      // Keep the dialog open: the operator may have the money in hand.
      setError(e instanceof Error ? e.message : "Could not record the payment");
    } finally {
      setSaving(false);
    }
  }

  return (
    <ConfirmDialog
      title="Record a payment"
      message="Money received against this account. It is applied to the oldest fees first, then charges — any remainder stays as a credit."
      confirmLabel={saving ? "Recording…" : "Record payment"}
      confirmDisabled={!valid || saving}
      destructive={false}
      onConfirm={submit}
      onCancel={onClose}
    >
      <div style={{ display: "grid", gap: "12px", marginTop: "4px" }}>
        <label style={label}>
          Amount
          <input
            autoFocus
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="0.00"
            aria-invalid={amount !== "" && !valid}
            style={input}
          />
          {amount !== "" && !valid && (
            <span style={hintError}>Enter a positive amount, at most two decimal places.</span>
          )}
        </label>

        <label style={label}>
          Tender
          <select value={tender} onChange={(e) => setTender(e.target.value)} style={input}>
            {TENDERS.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </label>

        <label style={label}>
          Received
          <input
            type="date"
            value={receivedAt}
            onChange={(e) => setReceivedAt(e.target.value)}
            style={input}
          />
        </label>

        <label style={label}>
          Reference <span style={optional}>optional</span>
          <input
            value={externalRef}
            onChange={(e) => setExternalRef(e.target.value)}
            placeholder="Cheque number, lockbox batch…"
            style={input}
          />
        </label>

        <label style={label}>
          Memo <span style={optional}>optional</span>
          <input value={memo} onChange={(e) => setMemo(e.target.value)} style={input} />
        </label>

        {error && <div style={hintError}>{error}</div>}
      </div>
    </ConfirmDialog>
  );
}

const label: React.CSSProperties = {
  display: "grid",
  gap: "4px",
  fontSize: "11px",
  textTransform: "uppercase",
  letterSpacing: "0.05em",
  color: "var(--text-muted)",
};
const optional: React.CSSProperties = { textTransform: "none", letterSpacing: 0, opacity: 0.7 };
const input: React.CSSProperties = {
  padding: "7px 10px",
  fontSize: "13px",
  fontFamily: "inherit",
  color: "var(--text-primary)",
  background: "var(--bg-base)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius)",
};
const hintError: React.CSSProperties = {
  fontSize: "12px",
  textTransform: "none",
  letterSpacing: 0,
  color: "var(--accent-danger, #b00)",
};
