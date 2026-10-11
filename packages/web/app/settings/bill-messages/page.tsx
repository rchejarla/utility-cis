"use client";

import { useCallback, useEffect, useState } from "react";
import { apiClient } from "@/lib/api-client";
import { SettingsSection, SettingsCard } from "@/components/settings/settings-shell";
import { useToast } from "@/components/ui/toast";
import { usePermission } from "@/lib/use-permission";
import { AccessDenied } from "@/components/ui/access-denied";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";

/**
 * Managing the text printed on bills.
 *
 * Gated on `settings` rather than `accounts`, matching the API: bill
 * text is tenant configuration, and editing it should not require the
 * authority to read every account.
 *
 * The window is the only switch. There is no active/inactive flag,
 * because a message with a date range and a separate on/off control can
 * contradict itself, and then nobody can say what a bill will carry.
 */

interface BillMessageRow {
  id: string;
  label: string;
  body: string;
  accountTypeDefId: string | null;
  commodityId: string | null;
  priority: number;
  activeFrom: string;
  activeTo: string | null;
}

interface AccountTypeDef {
  id: string;
  code: string;
  label: string;
}

interface Commodity {
  id: string;
  code: string;
  name: string;
}

type Draft = {
  label: string;
  body: string;
  accountTypeDefId: string;
  commodityId: string;
  priority: string;
  activeFrom: string;
  activeTo: string;
};

const EMPTY_DRAFT: Draft = {
  label: "",
  body: "",
  accountTypeDefId: "",
  commodityId: "",
  priority: "100",
  activeFrom: new Date().toISOString().slice(0, 10),
  activeTo: "",
};

