"use client";

import { useEffect, useState } from "react";
import { apiClient } from "@/lib/api-client";
import { useToast } from "@/components/ui/toast";
import { usePermission } from "@/lib/use-permission";
import { StatusBadge } from "@/components/ui/status-badge";
import {
  SettingsSection,
  SettingsCard,
  settingInputStyle,
} from "@/components/settings/settings-shell";

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
}

export default function DelinquencyRulesPage() {
  const { canEdit, canCreate } = usePermission("delinquency");
  const { toast } = useToast();
  const [rules, setRules] = useState<DelinquencyRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState<string | null>(null);

  const loadRules = () => {
    apiClient
      .get<{ data: DelinquencyRule[] }>("/api/v1/delinquency-rules", { limit: "50", sort: "tier", order: "asc" })
      .then((res) => setRules(res.data ?? []))
      .catch(() => toast("Failed to load rules", "error"))
      .finally(() => setLoading(false));
  };

  useEffect(() => { loadRules(); }, []);

  if (loading) {
    return <SettingsSection title="Delinquency Rules" description="Loading..."><p style={{ color: "var(--text-muted)" }}>Loading...</p></SettingsSection>;
  }

  return (
    <SettingsSection
      title="Delinquency Rules"
      description="Configure the escalation chain — each tier defines when and how to act on past-due accounts. Rules apply in tier order."
    >
      <SettingsCard padded={false}>
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
                <Th>Auto</Th>
                <Th>Status</Th>
              </tr>
            </thead>
            <tbody>
              {rules.map((r) => (
                <tr
                  key={r.id}
                  style={{ cursor: canEdit ? "pointer" : "default", transition: "background 0.1s" }}
                  onClick={() => canEdit && setEditingId(editingId === r.id ? null : r.id)}
                  onMouseEnter={(e) => { if (canEdit) (e.currentTarget as HTMLElement).style.background = "var(--bg-hover)"; }}
                  onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = "transparent"; }}
                >
                  <Td><span style={{ fontFamily: "'JetBrains Mono', monospace", fontWeight: 700, fontSize: 16 }}>{r.tier}</span></Td>
                  <Td><span style={{ fontWeight: 600 }}>{r.name}</span></Td>
                  <Td>{r.daysPastDue} days</Td>
                  <Td><span style={{ fontFamily: "'JetBrains Mono', monospace" }}>${Number(r.minBalance).toFixed(2)}</span></Td>
                  <Td><span style={{ fontSize: 11, color: "var(--text-muted)" }}>{r.actionType}</span></Td>
                  <Td>{r.autoApply ? "✓" : "—"}</Td>
                  <Td><StatusBadge status={r.isActive ? "Active" : "Inactive"} /></Td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </SettingsCard>

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
    </SettingsSection>
  );
}

function RuleEditor({ rule, onSave, onCancel }: { rule: DelinquencyRule; onSave: (data: Record<string, unknown>) => Promise<void>; onCancel: () => void }) {
  const [name, setName] = useState(rule.name);
  const [daysPastDue, setDaysPastDue] = useState(String(rule.daysPastDue));
  const [minBalance, setMinBalance] = useState(String(Number(rule.minBalance)));
  const [actionType, setActionType] = useState(rule.actionType);
  const [notificationEventType, setNotificationEventType] = useState(rule.notificationEventType ?? "");
  const [autoApply, setAutoApply] = useState(rule.autoApply);
  const [isActive, setIsActive] = useState(rule.isActive);
  const [saving, setSaving] = useState(false);

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
    <SettingsCard>
      <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-primary)", marginBottom: 16 }}>
        Edit Tier {rule.tier} — {rule.name}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12, marginBottom: 16 }}>
        <div>
          <Label>Name</Label>
          <input style={{ ...settingInputStyle, width: "100%" }} value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div>
          <Label>Days past due</Label>
          <input type="number" style={{ ...settingInputStyle, width: "100%" }} value={daysPastDue} onChange={(e) => setDaysPastDue(e.target.value)} />
        </div>
        <div>
          <Label>Min balance ($)</Label>
          <input type="number" style={{ ...settingInputStyle, width: "100%" }} value={minBalance} onChange={(e) => setMinBalance(e.target.value)} />
        </div>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 16 }}>
        <div>
          <Label>Action type</Label>
          <select style={{ ...settingInputStyle, width: "100%" }} value={actionType} onChange={(e) => setActionType(e.target.value)}>
            {ACTION_TYPES.map((a) => <option key={a.value} value={a.value}>{a.label}</option>)}
          </select>
        </div>
        <div>
          <Label>Notification template</Label>
          <select style={{ ...settingInputStyle, width: "100%" }} value={notificationEventType} onChange={(e) => setNotificationEventType(e.target.value)}>
            {NOTIF_EVENTS.map((n) => <option key={n.value} value={n.value}>{n.label}</option>)}
          </select>
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
            setSaving(true);
            try {
              await onSave({
                name,
                daysPastDue: Number(daysPastDue),
                minBalance: Number(minBalance),
                actionType,
                notificationEventType: notificationEventType || null,
                autoApply,
                isActive,
              });
            } finally { setSaving(false); }
          }}
          disabled={saving}
          style={{ padding: "8px 20px", fontSize: 13, fontWeight: 600, background: "var(--accent-primary)", color: "#fff", border: "none", borderRadius: "var(--radius)", cursor: saving ? "not-allowed" : "pointer", fontFamily: "inherit", opacity: saving ? 0.7 : 1 }}
        >
          {saving ? "Saving..." : "Save"}
        </button>
      </div>
    </SettingsCard>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-muted)", marginBottom: 4, textTransform: "uppercase", letterSpacing: "0.06em" }}>{children}</div>;
}

function Th({ children }: { children: React.ReactNode }) {
  return <th style={{ padding: "10px 16px", textAlign: "left", fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--text-muted)", borderBottom: "1px solid var(--border)", whiteSpace: "nowrap" }}>{children}</th>;
}

function Td({ children }: { children: React.ReactNode }) {
  return <td style={{ padding: "12px 16px", fontSize: 13, color: "var(--text-primary)", borderBottom: "1px solid var(--border-subtle)", whiteSpace: "nowrap" }}>{children}</td>;
}
