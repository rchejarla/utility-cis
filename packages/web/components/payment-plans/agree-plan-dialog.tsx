"use client";

import { useEffect, useMemo, useState } from "react";
import { apiClient } from "@/lib/api-client";
import { useToast } from "@/components/ui/toast";
import { DEFAULT_PLAN_TERMS, type PaymentPlanTerms } from "@utility-cis/shared";

/**
 * Agreeing a deferred payment agreement, on a phone call.
 *
 * The screen **proposes** and the operator adjusts; it does not present
 * nine empty fields and validate afterwards. Policy becomes a sentence
 * and a pre-filled schedule, and the test for the whole thing is that
 * nobody has to do arithmetic or hold a rule in their head.
 *
 * Refusals explain themselves at the control rather than on save: the
 * instalment count is a dropdown of the allowed range, so the
 * unreachable values are never offered at all.
 */

interface LedgerRow {
  id: string;
  type: string;
  amount: string;
  openAmount: string;
  dueDate: string | null;
  reasonLabel: string | null;
  billNumber: string | null;
  assessedOnBillNumber: string | null;
}

interface Props {
  accountId: string;
  onClose: () => void;
  onAgreed: (planId: string) => void;
}

/**
 * Money is counted in whole cents here, and only ever formatted for
 * display.
 *
 * Floating point disagreed with the server on 1.7% of plausible
 * balances: arrears of $50.64 over three instalments read out as
 * "$12.68 then two of $12.65" while the stored instalment was $12.66.
 * The figure a CSR says aloud has to be the figure the system of
 * record holds, and `Math.round(total * pct) / 100` is not it.
 *
 * The arithmetic below mirrors `createPaymentPlan` exactly: round the
 * down payment half-up, floor the base instalment, and put the whole
 * remainder on the first.
 */
const cents = (s: string) => Math.round(Number(s) * 100);
const money = (c: number) => `$${(c / 100).toFixed(2)}`;

/** Today at UTC midnight, the same day boundary the API validates on. */
function todayIso(): string {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
    .toISOString()
    .slice(0, 10);
}

function addMonths(iso: string, n: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const daysInTarget = new Date(Date.UTC(y!, m! - 1 + n + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y!, m! - 1 + n, Math.min(d!, daysInTarget)))
    .toISOString()
    .slice(0, 10);
}

function addDays(iso: string, n: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d! + n)).toISOString().slice(0, 10);
}

function nextDate(iso: string, n: number, frequency: PaymentPlanTerms["frequency"]): string {
  if (frequency === "WEEKLY") return addDays(iso, n * 7);
  if (frequency === "BIWEEKLY") return addDays(iso, n * 14);
  return addMonths(iso, n);
}

/**
 * What opens ticked: every open debt already overdue.
 *
 * A bill charge whose due date has not arrived opens unticked, so the
 * proposed total is the account's past-due balance — the figure the CSR
 * is already looking at. Illinois' rule that an agreement includes the
 * current bill is then a tick away rather than a default: offered, not
 * assumed.
 *
 * The rule is about the bill, not about every future date. A fee raised
 * on a covered bill belongs to the same arrears, and leaving it out
 * would suppress the bill while its own fee climbed the ladder on its
 * own clock days later.
 */
function opensTicked(row: LedgerRow, today: string): boolean {
  if (row.type !== "BILL_CHARGE") return true;
  return row.dueDate !== null && row.dueDate < today;
}