export default function BillMessagesPage() {
  const { toast } = useToast();
  const { canView, canEdit, canDelete } = usePermission("settings");

  const [rows, setRows] = useState<BillMessageRow[]>([]);
  const [types, setTypes] = useState<AccountTypeDef[]>([]);
  const [commodities, setCommodities] = useState<Commodity[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [saving, setSaving] = useState(false);
  const [deleteRow, setDeleteRow] = useState<BillMessageRow | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [m, t, c] = await Promise.all([
        apiClient.get<{ data: BillMessageRow[] }>("/api/v1/bill-messages"),
        apiClient
          .get<{ data: AccountTypeDef[] }>("/api/v1/account-types")
          .then((r) => r.data ?? [])
          .catch(() => [] as AccountTypeDef[]),
        apiClient
          .get<{ data: Commodity[] }>("/api/v1/commodities", { limit: "200" })
          .then((r) => r.data ?? [])
          .catch(() => [] as Commodity[]),
      ]);
      setRows(m.data ?? []);
      setTypes(t);
      setCommodities(c);
    } catch (err) {
      toast(err instanceof Error ? err.message : "Could not load bill messages", "error");
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!canView) return <AccessDenied />;

  function startNew() {
    setDraft(EMPTY_DRAFT);
    setEditing("new");
  }

  function startEdit(row: BillMessageRow) {
    setDraft({
      label: row.label,
      body: row.body,
      accountTypeDefId: row.accountTypeDefId ?? "",
      commodityId: row.commodityId ?? "",
      priority: String(row.priority),
      activeFrom: row.activeFrom.slice(0, 10),
      activeTo: row.activeTo ? row.activeTo.slice(0, 10) : "",
    });
    setEditing(row.id);
  }

  async function submit() {
    setSaving(true);
    // An empty select means "all", which the API spells as null — an
    // empty string would be rejected as a malformed uuid.
    const body = {
      label: draft.label.trim(),
      body: draft.body.trim(),
      accountTypeDefId: draft.accountTypeDefId || null,
      commodityId: draft.commodityId || null,
      priority: Number(draft.priority) || 100,
      activeFrom: draft.activeFrom,
      activeTo: draft.activeTo || null,
    };
    try {
      if (editing === "new") {
        await apiClient.post("/api/v1/bill-messages", body);
        toast("Bill message added", "success");
      } else if (editing) {
        await apiClient.patch(`/api/v1/bill-messages/${editing}`, body);
        toast("Bill message updated", "success");
      }
      setEditing(null);
      await load();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Could not save the message", "error");
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!deleteRow) return;
    try {
      await apiClient.delete(`/api/v1/bill-messages/${deleteRow.id}`);
      toast(`“${deleteRow.label}” deleted`, "success");
      setDeleteRow(null);
      await load();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Could not delete the message", "error");
    }
  }

  const typeName = (id: string | null) =>
    id ? (types.find((t) => t.id === id)?.label ?? "—") : "All";
  const commodityName = (id: string | null) =>
    id ? (commodities.find((c) => c.id === id)?.name ?? "—") : "All";

  return (
    <SettingsSection title="Bill Messages" description={DESCRIPTION}>
      {loading ? (
        <p style={{ color: "var(--text-muted)", padding: "24px 0" }}>Loading…</p>
      ) : (
        <>
          <SettingsCard padded={false}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  <th style={th}>Label</th>
                  <th style={th}>Message</th>
                  <th style={th}>Account type</th>
                  <th style={th}>Service</th>
                  <th style={{ ...th, textAlign: "right" }}>Priority</th>
                  <th style={th}>Shown</th>
                  {(canEdit || canDelete) && <th style={th} aria-label="Actions" />}
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 ? (
                  <tr>
                    <td colSpan={7} style={{ ...td, textAlign: "center", color: "var(--text-muted)" }}>
                      No bill messages. Bills print without any extra text.
                    </td>
                  </tr>
                ) : (
                  rows.map((r) => (
                    <tr key={r.id}>
                      <td style={{ ...td, fontWeight: 600 }}>{r.label}</td>
                      <td style={{ ...td, color: "var(--text-secondary)", maxWidth: 320 }}>
                        {r.body.length > 90 ? `${r.body.slice(0, 90)}…` : r.body}
                      </td>
                      <td style={td}>{typeName(r.accountTypeDefId)}</td>
                      <td style={td}>{commodityName(r.commodityId)}</td>
                      <td style={{ ...td, textAlign: "right" }}>{r.priority}</td>
                      <td style={{ ...td, fontSize: 12, color: "var(--text-muted)" }}>
                        {r.activeFrom.slice(0, 10)} →{" "}
                        {r.activeTo ? r.activeTo.slice(0, 10) : "no end"}
                      </td>
                      {(canEdit || canDelete) && (
                        <td style={{ ...td, textAlign: "right", whiteSpace: "nowrap" }}>
                          {canEdit && (
                            <button onClick={() => startEdit(r)} style={linkBtn}>
                              Edit
                            </button>
                          )}
                          {canDelete && (
                            <button
                              onClick={() => setDeleteRow(r)}
                              style={{ ...linkBtn, marginLeft: 10 }}
                            >
                              Delete
                            </button>
                          )}
                        </td>
                      )}
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </SettingsCard>

          {canEdit && editing === null && (
            <button onClick={startNew} style={addBtn}>
              + Add a bill message
            </button>
          )}

          {editing !== null && (
            <div style={{ marginTop: 20 }}>
              <SettingsCard>
                <Field label="Label" hint="Names the message for staff; it is not printed on the bill.">
                  <input
                    style={input}
                    value={draft.label}
                    aria-label="Label"
                    onChange={(e) => setDraft({ ...draft, label: e.target.value })}
                  />
                </Field>
                <Field label="Message" hint="The text printed on the bill.">
                  <textarea
                    style={{ ...input, height: 90, resize: "vertical" }}
                    value={draft.body}
                    aria-label="Message"
                    onChange={(e) => setDraft({ ...draft, body: e.target.value })}
                  />
                </Field>
                <Field label="Account type" hint="Leave as All to print on every account type.">
                  <select
                    style={input}
                    value={draft.accountTypeDefId}
                    aria-label="Account type"
                    onChange={(e) => setDraft({ ...draft, accountTypeDefId: e.target.value })}
                  >
                    <option value="">All</option>
                    {types.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.label}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Service" hint="Leave as All to print regardless of the services billed.">
                  <select
                    style={input}
                    value={draft.commodityId}
                    aria-label="Service"
                    onChange={(e) => setDraft({ ...draft, commodityId: e.target.value })}
                  >
                    <option value="">All</option>
                    {commodities.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Priority" hint="Lower prints first. Messages with the same priority sort by label.">
                  <input
                    type="number"
                    min={0}
                    max={10000}
                    style={{ ...input, width: 120, textAlign: "right" }}
                    value={draft.priority}
                    aria-label="Priority"
                    onChange={(e) => setDraft({ ...draft, priority: e.target.value })}
                  />
                </Field>
                <Field
                  label="Shown from"
                  hint="Matched against each bill's own bill date, not today — so reprinting an old bill reproduces the messages it carried."
                >
                  <input
                    type="date"
                    style={{ ...input, width: 180 }}
                    value={draft.activeFrom}
                    aria-label="Shown from"
                    onChange={(e) => setDraft({ ...draft, activeFrom: e.target.value })}
                  />
                </Field>
                <Field label="Shown until" hint="Leave empty to print indefinitely.">
                  <input
                    type="date"
                    style={{ ...input, width: 180 }}
                    value={draft.activeTo}
                    aria-label="Shown until"
                    onChange={(e) => setDraft({ ...draft, activeTo: e.target.value })}
                  />
                </Field>

                <div style={{ display: "flex", gap: 10, paddingTop: 14 }}>
                  <button
                    onClick={() => void submit()}
                    disabled={saving || draft.label.trim() === "" || draft.body.trim() === ""}
                    style={primaryBtn(saving || draft.label.trim() === "" || draft.body.trim() === "")}
                  >
                    {saving ? "Saving…" : editing === "new" ? "Add message" : "Save changes"}
                  </button>
                  <button onClick={() => setEditing(null)} style={mutedBtn}>
                    Cancel
                  </button>
                </div>
              </SettingsCard>
            </div>
          )}
        </>
      )}

      {deleteRow && (
        <ConfirmDialog
          title={`Delete “${deleteRow.label}”?`}
          message={
            "Bills already produced keep the text they were printed with — a stored PDF is not re-rendered. " +
            "Bills produced from now on will not carry this message."
          }
          confirmLabel="Delete"
          onConfirm={() => void remove()}
          onCancel={() => setDeleteRow(null)}
        />
      )}
    </SettingsSection>
  );
}

const DESCRIPTION =
  "Text printed on bills, targeted by account type and service over a date window. Each bill picks up every message whose window contains its own bill date.";

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div style={{ padding: "12px 0", borderBottom: "1px solid var(--border-subtle)" }}>
      <label style={{ display: "block", fontSize: 13, fontWeight: 600, marginBottom: 4 }}>
        {label}
      </label>
      {hint && (
        <p style={{ fontSize: 12, color: "var(--text-muted)", margin: "0 0 8px", lineHeight: 1.5 }}>
          {hint}
        </p>
      )}
      {children}
    </div>
  );
}

const th: React.CSSProperties = {
  textAlign: "left",
  padding: "8px 12px",
  fontSize: 11,
  fontWeight: 600,
  color: "var(--text-muted)",
  textTransform: "uppercase",
  letterSpacing: "0.06em",
  borderBottom: "1px solid var(--border)",
  background: "var(--bg-elevated)",
  whiteSpace: "nowrap",
};

const td: React.CSSProperties = {
  padding: "8px 12px",
  fontSize: 13,
  color: "var(--text-primary)",
  borderBottom: "1px solid var(--border-subtle)",
  verticalAlign: "middle",
};

const input: React.CSSProperties = {
  width: "100%",
  maxWidth: 420,
  padding: "6px 10px",
  fontSize: 13,
  background: "var(--bg-surface)",
  border: "1px solid var(--border)",
  borderRadius: 6,
  color: "var(--text-primary)",
  fontFamily: "inherit",
  outline: "none",
};

const linkBtn: React.CSSProperties = {
  padding: 0,
  fontSize: 12,
  background: "none",
  border: "none",
  color: "var(--accent-primary)",
  textDecoration: "underline",
  cursor: "pointer",
  fontFamily: "inherit",
};

const addBtn: React.CSSProperties = {
  marginTop: 16,
  padding: "6px 12px",
  fontSize: 13,
  background: "var(--bg-surface)",
  border: "1px solid var(--border)",
  borderRadius: 6,
  color: "var(--text-primary)",
  cursor: "pointer",
  fontFamily: "inherit",
};

const mutedBtn: React.CSSProperties = {
  padding: "6px 12px",
  fontSize: 13,
  background: "transparent",
  border: "1px solid var(--border)",
  borderRadius: 6,
  color: "var(--text-muted)",
  cursor: "pointer",
  fontFamily: "inherit",
};

const primaryBtn = (disabled: boolean): React.CSSProperties => ({
  padding: "6px 14px",
  fontSize: 13,
  fontWeight: 600,
  background: "var(--accent-primary)",
  color: "#fff",
  border: "none",
  borderRadius: 6,
  cursor: disabled ? "default" : "pointer",
  opacity: disabled ? 0.6 : 1,
  fontFamily: "inherit",
});
