"use client";

import { useCallback, useEffect, useState } from "react";
import { apiClient } from "@/lib/api-client";
import { usePermission } from "@/lib/use-permission";
import { useToast } from "@/components/ui/toast";
import { AgreePlanDialog } from "./agree-plan-dialog";

/**
 * The plan on an account, as a CSR reads it on a call.
 *
 * Four questions in the order they are asked:
 *
 *  1. **Is there a plan, and is it being kept?** `PaymentPlan.status`
 *     says ACTIVE whether the customer is current or three payments
 *     behind, and that is the first thing anyone asks — so it is
 *     derived, not read off the enum.
 *  2. **What is left**, with the next payment and its date.
 *  3. **The schedule**, derived from `start_date`, the frequency and
 *     the count. There is no instalment table: a stored copy of a
 *     derivable figure can disagree with the ledger.
 *  4. **What is covered** — the debts themselves, so a CSR looking at a
 *     charge can see it is in a plan and not chase it.
 *
 * And a warning where it will be read: a plan can break because a *new*
 * bill went unpaid while every instalment was paid faithfully, which is
 * only knowable from two screens unless this one says it.
 */

interface Summary {
  id: string;
  status: string;
}

interface CoveredDebt {
  entryId: string;
  type: string;
  amount: string;
  openAmount: string;
  dueDate: string | null;
  reasonLabel: string | null;
  billNumber: string | null;
  assessedOnBillNumber: string | null;
}

interface PlanDetail {
  id: string;
  status: string;
  totalBalance: string;
  downPayment: string | null;
  installmentCount: number;
  installmentFrequency: string;
  startDate: string;
  statusChangedAt: string;
  clearedToDate: string;
  progress: {
    onTrack: boolean;
    installmentsBehind: number;
    remaining: string;
  };
  schedule: Array<{ dueDate: string; amount: string }>;
  covers: CoveredDebt[];
  /** The uncovered past-due debt that would break this plan, if any. */
  atRisk: { entryId: string; billNumber: string | null; amount: string } | null;
}

interface Props {
  accountId: string;
  /**
   * Overrides what the API reports as putting the plan at risk. Only
   * tests pass it; the server answers the question, because it is the
   * same predicate the default sweep uses and two implementations
   * could disagree about whether a customer is about to lose a plan.
   */
  uncoveredPastDue?: { billNumber: string | null; amount: string } | null;
}

const money = (s: string) => `$${Number(s).toFixed(2)}`;

