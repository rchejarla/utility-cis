"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { PageHeader } from "@/components/ui/page-header";
import { StatusBadge } from "@/components/ui/status-badge";
import { AccessDenied } from "@/components/ui/access-denied";
import { apiClient } from "@/lib/api-client";
import { usePermission } from "@/lib/use-permission";
import {
  SeasonLegend,
  YearStrip,
  seasonColour,
  type CoverageDay,
} from "@/components/season-sets/year-strip";

/**
 * The season set editor (spec 26, §1).
 *
 * Seasons are a short list of month/day ranges, and the year bar above
 * them is the proof they cover the year exactly once. A published set is
 * read-only, because a season boundary decides which price applies and
 * these codes are what published TOU calendars and rate components are
 * keyed on.
 */

interface Season {
  seasonCode: string;
  label: string;
  startMonth: number;
  startDay: number;
  endMonth: number;
  endDay: number;
}

interface DivergingCalendar {
  id: string;
  name: string;
  effectiveDate: string;
  seasonSetName: string;
}

interface SeasonSet {
  id: string;
  name: string;
  effectiveDate: string;
  publishedAt: string | null;
  spanRule: string;
  seasons: Season[];
  coverage: CoverageDay[];
  validation: { ok: true } | { ok: false; problems: string[] };
  calendarsOnOtherSets: DivergingCalendar[];
}

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
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

const smallSelect = { ...inputStyle, width: "auto" };

function MonthDay({
  month,
  day,
  disabled,
  labelPrefix,
  onChange,
}: {
  month: number;
  day: number;
  disabled: boolean;
  labelPrefix: string;
  onChange: (month: number, day: number) => void;
}) {
  /*
   * Days are 1–31 whatever the month, and 30 February is refused by the
   * validator rather than hidden here. The validator's sentence names
   * the season and the date ("Season \"summer\" ends on 30 February,
   * which is not a date"), which is more use than a silently shortened
   * list — and a tenant mid-edit who has picked the 31st should not have
   * it changed under them by switching month.
   */
  return (
    <span style={{ display: "inline-flex", gap: "4px" }}>
      <select
        aria-label={`${labelPrefix} day`}
        disabled={disabled}
        style={smallSelect}
        value={day}
        onChange={(e) => onChange(month, Number(e.target.value))}
      >
        {Array.from({ length: 31 }, (_, i) => i + 1).map((d) => (
          <option key={d} value={d}>
            {d}
          </option>
        ))}
      </select>
      <select
        aria-label={`${labelPrefix} month`}
        disabled={disabled}
        style={smallSelect}
        value={month}
        onChange={(e) => onChange(Number(e.target.value), day)}
      >
        {MONTHS.map((name, i) => (
          <option key={name} value={i + 1}>
            {name}
          </option>
        ))}
      </select>
    </span>
  );
}

