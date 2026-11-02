"use client";

import { useCallback, useEffect, useState } from "react";
import { apiClient } from "@/lib/api-client";
import { useToast } from "@/components/ui/toast";

/**
 * Notes on a record: a dated remark a staff member attaches to
 * something.
 *
 * **Append-only, and the panel says so by what it lacks.** There is no
 * pencil and no bin, because the API has no update and no delete — a
 * note records that somebody observed something at a time, and an
 * editable note records nothing in particular. A mistake is corrected
 * by adding another note, as in a paper file.
 *
 * The author and the time are as much the note as the body is: an
 * unattributed remark is gossip. Newest first, because the latest
 * remark is the one that changes what the reader does next.
 *
 * Spec 28's OVL-T-3 is what forced it — a mirrored record is read-only
 * in overlay mode, and the refusal tells a CSR to add a note instead —
 * but this is not an overlay panel. It is on every record in both
 * modes, because recording a conversation is ordinary CIS work.
 */

/** URL segment of the host entity, which also picks the permission. */
export type NoteSubject =
  | "customers"
  | "premises"
  | "meters"
  | "accounts"
  | "service-agreements";

interface Note {
  id: string;
  body: string;
  authorName: string;
  createdAt: string;
}

export function NotesTab({
  subject,
  entityId,
}: {
  subject: NoteSubject;
  entityId: string;
}) {
  const { toast } = useToast();
  const [notes, setNotes] = useState<Note[]>([]);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);

  const path = `/api/v1/${subject}/${entityId}/notes`;

  const refresh = useCallback(async () => {
    try {
      setNotes(await apiClient.get<Note[]>(path));
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }, [path]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const add = async () => {
    const body = draft.trim();
    // Whitespace is not a note: the API refuses it and the database has
    // a CHECK behind that, so there is nothing to send.
    if (!body || saving) return;
    setSaving(true);
    try {
      await apiClient.post(path, { body });
      setDraft("");
      await refresh();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Could not add the note", "error");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "8px",
          background: "var(--bg-card)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius)",
          padding: "16px 20px",
        }}
      >
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="What happened, or what you were told."
          rows={3}
          style={{
            width: "100%",
            padding: "10px 12px",
            background: "var(--bg-elevated)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius)",
            color: "var(--text-primary)",
            fontSize: "13px",
            fontFamily: "inherit",
            resize: "vertical",
          }}
        />
        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <button
            type="button"
            onClick={add}
            disabled={saving || draft.trim() === ""}
            style={{
              padding: "8px 16px",
              borderRadius: "var(--radius)",
              background: draft.trim() === "" ? "transparent" : "var(--accent-primary)",
              color: draft.trim() === "" ? "var(--text-muted)" : "#fff",
              border:
                draft.trim() === "" ? "1px solid var(--border)" : "1px solid var(--accent-primary)",
              fontSize: "13px",
              fontWeight: 500,
              cursor: draft.trim() === "" ? "default" : "pointer",
              fontFamily: "inherit",
            }}
          >
            {saving ? "Adding…" : "Add note"}
          </button>
        </div>
      </div>

      {/*
        * One card around the list, as `AttachmentsTab` draws, with the
        * loading and empty states inside it: a panel with nothing in it
        * is still a panel, and a card that appeared only once there was
        * content would be the odd half of the same inconsistency.
        */}
      <div
        data-testid="notes-panel"
        style={{
          background: "var(--bg-card)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius)",
          overflow: "hidden",
        }}
      >
        {loading ? (
          <div
            style={{
              padding: "32px",
              textAlign: "center",
              color: "var(--text-muted)",
              fontSize: "13px",
            }}
          >
            Loading notes…
          </div>
        ) : notes.length === 0 ? (
          <div
            style={{
              padding: "40px",
              textAlign: "center",
              color: "var(--text-muted)",
              fontSize: "13px",
            }}
          >
            No notes on this record yet.
          </div>
        ) : (
          notes.map((n, i) => (
            <div
              key={n.id}
              style={{
                padding: "14px 18px",
                borderTop: i === 0 ? "none" : "1px solid var(--border-subtle)",
              }}
            >
              <div
                data-testid="note-body"
                style={{
                  fontSize: "13px",
                  color: "var(--text-primary)",
                  lineHeight: 1.55,
                  whiteSpace: "pre-wrap",
                }}
              >
                {n.body}
              </div>
              <div
                style={{
                  marginTop: "8px",
                  fontSize: "12px",
                  color: "var(--text-muted)",
                }}
              >
                {n.authorName} · {new Date(n.createdAt).toLocaleString()}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
