"use client";

import { useEffect, useState } from "react";
import { PageHeader } from "@/components/ui/page-header";
import { PageDescription } from "@/components/ui/page-description";
import { apiClient } from "@/lib/api-client";
import { useToast } from "@/components/ui/toast";
import { usePermission } from "@/lib/use-permission";
import { AccessDenied } from "@/components/ui/access-denied";
import { StatusBadge } from "@/components/ui/status-badge";
import { settingInputStyle } from "@/components/settings/settings-shell";

interface DelinquencyRule {
  id: string;
  name: string;
  accountType?: string;
  tier: number;
  daysPastDue: number;
  minBalance: string;
  actionType: string;
  notificationEventType?: string;
  autoApply: boolean;
  isActive: boolean;
  feeType?: "FLAT_FEE" | "PERCENT_OF_BALANCE" | null;
  /** A dollar amount under FLAT_FEE; a rate under PERCENT_OF_BALANCE, so "0.015" is 1.5%. */
  feeAmount?: string | null;
  maxFee?: string | null;
  feeReasonId?: string | null;
  feeMode?: "ACCUMULATE" | "REPLACE_LOWER_TIERS";
  serviceRequestTypeCode?: string | null;
  reconnectRequestTypeCode?: string | null;
}

interface FeeReason {
  id: string;
  code: string;
  label: string;
  /**
   * Whether a delinquency tier may book its fee here. Only a late-fee
   * reason may: a returned-payment fee answers to a payment bouncing, a
   * tap fee to a tap being cut, and neither to time passing. The API
   * refuses the others with REASON_NOT_FOR_DELINQUENCY, so offering
   * them would be offering a choice that cannot be saved.
   */
  allowsDelinquencyFee: boolean;
}

interface RequestType {
  code: string;
  label: string;
}

/** What a tier charges, in one short phrase for the table. */
function feeSummary(r: DelinquencyRule): string {
  if (!r.feeType || !r.feeAmount) return "—";
  const amount =
    r.feeType === "FLAT_FEE"
      ? `$${Number(r.feeAmount).toFixed(2)}`
      // 1.5%, not 1.50% — while 0.01% keeps the digits it needs.
      : `${(Number(r.feeAmount) * 100).toFixed(2).replace(/\.?0+$/, "")}%${r.maxFee ? ` max $${Number(r.maxFee).toFixed(2)}` : ""}`;
  return r.feeMode === "REPLACE_LOWER_TIERS" ? `${amount} (replaces)` : amount;
}