export default function SeasonSetEditorPage() {
  const params = useParams();
  const router = useRouter();
  const id = String(params.id);
  const { canView, canEdit } = usePermission("rate_schedules");

  const [set, setSet] = useState<SeasonSet | null>(null);
  const [rows, setRows] = useState<Season[]>([]);
  const [dirty, setDirty] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [publishedNote, setPublishedNote] = useState<DivergingCalendar[] | null>(null);

  const load = useCallback(async () => {
    try {
      const loaded = await apiClient.get<SeasonSet>(`/api/v1/season-sets/${id}`);
      setSet(loaded);
      setRows(loaded.seasons);
      setDirty(false);
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Could not load this season set");
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  const change = (next: Season[]) => {
    setRows(next);
    setDirty(true);
    setActionError(null);
  };

  const saveSeasons = async () => {
    setBusy(true);
    setActionError(null);
    try {
      const updated = await apiClient.put<SeasonSet>(`/api/v1/season-sets/${id}/seasons`, {
        seasons: rows,
      });
      setSet(updated);
      setRows(updated.seasons);
      setDirty(false);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Could not save these seasons");
    } finally {
      setBusy(false);
    }
  };

  const publish = async () => {
    setBusy(true);
    setActionError(null);
    try {
      const published = await apiClient.post<{ calendarsOnOtherSets: DivergingCalendar[] }>(
        `/api/v1/season-sets/${id}/publish`,
        {},
      );
      setPublishedNote(published.calendarsOnOtherSets ?? []);
      await load();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Could not publish this season set");
    } finally {
      setBusy(false);
    }
  };

  if (!canView) return <AccessDenied />;
  if (loadError) {
    return (
      <div style={{ padding: "24px", color: "var(--danger)" }} role="alert">
        {loadError}
      </div>
    );
  }
  if (!set) return <div style={{ padding: "24px" }}>Loading…</div>;

  const published = set.publishedAt !== null;
  const readOnly = published || !canEdit;
  const codes = rows.map((r) => r.seasonCode);

  /*
   * A row nobody has filled in yet. "Add a season" creates one whose
   * placeholders look like values, so the obvious next click is Save —
   * which sent an empty code to a schema demanding one and came back
   * "Validation failed", naming neither the field nor the row.
   */
  const incomplete = rows
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => row.seasonCode.trim() === "" || row.label.trim() === "");

  return (
    <div style={{ maxWidth: "1000px", display: "flex", flexDirection: "column", gap: "16px" }}>
      <PageHeader
        title={set.name}
        subtitle={`In force from ${set.effectiveDate.slice(0, 10)}`}
      />

      <div style={{ display: "flex", gap: "12px", alignItems: "center", flexWrap: "wrap" }}>
        <StatusBadge status={published ? "published" : "draft"} />
        {!published && canEdit && (
          <button
            type="button"
            onClick={publish}
            disabled={busy}
            style={{
              marginLeft: "auto",
              padding: "7px 16px",
              borderRadius: "var(--radius)",
              border: "none",
              background: "var(--accent-primary)",
              color: "#fff",
              fontSize: "13px",
              fontWeight: 500,
              cursor: busy ? "not-allowed" : "pointer",
              opacity: busy ? 0.7 : 1,
              fontFamily: "inherit",
            }}
          >
            {busy ? "Working…" : "Publish"}
          </button>
        )}
      </div>

      {published && (
        <div
          data-testid="published-notice"
          style={{
            fontSize: "12px",
            color: "var(--text-secondary)",
            border: "1px solid var(--border)",
            borderLeft: "3px solid var(--accent-primary)",
            borderRadius: "var(--radius)",
            padding: "10px 12px",
            background: "var(--bg-card)",
          }}
        >
          Published on {set.publishedAt?.slice(0, 10)} and read-only. These season codes are what
          published TOU calendars and rate components are keyed on, so changing a boundary would
          change what past bills should have said. To move a boundary, create a new set with a
          later effective date.
        </div>
      )}

      {/*
        The warning a tenant has no way to work out for themselves.

        A TOU calendar names its season set explicitly and a published
        one is immutable, so it keeps its own seasons for ever. Non-TOU
        charges do not — they follow whichever set is in force. So from
        the day this set takes effect, a water bill uses these
        boundaries while a TOU electric bill keeps the old ones. Both
        are right by their own rules; nothing else would ever say they
        disagree.
      */}
      {set.calendarsOnOtherSets.length > 0 && (
        <div
          data-testid="diverging-calendars"
          style={{
            border: "1px solid var(--warning)",
            borderRadius: "var(--radius)",
            padding: "12px 14px",
            background: "var(--bg-card)",
            fontSize: "12px",
          }}
        >
          <div style={{ fontWeight: 500, marginBottom: "6px" }}>
            {set.calendarsOnOtherSets.length} published TOU{" "}
            {set.calendarsOnOtherSets.length === 1 ? "calendar keeps" : "calendars keep"} different
            seasons
          </div>
          <div style={{ color: "var(--text-secondary)", marginBottom: "6px" }}>
            {published ? "Since this set took effect, charges" : "Once this set is published, charges"}{" "}
            that are not time-of-use follow these boundaries, while the hours in{" "}
            {set.calendarsOnOtherSets.length === 1 ? "this calendar" : "these calendars"} stay keyed
            on the set {set.calendarsOnOtherSets.length === 1 ? "it names" : "they name"}. That is
            deliberate — a published calendar must keep the seasons it was built against — but it
            means two bills for one customer can use two different definitions of summer. To move
            them, publish a new calendar version naming this set.
          </div>
          <ul style={{ margin: 0, paddingLeft: "18px", color: "var(--text-secondary)" }}>
            {set.calendarsOnOtherSets.map((calendar) => (
              <li key={calendar.id}>
                <a href={`/tou-calendars/${calendar.id}`} style={{ color: "var(--accent-primary)" }}>
                  {calendar.name}
                </a>{" "}
                (from {calendar.effectiveDate.slice(0, 10)}) → {calendar.seasonSetName}
              </li>
            ))}
          </ul>
        </div>
      )}

      {publishedNote !== null && publishedNote.length === 0 && (
        <div data-testid="publish-clean" style={{ fontSize: "12px", color: "var(--success)" }}>
          Published. No TOU calendar is keyed on a different set, so every charge now uses these
          boundaries.
        </div>
      )}

      {!set.validation.ok && (
        <div
          data-testid="season-problems"
          style={{
            border: "1px solid var(--danger)",
            borderRadius: "var(--radius)",
            padding: "12px 14px",
            background: "var(--bg-card)",
          }}
        >
          <div style={{ fontWeight: 500, fontSize: "13px", marginBottom: "6px" }}>
            {set.validation.problems.length}{" "}
            {set.validation.problems.length === 1 ? "problem" : "problems"} to fix before this can
            be published
          </div>
          <ul
            style={{ margin: 0, paddingLeft: "18px", fontSize: "12px", color: "var(--text-secondary)" }}
          >
            {set.validation.problems.map((problem, i) => (
              <li key={i}>{problem}</li>
            ))}
          </ul>
        </div>
      )}

      {set.validation.ok && !published && (
        <div data-testid="season-ready" style={{ fontSize: "12px", color: "var(--success)" }}>
          Every day of the year belongs to exactly one season, including 29 February.
        </div>
      )}

      {actionError && (
        <div
          data-testid="action-error"
          role="alert"
          style={{
            border: "1px solid var(--danger)",
            borderRadius: "var(--radius)",
            padding: "10px 12px",
            fontSize: "12px",
            color: "var(--danger)",
            whiteSpace: "pre-wrap",
          }}
        >
          {actionError}
        </div>
      )}

      <div
        style={{
          border: "1px solid var(--border)",
          borderRadius: "var(--radius)",
          padding: "14px",
          background: "var(--bg-card)",
          display: "flex",
          flexDirection: "column",
          gap: "12px",
        }}
      >
        {/*
          The bar reflects what is saved, not what is typed: it comes
          from the server's own coverage computation, which is the same
          code that decides whether the set may be published. A bar
          drawn from the unsaved rows would be a second implementation
          of the wrap arithmetic, and the wrapped season is exactly the
          case it would get wrong.
        */}
        <YearStrip coverage={set.coverage} seasonCodes={set.seasons.map((s) => s.seasonCode)} />
        <SeasonLegend seasons={set.seasons} />
        {dirty && (
          <div data-testid="bar-is-stale" style={{ fontSize: "11px", color: "var(--text-muted)" }}>
            The bar shows the saved seasons. Save to see these changes in it.
          </div>
        )}

        <table style={{ width: "100%", fontSize: "12px", borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ textAlign: "left", color: "var(--text-muted)" }}>
              <th style={{ padding: "2px 4px 6px 0", fontWeight: 400, width: "28px" }} />
              <th style={{ padding: "2px 4px 6px", fontWeight: 400 }}>Code</th>
              <th style={{ padding: "2px 4px 6px", fontWeight: 400 }}>Label</th>
              <th style={{ padding: "2px 4px 6px", fontWeight: 400 }}>From</th>
              <th style={{ padding: "2px 4px 6px", fontWeight: 400 }}>To</th>
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
                      background: seasonColour(codes, row.seasonCode).fill,
                    }}
                  />
                </td>
                <td style={{ padding: "2px 4px", width: "16%" }}>
                  <input
                    aria-label="Season code"
                    disabled={readOnly}
                    style={{
                      ...inputStyle,
                      fontFamily: "monospace",
                      ...(row.seasonCode.trim() === "" ? { borderColor: "var(--danger)" } : {}),
                    }}
                    value={row.seasonCode}
                    placeholder="summer"
                    onChange={(e) =>
                      change(
                        rows.map((r, i) => (i === index ? { ...r, seasonCode: e.target.value } : r)),
                      )
                    }
                  />
                </td>
                <td style={{ padding: "2px 4px", width: "20%" }}>
                  <input
                    aria-label="Season label"
                    disabled={readOnly}
                    style={{
                      ...inputStyle,
                      ...(row.label.trim() === "" ? { borderColor: "var(--danger)" } : {}),
                    }}
                    value={row.label}
                    placeholder="Summer"
                    onChange={(e) =>
                      change(rows.map((r, i) => (i === index ? { ...r, label: e.target.value } : r)))
                    }
                  />
                </td>
                <td style={{ padding: "2px 4px" }}>
                  <MonthDay
                    month={row.startMonth}
                    day={row.startDay}
                    disabled={readOnly}
                    labelPrefix={`${row.seasonCode || "Season"} start`}
                    onChange={(month, day) =>
                      change(
                        rows.map((r, i) =>
                          i === index ? { ...r, startMonth: month, startDay: day } : r,
                        ),
                      )
                    }
                  />
                </td>
                <td style={{ padding: "2px 4px" }}>
                  <MonthDay
                    month={row.endMonth}
                    day={row.endDay}
                    disabled={readOnly}
                    labelPrefix={`${row.seasonCode || "Season"} end`}
                    onChange={(month, day) =>
                      change(
                        rows.map((r, i) =>
                          i === index ? { ...r, endMonth: month, endDay: day } : r,
                        ),
                      )
                    }
                  />
                </td>
                <td style={{ padding: "2px 0 2px 4px", textAlign: "right" }}>
                  {!readOnly && (
                    <button
                      type="button"
                      aria-label="Remove this season"
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

        <div style={{ fontSize: "11px", color: "var(--text-muted)" }}>
          A season may wrap the year end — 1 November to 31 March is one season, not two.
        </div>

        {incomplete.length > 0 && (
          <div data-testid="seasons-incomplete" style={{ fontSize: "12px", color: "var(--warning)" }}>
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
              onClick={() =>
                change([
                  ...rows,
                  {
                    seasonCode: "",
                    label: "",
                    startMonth: 1,
                    startDay: 1,
                    endMonth: 12,
                    endDay: 31,
                  },
                ])
              }
              style={{
                padding: "5px 12px",
                borderRadius: "var(--radius)",
                border: "1px solid var(--border)",
                background: "transparent",
                color: "var(--text-secondary)",
                fontSize: "12px",
                cursor: "pointer",
                fontFamily: "inherit",
              }}
            >
              Add a season
            </button>
            <button
              type="button"
              onClick={saveSeasons}
              disabled={!dirty || busy || incomplete.length > 0}
              style={{
                marginLeft: "auto",
                padding: "5px 12px",
                borderRadius: "var(--radius)",
                border: "none",
                background: "var(--accent-primary)",
                color: "#fff",
                fontSize: "12px",
                fontWeight: 500,
                cursor: !dirty || busy || incomplete.length > 0 ? "not-allowed" : "pointer",
                opacity: !dirty || busy || incomplete.length > 0 ? 0.6 : 1,
                fontFamily: "inherit",
              }}
            >
              {busy ? "Saving…" : "Save seasons"}
            </button>
          </div>
        )}
      </div>

      {!published && canEdit && (
        <div>
          <button
            type="button"
            onClick={async () => {
              setActionError(null);
              try {
                await apiClient.delete(`/api/v1/season-sets/${id}`);
                router.push("/season-sets");
              } catch (err) {
                setActionError(err instanceof Error ? err.message : "Could not delete this draft");
              }
            }}
            style={{
              padding: "6px 14px",
              borderRadius: "var(--radius)",
              border: "1px solid var(--border)",
              background: "transparent",
              color: "var(--danger)",
              fontSize: "12px",
              cursor: "pointer",
              fontFamily: "inherit",
            }}
          >
            Delete this draft
          </button>
        </div>
      )}
    </div>
  );
}
