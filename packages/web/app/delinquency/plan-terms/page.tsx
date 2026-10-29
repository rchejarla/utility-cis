"use client";

import { useEffect, useState } from "react";
import { PageHeader } from "@/components/ui/page-header";
import { PageDescription } from "@/components/ui/page-description";
import { apiClient } from "@/lib/api-client";
import { useToast } from "@/components/ui/toast";
import { usePermission } from "@/lib/use-permission";
import { AccessDenied } from "@/components/ui/access-denied";
import { DEFAULT_PLAN_TERMS, type PaymentPlanTerms } from "@utility-cis/shared";

/**
 * How this utility agrees payment plans.
 *
 * Beside the delinquency rules rather than in Settings: both answer
 * "how do we chase money, and what do we offer instead", and an
 * operator should not have to know that one is a table and the other is
 * JSON. Design §4a.
 *
 * It reads as four questions rather than eleven fields. Each checkbox
 * is a sentence someone can agree or disagree with, not a flag whose
 * meaning has to be inferred from its name — and every term the schema
 * defines has a control here, because a setting nobody can edit is an
 * orphan (`autoPostBills` shipped that way and manual posting was
 * reachable only by SQL).
 */

const FREQUENCY_LABEL: Record<PaymentPlanTerms["frequency"], string> = {
  WEEKLY: "weekly",
  BIWEEKLY: "fortnightly",
  MONTHLY: "monthly",
};

