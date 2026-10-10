"use client";

import { useCallback, useEffect, useState } from "react";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { apiClient } from "@/lib/api-client";
import { useToast } from "@/components/ui/toast";
import { usePermission } from "@/lib/use-permission";

/**
 * Raise a fee, forgive a charge, or write one off.
 *
 * One component, three modes, because they differ only in which endpoint
 * they call and which reason type they may cite. They are NOT one act
 * though, and the UI must not blur that: a concession and a bad debt are
 * reported separately by any finance department, and once collapsed the
 * distinction is unrecoverable from history (spec §3.5).
 *
 * The reason dropdown is filtered per mode, which is the whole purpose of
 * `GET /ar/reasons?appliesToType=`. Offering write-off reasons in a
 * waive dialog would present a choice the API answers with 422 — so the
 * impossible choice is never shown.
 *
 * Waiving and writing off name the charge they apply to, and the excess
 * stays open as a refund due rather than spilling onto other charges
 * (§6.5). The dialog says so, because "waive $30 of a $10 charge" is a
 * reasonable thing to do by accident.
 */

export type AdjustMode = "fee" | "waive" | "writeOff";

/**
 * The charge a waiver or write-off applies to.
 *
 * Deliberately narrower than a ledger row: this dialog needs an id to
 * send as `debitId`, the two amounts to show what is left of what, and
 * something to call it. Taking a whole `LedgerRow` meant the only other
 * screen that can offer these acts -- the bill list, where the charge
 * arrives as four fields -- would have had to invent eleven nulls to
 * satisfy a type it does not use.
 */
export interface AdjustTarget {
  /** Sent as `debitId`. Must be a debit; a credit cannot be forgiven. */
  id: string;
  /** Signed original amount, for "$X still owed of $Y". */
  amount: string;
  openAmount: string;
  /** What to call it in the confirmation line. */
  label: string;
}

interface Reason {
  id: string;
  code: string;
  label: string;
  appliesToType: string;
}

const MODES: Record<
  AdjustMode,
  {
    title: string;
    message: string;
    confirm: string;
    path: (accountId: string) => string;
    appliesToType: string;
    needsTarget: boolean;
  }
> = {
  fee: {
    title: "Raise a fee",
    message:
      "An off-cycle charge against this account — a late fee, a reconnection, a meter test. It ages on its own due date and is paid before bills.",
    confirm: "Raise fee",
    path: (a) => `/api/v1/accounts/${a}/fees`,
    appliesToType: "FEE",
    needsTarget: false,
  },
  waive: {
    title: "Waive part of a charge",
    message:
      "The charge was right and you are forgiving it. The bill itself is unchanged — only what is owed. Anything beyond what this charge still owes becomes a refund due, not credit against other charges.",
    confirm: "Waive",
    path: (a) => `/api/v1/accounts/${a}/waivers`,
    appliesToType: "ADJUSTMENT_CREDIT",
    needsTarget: true,
  },
  writeOff: {
    title: "Write off a charge",
    message:
      "The charge was right and will never be collected. Recorded as bad debt, which is reported separately from a concession — if you are forgiving this as a courtesy, waive it instead.",
    confirm: "Write off",
    path: (a) => `/api/v1/accounts/${a}/write-offs`,
    appliesToType: "WRITE_OFF",
    needsTarget: true,
  },
};

