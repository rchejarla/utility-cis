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
  /*
   * Closed by default, like `AttachmentsTab`'s upload form. With the
   * box always open the tab was a compose area with a list bolted
   * under it; the common act on this tab is reading what is already
   * there.
   */
  const [composing, setComposing] = useState(false);
  /*
   * Which notes are shown in full. The list collapses each to one line
   * so it stays scannable, and a note is useless truncated — "stop tap
   * is under the driveway slab, not at the boundary" puts the point at
   * the end — so the full text has to be one click away rather than
   * gone. A Set, because reading two notes side by side is the normal
   * way to catch up on a record.
   */
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

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
      setComposing(false);
      await refresh();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Could not add the note", "error");
    } finally {
      setSaving(false);
    }
  };


  const toggle = (noteId: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(noteId)) next.delete(noteId);
      else next.add(noteId);
      return next;
    });

  const withdraw = async (noteId: string) => {
    try {
      await apiClient.delete(`${path}/${noteId}`);
      await refresh();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Could not remove the note", "error");
    }
  };

  /*
   * **One card, and a button rather than a standing form.**
   *
   * `AttachmentsTab` reads as a single panel because by default it is
   * only a list — its upload form appears after "+ Upload". This tab
   * followed the opposite shape for three revisions: a compose box
   * always open, with the list bolted underneath, which read as two
   * stacked panels however the borders were arranged. The common act
   * here is reading what is already on the record; writing is
   * occasional.
   */
  return (
    <div
      data-testid="notes-panel"
      style={{
        background: "var(--bg-card)",
        border: "1px solid var(--border)",
        borderRadius: "var(--radius)",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "8px",
          padding: "14px 18px",
        }}
      >
        {composing ? (
          <>
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="What happened, or what you were told."
              rows={3}
              autoFocus
              style={{
                width: "100%",
                padding: "10px 12px",
                /*
                 * `--bg-deep`, not `--bg-elevated`. The tokens are
                 * ordered — deep is darker than card, elevated is
                 * lighter — so filling an input with the lighter one
                 * makes it read as a raised panel sitting on the card.
                 * An input inside a card is a recessed well;
                 * `attachments-tab.tsx`'s `inputStyle` is the
                 * convention.
                 */
                background: "var(--bg-deep)",
                border: "1px solid var(--border)",
                borderRadius: "var(--radius)",
                color: "var(--text-primary)",
                fontSize: "13px",
                fontFamily: "inherit",
                resize: "vertical",
                boxSizing: "border-box",
              }}
            />
            <div style={{ display: "flex", justifyContent: "flex-end", gap: "8px" }}>
              <button
                type="button"
                onClick={() => {
                  setComposing(false);
                  setDraft("");
                }}
                style={{
                  padding: "8px 16px",
                  borderRadius: "var(--radius)",
                  background: "transparent",
                  color: "var(--text-secondary)",
                  border: "1px solid var(--border)",
                  fontSize: "13px",
                  fontWeight: 500,
                  cursor: "pointer",
                  fontFamily: "inherit",
                }}
              >
                Cancel
              </button>
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
                    draft.trim() === ""
                      ? "1px solid var(--border)"
                      : "1px solid var(--accent-primary)",
                  fontSize: "13px",
                  fontWeight: 500,
                  cursor: draft.trim() === "" ? "default" : "pointer",
                  fontFamily: "inherit",
                }}
              >
                {saving ? "Adding…" : "Save note"}
              </button>
            </div>
          </>
        ) : (
          /* Top right, above the list — where an action on a panel
             belongs, and where `AttachmentsTab` puts "+ Upload". */
          <div style={{ display: "flex", justifyContent: "flex-end" }}>
            <button
              type="button"
              onClick={() => setComposing(true)}
              style={{
                padding: "8px 16px",
                borderRadius: "var(--radius)",
                background: "transparent",
                color: "var(--accent-primary)",
                border: "1px solid var(--accent-primary)",
                fontSize: "13px",
                fontWeight: 500,
                cursor: "pointer",
                fontFamily: "inherit",
              }}
            >
              Add note
            </button>
          </div>
        )}
      </div>

      {/*
        * No rule and no padded block when there is nothing to list: a
        * full-width line with an empty region under it split the one
        * card into two visual halves, which is what read as two cards
        * through three reports. With notes the rule is a list header and
        * earns its place.
        */}
      {loading ? (
        <div style={{ padding: "0 18px 14px", color: "var(--text-muted)", fontSize: "13px" }}>
          Loading notes…
        </div>
      ) : notes.length === 0 ? (
        <div style={{ padding: "0 18px 14px", color: "var(--text-muted)", fontSize: "13px" }}>
          No notes on this record yet.
        </div>
      ) : (
        <div style={{ borderTop: "1px solid var(--border)" }}>
          {notes.map((n, i) => (
            <div
              key={n.id}
              style={{
                display: "flex",
                alignItems: "flex-start",
                gap: "12px",
                padding: "14px 18px",
                borderTop: i === 0 ? "none" : "1px solid var(--border-subtle)",
              }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                {/*
                  * One line until asked. A list of three-line notes is
                  * a wall of text that nobody scans, and the dates and
                  * authors — the part you navigate by — get pushed
                  * apart. Collapsed uses `nowrap` with an ellipsis
                  * rather than a character count, so the cut lands
                  * where the column actually ends instead of at an
                  * arbitrary letter that is wrong at every width.
                  */}
                <div
                  data-testid="note-body"
                  onClick={() => toggle(n.id)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      toggle(n.id);
                    }
                  }}
                  title={expanded.has(n.id) ? "Show less" : n.body}
                  style={{
                    fontSize: "13px",
                    color: "var(--text-primary)",
                    lineHeight: 1.55,
                    cursor: "pointer",
                    ...(expanded.has(n.id)
                      ? { whiteSpace: "pre-wrap" }
                      : {
                          whiteSpace: "nowrap",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                        }),
                  }}
                >
                  {n.body}
                </div>
                <div style={{ marginTop: "8px", fontSize: "12px", color: "var(--text-muted)" }}>
                  {n.authorName} · {new Date(n.createdAt).toLocaleString()}
                </div>
              </div>
              {/*
                * Withdrawing is soft on the server — the row keeps
                * `deletedAt` and `deletedBy` — so this removes the note
                * from the record without erasing the fact that it was
                * written. No confirmation dialog: the act is reversible
                * in the database and the alternative, a modal on every
                * stray note, is the kind of friction that trains people
                * to click through.
                */}
              <button
                type="button"
                onClick={() => withdraw(n.id)}
                aria-label="Remove note"
                title="Remove this note"
                style={{
                  padding: "4px 8px",
                  background: "transparent",
                  border: "none",
                  color: "var(--text-muted)",
                  fontSize: "12px",
                  cursor: "pointer",
                  fontFamily: "inherit",
                  flexShrink: 0,
                }}
              >
                Remove
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
