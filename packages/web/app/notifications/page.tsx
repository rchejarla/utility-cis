"use client";

import { useEffect, useState } from "react";
import { PageHeader } from "@/components/ui/page-header";
import { Tabs } from "@/components/ui/tabs";
import { StatusBadge } from "@/components/ui/status-badge";
import { apiClient } from "@/lib/api-client";
import { usePermission } from "@/lib/use-permission";
import { useToast } from "@/components/ui/toast";
import { AccessDenied } from "@/components/ui/access-denied";
import { settingInputStyle } from "@/components/settings/settings-shell";

// ─── Types ───────────────────────────────────────────────────────

interface NotificationRow {
  id: string;
  eventType: string;
  channel: string;
  recipientEmail?: string;
  recipientPhone?: string;
  resolvedSubject?: string;
  resolvedBody: string;
  status: string;
  provider?: string;
  error?: string;
  attempts: number;
  sentAt?: string;
  createdAt: string;
  template?: { name: string; eventType: string };
}

interface TemplateVariable {
  key: string;
  label: string;
  sample: string;
}

interface ChannelContent {
  subject?: string;
  body: string;
}

interface NotificationTemplate {
  id: string;
  name: string;
  eventType: string;
  description?: string;
  channels: { email?: ChannelContent; sms?: ChannelContent };
  variables: TemplateVariable[];
  isActive: boolean;
}

const statusMap: Record<string, string> = {
  PENDING: "Pending",
  SENDING: "Active",
  SENT: "Active",
  FAILED: "Suspended",
};

// ─── Main page ───────────────────────────────────────────────────

export default function NotificationsPage() {
  const { canView, canCreate, canEdit } = usePermission("notifications");
  const [activeTab, setActiveTab] = useState("templates");

  if (!canView) return <AccessDenied />;

  return (
    <div>
      <PageHeader
        title="Notifications"
        subtitle="Message templates and delivery log"
      />

      <Tabs
        tabs={[
          { key: "templates", label: "Templates" },
          { key: "log", label: "Send Log" },
        ]}
        activeTab={activeTab}
        onTabChange={setActiveTab}
      >
        {activeTab === "templates" && (
          <TemplatesTab canCreate={canCreate} canEdit={canEdit} />
        )}
        {activeTab === "log" && <SendLogTab />}
      </Tabs>
    </div>
  );
}

// ─── Templates tab ───────────────────────────────────────────────