export default function DelinquencyRulesPage() {
  const { canView, canEdit, canCreate } = usePermission("delinquency");
  const { toast } = useToast();
  const [rules, setRules] = useState<DelinquencyRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);

  const loadRules = () => {
    apiClient
      .get<{ data: DelinquencyRule[] }>("/api/v1/delinquency-rules", { limit: "50", sort: "tier", order: "asc" })
      .then((res) => setRules(res.data ?? []))
      .catch(() => toast("Failed to load rules", "error"))
      .finally(() => setLoading(false));
  };

  useEffect(() => { loadRules(); }, []);

  if (!canView) return <AccessDenied />;

  if (loading) {
    return (
      <div>
        <PageHeader title="Delinquency Rules" subtitle="Loading..." />
        <p style={{ color: "var(--text-muted)" }}>Loading...</p>
      </div>
    );
  }

  return (
    <div>
      <PageHeader title="Delinquency Rules" subtitle="Configure the escalation chain — each tier defines when and how to act on past-due accounts" />
      <PageDescription storageKey="delinquency-rules">
        A <b>rule</b> fires when an account's <b>days past due</b> and
        <b> balance</b> both cross its tier's thresholds, and when the rule was
        already in force on the day the debt came due. Every tier an account
        has passed fires, not just the next one: 50 days past due against
        tiers at 15, 30 and 45 files three actions. The hourly scheduler
        evaluates active rules and files <b>DelinquencyActions</b> — notices,
        door hangers, shut-off eligibility — and a tier that configures a
        <b> late fee</b> charges it to the account ledger at the same time,
        where it appears on the customer&apos;s next bill.
      </PageDescription>
      {canCreate && (
        <div style={{ marginBottom: 16 }}>
          <button
            onClick={() => { setShowCreate(!showCreate); setEditingId(null); }}
            style={{
              padding: "8px 16px", fontSize: 13, fontWeight: 500,
              background: showCreate ? "transparent" : "var(--accent-primary)",
              color: showCreate ? "var(--text-secondary)" : "#fff",
              border: showCreate ? "1px solid var(--border)" : "none",
              borderRadius: "var(--radius)", cursor: "pointer", fontFamily: "inherit",
            }}
          >
            {showCreate ? "Cancel" : "+ New Rule"}
          </button>
        </div>
      )}

      {showCreate && (
        <div style={{ marginBottom: 16 }}>
          <RuleEditor
            onSave={async (data) => {
              await apiClient.post("/api/v1/delinquency-rules", data);
              toast("Rule created", "success");
              setShowCreate(false);
              loadRules();
            }}
            onCancel={() => setShowCreate(false)}
            nextTier={(rules[rules.length - 1]?.tier ?? 0) + 1}
          />
        </div>
      )}

      <div style={{ background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: "var(--radius)", overflow: "hidden" }}>
        {rules.length === 0 ? (
          <div style={{ padding: "32px 24px", textAlign: "center", color: "var(--text-muted)", fontSize: 13 }}>
            No rules configured. Run seed_db.bat to load the default 5-tier escalation chain.
          </div>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ background: "var(--bg-elevated)" }}>
                <Th>Tier</Th>
                <Th>Name</Th>
                <Th>Days Past Due</Th>
                <Th>Min Balance</Th>
                <Th>Action</Th>
                <Th>Late Fee</Th>
                <Th>Auto</Th>
                <Th>Status</Th>
              </tr>
            </thead>
            <tbody>
              {rules.map((r) => (
                <tr
                  key={r.id}
                  style={{ cursor: canEdit ? "pointer" : "default", transition: "background 0.1s" }}
                  onClick={() => { if (canEdit) { setEditingId(editingId === r.id ? null : r.id); setShowCreate(false); } }}
                  onMouseEnter={(e) => { if (canEdit) (e.currentTarget as HTMLElement).style.background = "var(--bg-hover)"; }}
                  onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = "transparent"; }}
                >
                  <Td><span style={{ fontFamily: "'JetBrains Mono', monospace", fontWeight: 700, fontSize: 16 }}>{r.tier}</span></Td>
                  <Td><span style={{ fontWeight: 600 }}>{r.name}</span></Td>
                  <Td>{r.daysPastDue} days</Td>
                  <Td><span style={{ fontFamily: "'JetBrains Mono', monospace" }}>${Number(r.minBalance).toFixed(2)}</span></Td>
                  <Td><span style={{ fontSize: 11, color: "var(--text-muted)" }}>{r.actionType}</span></Td>
                  <Td>
                    <span style={{ fontFamily: "'JetBrains Mono', monospace", color: r.feeType ? "var(--text-primary)" : "var(--text-muted)" }}>
                      {feeSummary(r)}
                    </span>
                  </Td>
                  <Td>{r.autoApply ? "✓" : "—"}</Td>
                  <Td><StatusBadge status={r.isActive ? "Active" : "Inactive"} /></Td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {editingId && (
        <div style={{ marginTop: 16 }}>
          <RuleEditor
            rule={rules.find((r) => r.id === editingId)!}
            onSave={async (data) => {
              await apiClient.patch(`/api/v1/delinquency-rules/${editingId}`, data);
              toast("Rule updated", "success");
              setEditingId(null);
              loadRules();
            }}
            onCancel={() => setEditingId(null)}
          />
        </div>
      )}
    </div>
  );
}