export function PlanPanel({ accountId, uncoveredPastDue }: Props) {
  const { canCreate, canEdit } = usePermission("delinquency");
  const { toast } = useToast();
  const [plan, setPlan] = useState<PlanDetail | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [agreeing, setAgreeing] = useState(false);

  const load = useCallback(async () => {
    try {
      const list = await apiClient.get<{ data: Summary[] }>(
        `/api/v1/accounts/${accountId}/payment-plans`,
      );
      // The live one if there is one; otherwise the most recent, so a
      // defaulted plan is still visible rather than vanishing.
      const pick =
        (list.data ?? []).find((p) => p.status === "ACTIVE") ?? (list.data ?? [])[0];
      if (!pick) {
        setPlan(null);
        return;
      }
      setPlan(await apiClient.get<PlanDetail>(`/api/v1/payment-plans/${pick.id}`));
    } catch {
      setPlan(null);
    } finally {
      setLoaded(true);
    }
  }, [accountId]);

  useEffect(() => {
    void load();
  }, [load]);

  const cancel = async () => {
    if (!plan) return;
    try {
      await apiClient.post(`/api/v1/payment-plans/${plan.id}/cancel`, {});
      toast("Payment plan cancelled", "success");
      await load();
    } catch {
      toast("Could not cancel the plan", "error");
    }
  };

  if (!loaded) return null;

  if (!plan) {
    return (
      <section style={card}>
        <div style={headerRow}>
          <h3 style={title}>Payment plan</h3>
          <span style={{ fontSize: 13, color: "var(--text-muted)" }}>None</span>
        </div>
        {canCreate && (
          <button onClick={() => setAgreeing(true)} style={primaryBtn}>
            Agree a plan
          </button>
        )}
        {agreeing && (
          <AgreePlanDialog
            accountId={accountId}
            onClose={() => setAgreeing(false)}
            onAgreed={async () => {
              setAgreeing(false);
              await load();
            }}
          />
        )}
      </section>
    );
  }

  const live = plan.status === "ACTIVE";
  const risk = uncoveredPastDue ?? plan.atRisk ?? null;
  const atRisk = live && !!risk;
  const behind = plan.progress.installmentsBehind;

  /* The status line, which is the whole first question. */
  const state = !live
    ? `${plan.status} ${plan.statusChangedAt.slice(0, 10)}`
    : atRisk
      ? "ACTIVE — at risk"
      : plan.progress.onTrack
        ? "ACTIVE — on track"
        : `ACTIVE — ${behind} payment${behind === 1 ? "" : "s"} behind`;

  /*
   * The next payment still owed, not merely the next by date. Taking
   * the first future row told a customer who paid this morning that
   * their next payment was due today. How much of the debt is gone is
   * known (`clearedToDate`), so walk the schedule's cumulative total
   * and stop at the first row that money has not yet reached.
   */
  const cleared = Number(plan.clearedToDate);
  let cumulative = 0;
  const next = plan.schedule.find((r) => {
    cumulative += Number(r.amount);
    return cumulative > cleared;
  });

  return (
    <section style={card}>
      <div style={headerRow}>
        <h3 style={title}>Payment plan</h3>
        <span
          style={{
            fontSize: 12,
            fontWeight: 650,
            letterSpacing: "0.04em",
            color: !live ? "var(--danger)" : atRisk || !plan.progress.onTrack ? "var(--warning)" : "var(--success)",
          }}
        >
          {state}
        </span>
      </div>

      {atRisk && (
        <div role="alert" style={warnStyle}>
          <strong>
            {risk!.billNumber ?? "A charge"} ({money(risk!.amount)})
          </strong>{" "}
          is unpaid and past due. The plan breaks if it is not paid — keeping to the
          instalments is not enough.
        </div>
      )}

      <dl style={factGrid}>
        <dt style={dt}>Remaining</dt>
        <dd style={dd}>
          {money(plan.progress.remaining)}{" "}
          <span style={{ color: "var(--text-muted)" }}>of {money(plan.totalBalance)}</span>
        </dd>
        {next && (
          <>
            <dt style={dt}>Next payment</dt>
            <dd style={dd}>
              {money(next.amount)} on {next.dueDate}
            </dd>
          </>
        )}
      </dl>

      <h4 style={subTitle}>Schedule</h4>
      <div style={{ marginBottom: 14 }}>
        {plan.schedule.map((row, i) => (
          <div key={i} style={lineRow}>
            <span style={{ width: 104, color: "var(--text-muted)" }}>{row.dueDate}</span>
            <span style={{ width: 80, textAlign: "right", fontWeight: 600 }}>
              {money(row.amount)}
            </span>
            {i === 0 && (
              <span style={{ color: "var(--text-muted)", fontSize: 12 }}>down payment</span>
            )}
          </div>
        ))}
      </div>

      <h4 style={subTitle}>Covering</h4>
      <div style={{ marginBottom: 14 }}>
        {plan.covers.map((d) => (
          <div key={d.entryId} style={lineRow}>
            <span style={{ flex: 1 }}>
              {d.billNumber ??
                (d.assessedOnBillNumber ? `for ${d.assessedOnBillNumber}` : null) ??
                d.reasonLabel ??
                d.type}
            </span>
            <span style={{ width: 96, color: "var(--text-muted)" }}>{d.dueDate ?? "—"}</span>
            <span style={{ width: 80, textAlign: "right", fontWeight: 600 }}>
              {money(d.openAmount)}
            </span>
          </div>
        ))}
      </div>

      <div style={{ display: "flex", gap: 8 }}>
        {live && canEdit && (
          <button onClick={cancel} style={secondaryBtn}>
            Cancel plan
          </button>
        )}
        {/*
          * A plan that ended is still shown — it is the account's
          * history — but it must not be the reason no new one can be
          * agreed. Without this the panel showed last month's defaulted
          * plan and offered only "Cancel", and the shut-off queue was
          * the one remaining way in.
          */}
        {!live && canCreate && (
          <button onClick={() => setAgreeing(true)} style={primaryBtn}>
            Agree a plan
          </button>
        )}
      </div>

      {agreeing && (
        <AgreePlanDialog
          accountId={accountId}
          onClose={() => setAgreeing(false)}
          onAgreed={async () => {
            setAgreeing(false);
            await load();
          }}
        />
      )}
    </section>
  );
}

const card = {
  background: "var(--bg-card)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius)",
  padding: 18,
  marginBottom: 18,
};

const headerRow = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  marginBottom: 12,
};

const title = { margin: 0, fontSize: 14, fontWeight: 650 };

const subTitle = {
  margin: "0 0 8px",
  fontSize: 11,
  fontWeight: 700,
  letterSpacing: "0.09em",
  textTransform: "uppercase" as const,
  color: "var(--text-muted)",
};

const factGrid = {
  display: "grid",
  gridTemplateColumns: "auto 1fr",
  gap: "6px 16px",
  margin: "0 0 16px",
  fontSize: 13,
};

const dt = { color: "var(--text-muted)" };
const dd = { margin: 0, fontWeight: 600 };

const lineRow = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  fontSize: 13,
  padding: "3px 0",
};

const warnStyle = {
  margin: "0 0 14px",
  padding: "10px 14px",
  fontSize: 13,
  lineHeight: 1.5,
  color: "var(--warning)",
  background: "color-mix(in srgb, var(--warning) 8%, transparent)",
  border: "1px solid color-mix(in srgb, var(--warning) 30%, transparent)",
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
  padding: "7px 14px",
  fontSize: 13,
  color: "var(--text-primary)",
  background: "transparent",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius)",
  cursor: "pointer",
};