export function AgreePlanDialog({ accountId, onClose, onAgreed }: Props) {
  const { toast } = useToast();
  const today = todayIso();

  const [terms, setTerms] = useState<PaymentPlanTerms>(DEFAULT_PLAN_TERMS);
  const [debts, setDebts] = useState<LedgerRow[]>([]);
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [installmentCount, setInstallmentCount] = useState<number | null>(null);
  const [downPaymentEdited, setDownPaymentEdited] = useState<string | null>(null);
  const [startDate, setStartDate] = useState(today);
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    Promise.all([
      apiClient.get<{ terms: PaymentPlanTerms }>("/api/v1/delinquency/plan-terms"),
      apiClient.get<{ data: LedgerRow[] }>(`/api/v1/accounts/${accountId}/ledger`, {
        openOnly: "true",
        limit: "200",
      }),
    ])
      .then(([t, ledger]) => {
        const policy = t?.terms ?? DEFAULT_PLAN_TERMS;
        setTerms(policy);
        setInstallmentCount((c) => c ?? policy.minInstallments);
        const open = (ledger?.data ?? []).filter((r) => Number(r.openAmount) > 0);
        setDebts(open);
        setTicked(new Set(open.filter((r) => opensTicked(r, today)).map((r) => r.id)));
      })
      .catch(() => setError("Could not load this account's debts."));
  }, [accountId, today]);

  /** Total in cents, so no sum of decimals can drift. */
  const totalCents = useMemo(
    () => debts.filter((d) => ticked.has(d.id)).reduce((s, d) => s + cents(d.openAmount), 0),
    [debts, ticked],
  );

  /*
   * The down payment follows the balance until an operator types one.
   * "Lower it if the customer cannot manage it" means the percentage is
   * a proposal, and once they have overridden it, unticking a debt must
   * not silently undo their decision.
   */
  const downCents =
    downPaymentEdited !== null && downPaymentEdited !== ""
      ? cents(downPaymentEdited)
      : // Half-up on the exact cent product, as the server does.
        Math.round((totalCents * terms.downPaymentPercent) / 100);

  const count = installmentCount ?? terms.minInstallments;

  const schedule = useMemo(() => {
    const remainder = totalCents - downCents;
    if (remainder <= 0 || count < 1) return [];
    // Floor, then the whole remainder on the first instalment — the
    // customer's last payment is the round one.
    const base = Math.floor(remainder / count);
    const first = remainder - base * (count - 1);
    return [
      { dueDate: startDate, amount: downCents, label: "down payment" },
      ...Array.from({ length: count }, (_, i) => ({
        dueDate: nextDate(startDate, i + 1, terms.frequency),
        amount: i === 0 ? first : base,
        label: "",
      })),
    ];
  }, [totalCents, downCents, count, startDate, terms.frequency]);

  const agree = async () => {
    if (ticked.size === 0) {
      setError("Pick at least one debt for the plan to cover.");
      return;
    }
    if (totalCents - downCents <= 0) {
      setError("The down payment covers the whole balance — take it as a payment instead.");
      return;
    }
    setSaving(true);
    try {
      const body = {
        entryIds: [...ticked],
        installmentCount: count,
        startDate,
        downPayment: (downCents / 100).toFixed(2),
        ...(notes ? { notes } : {}),
      };
      const res = await apiClient.post<{ planId: string }>(
        `/api/v1/accounts/${accountId}/payment-plans`,
        body,
      );
      toast("Payment plan agreed", "success");
      onAgreed(res.planId);
    } catch (e) {
      // The API's refusals are written for a CSR; show them rather than
      // a generic failure.
      const message =
        (e as { body?: { error?: { message?: string } } })?.body?.error?.message ??
        "Could not agree the plan.";
      setError(message);
    } finally {
      setSaving(false);
    }
  };

  const describe = (row: LedgerRow) => {
    if (row.billNumber) return row.billNumber;
    if (row.assessedOnBillNumber) return `for ${row.assessedOnBillNumber}`;
    return null;
  };

  return (
    <div style={overlay} role="dialog" aria-label="Agree a payment plan">
      <div style={panel}>
        <h2 style={{ margin: "0 0 4px", fontSize: 17, fontWeight: 650 }}>
          Agree a payment plan
        </h2>
        <p style={{ margin: "0 0 18px", fontSize: 13, color: "var(--text-muted)" }}>
          What this account owes now, and how it will be paid down. Debts that are
          not yet due are offered but not assumed.
        </p>

        {error && (
          <div role="alert" style={alertStyle}>
            {error}
          </div>
        )}

        <h3 style={groupTitle}>
          Arrears covered — <strong>{money(totalCents)}</strong>
        </h3>
        <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 20 }}>
          {debts.map((row) => (
            <label key={row.id} style={debtRow}>
              <input
                type="checkbox"
                aria-label={`debt-${row.id}`}
                checked={ticked.has(row.id)}
                onChange={(e) => {
                  setTicked((prev) => {
                    const next = new Set(prev);
                    if (e.target.checked) next.add(row.id);
                    else next.delete(row.id);
                    return next;
                  });
                  setError(null);
                }}
                style={{ accentColor: "var(--accent-primary)" }}
              />
              <span style={{ width: 86, textAlign: "right", fontWeight: 600 }}>
                {money(cents(row.openAmount))}
              </span>
              <span style={{ flex: 1 }}>
                {describe(row) ?? row.reasonLabel ?? row.type}
                {row.reasonLabel && describe(row) ? (
                  <span style={{ color: "var(--text-muted)" }}> · {row.reasonLabel}</span>
                ) : null}
              </span>
              <span style={{ color: "var(--text-muted)", fontSize: 12 }}>
                {row.dueDate ?? "—"}
              </span>
              {row.dueDate && row.dueDate >= today && (
                <span style={{ color: "var(--text-muted)", fontSize: 12, fontStyle: "italic" }}>
                  not yet due
                </span>
              )}
            </label>
          ))}
        </div>

        <h3 style={groupTitle}>What we ask for</h3>
        <p style={{ margin: "0 0 14px", fontSize: 14, lineHeight: 2.2 }}>
          A down payment of{" "}
          {/*
              A draft string, not a number: binding a number means the
              empty string has to be coerced, so backspacing the last
              digit snaps the field to 0 and the operator cannot type a
              replacement. The same defect was found and fixed on the
              terms screen and not carried across.
            */}
          <input
            type="number"
            aria-label="Down payment"
            value={downPaymentEdited ?? (downCents / 100).toFixed(2)}
            step="0.01"
            min={0}
            onChange={(e) => {
              setDownPaymentEdited(e.target.value);
              setError(null);
            }}
            style={{ ...inlineControl, width: 96 }}
          />{" "}
          <span style={{ color: "var(--text-muted)", fontSize: 12 }}>
            ({terms.downPaymentPercent}% — your policy. Lower it if the customer
            cannot manage it.)
          </span>
          <br />
          then{" "}
          <select
            aria-label="Instalments"
            value={count}
            onChange={(e) => setInstallmentCount(Number(e.target.value))}
            style={{ ...inlineControl, width: 64 }}
          >
            {Array.from(
              { length: terms.maxInstallments - terms.minInstallments + 1 },
              (_, i) => terms.minInstallments + i,
            ).map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>{" "}
          payments, the first due{" "}
          {/*
              Bounded at the control. The API refuses a date beyond the
              tenant's `maxStartDateDays`, and an operator should not
              have to press Save to be told.
            */}
          <input
            type="date"
            aria-label="First payment date"
            value={startDate}
            min={today}
            max={addDays(today, terms.maxStartDateDays)}
            onChange={(e) => setStartDate(e.target.value)}
            style={{ ...inlineControl, width: 150 }}
          />
          .
        </p>

        {schedule.length > 0 && (
          <>
            <h3 style={groupTitle}>What the customer is agreeing to</h3>
            <div style={{ marginBottom: 20 }}>
              {schedule.map((row, i) => (
                <div key={i} style={scheduleRow}>
                  <span style={{ width: 110, color: "var(--text-muted)" }}>{row.dueDate}</span>
                  <span style={{ width: 86, textAlign: "right", fontWeight: 600 }}>
                    {money(row.amount)}
                  </span>
                  <span style={{ color: "var(--text-muted)", fontSize: 12 }}>{row.label}</span>
                </div>
              ))}
            </div>
          </>
        )}

        <textarea
          aria-label="Notes"
          placeholder="Notes (optional)"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={2}
          style={{ ...inlineControl, width: "100%", marginBottom: 16, resize: "vertical" }}
        />

        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button onClick={onClose} style={secondaryBtn}>
            Cancel
          </button>
          <button onClick={agree} disabled={saving} style={primaryBtn}>
            {saving ? "Agreeing…" : "Agree plan"}
          </button>
        </div>
      </div>
    </div>
  );
}