export default function PlanTermsPage() {
  const { canView, canEdit } = usePermission("delinquency");
  const { toast } = useToast();
  const [terms, setTerms] = useState<PaymentPlanTerms | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiClient
      .get<{ terms: PaymentPlanTerms }>("/api/v1/delinquency/plan-terms")
      .then((res) => setTerms(res.terms))
      .catch(() => {
        // The defaults are what the API would have answered for a
        // tenant that never saved; showing them beats an empty screen,
        // and the error says not to trust them as saved values.
        setTerms(DEFAULT_PLAN_TERMS);
        setError("Could not load this tenant's terms — showing the shipped defaults.");
      });
  }, []);

  if (!canView) return <AccessDenied />;
  if (!terms) return null;

  const set = <K extends keyof PaymentPlanTerms>(key: K, value: PaymentPlanTerms[K]) => {
    setTerms((t) => (t ? { ...t, [key]: value } : t));
    setError(null);
  };

  /**
   * Refused at the control rather than on save. The API rejects this
   * range too, but an operator should not have to press Save to be
   * told that between 6 and 3 instalments is no plan at all.
   */
  const rangeInvalid = terms.maxInstallments < terms.minInstallments;

  const save = async () => {
    if (rangeInvalid) {
      setError("The maximum number of instalments must be at least the minimum.");
      return;
    }
    setSaving(true);
    try {
      // The whole namespace. The API replaces `settings.paymentPlans`
      // wholesale, so a partial body would quietly revert every term
      // the operator did not touch.
      const res = await apiClient.put<{ terms: PaymentPlanTerms }>(
        "/api/v1/delinquency/plan-terms",
        terms,
      );
      setTerms(res.terms);
      toast("Payment plan terms saved", "success");
    } catch {
      toast("Could not save the terms", "error");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <PageHeader title="Payment Plan Terms" />
      <PageDescription storageKey="plan-terms">
        What this utility offers a customer who cannot pay a balance at once, and
        what counts as breaking the arrangement. These terms are copied onto each
        plan when it is agreed, so changing them here never re-terms a plan
        already running.
      </PageDescription>

      {error && (
        <div
          role="alert"
          style={{
            margin: "0 0 16px",
            padding: "10px 14px",
            fontSize: 13,
            color: "var(--danger)",
            background: "color-mix(in srgb, var(--danger) 8%, transparent)",
            border: "1px solid color-mix(in srgb, var(--danger) 30%, transparent)",
            borderRadius: "var(--radius)",
          }}
        >
          {error}
        </div>
      )}

      <Group title="What we ask for">
        <Sentence>
          A down payment of{" "}
          <Num
            termKey="downPaymentPercent"
            label="Down payment percent"
            value={terms.downPaymentPercent}
            min={0}
            max={100}
            onChange={(v) => set("downPaymentPercent", v)}
            disabled={!canEdit}
          />
          % of the balance, repaid in at least{" "}
          <Num
            termKey="minInstallments"
            label="At least this many instalments"
            value={terms.minInstallments}
            min={1}
            max={60}
            onChange={(v) => set("minInstallments", v)}
            disabled={!canEdit}
          />{" "}
          and at most{" "}
          <Num
            termKey="maxInstallments"
            label="At most this many instalments"
            value={terms.maxInstallments}
            min={1}
            max={60}
            onChange={(v) => set("maxInstallments", v)}
            disabled={!canEdit}
            invalid={rangeInvalid}
          />{" "}
          <span data-testid="term-frequency">
            <select
              aria-label="Instalment frequency"
              value={terms.frequency}
              disabled={!canEdit}
              onChange={(e) => set("frequency", e.target.value as PaymentPlanTerms["frequency"])}
              style={{ ...inlineControl, width: 130 }}
            >
              {(Object.keys(FREQUENCY_LABEL) as PaymentPlanTerms["frequency"][]).map((f) => (
                <option key={f} value={f}>
                  {FREQUENCY_LABEL[f]}
                </option>
              ))}
            </select>
          </span>{" "}
          instalments.
        </Sentence>
        <Sentence>
          The first payment may be set up to{" "}
          <Num
            termKey="maxStartDateDays"
            label="Days ahead the first payment may be set"
            value={terms.maxStartDateDays}
            min={0}
            max={365}
            onChange={(v) => set("maxStartDateDays", v)}
            disabled={!canEdit}
          />{" "}
          days ahead.
        </Sentence>
      </Group>

      <Group title="When a plan is broken">
        <Sentence>
          After{" "}
          <Num
            termKey="missedInstallmentsBeforeDefault"
            label="Missed instalments before default"
            value={terms.missedInstallmentsBeforeDefault}
            min={1}
            max={12}
            onChange={(v) => set("missedInstallmentsBeforeDefault", v)}
            disabled={!canEdit}
          />{" "}
          missed instalment, counting one missed{" "}
          <Num
            termKey="graceDays"
            label="Grace days"
            value={terms.graceDays}
            min={0}
            max={60}
            onChange={(v) => set("graceDays", v)}
            disabled={!canEdit}
          />{" "}
          days after it was due.
        </Sentence>
        <Check
          termKey="partialInstallmentCounts"
          checked={terms.partialInstallmentCounts}
          onChange={(v) => set("partialInstallmentCounts", v)}
          disabled={!canEdit}
        >
          A part payment counts as paying the instalment.
        </Check>
        <Check
          termKey="currentBillCountsTowardDefault"
          checked={terms.currentBillCountsTowardDefault}
          onChange={(v) => set("currentBillCountsTowardDefault", v)}
          disabled={!canEdit}
        >
          A customer must also keep paying new bills while the plan runs.
        </Check>
      </Group>

      <Group title="Late fees">
        <Check
          termKey="suppressFeesWhileKept"
          checked={terms.suppressFeesWhileKept}
          onChange={(v) => set("suppressFeesWhileKept", v)}
          disabled={!canEdit}
        >
          Do not charge late fees on debts covered by a plan.
        </Check>
        {/*
          * Stored and frozen onto every plan agreed, but nothing reads
          * it yet: charging the skipped fees needs them recorded when
          * they were skipped, which is not built. The control says so
          * rather than presenting itself as live policy - a setting
          * that looks settable and does nothing is the `autoPostBills`
          * trap in reverse.
          */}
        <Check
          termKey="assessSuppressedFeesOnDefault"
          checked={terms.assessSuppressedFeesOnDefault}
          onChange={(v) => set("assessSuppressedFeesOnDefault", v)}
          disabled={!canEdit}
        >
          Charge the skipped fees if the plan is broken.{" "}
          <span style={{ color: "var(--text-muted)", fontStyle: "italic" }}>
            Recorded on each plan, not yet enforced.
          </span>
        </Check>
      </Group>

      <Group title="Afterwards">
        <Check
          termKey="allowSecondPlanAfterDefault"
          checked={terms.allowSecondPlanAfterDefault}
          onChange={(v) => set("allowSecondPlanAfterDefault", v)}
          disabled={!canEdit}
        >
          A customer may agree a second plan after breaking one.
        </Check>
      </Group>

      {canEdit && (
        <button
          onClick={save}
          disabled={saving}
          style={{
            marginTop: 8,
            padding: "9px 18px",
            fontSize: 13,
            fontWeight: 600,
            color: "var(--bg-deep)",
            background: "var(--accent-primary)",
            border: "none",
            borderRadius: "var(--radius)",
            cursor: saving ? "default" : "pointer",
            opacity: saving ? 0.6 : 1,
          }}
        >
          {saving ? "Saving…" : "Save terms"}
        </button>
      )}
    </div>
  );
}