function RuleEditor({ rule, onSave, onCancel, nextTier }: { rule?: DelinquencyRule; onSave: (data: Record<string, unknown>) => Promise<void>; onCancel: () => void; nextTier?: number }) {
  const isCreate = !rule;
  const [name, setName] = useState(rule?.name ?? "");
  const [tier, setTier] = useState(String(rule?.tier ?? nextTier ?? 1));
  const [daysPastDue, setDaysPastDue] = useState(String(rule?.daysPastDue ?? ""));
  const [minBalance, setMinBalance] = useState(String(rule ? Number(rule.minBalance) : ""));
  const [actionType, setActionType] = useState(rule?.actionType ?? "NOTICE_EMAIL");
  const [notificationEventType, setNotificationEventType] = useState(rule?.notificationEventType ?? "");
  const [autoApply, setAutoApply] = useState(rule?.autoApply ?? true);
  const [isActive, setIsActive] = useState(rule?.isActive ?? true);
  const [saving, setSaving] = useState(false);
  const { toast } = useToast();

  const [feeType, setFeeType] = useState<"" | "FLAT_FEE" | "PERCENT_OF_BALANCE">(rule?.feeType ?? "");
  /*
   * Held in the operator's units, not the API's. A percentage tier
   * stores a rate — 0.0150 is 1.5% — and asking someone to type 0.015
   * into a field labelled "rate" is how a 1.5% fee becomes a 0.015%
   * one. The conversion happens on save and on load, in one place each.
   */
  const [feeInput, setFeeInput] = useState(
    rule?.feeAmount == null
      ? ""
      : rule.feeType === "PERCENT_OF_BALANCE"
        ? String(Number(rule.feeAmount) * 100)
        : String(Number(rule.feeAmount)),
  );
  const [maxFee, setMaxFee] = useState(rule?.maxFee == null ? "" : String(Number(rule.maxFee)));
  const [feeReasonId, setFeeReasonId] = useState(rule?.feeReasonId ?? "");
  const [feeMode, setFeeMode] = useState<"ACCUMULATE" | "REPLACE_LOWER_TIERS">(rule?.feeMode ?? "ACCUMULATE");
  const [srCode, setSrCode] = useState(rule?.serviceRequestTypeCode ?? "");
  const [reconnectCode, setReconnectCode] = useState(rule?.reconnectRequestTypeCode ?? "");

  /*
   * Both pickers live behind other modules — `ar_adjustments:VIEW` for
   * the reasons, `service_requests:VIEW` for the types — so a role with
   * only delinquency permissions cannot load them. Say so instead of
   * showing an empty dropdown, which reads as "this tenant has none".
   */
  const [reasons, setReasons] = useState<FeeReason[] | "denied" | null>(null);
  const [requestTypes, setRequestTypes] = useState<RequestType[] | "denied" | null>(null);

  useEffect(() => {
    apiClient
      .get<{ data: FeeReason[] }>("/api/v1/ar/reasons", { appliesToType: "FEE" })
      .then((res) => setReasons((res.data ?? []).filter((r) => r.allowsDelinquencyFee)))
      .catch(() => setReasons("denied"));
    apiClient
      .get<RequestType[]>("/api/v1/service-request-types")
      .then((res) => setRequestTypes(Array.isArray(res) ? res : []))
      .catch(() => setRequestTypes("denied"));
  }, []);

  const charging = feeType !== "";
  const fid = (field: string) => `${rule?.id ?? "new"}-${field}`;

  const ACTION_TYPES = [
    { value: "NOTICE_EMAIL", label: "Send Email Notice" },
    { value: "NOTICE_SMS", label: "Send SMS Notice" },
    { value: "DOOR_HANGER", label: "Door Hanger (field crew)" },
    { value: "SHUT_OFF_ELIGIBLE", label: "Mark Shut-Off Eligible" },
    { value: "DISCONNECT", label: "Disconnect Service" },
  ];

  const NOTIF_EVENTS = [
    { value: "", label: "None" },
    { value: "delinquency.tier_1", label: "Past Due Reminder (Tier 1)" },
    { value: "delinquency.tier_2", label: "Formal Past Due Notice (Tier 2)" },
    { value: "delinquency.tier_3", label: "Shut-Off Warning (Tier 3)" },
    { value: "delinquency.tier_4", label: "Disconnection Notice (Tier 4)" },
  ];

  return (
    <div style={{ background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: "var(--radius)", padding: "4px 24px" }}>
      <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-primary)", marginBottom: 16 }}>
        {isCreate ? "Create New Rule" : `Edit Tier ${rule.tier} — ${rule.name}`}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: isCreate ? "0.5fr 1fr 1fr 1fr" : "1fr 1fr 1fr", gap: 12, marginBottom: 16 }}>
        {isCreate && (
          <div>
            <Label htmlFor={fid("tier")}>Tier</Label>
            <input id={fid("tier")} type="number" min={1} style={{ ...settingInputStyle, width: "100%" }} value={tier} onChange={(e) => setTier(e.target.value)} />
          </div>
        )}
        <div>
          <Label htmlFor={fid("name")}>Name</Label>
          <input id={fid("name")} style={{ ...settingInputStyle, width: "100%" }} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Final Warning" />
        </div>
        <div>
          <Label htmlFor={fid("daysPastDue")}>Days past due</Label>
          <input id={fid("daysPastDue")} type="number" style={{ ...settingInputStyle, width: "100%" }} value={daysPastDue} onChange={(e) => setDaysPastDue(e.target.value)} placeholder="e.g. 30" />
        </div>
        <div>
          <Label htmlFor={fid("minBalance")}>Min balance ($)</Label>
          <input id={fid("minBalance")} type="number" style={{ ...settingInputStyle, width: "100%" }} value={minBalance} onChange={(e) => setMinBalance(e.target.value)} placeholder="e.g. 50" />
        </div>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 16 }}>
        <div>
          <Label htmlFor={fid("actionType")}>Action type</Label>
          <select id={fid("actionType")} style={{ ...settingInputStyle, width: "100%" }} value={actionType} onChange={(e) => setActionType(e.target.value)}>
            {ACTION_TYPES.map((a) => <option key={a.value} value={a.value}>{a.label}</option>)}
          </select>
        </div>
        <div>
          <Label htmlFor={fid("notificationEventType")}>Notification template</Label>
          <select id={fid("notificationEventType")} style={{ ...settingInputStyle, width: "100%" }} value={notificationEventType} onChange={(e) => setNotificationEventType(e.target.value)}>
            {NOTIF_EVENTS.map((n) => <option key={n.value} value={n.value}>{n.label}</option>)}
          </select>
        </div>
      </div>
      <SectionLabel>Late fee</SectionLabel>
      <div style={{ display: "grid", gridTemplateColumns: charging ? "1fr 1fr 1fr" : "1fr", gap: 12, marginBottom: charging ? 12 : 16 }}>
        <div>
          <Label htmlFor={fid("feeType")}>Charge</Label>
          <select
            id={fid("feeType")}
            style={{ ...settingInputStyle, width: "100%" }}
            value={feeType}
            onChange={(e) => {
              const next = e.target.value as typeof feeType;
              setFeeType(next);
              // A cap means nothing on a flat amount, which is its own
              // cap, and the database refuses the combination.
              if (next !== "PERCENT_OF_BALANCE") setMaxFee("");
              if (next === "") setFeeMode("ACCUMULATE");
            }}
          >
            <option value="">Nothing — notice only</option>
            <option value="FLAT_FEE">A flat amount</option>
            <option value="PERCENT_OF_BALANCE">A percentage of the balance</option>
          </select>
        </div>
        {charging && (
          <div>
            <Label htmlFor={fid("feeAmount")}>{feeType === "FLAT_FEE" ? "Amount ($)" : "Rate (%)"}</Label>
            <input
              id={fid("feeAmount")}
              type="number"
              min={0}
              step={0.01}
              style={{ ...settingInputStyle, width: "100%" }}
              value={feeInput}
              onChange={(e) => setFeeInput(e.target.value)}
              placeholder={feeType === "FLAT_FEE" ? "e.g. 25.00" : "e.g. 1.5"}
            />
          </div>
        )}
        {feeType === "PERCENT_OF_BALANCE" && (
          <div>
            <Label htmlFor={fid("maxFee")}>Cap ($, optional)</Label>
            <input id={fid("maxFee")} type="number" min={0} step={0.01} style={{ ...settingInputStyle, width: "100%" }} value={maxFee} onChange={(e) => setMaxFee(e.target.value)} placeholder="e.g. 50.00" />
          </div>
        )}
      </div>
      {charging && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 16 }}>
          <div>
            <Label htmlFor={fid("feeReasonId")}>Reason shown on the bill</Label>
            {reasons === "denied" ? (
              <Blocked>Needs AR adjustments view permission</Blocked>
            ) : reasons !== null && reasons.length === 0 ? (
              <Blocked>No reason is marked for delinquency</Blocked>
            ) : (
              <select id={fid("feeReasonId")} style={{ ...settingInputStyle, width: "100%" }} value={feeReasonId} onChange={(e) => setFeeReasonId(e.target.value)}>
                <option value="">Choose a reason…</option>
                {(reasons ?? []).map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
              </select>
            )}
          </div>
          <div>
            <Label htmlFor={fid("feeMode")}>When a higher tier charges</Label>
            <select id={fid("feeMode")} style={{ ...settingInputStyle, width: "100%" }} value={feeMode} onChange={(e) => setFeeMode(e.target.value as typeof feeMode)}>
              <option value="ACCUMULATE">Keep this fee as well</option>
              <option value="REPLACE_LOWER_TIERS">Replace the fees below it</option>
            </select>
          </div>
        </div>
      )}

      <SectionLabel>Field work</SectionLabel>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 16 }}>
        <div>
          <Label htmlFor={fid("serviceRequestTypeCode")}>Work order this tier raises</Label>
          {requestTypes === "denied" ? (
            <Blocked>Needs service requests view permission</Blocked>
          ) : (
            <select id={fid("serviceRequestTypeCode")} style={{ ...settingInputStyle, width: "100%" }} value={srCode} onChange={(e) => setSrCode(e.target.value)}>
              <option value="">None</option>
              {(requestTypes ?? []).map((t) => <option key={t.code} value={t.code}>{t.label}</option>)}
            </select>
          )}
        </div>
        <div>
          <Label htmlFor={fid("reconnectRequestTypeCode")}>Reconnection when the balance clears</Label>
          {requestTypes === "denied" ? (
            <Blocked>Needs service requests view permission</Blocked>
          ) : (
            <select id={fid("reconnectRequestTypeCode")} style={{ ...settingInputStyle, width: "100%" }} value={reconnectCode} onChange={(e) => setReconnectCode(e.target.value)}>
              <option value="">None</option>
              {(requestTypes ?? []).map((t) => <option key={t.code} value={t.code}>{t.label}</option>)}
            </select>
          )}
        </div>
      </div>

      <div style={{ display: "flex", gap: 16, marginBottom: 16 }}>
        <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "var(--text-secondary)", cursor: "pointer" }}>
          <input type="checkbox" checked={autoApply} onChange={(e) => setAutoApply(e.target.checked)} style={{ width: 16, height: 16, accentColor: "var(--accent-primary)" }} />
          Auto-apply
        </label>
        <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "var(--text-secondary)", cursor: "pointer" }}>
          <input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} style={{ width: 16, height: 16, accentColor: "var(--accent-primary)" }} />
          Active
        </label>
      </div>
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
        <button onClick={onCancel} style={{ padding: "8px 16px", fontSize: 13, background: "transparent", border: "1px solid var(--border)", borderRadius: "var(--radius)", color: "var(--text-secondary)", cursor: "pointer", fontFamily: "inherit" }}>Cancel</button>
        <button
          onClick={async () => {
            if (charging && !(Number(feeInput) > 0)) {
              toast(feeType === "FLAT_FEE" ? "Enter an amount above zero" : "Enter a rate above zero", "error");
              return;
            }
            if (charging && !feeReasonId) {
              toast("Choose the fee reason this tier books to", "error");
              return;
            }
            setSaving(true);
            try {
              await onSave({
                ...(isCreate ? { tier: Number(tier) } : {}),
                name,
                daysPastDue: Number(daysPastDue),
                minBalance: Number(minBalance),
                actionType,
                notificationEventType: notificationEventType || undefined,
                autoApply,
                isActive,
                /*
                 * The three fee fields are sent as a group, always.
                 * The API refuses a partial update of them — an amount
                 * with no reason is a charge nobody can explain — and
                 * sending all three also sidesteps `feeMode` being
                 * rejected on its own, which it is when the server
                 * cannot see the stored `feeType`.
                 */
                feeType: charging ? feeType : null,
                feeAmount: charging
                  ? feeType === "FLAT_FEE"
                    ? Number(feeInput).toFixed(2)
                    : (Number(feeInput) / 100).toFixed(4)
                  : null,
                feeReasonId: charging ? feeReasonId : null,
                maxFee: feeType === "PERCENT_OF_BALANCE" && Number(maxFee) > 0 ? Number(maxFee).toFixed(2) : null,
                feeMode: charging ? feeMode : "ACCUMULATE",
                serviceRequestTypeCode: srCode || null,
                reconnectRequestTypeCode: reconnectCode || null,
              });
            } finally { setSaving(false); }
          }}
          disabled={saving}
          style={{ padding: "8px 20px", fontSize: 13, fontWeight: 600, background: "var(--accent-primary)", color: "#fff", border: "none", borderRadius: "var(--radius)", cursor: saving ? "not-allowed" : "pointer", fontFamily: "inherit", opacity: saving ? 0.7 : 1 }}
        >
          {saving ? "Saving..." : isCreate ? "Create Rule" : "Save"}
        </button>
      </div>
    </div>
  );
}