function TemplatesTab({ canCreate, canEdit }: { canCreate: boolean; canEdit: boolean }) {
  const { toast } = useToast();
  const [templates, setTemplates] = useState<NotificationTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);

  const loadTemplates = async () => {
    try {
      const res = await apiClient.get<{ data: NotificationTemplate[] }>(
        "/api/v1/notification-templates",
        { limit: "200" },
      );
      setTemplates(res.data ?? []);
    } catch {
      toast("Failed to load templates", "error");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadTemplates(); }, []);

  if (loading) return <p style={{ color: "var(--text-muted)" }}>Loading templates...</p>;

  return (
    <div>
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
            {showCreate ? "Cancel" : "+ New Template"}
          </button>
        </div>
      )}

      {showCreate && (
        <div style={{ marginBottom: 20 }}>
          <TemplateForm
            onSave={async (data) => {
              await apiClient.post("/api/v1/notification-templates", data);
              toast("Template created", "success");
              setShowCreate(false);
              loadTemplates();
            }}
            onCancel={() => setShowCreate(false)}
          />
        </div>
      )}

      <div
        style={{
          background: "var(--bg-card)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius)",
          overflow: "hidden",
        }}
      >
        {templates.length === 0 ? (
          <div style={{ padding: "32px 24px", textAlign: "center", color: "var(--text-muted)", fontSize: 13 }}>
            No templates configured. Click "+ New Template" to create one, or run seed_db.bat to load defaults.
          </div>
        ) : (
          templates.map((t) => (
            <div key={t.id}>
              <div
                style={{
                  padding: "14px 24px",
                  borderBottom: "1px solid var(--border-subtle)",
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  cursor: canEdit ? "pointer" : "default",
                  transition: "background 0.1s",
                }}
                onClick={() => {
                  if (!canEdit) return;
                  setEditingId(editingId === t.id ? null : t.id);
                  setShowCreate(false);
                }}
                onMouseEnter={(e) => { if (canEdit) (e.currentTarget as HTMLElement).style.background = "var(--bg-hover)"; }}
                onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = "transparent"; }}
              >
                <div>
                  <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-primary)" }}>{t.name}</div>
                  <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 2, display: "flex", gap: 8, alignItems: "center" }}>
                    <span style={{ fontFamily: "'JetBrains Mono', monospace" }}>{t.eventType}</span>
                    {t.channels.email && <ChannelBadge channel="email" />}
                    {t.channels.sms && <ChannelBadge channel="sms" />}
                  </div>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <StatusBadge status={t.isActive ? "Active" : "Inactive"} />
                  {canEdit && <span style={{ fontSize: 12, color: "var(--text-muted)" }}>›</span>}
                </div>
              </div>

              {editingId === t.id && (
                <div style={{ padding: "16px 24px", background: "var(--bg-surface)", borderBottom: "1px solid var(--border-subtle)" }}>
                  <TemplateForm
                    initial={t}
                    onSave={async (data) => {
                      await apiClient.patch(`/api/v1/notification-templates/${t.id}`, data);
                      toast("Template updated", "success");
                      setEditingId(null);
                      loadTemplates();
                    }}
                    onCancel={() => setEditingId(null)}
                  />
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

// ─── Send log tab ────────────────────────────────────────────────

function SendLogTab() {
  const [notifications, setNotifications] = useState<NotificationRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<NotificationRow | null>(null);

  useEffect(() => {
    apiClient
      .get<{ data: NotificationRow[] }>("/api/v1/notifications", { limit: "50" })
      .then((res) => setNotifications(res.data ?? []))
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <p style={{ color: "var(--text-muted)" }}>Loading...</p>;

  if (notifications.length === 0) {
    return (
      <div style={{ padding: 32, textAlign: "center", color: "var(--text-muted)", background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: "var(--radius)" }}>
        No notifications yet. Notifications will appear here when the system sends messages via templates.
      </div>
    );
  }

  return (
    <div style={{ display: "flex", gap: 16 }}>
      <div style={{ flex: 1, background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: "var(--radius)", overflow: "hidden" }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ background: "var(--bg-elevated)" }}>
              <Th>Date</Th><Th>Event</Th><Th>Channel</Th><Th>Recipient</Th><Th>Status</Th>
            </tr>
          </thead>
          <tbody>
            {notifications.map((n) => (
              <tr
                key={n.id}
                onClick={() => setSelected(n)}
                style={{ cursor: "pointer", background: selected?.id === n.id ? "var(--bg-hover)" : "transparent", transition: "background 0.1s" }}
                onMouseEnter={(e) => { if (selected?.id !== n.id) (e.currentTarget as HTMLElement).style.background = "var(--bg-hover)"; }}
                onMouseLeave={(e) => { if (selected?.id !== n.id) (e.currentTarget as HTMLElement).style.background = "transparent"; }}
              >
                <Td>{new Date(n.createdAt).toLocaleString()}</Td>
                <Td>
                  <div style={{ fontSize: 12, fontWeight: 500 }}>{n.template?.name ?? n.eventType}</div>
                  <div style={{ fontSize: 10, color: "var(--text-muted)", fontFamily: "'JetBrains Mono', monospace" }}>{n.eventType}</div>
                </Td>
                <Td><ChannelBadge channel={n.channel.toLowerCase()} /></Td>
                <Td><span style={{ fontSize: 12, color: "var(--text-secondary)" }}>{n.recipientEmail ?? n.recipientPhone ?? "—"}</span></Td>
                <Td><StatusBadge status={statusMap[n.status] ?? n.status} /></Td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {selected && (
        <div style={{ width: 400, background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: "var(--radius)", padding: 20, flexShrink: 0 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
            <h3 style={{ fontSize: 14, fontWeight: 600, color: "var(--text-primary)", margin: 0 }}>{selected.template?.name ?? selected.eventType}</h3>
            <button onClick={() => setSelected(null)} style={{ background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer", fontSize: 16 }}>×</button>
          </div>
          <DetailField label="Status"><StatusBadge status={statusMap[selected.status] ?? selected.status} /></DetailField>
          <DetailField label="Channel">{selected.channel}</DetailField>
          <DetailField label="Recipient">{selected.recipientEmail ?? selected.recipientPhone ?? "—"}</DetailField>
          <DetailField label="Sent at">{selected.sentAt ? new Date(selected.sentAt).toLocaleString() : "—"}</DetailField>
          <DetailField label="Provider">{selected.provider ?? "—"}</DetailField>
          <DetailField label="Attempts">{selected.attempts}</DetailField>
          {selected.resolvedSubject && (
            <div style={{ marginTop: 12 }}>
              <SmallLabel>Subject</SmallLabel>
              <div style={{ fontSize: 13, color: "var(--text-primary)", fontWeight: 500 }}>{selected.resolvedSubject}</div>
            </div>
          )}
          <div style={{ marginTop: 12 }}>
            <SmallLabel>Body</SmallLabel>
            <div style={{ padding: "10px 12px", background: "var(--bg-deep)", border: "1px solid var(--border)", borderRadius: "var(--radius)", fontSize: 12, color: "var(--text-primary)", whiteSpace: "pre-wrap", lineHeight: 1.5, maxHeight: 300, overflowY: "auto" }}>
              {selected.resolvedBody}
            </div>
          </div>
          {selected.error && (
            <div style={{ marginTop: 12 }}>
              <SmallLabel>Error</SmallLabel>
              <div style={{ padding: "8px 12px", background: "var(--danger-subtle)", border: "1px solid var(--danger)", borderRadius: "var(--radius)", fontSize: 12, color: "var(--danger)" }}>{selected.error}</div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Template form ───────────────────────────────────────────────

const textareaStyle = {
  ...settingInputStyle,
  width: "100%",
  minHeight: 120,
  resize: "vertical" as const,
  fontFamily: "'JetBrains Mono', monospace",
  fontSize: 12,
  lineHeight: 1.6,
};

interface TemplateFormProps {
  initial?: NotificationTemplate;
  onSave: (data: Record<string, unknown>) => Promise<void>;
  onCancel: () => void;
}

function TemplateForm({ initial, onSave, onCancel }: TemplateFormProps) {
  const [name, setName] = useState(initial?.name ?? "");
  const [eventType, setEventType] = useState(initial?.eventType ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [emailSubject, setEmailSubject] = useState(initial?.channels.email?.subject ?? "");
  const [emailBody, setEmailBody] = useState(initial?.channels.email?.body ?? "");
  const [smsBody, setSmsBody] = useState(initial?.channels.sms?.body ?? "");
  const [isActive, setIsActive] = useState(initial?.isActive ?? true);
  const [saving, setSaving] = useState(false);
  const [activeTab, setActiveTab] = useState<"email" | "sms">("email");

  const variables = initial?.variables ?? [];
  const sampleVars: Record<string, string> = {};
  for (const v of variables) sampleVars[v.key] = v.sample || `{{${v.key}}}`;

  function renderPreview(text: string): string {
    return text.replace(/\{\{([^}]+)\}\}/g, (_, key: string) => sampleVars[key.trim()] ?? `{{${key.trim()}}}`);
  }

  async function handleSave() {
    setSaving(true);
    try {
      const channels: Record<string, unknown> = {};
      if (emailBody.trim()) channels.email = { subject: emailSubject, body: emailBody };
      if (smsBody.trim()) channels.sms = { body: smsBody };
      await onSave({
        ...(initial ? {} : { eventType }),
        name,
        description: description || undefined,
        channels,
        isActive,
      });
    } catch (err) {
      console.error(err);
    } finally {
      setSaving(false);
    }
  }

  const previewBody = activeTab === "email" ? renderPreview(emailBody) : renderPreview(smsBody);
  const previewSubject = emailSubject ? renderPreview(emailSubject) : "";

  return (
    <div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 16 }}>
        <div>
          <SmallLabel>Name</SmallLabel>
          <input style={{ ...settingInputStyle, width: "100%" }} value={name} onChange={(e) => setName(e.target.value)} placeholder="Past Due Reminder" />
        </div>
        <div>
          <SmallLabel>Event type</SmallLabel>
          <input style={{ ...settingInputStyle, width: "100%", fontFamily: "'JetBrains Mono', monospace", fontSize: 12 }} value={eventType} onChange={(e) => setEventType(e.target.value)} placeholder="delinquency.tier_1" disabled={!!initial} />
        </div>
      </div>
      <div style={{ marginBottom: 16 }}>
        <SmallLabel>Description</SmallLabel>
        <input style={{ ...settingInputStyle, width: "100%" }} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What this template is for..." />
      </div>

      <div style={{ display: "flex", gap: 2, marginBottom: 12 }}>
        {(["email", "sms"] as const).map((tab) => (
          <button key={tab} onClick={() => setActiveTab(tab)} style={{
            padding: "6px 14px", fontSize: 12, fontWeight: activeTab === tab ? 600 : 500,
            borderRadius: "var(--radius)", border: activeTab === tab ? "1px solid var(--accent-primary)" : "1px solid var(--border)",
            background: activeTab === tab ? "var(--accent-primary-subtle)" : "var(--bg-card)",
            color: activeTab === tab ? "var(--accent-primary-hover)" : "var(--text-secondary)",
            cursor: "pointer", fontFamily: "inherit", textTransform: "uppercase", letterSpacing: "0.06em",
          }}>
            {tab}
          </button>
        ))}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 16 }}>
        <div>
          {activeTab === "email" && (
            <>
              <SmallLabel>Subject</SmallLabel>
              <input style={{ ...settingInputStyle, width: "100%", marginBottom: 8 }} value={emailSubject} onChange={(e) => setEmailSubject(e.target.value)} placeholder="Past due notice — Account {{account.accountNumber}}" />
              <SmallLabel>Body</SmallLabel>
              <textarea style={textareaStyle} value={emailBody} onChange={(e) => setEmailBody(e.target.value)} placeholder="Dear {{customer.firstName}},..." />
            </>
          )}
          {activeTab === "sms" && (
            <>
              <SmallLabel>Body <span style={{ fontWeight: 400, color: "var(--text-muted)" }}>({smsBody.length}/160)</span></SmallLabel>
              <textarea style={{ ...textareaStyle, minHeight: 80 }} value={smsBody} onChange={(e) => setSmsBody(e.target.value)} placeholder="{{customer.firstName}}, your account..." />
            </>
          )}
        </div>
        <div>
          <SmallLabel>Preview</SmallLabel>
          <div style={{ padding: "12px 14px", background: "var(--bg-deep)", border: "1px solid var(--border)", borderRadius: "var(--radius)", fontSize: 12, color: "var(--text-primary)", whiteSpace: "pre-wrap", lineHeight: 1.6, minHeight: 120 }}>
            {activeTab === "email" && previewSubject && (
              <div style={{ fontWeight: 600, marginBottom: 8, paddingBottom: 8, borderBottom: "1px solid var(--border-subtle)" }}>{previewSubject}</div>
            )}
            {previewBody || <span style={{ color: "var(--text-muted)", fontStyle: "italic" }}>Start typing to see preview...</span>}
          </div>
        </div>
      </div>

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "var(--text-secondary)", cursor: "pointer" }}>
          <input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} style={{ width: 16, height: 16, accentColor: "var(--accent-primary)" }} />
          Active
        </label>
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={onCancel} style={{ padding: "8px 16px", fontSize: 13, background: "transparent", border: "1px solid var(--border)", borderRadius: "var(--radius)", color: "var(--text-secondary)", cursor: "pointer", fontFamily: "inherit" }}>Cancel</button>
          <button onClick={handleSave} disabled={saving || !name || !eventType} style={{
            padding: "8px 20px", fontSize: 13, fontWeight: 600,
            background: saving || !name || !eventType ? "var(--bg-elevated)" : "var(--accent-primary)",
            color: saving || !name || !eventType ? "var(--text-muted)" : "#fff",
            border: "none", borderRadius: "var(--radius)",
            cursor: saving || !name || !eventType ? "not-allowed" : "pointer", fontFamily: "inherit",
          }}>
            {saving ? "Saving..." : initial ? "Update" : "Create"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Shared helpers ──────────────────────────────────────────────

function ChannelBadge({ channel }: { channel: string }) {
  return (
    <span style={{
      padding: "1px 6px", borderRadius: 999, fontSize: 9, fontWeight: 600,
      textTransform: "uppercase", letterSpacing: "0.06em",
      background: channel === "email" ? "var(--info-subtle)" : "var(--accent-tertiary-subtle)",
      color: channel === "email" ? "var(--info)" : "var(--accent-tertiary)",
      border: `1px solid ${channel === "email" ? "var(--info)" : "var(--accent-tertiary)"}`,
    }}>
      {channel}
    </span>
  );
}

function DetailField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "6px 0", borderBottom: "1px solid var(--border-subtle)", fontSize: 12 }}>
      <span style={{ color: "var(--text-muted)" }}>{label}</span>
      <span style={{ color: "var(--text-primary)" }}>{children}</span>
    </div>
  );
}

function SmallLabel({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-muted)", marginBottom: 4, textTransform: "uppercase", letterSpacing: "0.06em" }}>
      {children}
    </div>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return <th style={{ padding: "10px 16px", textAlign: "left", fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--text-muted)", borderBottom: "1px solid var(--border)", whiteSpace: "nowrap" }}>{children}</th>;
}

function Td({ children }: { children: React.ReactNode }) {
  return <td style={{ padding: "10px 16px", fontSize: 13, color: "var(--text-primary)", borderBottom: "1px solid var(--border-subtle)", whiteSpace: "nowrap" }}>{children}</td>;
}
