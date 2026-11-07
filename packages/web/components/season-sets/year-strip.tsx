"use client";

/**
 * A year as 366 days, coloured by the season claiming each one
 * (spec 26, §1).
 *
 * The same idea as the TOU calendar's day strip, and for the same
 * reason: the seasons are edited as a short list of month/day ranges,
 * and this is the proof that they cover the year exactly once. A wrapped
 * season — Nov 1 – Mar 31 — is the case nobody can check by reading,
 * and it is the one this makes obvious.
 *
 * **Drawn from coverage the server computed.** The containment
 * arithmetic lives in `seasons.ts` and is the same code that decides
 * whether the set may be published, so this cannot show a tidy green
 * year for a set the validator rejects. 366 and not 365 because the
 * engine enumerates a leap year on purpose: a set that ends February on
 * the 28th loses a day every fourth year.
 */

export interface CoverageDay {
  month: number;
  day: number;
  claimedBy: string[];
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const PALETTE = [
  { fill: "#2f6f4f" },
  { fill: "#b3761a" },
  { fill: "#3b5f8d" },
  { fill: "#8d3b3b" },
  { fill: "#6b4b8a" },
  { fill: "#4b6b6b" },
];

export function seasonColour(codes: string[], code: string) {
  const index = codes.indexOf(code);
  return index >= 0 ? PALETTE[index % PALETTE.length] : { fill: "#555" };
}

export function YearStrip({
  coverage,
  seasonCodes,
  height = 28,
}: {
  coverage: CoverageDay[];
  seasonCodes: string[];
  height?: number;
}) {
  return (
    <div>
      <div
        data-testid="year-strip"
        style={{ display: "flex", height, borderRadius: "3px", overflow: "hidden" }}
      >
        {coverage.map((day, index) => {
          const date = `${day.day} ${MONTHS[day.month - 1]}`;
          if (day.claimedBy.length === 0) {
            return (
              <div
                key={index}
                data-kind="gap"
                title={`${date}: no season`}
                style={{
                  flex: 1,
                  background:
                    "repeating-linear-gradient(45deg, var(--danger) 0 3px, transparent 3px 6px)",
                  borderTop: "1px solid var(--danger)",
                  borderBottom: "1px solid var(--danger)",
                }}
              />
            );
          }
          if (day.claimedBy.length > 1) {
            return (
              <div
                key={index}
                data-kind="overlap"
                title={`${date}: ${day.claimedBy.join(" and ")} both`}
                style={{ flex: 1, background: "var(--danger)" }}
              />
            );
          }
          return (
            <div
              key={index}
              data-kind="covered"
              title={`${date}: ${day.claimedBy[0]}`}
              style={{ flex: 1, background: seasonColour(seasonCodes, day.claimedBy[0]).fill }}
            />
          );
        })}
      </div>
      <div
        style={{
          display: "flex",
          fontSize: "10px",
          color: "var(--text-muted)",
          marginTop: "2px",
        }}
      >
        {MONTHS.map((m) => (
          <span key={m} style={{ flex: 1, textAlign: "center" }}>
            {m}
          </span>
        ))}
      </div>
    </div>
  );
}

export function SeasonLegend({
  seasons,
}: {
  seasons: Array<{ seasonCode: string; label: string }>;
}) {
  const codes = seasons.map((s) => s.seasonCode);
  return (
    <div style={{ display: "flex", gap: "12px", flexWrap: "wrap", alignItems: "center" }}>
      {seasons.map((season) => (
        <span
          key={season.seasonCode}
          style={{ display: "inline-flex", alignItems: "center", gap: "6px", fontSize: "12px" }}
        >
          <span
            style={{
              width: "12px",
              height: "12px",
              borderRadius: "2px",
              background: seasonColour(codes, season.seasonCode).fill,
              display: "inline-block",
            }}
          />
          {season.label}
        </span>
      ))}
    </div>
  );
}