// ─── The prose furniture ───────────────────────────────────────────

const inlineControl = {
  padding: "4px 8px",
  fontSize: 13,
  background: "var(--bg-deep)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius)",
  color: "var(--text-primary)",
  fontFamily: "inherit",
  outline: "none",
} as const;

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={{ marginBottom: 26 }}>
      <h2
        style={{
          margin: "0 0 10px",
          fontSize: 11,
          fontWeight: 700,
          letterSpacing: "0.09em",
          textTransform: "uppercase",
          color: "var(--text-muted)",
        }}
      >
        {title}
      </h2>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>{children}</div>
    </section>
  );
}

function Sentence({ children }: { children: React.ReactNode }) {
  return (
    <p style={{ margin: 0, fontSize: 14, lineHeight: 2.1, color: "var(--text-primary)" }}>
      {children}
    </p>
  );
}

function Num({
  termKey,
  label,
  value,
  min,
  max,
  onChange,
  disabled,
  invalid,
}: {
  termKey: keyof PaymentPlanTerms;
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (v: number) => void;
  disabled: boolean;
  invalid?: boolean;
}) {
  /*
   * The input is backed by a string while it is being edited, and only
   * a parseable value is reported upward.
   *
   * Binding a number straight to `value` makes the field impossible to
   * clear: the empty string has to be coerced to something to stay a
   * number, so backspacing the last digit snaps the field back to that
   * something and the operator cannot type a replacement without first
   * deleting what reappeared. The draft keeps the half-typed state
   * where it belongs — on screen — while the committed terms stay
   * numeric.
   */
  const [draft, setDraft] = useState(String(value));
  useEffect(() => {
    setDraft(String(value));
  }, [value]);

  return (
    <span data-testid={`term-${termKey}`}>
      <input
        type="number"
        aria-label={label}
        value={draft}
        min={min}
        max={max}
        disabled={disabled}
        onChange={(e) => {
          const raw = e.target.value;
          setDraft(raw);
          if (raw !== "" && Number.isFinite(Number(raw))) onChange(Number(raw));
        }}
        style={{
          ...inlineControl,
          width: 62,
          textAlign: "center",
          borderColor: invalid ? "var(--danger)" : "var(--border)",
        }}
      />
    </span>
  );
}

function Check({
  termKey,
  checked,
  onChange,
  disabled,
  children,
}: {
  termKey: keyof PaymentPlanTerms;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled: boolean;
  children: React.ReactNode;
}) {
  return (
    <label
      data-testid={`term-${termKey}`}
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: 9,
        fontSize: 14,
        lineHeight: 1.5,
        color: "var(--text-primary)",
        cursor: disabled ? "default" : "pointer",
      }}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        style={{ marginTop: 3, accentColor: "var(--accent-primary)" }}
      />
      <span>{children}</span>
    </label>
  );
}