export function AdjustDialog({
  mode,
  accountId,
  target,
  onClose,
  onDone,
}: {
  mode: AdjustMode;
  accountId: string;
  /** The charge being waived or written off. Unused in fee mode. */
  target?: AdjustTarget | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const { toast } = useToast();
  // Seeding writes rows, so it needs CREATE rather than the EDIT that got
  // the operator into this dialog.
  const { canCreate: canSeed } = usePermission("ar_adjustments");
  const cfg = MODES[mode];
  const [reasons, setReasons] = useState<Reason[] | null>(null);
  const [reasonId, setReasonId] = useState("");
  const [amount, setAmount] = useState(
    cfg.needsTarget && target ? Math.abs(parseFloat(target.openAmount)).toFixed(2) : "",
  );
  const [dueDate, setDueDate] = useState("");
  const [memo, setMemo] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /**
   * Why this is separate from `reasons: []`.
   *
   * Swallowing the error into an empty list made a failed request render
   * as "this utility has no reason codes" — telling the operator the data
   * is missing when in truth we never managed to ask. The two need
   * different words because they need different actions: seed the
   * defaults, versus find out why the call failed.
   */
  const [loadFailed, setLoadFailed] = useState<string | null>(null);
  const [seeding, setSeeding] = useState(false);

  const loadReasons = useCallback(() => {
    setLoadFailed(null);
    apiClient
      .get<{ data: Reason[] }>(`/api/v1/ar/reasons?appliesToType=${cfg.appliesToType}`)
      .then((r) => {
        setReasons(r.data);
        if (r.data.length === 1) setReasonId(r.data[0]!.id);
      })
      .catch((e: unknown) => {
        setReasons([]);
        setLoadFailed(e instanceof Error ? e.message : "The reason codes could not be loaded");
      });
  }, [cfg.appliesToType]);

  useEffect(loadReasons, [loadReasons]);

  async function seedDefaults() {
    setSeeding(true);
    try {
      await apiClient.post("/api/v1/ar/reasons/seed-defaults", {});
      toast("Default reason codes added", "success");
      loadReasons();
    } catch (e: unknown) {
      toast(e instanceof Error ? e.message : "Could not add the default reason codes", "error");
    } finally {
      setSeeding(false);
    }
  }

  const parsed = parseFloat(amount);
  const amountOk = /^\d+(\.\d{1,2})?$/.test(amount) && parsed > 0;
  const valid = amountOk && reasonId !== "" && (!cfg.needsTarget || !!target);

  // A tenant that never seeded reason codes cannot do any of this, and an
  // empty dropdown with a dead button says nothing about why.
  const noReasons = reasons !== null && reasons.length === 0 && loadFailed === null;
  /**
   * The third state, and the one that caused a real support round-trip.
   *
   * While this is true the dropdown has nothing in it but its placeholder,
   * which looks exactly like a tenant with no reason codes. A request that
   * is merely slow, or that never settles at all, is therefore
   * indistinguishable from missing data unless the UI says which it is.
   */
  const loadingReasons = reasons === null && loadFailed === null;

  async function submit() {
    if (!valid || saving) return;
    setSaving(true);
    setError(null);
    try {
      const body: Record<string, unknown> = { amount, reasonId };
      if (cfg.needsTarget && target) body.debitId = target.id;
      if (mode === "fee" && dueDate) body.dueDate = dueDate;
      if (memo) body.memo = memo;

      const res = await apiClient.post<{ balance: string; unapplied?: string }>(
        cfg.path(accountId),
        body,
      );
      const refund = res.unapplied && parseFloat(res.unapplied) > 0;
      toast(
        refund
          ? `Done. $${res.unapplied} is beyond what that charge owed and is now a refund due. Balance is $${res.balance}.`
          : `Done. Balance is now $${res.balance}.`,
        "success",
      );
      onDone();
      onClose();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Could not record the adjustment");
    } finally {
      setSaving(false);
    }
  }

  return (
    <ConfirmDialog
      title={cfg.title}
      message={cfg.message}
      confirmLabel={saving ? "Saving…" : cfg.confirm}
      confirmDisabled={!valid || saving}
      destructive={mode === "writeOff"}
      onConfirm={submit}
      onCancel={onClose}
    >
      <div style={{ display: "grid", gap: "12px", marginTop: "4px" }}>
        {cfg.needsTarget && target && (
          <div style={targetBox}>
            Applying to <b>{target.label}</b> — $
            {Math.abs(parseFloat(target.openAmount)).toFixed(2)} still owed of $
            {Math.abs(parseFloat(target.amount)).toFixed(2)}.
          </div>
        )}

        {loadFailed ? (
          <div style={hintError}>
            The reason codes could not be loaded, so this cannot be filled in yet — this is not the
            same as the utility having none. {loadFailed}
            <button type="button" onClick={loadReasons} style={inlineAction}>
              Try again
            </button>
          </div>
        ) : noReasons ? (
          <div style={hintError}>
            This utility has no {cfg.appliesToType.toLowerCase().replace(/_/g, " ")} reason codes
            yet, so there is nothing to cite.
            {canSeed && (
              <button
                type="button"
                onClick={() => void seedDefaults()}
                disabled={seeding}
                style={inlineAction}
              >
                {seeding ? "Adding…" : "Add the default reason codes"}
              </button>
            )}
          </div>
        ) : (
          <label style={label}>
            Reason
            <select
              value={reasonId}
              onChange={(e) => setReasonId(e.target.value)}
              style={input}
              disabled={loadingReasons}
            >
              <option value="">
                {loadingReasons ? "Loading reason codes…" : "Choose a reason…"}
              </option>
              {(reasons ?? []).map((r) => (
                <option key={r.id} value={r.id}>
                  {r.label}
                </option>
              ))}
            </select>
          </label>
        )}

        <label style={label}>
          Amount
          <input
            autoFocus
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="0.00"
            aria-invalid={amount !== "" && !amountOk}
            style={input}
          />
          {amount !== "" && !amountOk && (
            <span style={hintError}>Enter a positive amount, at most two decimal places.</span>
          )}
        </label>

        {mode === "fee" && (
          <label style={label}>
            Due <span style={optional}>optional — defaults to 30 days</span>
            <input
              type="date"
              value={dueDate}
              onChange={(e) => setDueDate(e.target.value)}
              style={input}
            />
          </label>
        )}

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
const inlineAction: React.CSSProperties = {
  display: "block",
  marginTop: "8px",
  padding: "4px 10px",
  fontSize: "11px",
  fontWeight: 600,
  background: "var(--bg-card)",
  color: "var(--text-primary)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius)",
  cursor: "pointer",
  fontFamily: "inherit",
};

const hintError: React.CSSProperties = {
  fontSize: "12px",
  textTransform: "none",
  letterSpacing: 0,
  color: "var(--accent-danger, #b00)",
};
const targetBox: React.CSSProperties = {
  fontSize: "12px",
  color: "var(--text-secondary)",
  background: "var(--bg-elevated)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius)",
  padding: "8px 10px",
};