const overlay = {
  position: "fixed" as const,
  inset: 0,
  background: "rgba(0,0,0,0.5)",
  display: "flex",
  alignItems: "flex-start",
  justifyContent: "center",
  padding: "40px 16px",
  overflowY: "auto" as const,
  zIndex: 1000,
};

const panel = {
  background: "var(--bg-card)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius)",
  padding: 24,
  width: "100%",
  maxWidth: 640,
};

const groupTitle = {
  margin: "0 0 10px",
  fontSize: 11,
  fontWeight: 700,
  letterSpacing: "0.09em",
  textTransform: "uppercase" as const,
  color: "var(--text-muted)",
};

const debtRow = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  fontSize: 13,
  cursor: "pointer",
};

const scheduleRow = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  fontSize: 13,
  padding: "3px 0",
};

const inlineControl = {
  padding: "5px 8px",
  fontSize: 13,
  background: "var(--bg-deep)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius)",
  color: "var(--text-primary)",
  fontFamily: "inherit",
  outline: "none",
};

const alertStyle = {
  margin: "0 0 16px",
  padding: "10px 14px",
  fontSize: 13,
  color: "var(--danger)",
  background: "color-mix(in srgb, var(--danger) 8%, transparent)",
  border: "1px solid color-mix(in srgb, var(--danger) 30%, transparent)",
  borderRadius: "var(--radius)",
};

const primaryBtn = {
  padding: "8px 16px",
  fontSize: 13,
  fontWeight: 600,
  color: "var(--bg-deep)",
  background: "var(--accent-primary)",
  border: "none",
  borderRadius: "var(--radius)",
  cursor: "pointer",
};

const secondaryBtn = {
  padding: "8px 16px",
  fontSize: 13,
  color: "var(--text-primary)",
  background: "transparent",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius)",
  cursor: "pointer",
};
