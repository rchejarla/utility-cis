"use client";

/**
 * A day as 96 quarter-hours, coloured by the period that covers each
 * one (spec 26, TOU-UI-1 and TOU-UI-1a).
 *
 * **Rendered from the spans, never edited.** A tariff says "on-peak is
 * 4–9 pm on summer weekdays"; it does not say ninety-six things. So the
 * spans are the input and this is the proof that they tile the day — a
 * gap or an overlap is a colour you cannot miss, which a list of four
 * rows genuinely cannot show. Painting cells was the obvious design and
 * is the wrong one: 576 drag targets across three day types and two
 * seasons, an off-by-one-slot peak nobody can see, and — the part that
 * decides it — a painted calendar cannot be read back. A regulator asks
 * "what are your peak hours" and the answer has to be four rows.
 */

export interface StripSpan {
  startMinute: number;
  endMinute: number;
  peakCode: string;
}

export interface StripPeriod {
  peakCode: string;
  label: string;
}

/**
 * Colours are assigned by the period's position in the calendar's own
 * list, not by its code. `peak_code` is a tenant string (TOU-CAL-2
 * leaves the vocabulary open), so a lookup keyed on "peak" would leave
 * a tenant who wrote "on_peak" with the default grey everywhere.
 */
const PALETTE = [
  { fill: "#2f6f4f", text: "#eaf6ef" },
  { fill: "#b3761a", text: "#fff6e6" },
  { fill: "#8d3b3b", text: "#fdecec" },
  { fill: "#3b5f8d", text: "#eaf1fb" },
  { fill: "#6b4b8a", text: "#f3ecfb" },
  { fill: "#4b6b6b", text: "#ecf5f5" },
];

export function periodColour(periods: StripPeriod[], peakCode: string) {
  const index = periods.findIndex((p) => p.peakCode === peakCode);
  return index >= 0 ? PALETTE[index % PALETTE.length] : { fill: "#555", text: "#eee" };
}

const QUARTERS = 96;

export function timeLabel(minute: number): string {
  return `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
}

/** What covers one quarter-hour: nothing, one period, or several. */
function coverage(spans: StripSpan[], quarter: number): string[] {
  const start = quarter * 15;
  const end = start + 15;
  return spans.filter((s) => s.startMinute < end && s.endMinute > start).map((s) => s.peakCode);
}

export function DayStrip({
  spans,
  periods,
  height = 26,
}: {
  spans: StripSpan[];
  periods: StripPeriod[];
  height?: number;
}) {
  const cells = Array.from({ length: QUARTERS }, (_, q) => {
    const covering = coverage(spans, q);
    const from = timeLabel(q * 15);
    const to = timeLabel(q * 15 + 15);

    if (covering.length === 0) {
      return {
        q,
        title: `${from}–${to}: no period`,
        // Hatched rather than a flat colour: a flat red reads as a
        // period called "red" to anyone who has not been told.
        style: {
          background:
            "repeating-linear-gradient(45deg, var(--danger) 0 3px, transparent 3px 6px)",
          border: "1px solid var(--danger)",
        },
        kind: "gap" as const,
      };
    }
    if (covering.length > 1) {
      return {
        q,
        title: `${from}–${to}: ${covering.join(" and ")} both`,
        style: { background: "var(--danger)", border: "1px solid var(--danger)" },
        kind: "overlap" as const,
      };
    }
    const colour = periodColour(periods, covering[0]);
    const label = periods.find((p) => p.peakCode === covering[0])?.label ?? covering[0];
    return {
      q,
      title: `${from}–${to}: ${label}`,
      style: { background: colour.fill, border: "none" },
      kind: "covered" as const,
    };
  });

  return (
    <div>
      <div
        data-testid="day-strip"
        style={{ display: "flex", height, borderRadius: "3px", overflow: "hidden" }}
      >
        {cells.map((cell) => (
          <div
            key={cell.q}
            data-kind={cell.kind}
            title={cell.title}
            style={{ flex: 1, boxSizing: "border-box", ...cell.style }}
          />
        ))}
      </div>
      {/*
        Six-hour ticks. Hour-by-hour labels do not fit at this width and
        the strip is read for shape — "the peak is late afternoon" —
        rather than for a number, which the rows beneath give exactly.
      */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          fontSize: "10px",
          color: "var(--text-muted)",
          marginTop: "2px",
          fontFamily: "monospace",
        }}
      >
        {["00:00", "06:00", "12:00", "18:00", "24:00"].map((t) => (
          <span key={t}>{t}</span>
        ))}
      </div>
    </div>
  );
}

/** Which colour means which period, beside the strips that use them. */
export function PeriodLegend({ periods }: { periods: StripPeriod[] }) {
  return (
    <div style={{ display: "flex", gap: "12px", flexWrap: "wrap", alignItems: "center" }}>
      {periods.map((period) => {
        const colour = periodColour(periods, period.peakCode);
        return (
          <span
            key={period.peakCode}
            style={{ display: "inline-flex", alignItems: "center", gap: "6px", fontSize: "12px" }}
          >
            <span
              style={{
                width: "12px",
                height: "12px",
                borderRadius: "2px",
                background: colour.fill,
                display: "inline-block",
              }}
            />
            {period.label}
          </span>
        );
      })}
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: "6px",
          fontSize: "12px",
          color: "var(--text-muted)",
        }}
      >
        <span
          style={{
            width: "12px",
            height: "12px",
            borderRadius: "2px",
            display: "inline-block",
            background:
              "repeating-linear-gradient(45deg, var(--danger) 0 3px, transparent 3px 6px)",
            border: "1px solid var(--danger)",
          }}
        />
        No period, or two
      </span>
    </div>
  );
}