/** A heading inside the editor, so the fee and field-work fields read as groups. */
function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-secondary)", marginBottom: 8, paddingTop: 4, borderTop: "1px solid var(--border-subtle)", textTransform: "uppercase", letterSpacing: "0.06em" }}>
      {children}
    </div>
  );
}

/** A field the operator's role cannot populate, said plainly. */
function Blocked({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ ...settingInputStyle, width: "100%", color: "var(--text-muted)", fontStyle: "italic", cursor: "not-allowed" }}>
      {children}
    </div>
  );
}

/**
 * A real `<label>` bound to its field. It was a bare `<div>`, so no
 * input on this form was reachable by its name — not by a screen
 * reader, and not by a test that wants to fill the thing in.
 */
function Label({ children, htmlFor }: { children: React.ReactNode; htmlFor?: string }) {
  return (
    <label
      htmlFor={htmlFor}
      style={{ display: "block", fontSize: 11, fontWeight: 600, color: "var(--text-muted)", marginBottom: 4, textTransform: "uppercase", letterSpacing: "0.06em" }}
    >
      {children}
    </label>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return <th style={{ padding: "10px 16px", textAlign: "left", fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--text-muted)", borderBottom: "1px solid var(--border)", whiteSpace: "nowrap" }}>{children}</th>;
}

function Td({ children }: { children: React.ReactNode }) {
  return <td style={{ padding: "12px 16px", fontSize: 13, color: "var(--text-primary)", borderBottom: "1px solid var(--border-subtle)", whiteSpace: "nowrap" }}>{children}</td>;
}
