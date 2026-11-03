"use client";

import { useState } from "react";
import { apiClient } from "@/lib/api-client";
import { timeLabel } from "./day-strip";

/**
 * "Tuesday 3 July, 5:15 pm" — which period, which day type, and why
 * (spec 26, TOU-UI-1c).
 *
 * The most valuable control on the screen, because it is how somebody
 * checks a calendar before publishing it, and because the holiday
 * interaction is the part people get wrong: 4 July 2026 is a Saturday,
 * so a utility observing it on the nearest weekday makes Friday 3 July
 * a holiday — a date whose weekday says otherwise. The answer therefore
 * carries a sentence naming the rule, not just the word "holiday".
 *
 * It asks the server rather than classifying here. The server runs the
 * same `resolvePeak` a bill does, so this cannot bless a calendar that
 * would rate differently — which a second implementation in the browser
 * eventually would.
 */

interface SpotCheckAnswer {
  date: string;
  time: string;
  ok: boolean;
  peakCode?: string;
  periodLabel?: string;
  seasonCode?: string;
  seasonLabel?: string;
  dayTypeCode?: string;
  dayTypeLabel?: string;
  why?: string;
  problem?: string;
}

interface DayAnswer {
  date: string;
  ok: boolean;
  dayTypeLabel?: string;
  seasonLabel?: string;
  why?: string;
  problem?: string;
  spans?: Array<{ startMinute: number; endMinute: number; periodLabel: string }>;
}

const inputStyle = {
  padding: "6px 8px",
  borderRadius: "var(--radius)",
  border: "1px solid var(--border)",
  background: "var(--bg-elevated)",
  color: "var(--text-primary)",
  fontSize: "13px",
  fontFamily: "inherit",
};

const buttonStyle = {
  padding: "6px 14px",
  borderRadius: "var(--radius)",
  border: "1px solid var(--border)",
  background: "transparent",
  color: "var(--text-secondary)",
  fontSize: "13px",
  cursor: "pointer",
  fontFamily: "inherit",
};

export function SpotCheck({ calendarId }: { calendarId: string }) {
  const [date, setDate] = useState("");
  const [time, setTime] = useState("17:15");
  const [answer, setAnswer] = useState<SpotCheckAnswer | null>(null);
  const [day, setDay] = useState<DayAnswer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const ask = async (whole: boolean) => {
    if (!date) {
      setError("Pick a date first.");
      return;
    }
    setBusy(true);
    setError(null);
    setAnswer(null);
    setDay(null);
    try {
      if (whole) {
        setDay(
          await apiClient.get<DayAnswer>(`/api/v1/tou-calendars/${calendarId}/day`, { date }),
        );
      } else {
        setAnswer(
          await apiClient.get<SpotCheckAnswer>(`/api/v1/tou-calendars/${calendarId}/spot-check`, {
            date,
            time,
          }),
        );
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not check that date");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      data-testid="spot-check"
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
      <div style={{ fontWeight: 500, fontSize: "13px" }}>Check a date and time</div>
      <div style={{ fontSize: "12px", color: "var(--text-muted)" }}>
        Answers with the period a bill would use, and why that day resolved the way it did.
        Holidays and their observance rules are where calendars usually go wrong.
      </div>

      <div style={{ display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" }}>
        <input
          type="date"
          aria-label="Date"
          style={inputStyle}
          value={date}
          onChange={(e) => setDate(e.target.value)}
        />
        <input
          type="time"
          aria-label="Time"
          step={900}
          style={inputStyle}
          value={time}
          onChange={(e) => setTime(e.target.value)}
        />
        <button type="button" style={buttonStyle} disabled={busy} onClick={() => ask(false)}>
          Check this time
        </button>
        {/* TOU-UI-1e — the same mechanism for a whole day, which is how
            an observance rule gets sanity-checked. */}
        <button type="button" style={buttonStyle} disabled={busy} onClick={() => ask(true)}>
          Show the whole day
        </button>
      </div>

      {error && (
        <div role="alert" style={{ fontSize: "12px", color: "var(--danger)" }}>
          {error}
        </div>
      )}

      {answer && (
        <div data-testid="spot-check-answer" style={{ fontSize: "13px" }}>
          {answer.ok ? (
            <>
              <div style={{ fontWeight: 500 }}>
                {answer.periodLabel} — {answer.seasonLabel}, {answer.dayTypeLabel}
              </div>
              <div style={{ color: "var(--text-secondary)", marginTop: "4px" }}>{answer.why}</div>
            </>
          ) : (
            <div style={{ color: "var(--danger)" }}>{answer.problem}</div>
          )}
        </div>
      )}

      {day && (
        <div data-testid="day-preview" style={{ fontSize: "13px" }}>
          {day.ok ? (
            <>
              <div style={{ fontWeight: 500 }}>
                {day.date} — {day.seasonLabel}, {day.dayTypeLabel}
              </div>
              <div style={{ color: "var(--text-secondary)", margin: "4px 0" }}>{day.why}</div>
              <ul style={{ margin: 0, paddingLeft: "18px", color: "var(--text-secondary)" }}>
                {(day.spans ?? []).map((span, i) => (
                  <li key={i} style={{ fontFamily: "monospace", fontSize: "12px" }}>
                    {timeLabel(span.startMinute)}–{timeLabel(span.endMinute)} {span.periodLabel}
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <div style={{ color: "var(--danger)" }}>{day.problem}</div>
          )}
        </div>
      )}
    </div>
  );
}
