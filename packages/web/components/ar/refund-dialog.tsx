"use client";

import { useState } from "react";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { apiClient } from "@/lib/api-client";
import { useToast } from "@/components/ui/toast";

/**
 * Give money back — return an overpayment, or release a deposit.
 *
 * Wraps `ConfirmDialog` for the same reason the payment dialog does: it
 * already traps focus, closes on Escape and wires the aria plumbing.
 *
 * **The pool is chosen, never defaulted.** Returning an overpayment and
 * releasing a security deposit are different acts: one hands back money
 * the customer overpaid, the other releases money the utility was
 * holding as collateral. They draw on separate pools that the ledger
 * keeps apart on purpose, so the operator says which, and so does the
 * API — `source` has no default there either.
 *
 * **The available figures shown here are a floor, not the authority.**
 * `balance` is a net number: an account with a $300 open credit and a
 * $100 open charge reads −$200, so the real refundable credit can be
 * more than shown, never less. The server sums the open credits and
 * refuses with the true figure, which is why a 422 is surfaced in place
 * rather than pre-empted.
 *
 * On failure the dialog STAYS OPEN with the message. A refund may have a
 * cheque already written against it, so discarding what was typed is the
 * wrong response to a rejection.
 */

const TENDERS = ["CHECK", "CASH", "CARD", "ACH", "LOCKBOX"] as const;

interface RefundResult {
  entryId: string;
  amount: string;
  source: "CREDIT" | "DEPOSIT";
  balance: string;
  depositAmount: string;
}

export function RefundDialog({
  accountId,
  /** Credit available as a floor: `-balance` when the account is in credit. */
  creditAvailable,
  /** Deposit held, positive. */
  depositHeld,
  onClose,
  onRefunded,
}: {
  accountId: string;
  creditAvailable: string;
  depositHeld: string;
  onClose: () => void;
  onRefunded: () => void;
}) {
  const { toast } = useToast();

  const hasCredit = parseFloat(creditAvailable) > 0;
  const hasDeposit = parseFloat(depositHeld) > 0;
  // Opens on whichever pool has money in it; when both do, the operator
  // picks. Never a pool with nothing in it, which would read as an error
  // the moment they typed an amount.
  const [source, setSource] = useState<"CREDIT" | "DEPOSIT">(hasCredit ? "CREDIT" : "DEPOSIT");
  const [amount, setAmount] = useState(() => (hasCredit ? creditAvailable : depositHeld));
  const [tender, setTender] = useState<string>("CHECK");
  const [issuedOn, setIssuedOn] = useState(() => new Date().toISOString().slice(0, 10));
  const [externalRef, setExternalRef] = useState("");
  const [memo, setMemo] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const parsed = parseFloat(amount);
  const valid = /^\d+(\.\d{1,2})?$/.test(amount) && parsed > 0;
  const shown = source === "DEPOSIT" ? depositHeld : creditAvailable;

  function pick(next: "CREDIT" | "DEPOSIT") {
    setSource(next);
    // Follow the pool, so the figure in the box always belongs to the
    // pool named above it.
    setAmount(next === "DEPOSIT" ? depositHeld : creditAvailable);
    setError(null);
  }

  async function submit() {
    if (!valid || saving) return;
    setSaving(true);
    setError(null);
    try {
      const res = await apiClient.post<RefundResult>(`/api/v1/accounts/${accountId}/refunds`, {
        amount,
        source,
        tender,
        ...(issuedOn ? { issuedOn } : {}),
        ...(externalRef ? { externalRef } : {}),
        ...(memo ? { memo } : {}),
      });
      toast(
        res.source === "DEPOSIT"
          ? `Deposit returned. $${res.depositAmount} still held; balance is $${res.balance}.`
          : `Refund issued. Balance is now $${res.balance}.`,
        "success",
      );
      onRefunded();
      onClose();
    } catch (e: unknown) {
      // Stays open: the cheque may already exist, and the server's
      // message carries the figure that was actually available.
      setError(e instanceof Error ? e.message : "Could not issue the refund");
    } finally {
      setSaving(false);
    }
  }

  return (
    <ConfirmDialog
      title="Issue a refund"
      message="Money leaving the utility. A refund discharges a credit the customer already holds — it does not reduce what they owe."
      confirmLabel={saving ? "Issuing…" : "Issue refund"}
      confirmDisabled={!valid || saving}
      destructive
      onConfirm={submit}
      onCancel={onClose}
    >
      <div style={{ display: "grid", gap: "12px", marginTop: "4px" }}>
        <fieldset style={fieldset}>
          <legend style={legend}>What is being returned</legend>
          {/*
            Both options are always offered, with their figures, even at
            zero. Hiding the empty one would leave an operator unable to
            tell "there is no deposit" from "this screen does not do
            deposits" -- and a disabled radio saying $0.00 answers the
            question.
          */}
          <label style={radio}>
            <input
              type="radio"
              name="refund-source"
              checked={source === "CREDIT"}
              disabled={!hasCredit}
              onChange={() => pick("CREDIT")}
            />
            <span>
              Credit balance <strong style={figure}>${creditAvailable}</strong>
              <span style={note}>An overpayment, or a credit the customer was given</span>
            </span>
          </label>
          <label style={radio}>
            <input
              type="radio"
              name="refund-source"
              checked={source === "DEPOSIT"}
              disabled={!hasDeposit}
              onChange={() => pick("DEPOSIT")}
            />
            <span>
              Deposit held <strong style={figure}>${depositHeld}</strong>
              <span style={note}>
                Collateral the utility holds. Returning it does not pay anything off
              </span>
            </span>
          </label>
        </fieldset>

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
          {amount !== "" && !valid ? (
            <span style={hintError}>Enter a positive amount, at most two decimal places.</span>
          ) : (
            <span style={note}>
              ${shown} available from{" "}
              {source === "DEPOSIT" ? "the deposit held" : "the credit balance"}
            </span>
          )}
        </label>

        <label style={label}>
          Paid by
          <select value={tender} onChange={(e) => setTender(e.target.value)} style={input}>
            {TENDERS.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </label>

        <label style={label}>
          Issued
          <input
            type="date"
            value={issuedOn}
            onChange={(e) => setIssuedOn(e.target.value)}
            style={input}
          />
        </label>

        <label style={label}>
          Reference <span style={optional}>optional</span>
          <input
            value={externalRef}
            onChange={(e) => setExternalRef(e.target.value)}
            placeholder="Cheque number, ACH trace…"
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
const fieldset: React.CSSProperties = {
  display: "grid",
  gap: "8px",
  margin: 0,
  padding: "10px 12px",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius)",
};
const legend: React.CSSProperties = {
  padding: "0 6px",
  fontSize: "11px",
  textTransform: "uppercase",
  letterSpacing: "0.05em",
  color: "var(--text-muted)",
};
const radio: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "auto 1fr",
  gap: "8px",
  alignItems: "start",
  fontSize: "13px",
  color: "var(--text-primary)",
};
const figure: React.CSSProperties = {
  fontFamily: "'JetBrains Mono', monospace",
  marginLeft: "4px",
};
const note: React.CSSProperties = {
  display: "block",
  fontSize: "11px",
  textTransform: "none",
  letterSpacing: 0,
  color: "var(--text-muted)",
};
const hintError: React.CSSProperties = {
  fontSize: "12px",
  textTransform: "none",
  letterSpacing: 0,
  color: "var(--accent-danger, #b00)",
};
