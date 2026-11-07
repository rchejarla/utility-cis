"use client";

import { useState } from "react";
import { DayStrip, timeLabel, type StripPeriod, type StripSpan } from "./day-strip";

/**
 * One (season, day type)'s hours: a short list of `from – to → period`
 * rows, with the 96-quarter strip above them as the proof they tile the
 * day (spec 26, TOU-UI-1).
 *
 * Saved as a whole list, which is what the API takes. Every invariant
 * belongs to the list rather than the row — the rows must tile the day
 * exactly once — so a per-row save would make every intermediate state
 * invalid and reduce the strip to decoration.
 */

export interface SpanGroup {
  seasonCode: string;
  dayTypeCode: string;
  spans: StripSpan[];
}

/**
 * Times are chosen from the quarter-hours rather than typed.
 *
 * TOU-CAL-1 is 15-minute granularity, so a free-text field can only
 * produce values the server will refuse — and "16:07" refused after a
 * save is a worse way to learn the rule than never being able to say
 * it.
 */
const QUARTER_HOURS = Array.from({ length: 97 }, (_, i) => i * 15);

const selectStyle = {
  padding: "4px 6px",
  borderRadius: "var(--radius)",
  border: "1px solid var(--border)",
  background: "var(--bg-elevated)",
  color: "var(--text-primary)",
  fontSize: "12px",
  fontFamily: "monospace",
};

const secondaryButton = {
  padding: "5px 12px",
  borderRadius: "var(--radius)",
  border: "1px solid var(--border)",
  background: "transparent",
  color: "var(--text-secondary)",
  fontSize: "12px",
  cursor: "pointer",
  fontFamily: "inherit",
};

const primaryButton = (disabled: boolean) => ({
  padding: "5px 12px",
  borderRadius: "var(--radius)",
  border: "none",
  background: "var(--accent-primary)",
  color: "#fff",
  fontSize: "12px",
  fontWeight: 500,
  cursor: disabled ? "not-allowed" : "pointer",
  opacity: disabled ? 0.6 : 1,
  fontFamily: "inherit",
  marginLeft: "auto",
});

