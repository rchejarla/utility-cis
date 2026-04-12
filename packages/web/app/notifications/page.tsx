"use client";

import { useEffect, useState } from "react";
import { PageHeader } from "@/components/ui/page-header";
import { StatusBadge } from "@/components/ui/status-badge";
import { apiClient } from "@/lib/api-client";
import { usePermission } from "@/lib/use-permission";
import { AccessDenied } from "@/components/ui/access-denied";

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

const statusMap: Record<string, string> = {
  PENDING: "Pending",
  SENDING: "Active",
  SENT: "Active",
  FAILED: "Suspended",
};

export default function NotificationLogPage() {
  const { canView } = usePermission("notifications");
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

  if (!canView) return <AccessDenied />;

  return (
    <div>
      <PageHeader
        title="Notification Log"
        subtitle="All sent, pending, and failed notifications"
      />

      {loading ? (
        <p style={{ color: "var(--text-muted)" }}>Loading...</p>
      ) : notifications.length === 0 ? (
        <div
          style={{
            padding: 32,
            textAlign: "center",
            color: "var(--text-muted)",
            background: "var(--bg-card)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius)",
          }}
        >
          No notifications yet. Notifications will appear here when the system sends messages via templates.
        </div>
      ) : (
        <div style={{ display: "flex", gap: 16 }}>
          {/* List */}
          <div
            style={{
              flex: 1,
              background: "var(--bg-card)",
              border: "1px solid var(--border)",
              borderRadius: "var(--radius)",
              overflow: "hidden",
            }}
          >
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ background: "var(--bg-elevated)" }}>
                  <Th>Date</Th>
                  <Th>Event</Th>
                  <Th>Channel</Th>
                  <Th>Recipient</Th>
                  <Th>Status</Th>
                </tr>
              </thead>
              <tbody>
                {notifications.map((n) => (
                  <tr
                    key={n.id}
                    onClick={() => setSelected(n)}
                    style={{
                      cursor: "pointer",
                      background: selected?.id === n.id ? "var(--bg-hover)" : "transparent",
                      transition: "background 0.1s",
                    }}
                    onMouseEnter={(e) => {
                      if (selected?.id !== n.id) (e.currentTarget as HTMLElement).style.background = "var(--bg-hover)";
                    }}
                    onMouseLeave={(e) => {
                      if (selected?.id !== n.id) (e.currentTarget as HTMLElement).style.background = "transparent";
                    }}
                  >
                    <Td>{new Date(n.createdAt).toLocaleString()}</Td>
                    <Td>
                      <div style={{ fontSize: 12, fontWeight: 500 }}>{n.template?.name ?? n.eventType}</div>
                      <div style={{ fontSize: 10, color: "var(--text-muted)", fontFamily: "'JetBrains Mono', monospace" }}>{n.eventType}</div>
                    </Td>
                    <Td>
                      <span
                        style={{
                          padding: "1px 6px",
                          borderRadius: 999,
                          fontSize: 9,
                          fontWeight: 600,
                          textTransform: "uppercase",
                          background: n.channel === "EMAIL" ? "var(--info-subtle)" : "var(--accent-tertiary-subtle)",
                          color: n.channel === "EMAIL" ? "var(--info)" : "var(--accent-tertiary)",
                          border: `1px solid ${n.channel === "EMAIL" ? "var(--info)" : "var(--accent-tertiary)"}`,
                        }}
                      >
                        {n.channel}
                      </span>
                    </Td>
                    <Td>
                      <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>
                        {n.recipientEmail ?? n.recipientPhone ?? "—"}
                      </span>
                    </Td>
                    <Td><StatusBadge status={statusMap[n.status] ?? n.status} /></Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Detail panel */}
          {selected && (
            <div
              style={{
                width: 400,
                background: "var(--bg-card)",
                border: "1px solid var(--border)",
                borderRadius: "var(--radius)",
                padding: "20px",
                flexShrink: 0,
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
                <h3 style={{ fontSize: 14, fontWeight: 600, color: "var(--text-primary)", margin: 0 }}>
                  {selected.template?.name ?? selected.eventType}
                </h3>
                <button
                  onClick={() => setSelected(null)}
                  style={{ background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer", fontSize: 16 }}
                >
                  ×
                </button>
              </div>

              <Field label="Status"><StatusBadge status={statusMap[selected.status] ?? selected.status} /></Field>
              <Field label="Channel">{selected.channel}</Field>
              <Field label="Recipient">{selected.recipientEmail ?? selected.recipientPhone ?? "—"}</Field>
              <Field label="Sent at">{selected.sentAt ? new Date(selected.sentAt).toLocaleString() : "—"}</Field>
              <Field label="Provider">{selected.provider ?? "—"}</Field>
              <Field label="Attempts">{selected.attempts}</Field>

              {selected.resolvedSubject && (
                <div style={{ marginTop: 12 }}>
                  <Label>Subject</Label>
                  <div style={{ fontSize: 13, color: "var(--text-primary)", fontWeight: 500 }}>{selected.resolvedSubject}</div>
                </div>
              )}

              <div style={{ marginTop: 12 }}>
                <Label>Body</Label>
                <div
                  style={{
                    padding: "10px 12px",
                    background: "var(--bg-deep)",
                    border: "1px solid var(--border)",
                    borderRadius: "var(--radius)",
                    fontSize: 12,
                    color: "var(--text-primary)",
                    whiteSpace: "pre-wrap",
                    lineHeight: 1.5,
                    maxHeight: 300,
                    overflowY: "auto",
                  }}
                >
                  {selected.resolvedBody}
                </div>
              </div>

              {selected.error && (
                <div style={{ marginTop: 12 }}>
                  <Label>Error</Label>
                  <div style={{ padding: "8px 12px", background: "var(--danger-subtle)", border: "1px solid var(--danger)", borderRadius: "var(--radius)", fontSize: 12, color: "var(--danger)" }}>
                    {selected.error}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "6px 0", borderBottom: "1px solid var(--border-subtle)", fontSize: 12 }}>
      <span style={{ color: "var(--text-muted)" }}>{label}</span>
      <span style={{ color: "var(--text-primary)" }}>{children}</span>
    </div>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ fontSize: 10, fontWeight: 600, color: "var(--text-muted)", marginBottom: 4, textTransform: "uppercase", letterSpacing: "0.06em" }}>
      {children}
    </div>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th style={{ padding: "10px 16px", textAlign: "left", fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--text-muted)", borderBottom: "1px solid var(--border)", whiteSpace: "nowrap" }}>
      {children}
    </th>
  );
}

function Td({ children }: { children: React.ReactNode }) {
  return (
    <td style={{ padding: "10px 16px", fontSize: 13, color: "var(--text-primary)", borderBottom: "1px solid var(--border-subtle)", whiteSpace: "nowrap" }}>
      {children}
    </td>
  );
}
