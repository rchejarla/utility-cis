"use client";

/**
 * The three steps of building a calendar, as tabs: periods, day types,
 * hours (spec 26, §5).
 *
 * One tab per collection, because that is where the save boundary
 * already is — each is its own `PUT` with its own invariants and its own
 * refusals. Two of them on one tab would mean two Save buttons saving
 * half a tab each, or one button issuing two writes with no way to be
 * atomic about it.
 *
 * What stays *outside* the tabs is the calendar's own state: the status,
 * the sets it names, the validation verdict and Publish. A tab that hid
 * "2 problems to fix" would let somebody believe the hours were
 * finished.
 */

export interface Tab<K extends string> {
  key: K;
  label: string;
  /** Marked as needing attention — nothing in it yet. */
  incomplete: boolean;
  /** Marked as holding edits nobody has saved. */
  dirty: boolean;
}

export function TabStrip<K extends string>({
  tabs,
  active,
  onSelect,
}: {
  tabs: Tab<K>[];
  active: K;
  onSelect: (key: K) => void;
}) {
  return (
    <div
      role="tablist"
      aria-label="Calendar sections"
      style={{
        display: "flex",
        gap: "2px",
        borderBottom: "1px solid var(--border)",
      }}
    >
      {tabs.map((tab) => {
        const on = tab.key === active;
        return (
          <button
            key={tab.key}
            type="button"
            role="tab"
            aria-selected={on}
            data-testid={`tab-${tab.key}`}
            onClick={() => onSelect(tab.key)}
            style={{
              padding: "8px 14px",
              border: "none",
              borderBottom: `2px solid ${on ? "var(--accent-primary)" : "transparent"}`,
              background: "transparent",
              color: on ? "var(--text-primary)" : "var(--text-secondary)",
              fontSize: "13px",
              fontWeight: on ? 500 : 400,
              cursor: "pointer",
              fontFamily: "inherit",
              display: "flex",
              alignItems: "center",
              gap: "6px",
            }}
          >
            {tab.label}
            {/*
              Two different marks, because they are two different
              states: nothing here yet, and something here that is not
              saved. One dot for both would make a finished tab with an
              unsaved edit look empty.
            */}
            {tab.dirty && (
              <span
                data-testid={`tab-${tab.key}-unsaved`}
                title="Unsaved changes"
                style={{
                  width: "6px",
                  height: "6px",
                  borderRadius: "50%",
                  background: "var(--accent-primary)",
                }}
              />
            )}
            {!tab.dirty && tab.incomplete && (
              <span
                data-testid={`tab-${tab.key}-incomplete`}
                title="Nothing in here yet"
                style={{
                  width: "6px",
                  height: "6px",
                  borderRadius: "50%",
                  border: "1px solid var(--warning)",
                }}
              />
            )}
          </button>
        );
      })}
    </div>
  );
}

/**
 * The season chips on the Hours tab.
 *
 * Chips rather than a dropdown: publishing needs every (season, day
 * type) covered exactly once, and a dropdown can only tell you which
 * season is empty once you have opened it and gone looking. Seasons are
 * nearly always two or three, so they fit.
 */
export function SeasonChips({
  seasons,
  active,
  onSelect,
}: {
  seasons: Array<{ seasonCode: string; label: string; complete: boolean; dirty: boolean }>;
  active: string;
  onSelect: (seasonCode: string) => void;
}) {
  return (
    <div style={{ display: "flex", gap: "6px", flexWrap: "wrap", alignItems: "center" }}>
      {seasons.map((season) => {
        const on = season.seasonCode === active;
        return (
          <button
            key={season.seasonCode}
            type="button"
            aria-pressed={on}
            data-testid={`season-chip-${season.seasonCode}`}
            onClick={() => onSelect(season.seasonCode)}
            style={{
              padding: "4px 12px",
              borderRadius: "999px",
              border: `1px solid ${on ? "var(--accent-primary)" : "var(--border)"}`,
              background: on ? "var(--accent-primary)" : "transparent",
              color: on ? "#fff" : "var(--text-secondary)",
              fontSize: "12px",
              cursor: "pointer",
              fontFamily: "inherit",
              display: "flex",
              alignItems: "center",
              gap: "6px",
            }}
          >
            {season.label}
            {season.dirty ? (
              <span
                data-testid={`season-chip-${season.seasonCode}-unsaved`}
                title="Unsaved hours"
                style={{
                  width: "6px",
                  height: "6px",
                  borderRadius: "50%",
                  background: on ? "#fff" : "var(--accent-primary)",
                }}
              />
            ) : (
              <span
                data-testid={`season-chip-${season.seasonCode}-${
                  season.complete ? "complete" : "incomplete"
                }`}
                title={season.complete ? "Every day type has hours" : "Hours missing"}
                style={{
                  width: "6px",
                  height: "6px",
                  borderRadius: "50%",
                  background: season.complete ? (on ? "#fff" : "var(--success)") : "transparent",
                  border: season.complete ? "none" : `1px solid ${on ? "#fff" : "var(--warning)"}`,
                }}
              />
            )}
          </button>
        );
      })}
    </div>
  );
}

const MONTH_NAMES = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/**
 * "1 May – 31 Oct", beside the season's name.
 *
 * A season code is the tenant's word and says nothing about when it
 * runs, so somebody checking hours against a tariff document had to
 * open the season set in another tab to find out which months "summer"
 * means here — and a season may wrap the year end, which is exactly the
 * case they would guess wrong.
 */
export function seasonDates(season: {
  startMonth: number;
  startDay: number;
  endMonth: number;
  endDay: number;
}): string {
  const from = `${season.startDay} ${MONTH_NAMES[season.startMonth - 1]}`;
  const to = `${season.endDay} ${MONTH_NAMES[season.endMonth - 1]}`;
  return `${from} – ${to}`;
}