export function SpanEditor({
  group,
  periods,
  readOnly,
  otherGroups,
  onDirtyChange,
  onSave,
}: {
  group: SpanGroup;
  periods: StripPeriod[];
  readOnly: boolean;
  /** For TOU-UI-1b — the groups this one can be copied from. */
  otherGroups: SpanGroup[];
  /**
   * Reported upwards so the season this group belongs to can be marked
   * unsaved on its chip. Copying hours in leaves a group dirty without
   * saving it, which is exactly the state worth a mark.
   */
  onDirtyChange?: (dirty: boolean) => void;
  onSave: (spans: StripSpan[]) => Promise<void>;
}) {
  const [spans, setSpans] = useState<StripSpan[]>(group.spans);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const change = (next: StripSpan[]) => {
    setSpans(next);
    setDirty(true);
    onDirtyChange?.(true);
    setError(null);
  };

  const addRow = () => {
    const last = spans[spans.length - 1];
    const start = last ? last.endMinute : 0;
    change([
      ...spans,
      {
        startMinute: Math.min(start, 1425),
        endMinute: 1440,
        peakCode: periods[0]?.peakCode ?? "",
      },
    ]);
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await onSave(spans);
      setDirty(false);
      onDirtyChange?.(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save these hours");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      data-testid={`span-editor-${group.seasonCode}-${group.dayTypeCode}`}
      style={{
        border: "1px solid var(--border)",
        borderRadius: "var(--radius)",
        padding: "12px",
        background: "var(--bg-card)",
        display: "flex",
        flexDirection: "column",
        gap: "10px",
      }}
    >
      <DayStrip spans={spans} periods={periods} />

      <table style={{ width: "100%", fontSize: "12px", borderCollapse: "collapse" }}>
        <tbody>
          {spans.map((span, index) => (
            <tr key={index}>
              <td style={{ padding: "2px 4px 2px 0" }}>
                <select
                  aria-label="From"
                  disabled={readOnly}
                  style={selectStyle}
                  value={span.startMinute}
                  onChange={(e) =>
                    change(
                      spans.map((s, i) =>
                        i === index ? { ...s, startMinute: Number(e.target.value) } : s,
                      ),
                    )
                  }
                >
                  {QUARTER_HOURS.slice(0, 96).map((m) => (
                    <option key={m} value={m}>
                      {timeLabel(m)}
                    </option>
                  ))}
                </select>
              </td>
              <td style={{ padding: "2px 4px", color: "var(--text-muted)" }}>to</td>
              <td style={{ padding: "2px 4px" }}>
                <select
                  aria-label="To"
                  disabled={readOnly}
                  style={selectStyle}
                  value={span.endMinute}
                  onChange={(e) =>
                    change(
                      spans.map((s, i) =>
                        i === index ? { ...s, endMinute: Number(e.target.value) } : s,
                      ),
                    )
                  }
                >
                  {QUARTER_HOURS.slice(1).map((m) => (
                    <option key={m} value={m}>
                      {timeLabel(m)}
                    </option>
                  ))}
                </select>
              </td>
              <td style={{ padding: "2px 4px", color: "var(--text-muted)" }}>→</td>
              <td style={{ padding: "2px 4px", width: "40%" }}>
                <select
                  aria-label="Period"
                  disabled={readOnly}
                  style={{ ...selectStyle, fontFamily: "inherit", width: "100%" }}
                  value={span.peakCode}
                  onChange={(e) =>
                    change(
                      spans.map((s, i) => (i === index ? { ...s, peakCode: e.target.value } : s)),
                    )
                  }
                >
                  {periods.map((p) => (
                    <option key={p.peakCode} value={p.peakCode}>
                      {p.label}
                    </option>
                  ))}
                </select>
              </td>
              <td style={{ padding: "2px 0 2px 4px", textAlign: "right" }}>
                {!readOnly && (
                  <button
                    type="button"
                    aria-label="Remove this span"
                    onClick={() => change(spans.filter((_, i) => i !== index))}
                    style={{
                      background: "none",
                      border: "none",
                      color: "var(--text-muted)",
                      cursor: "pointer",
                      fontSize: "14px",
                      padding: "0 4px",
                    }}
                  >
                    ×
                  </button>
                )}
              </td>
            </tr>
          ))}
          {spans.length === 0 && (
            <tr>
              <td colSpan={6} style={{ padding: "6px 0", color: "var(--warning)" }}>
                No hours assigned — every minute of this day is unpriced.
              </td>
            </tr>
          )}
        </tbody>
      </table>

      {error && (
        <div style={{ fontSize: "12px", color: "var(--danger)" }} role="alert">
          {error}
        </div>
      )}

      {!readOnly && (
        <div style={{ display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" }}>
          <button type="button" onClick={addRow} style={secondaryButton}>
            Add a span
          </button>

          {/*
            TOU-UI-1b. Real tariffs repeat — Saturday is often
            weekday-shaped, winter is summer with a shorter peak — and
            without this every season is retyped, which is where
            transcription errors come from. It fills the rows and leaves
            them unsaved, because copying is the start of editing.
          */}
          {otherGroups.length > 0 && (
            <select
              aria-label="Copy hours from"
              style={{ ...selectStyle, fontFamily: "inherit" }}
              value=""
              onChange={(e) => {
                const source = otherGroups.find(
                  (g) => `${g.seasonCode}|${g.dayTypeCode}` === e.target.value,
                );
                if (source) change(source.spans.map((s) => ({ ...s })));
              }}
            >
              <option value="">Copy hours from…</option>
              {otherGroups.map((g) => (
                <option key={`${g.seasonCode}|${g.dayTypeCode}`} value={`${g.seasonCode}|${g.dayTypeCode}`}>
                  {g.seasonCode} / {g.dayTypeCode}
                </option>
              ))}
            </select>
          )}

          <button
            type="button"
            onClick={save}
            disabled={!dirty || saving}
            style={primaryButton(!dirty || saving)}
          >
            {saving ? "Saving…" : "Save these hours"}
          </button>
        </div>
      )}
    </div>
  );
}
