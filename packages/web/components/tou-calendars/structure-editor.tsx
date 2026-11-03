"use client";

import { useState } from "react";
import { periodColour } from "./day-strip";

/**
 * A calendar's two vocabularies: its periods and its day types
 * (spec 26, TOU-CAL-1 and TOU-CAL-2).
 *
 * Both are saved as whole lists, because both carry invariants the row
 * cannot see — exactly one holiday day type, and the seven weekdays
 * claimed exactly once between them. Moving Saturday from weekday to
 * weekend is not expressible as two row edits at all.
 */

export interface PeriodRow {
  peakCode: string;
  label: string;
}

export interface DayTypeRow {
  dayTypeCode: string;
  label: string;
  isHoliday: boolean;
  weekdays: number[];
}

const WEEKDAYS = [
  { iso: 1, short: "Mon" },
  { iso: 2, short: "Tue" },
  { iso: 3, short: "Wed" },
  { iso: 4, short: "Thu" },
  { iso: 5, short: "Fri" },
  { iso: 6, short: "Sat" },
  { iso: 7, short: "Sun" },
];

const inputStyle = {
  padding: "4px 8px",
  borderRadius: "var(--radius)",
  border: "1px solid var(--border)",
  background: "var(--bg-elevated)",
  color: "var(--text-primary)",
  fontSize: "12px",
  fontFamily: "inherit",
  width: "100%",
  boxSizing: "border-box" as const,
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

function Card({
  title,
  hint,
  children,
  testId,
}: {
  title: string;
  hint: string;
  children: React.ReactNode;
  testId: string;
}) {
  return (
    <div
      data-testid={testId}
      style={{
        border: "1px solid var(--border)",
        borderRadius: "var(--radius)",
        padding: "14px",
        background: "var(--bg-card)",
        display: "flex",
        flexDirection: "column",
        gap: "10px",
      }}
    >
      <div style={{ fontWeight: 500, fontSize: "13px" }}>{title}</div>
      <div style={{ fontSize: "12px", color: "var(--text-muted)" }}>{hint}</div>
      {children}
    </div>
  );
}

export function PeriodsEditor({
  periods,
  readOnly,
  onSave,
}: {
  periods: PeriodRow[];
  readOnly: boolean;
  onSave: (rows: PeriodRow[]) => Promise<void>;
}) {
  const [rows, setRows] = useState<PeriodRow[]>(periods);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const change = (next: PeriodRow[]) => {
    setRows(next);
    setDirty(true);
    setError(null);
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await onSave(rows);
      setDirty(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save the periods");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card
      testId="periods-editor"
      title="Periods"
      hint="What the hours are called and what a rate schedule prices against. A schedule cannot be published unless it prices every one of them."
    >
      <table style={{ width: "100%", fontSize: "12px", borderCollapse: "collapse" }}>
        <thead>
          <tr style={{ textAlign: "left", color: "var(--text-muted)" }}>
            <th style={{ padding: "2px 4px 6px 0", fontWeight: 400, width: "32px" }} />
            <th style={{ padding: "2px 4px 6px", fontWeight: 400 }}>Code</th>
            <th style={{ padding: "2px 4px 6px", fontWeight: 400 }}>Label</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={index}>
              <td style={{ padding: "2px 4px 2px 0" }}>
                <span
                  style={{
                    display: "inline-block",
                    width: "12px",
                    height: "12px",
                    borderRadius: "2px",
                    background: periodColour(rows, row.peakCode).fill,
                  }}
                />
              </td>
              <td style={{ padding: "2px 4px" }}>
                <input
                  aria-label="Period code"
                  disabled={readOnly}
                  style={{ ...inputStyle, fontFamily: "monospace" }}
                  value={row.peakCode}
                  placeholder="peak"
                  onChange={(e) =>
                    change(rows.map((r, i) => (i === index ? { ...r, peakCode: e.target.value } : r)))
                  }
                />
              </td>
              <td style={{ padding: "2px 4px" }}>
                <input
                  aria-label="Period label"
                  disabled={readOnly}
                  style={inputStyle}
                  value={row.label}
                  placeholder="Peak"
                  onChange={(e) =>
                    change(rows.map((r, i) => (i === index ? { ...r, label: e.target.value } : r)))
                  }
                />
              </td>
              <td style={{ padding: "2px 0 2px 4px", textAlign: "right" }}>
                {!readOnly && (
                  <button
                    type="button"
                    aria-label="Remove this period"
                    onClick={() => change(rows.filter((_, i) => i !== index))}
                    style={{
                      background: "none",
                      border: "none",
                      color: "var(--text-muted)",
                      cursor: "pointer",
                      fontSize: "14px",
                    }}
                  >
                    ×
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {error && (
        <div role="alert" style={{ fontSize: "12px", color: "var(--danger)" }}>
          {error}
        </div>
      )}

      {!readOnly && (
        <div style={{ display: "flex", gap: "8px" }}>
          <button
            type="button"
            style={secondaryButton}
            onClick={() => change([...rows, { peakCode: "", label: "" }])}
          >
            Add a period
          </button>
          <button
            type="button"
            style={primaryButton(!dirty || saving)}
            disabled={!dirty || saving}
            onClick={save}
          >
            {saving ? "Saving…" : "Save periods"}
          </button>
        </div>
      )}
    </Card>
  );
}

export function DayTypesEditor({
  dayTypes,
  readOnly,
  onSave,
}: {
  dayTypes: DayTypeRow[];
  readOnly: boolean;
  onSave: (rows: DayTypeRow[]) => Promise<void>;
}) {
  const [rows, setRows] = useState<DayTypeRow[]>(dayTypes);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const change = (next: DayTypeRow[]) => {
    setRows(next);
    setDirty(true);
    setError(null);
  };

  /**
   * A weekday belongs to one day type, so ticking it here unticks it
   * wherever it was. The database says the same
   * (`tou_day_type_weekday_once_per_calendar`); doing it in the form
   * means the operator never composes a list the server will refuse.
   */
  const toggleWeekday = (index: number, iso: number) => {
    change(
      rows.map((row, i) => {
        if (i === index) {
          return row.weekdays.includes(iso)
            ? { ...row, weekdays: row.weekdays.filter((w) => w !== iso) }
            : { ...row, weekdays: [...row.weekdays, iso].sort((a, b) => a - b) };
        }
        return { ...row, weekdays: row.weekdays.filter((w) => w !== iso) };
      }),
    );
  };

  const claimed = new Set(rows.flatMap((r) => r.weekdays));
  const unclaimed = WEEKDAYS.filter((d) => !claimed.has(d.iso));

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await onSave(rows);
      setDirty(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save the day types");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card
      testId="day-types-editor"
      title="Day types"
      hint="Which kinds of day this calendar distinguishes. Every weekday has to belong to exactly one of them, and at most one can be the holiday type."
    >
      <table style={{ width: "100%", fontSize: "12px", borderCollapse: "collapse" }}>
        <thead>
          <tr style={{ textAlign: "left", color: "var(--text-muted)" }}>
            <th style={{ padding: "2px 4px 6px 0", fontWeight: 400 }}>Code</th>
            <th style={{ padding: "2px 4px 6px", fontWeight: 400 }}>Label</th>
            <th style={{ padding: "2px 4px 6px", fontWeight: 400 }}>Days</th>
            <th style={{ padding: "2px 4px 6px", fontWeight: 400 }}>Holiday</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={index}>
              <td style={{ padding: "2px 4px 2px 0", width: "18%" }}>
                <input
                  aria-label="Day type code"
                  disabled={readOnly}
                  style={{ ...inputStyle, fontFamily: "monospace" }}
                  value={row.dayTypeCode}
                  placeholder="weekday"
                  onChange={(e) =>
                    change(
                      rows.map((r, i) =>
                        i === index ? { ...r, dayTypeCode: e.target.value } : r,
                      ),
                    )
                  }
                />
              </td>
              <td style={{ padding: "2px 4px", width: "20%" }}>
                <input
                  aria-label="Day type label"
                  disabled={readOnly}
                  style={inputStyle}
                  value={row.label}
                  placeholder="Weekday"
                  onChange={(e) =>
                    change(rows.map((r, i) => (i === index ? { ...r, label: e.target.value } : r)))
                  }
                />
              </td>
              <td style={{ padding: "2px 4px" }}>
                <div style={{ display: "flex", gap: "2px", flexWrap: "wrap" }}>
                  {WEEKDAYS.map((day) => {
                    const on = row.weekdays.includes(day.iso);
                    return (
                      <button
                        key={day.iso}
                        type="button"
                        disabled={readOnly}
                        aria-pressed={on}
                        aria-label={`${day.short} on ${row.dayTypeCode || "this day type"}`}
                        onClick={() => toggleWeekday(index, day.iso)}
                        style={{
                          padding: "3px 6px",
                          fontSize: "11px",
                          borderRadius: "3px",
                          border: `1px solid ${on ? "var(--accent-primary)" : "var(--border)"}`,
                          background: on ? "var(--accent-primary)" : "transparent",
                          color: on ? "#fff" : "var(--text-muted)",
                          cursor: readOnly ? "default" : "pointer",
                          fontFamily: "inherit",
                        }}
                      >
                        {day.short}
                      </button>
                    );
                  })}
                </div>
              </td>
              <td style={{ padding: "2px 4px", textAlign: "center" }}>
                {/*
                  A flag and not a code, because TOU-CAL-2 leaves the
                  day-type vocabulary open — a tenant may call theirs
                  `observed_holiday` or add a Saturday type — so nothing
                  may match a literal "holiday". Without the flag, every
                  holiday would classify as an ordinary weekday and
                  nothing would say so.
                */}
                <input
                  type="checkbox"
                  aria-label={`${row.dayTypeCode || "This day type"} is the holiday type`}
                  disabled={readOnly}
                  checked={row.isHoliday}
                  onChange={(e) =>
                    change(
                      rows.map((r, i) =>
                        i === index
                          ? { ...r, isHoliday: e.target.checked }
                          : e.target.checked
                            ? { ...r, isHoliday: false }
                            : r,
                      ),
                    )
                  }
                />
              </td>
              <td style={{ padding: "2px 0 2px 4px", textAlign: "right" }}>
                {!readOnly && (
                  <button
                    type="button"
                    aria-label="Remove this day type"
                    onClick={() => change(rows.filter((_, i) => i !== index))}
                    style={{
                      background: "none",
                      border: "none",
                      color: "var(--text-muted)",
                      cursor: "pointer",
                      fontSize: "14px",
                    }}
                  >
                    ×
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {unclaimed.length > 0 && (
        <div data-testid="unclaimed-weekdays" style={{ fontSize: "12px", color: "var(--warning)" }}>
          {unclaimed.map((d) => d.short).join(", ")} {unclaimed.length === 1 ? "belongs" : "belong"}{" "}
          to no day type. Dates falling on {unclaimed.length === 1 ? "it" : "them"} cannot be
          classified, and a bill covering one will stop.
        </div>
      )}

      {error && (
        <div role="alert" style={{ fontSize: "12px", color: "var(--danger)" }}>
          {error}
        </div>
      )}

      {!readOnly && (
        <div style={{ display: "flex", gap: "8px" }}>
          <button
            type="button"
            style={secondaryButton}
            onClick={() =>
              change([...rows, { dayTypeCode: "", label: "", isHoliday: false, weekdays: [] }])
            }
          >
            Add a day type
          </button>
          <button
            type="button"
            style={primaryButton(!dirty || saving)}
            disabled={!dirty || saving}
            onClick={save}
          >
            {saving ? "Saving…" : "Save day types"}
          </button>
        </div>
      )}
    </Card>
  );
}
