"use client";

import { useState } from "react";
import { periodColour } from "./day-strip";

/**
 * A calendar's two vocabularies: its periods and its day types
 * (spec 26, TOU-CAL-1 and TOU-CAL-2).
 *
 * Both are saved as whole lists, because both carry invariants the row
 * cannot see — the seven weekdays claimed exactly once between them, and
 * the periods tiling each day exactly once. Moving Saturday from weekday
 * to weekend is not expressible as two row edits at all.
 */

export interface PeriodRow {
  peakCode: string;
  label: string;
}

export interface DayTypeRow {
  dayTypeCode: string;
  label: string;
  /**
   * `holiday`, the one code the system owns. Derived by the server from
   * the code itself and sent back so the screen does not have to know
   * the literal; a row added here is never one.
   */
  isHolidayDayType?: boolean;
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

/**
 * A row nobody has filled in yet.
 *
 * "Add a period" creates a blank row whose placeholders — `peak`,
 * `Peak` — look exactly like values, so the obvious next click is Save.
 * That sent an empty code to a schema demanding at least one character
 * and came back "Validation failed", which named neither the field nor
 * the row. Caught here instead: the save is held and the empty boxes
 * say so.
 */
function isBlank(value: string): boolean {
  return value.trim() === "";
}

/*
 * The whole `border` shorthand, not just `borderColor`.
 *
 * `inputStyle` sets `border`, and overriding only the colour mixes a
 * shorthand with a longhand for the same value — React warns that the
 * one it removes on rerender can leave the border in a state neither
 * style asked for, which here means a red outline that does not clear
 * when the field is filled in.
 */
const blankInput = {
  border: "1px solid var(--danger)",
};

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
  onDirtyChange,
  onSave,
}: {
  periods: PeriodRow[];
  readOnly: boolean;
  /**
   * Reported upwards so the tab holding this editor can mark itself
   * unsaved. The editor keeps owning the state — the tab only needs to
   * know there is some.
   */
  onDirtyChange?: (dirty: boolean) => void;
  onSave: (rows: PeriodRow[]) => Promise<void>;
}) {
  const [rows, setRows] = useState<PeriodRow[]>(periods);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const change = (next: PeriodRow[]) => {
    setRows(next);
    setDirty(true);
    onDirtyChange?.(true);
    setError(null);
  };

  /** Rows that would be refused, by position, so the message can say which. */
  const incomplete = rows
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => isBlank(row.peakCode) || isBlank(row.label));

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await onSave(rows);
      setDirty(false);
      onDirtyChange?.(false);
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
                  value={row.peakCode}
                  style={{
                    ...inputStyle,
                    fontFamily: "monospace",
                    ...(isBlank(row.peakCode) ? blankInput : {}),
                  }}
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
                  value={row.label}
                  style={{ ...inputStyle, ...(isBlank(row.label) ? blankInput : {}) }}
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

      {incomplete.length > 0 && (
        <div data-testid="periods-incomplete" style={{ fontSize: "12px", color: "var(--warning)" }}>
          {incomplete.length === 1 ? "Row" : "Rows"}{" "}
          {incomplete.map(({ index }) => index + 1).join(", ")} still{" "}
          {incomplete.length === 1 ? "needs" : "need"} a code and a label. The greyed text is an
          example, not a value.
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
            style={primaryButton(!dirty || saving || incomplete.length > 0)}
            disabled={!dirty || saving || incomplete.length > 0}
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
  holidaySetName,
  onDirtyChange,
  onSave,
}: {
  dayTypes: DayTypeRow[];
  readOnly: boolean;
  /** The set whose dates reach the holiday row, or null if none is named. */
  holidaySetName: string | null;
  /** See `PeriodsEditor`. */
  onDirtyChange?: (dirty: boolean) => void;
  onSave: (rows: DayTypeRow[]) => Promise<void>;
}) {
  const [rows, setRows] = useState<DayTypeRow[]>(dayTypes);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const change = (next: DayTypeRow[]) => {
    setRows(next);
    setDirty(true);
    onDirtyChange?.(true);
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

  /**
   * The rows a tenant defines, which is what this list is for.
   *
   * The reserved `holiday` row is not one of them: nothing about it is
   * the operator's to decide — the system creates it with the holiday
   * set, the engine finds it by its code, and it claims no weekday. It
   * stayed in `rows` and out of the table, because the save replaces
   * the whole collection and a list submitted without it is refused.
   *
   * Absolute indices, so the edit handlers keep addressing `rows`; the
   * number in the "needs a code" message counts visible rows, since
   * that is what somebody is looking at.
   */
  const visible = rows
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => row.isHolidayDayType !== true);

  /** Rows that would be refused, by the position shown. See `isBlank`. */
  const incomplete = visible
    .map((entry, position) => ({ ...entry, position }))
    .filter(({ row }) => isBlank(row.dayTypeCode) || isBlank(row.label));

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await onSave(rows);
      setDirty(false);
      onDirtyChange?.(false);
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
      hint="Which kinds of day this calendar distinguishes. Every weekday has to belong to exactly one of them."
    >
      <table style={{ width: "100%", fontSize: "12px", borderCollapse: "collapse" }}>
        <thead>
          <tr style={{ textAlign: "left", color: "var(--text-muted)" }}>
            <th style={{ padding: "2px 4px 6px 0", fontWeight: 400 }}>Code</th>
            <th style={{ padding: "2px 4px 6px", fontWeight: 400 }}>Label</th>
            <th style={{ padding: "2px 4px 6px", fontWeight: 400 }}>Days</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {visible.map(({ row, index }) => (
            <tr key={index}>
              <td style={{ padding: "2px 4px 2px 0", width: "18%" }}>
                <input
                  aria-label="Day type code"
                  disabled={readOnly}
                  style={{
                    ...inputStyle,
                    fontFamily: "monospace",
                    ...(isBlank(row.dayTypeCode) ? blankInput : {}),
                  }}
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
                  style={{ ...inputStyle, ...(isBlank(row.label) ? blankInput : {}) }}
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

      {/*
        Said in a line rather than as a row in the table above. Without
        it the Hours section further down grows a "Holiday" block out of
        nowhere; with it as a row, every cell was disabled and the list
        read as though holidays were something to configure here.
      */}
      {holidaySetName && (
        <div data-testid="holiday-day-type-note" style={{ fontSize: "12px", color: "var(--text-muted)" }}>
          Holidays are the dates in &ldquo;{holidaySetName}&rdquo;, and take their own hours
          below &mdash; whatever weekday they fall on.
        </div>
      )}

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

      {incomplete.length > 0 && (
        <div data-testid="day-types-incomplete" style={{ fontSize: "12px", color: "var(--warning)" }}>
          {incomplete.length === 1 ? "Row" : "Rows"}{" "}
          {incomplete.map(({ position }) => position + 1).join(", ")} still{" "}
          {incomplete.length === 1 ? "needs" : "need"} a code and a label. The greyed text is an
          example, not a value.
        </div>
      )}

      {!readOnly && (
        <div style={{ display: "flex", gap: "8px" }}>
          <button
            type="button"
            style={secondaryButton}
            onClick={() => change([...rows, { dayTypeCode: "", label: "", weekdays: [] }])}
          >
            Add a day type
          </button>
          <button
            type="button"
            style={primaryButton(!dirty || saving || incomplete.length > 0)}
            disabled={!dirty || saving || incomplete.length > 0}
            onClick={save}
          >
            {saving ? "Saving…" : "Save day types"}
          </button>
        </div>
      )}
    </Card>
  );
}
