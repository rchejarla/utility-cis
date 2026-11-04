"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { PageHeader } from "@/components/ui/page-header";
import { StatusBadge } from "@/components/ui/status-badge";
import { AccessDenied } from "@/components/ui/access-denied";
import { apiClient } from "@/lib/api-client";
import { usePermission } from "@/lib/use-permission";
import {
  touCalendarLifecycle,
  touCalendarPeriod,
} from "@/lib/tou-calendar-lifecycle";
import { PeriodLegend } from "@/components/tou-calendars/day-strip";
import { SpanEditor, type SpanGroup } from "@/components/tou-calendars/span-editor";
import { SpotCheck } from "@/components/tou-calendars/spot-check";
import {
  DayTypesEditor,
  PeriodsEditor,
  type DayTypeRow,
  type PeriodRow,
} from "@/components/tou-calendars/structure-editor";

/**
 * The TOU calendar editor (spec 26, §5).
 *
 * A draft is editable and a published version is read-only, because
 * changing which hours are on-peak changes what a bill costs — so a
 * change is a new version with its own effective date, never an edit to
 * the one that billed.
 *
 * Every save returns the whole calendar, which is why the sections
 * re-key off a counter: saving one (season, day type) changes the
 * verdict on the calendar as a whole, and a screen that kept its old
 * verdict would offer Publish on a calendar the server will refuse.
 */

interface Calendar {
  id: string;
  name: string;
  effectiveDate: string;
  publishedAt: string | null;
  timeZone: string;
  clockBasis: string;
  seasonSet: {
    id: string;
    name: string;
    publishedAt: string | null;
    seasons: Array<{ seasonCode: string; label: string }>;
  };
  touHolidayListId: string | null;
  periods: PeriodRow[];
  dayTypes: DayTypeRow[];
  spanGroups: SpanGroup[];
  overrides: Array<{ id: string; date: string; dayTypeCode: string; reason: string | null }>;
  validation: { ok: true } | { ok: false; problems: string[] };
  /** Derived, not stored — see `tou-calendar.service.ts`. */
  inForceUntil: string | null;
  supersededBy: { id: string; effectiveDate: string } | null;
}

export default function TouCalendarEditorPage() {
  const params = useParams();
  const router = useRouter();
  const id = String(params.id);
  const { canView, canEdit } = usePermission("rate_schedules");

  const [calendar, setCalendar] = useState<Calendar | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [publishing, setPublishing] = useState(false);
  /** Bumped on every save, so the section editors remount with fresh props. */
  const [revision, setRevision] = useState(0);
  /** Offered only while the calendar is a draft, so loaded lazily. */
  const [seasonSets, setSeasonSets] = useState<
    Array<{ id: string; name: string; publishedAt: string | null }>
  >([]);

  const load = useCallback(async () => {
    try {
      setCalendar(await apiClient.get<Calendar>(`/api/v1/tou-calendars/${id}`));
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Could not load this calendar");
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (calendar?.publishedAt) return;
    apiClient
      .get<{ data: Array<{ id: string; name: string; publishedAt: string | null }> }>(
        "/api/v1/season-sets",
      )
      .then((res) => setSeasonSets(res.data ?? []))
      .catch(() => setSeasonSets([]));
  }, [calendar?.publishedAt]);

  const afterSave = (updated: Calendar) => {
    setCalendar(updated);
    setRevision((n) => n + 1);
  };

  const publish = async () => {
    if (!calendar) return;
    setPublishing(true);
    setActionError(null);
    try {
      await apiClient.post(`/api/v1/tou-calendars/${id}/publish`, {});
      await load();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Could not publish this calendar");
    } finally {
      setPublishing(false);
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
  if (!calendar) return <div style={{ padding: "24px" }}>Loading…</div>;

  const published = calendar.publishedAt !== null;
  const readOnly = published || !canEdit;

  return (
    <div style={{ maxWidth: "1100px", display: "flex", flexDirection: "column", gap: "16px" }}>
      <PageHeader
        title={calendar.name}
        subtitle={`${touCalendarPeriod(calendar)} · ${calendar.timeZone} · ${
          calendar.clockBasis === "standard" ? "standard time all year" : "follows daylight saving"
        }`}
      />

      <div style={{ display: "flex", gap: "12px", alignItems: "center", flexWrap: "wrap" }}>
        <StatusBadge
          status={touCalendarLifecycle({
            ...calendar,
            supersededById: calendar.supersededBy?.id ?? null,
          }).toLowerCase()}
        />
        {published || !canEdit ? (
          <span style={{ fontSize: "12px", color: "var(--text-muted)" }}>
            Seasons: {calendar.seasonSet.name}
            {calendar.seasonSet.publishedAt === null && " (still a draft)"}
          </span>
        ) : (
          /*
           * Changeable while the calendar is a draft, which is what a
           * draft is for. The server refuses a set that does not define
           * a season the hours are already keyed on, rather than
           * deleting those hours to make the change succeed.
           */
          <label style={{ fontSize: "12px", color: "var(--text-muted)" }}>
            Seasons:{" "}
            <select
              aria-label="Season set"
              value={calendar.seasonSet.id}
              onChange={async (e) => {
                setActionError(null);
                try {
                  await apiClient.patch(`/api/v1/tou-calendars/${id}`, {
                    seasonSetId: e.target.value,
                  });
                  await load();
                  setRevision((n) => n + 1);
                } catch (err) {
                  setActionError(
                    err instanceof Error ? err.message : "Could not change the season set",
                  );
                }
              }}
              style={{
                padding: "3px 6px",
                borderRadius: "var(--radius)",
                border: "1px solid var(--border)",
                background: "var(--bg-elevated)",
                color: "var(--text-primary)",
                fontSize: "12px",
                fontFamily: "inherit",
              }}
            >
              {seasonSets.length === 0 && (
                <option value={calendar.seasonSet.id}>{calendar.seasonSet.name}</option>
              )}
              {seasonSets.map((set) => (
                <option key={set.id} value={set.id}>
                  {set.name}
                  {set.publishedAt === null ? " (draft)" : ""}
                </option>
              ))}
            </select>
            {/*
              Said beside the control, not only inside it. Publishing
              refuses a calendar whose set is still a draft (TOU-CAL-10),
              and an option suffix disappears the moment the list has
              not loaded — leaving the one warning that explains the
              refusal invisible.
            */}
            {calendar.seasonSet.publishedAt === null && " (still a draft)"}
          </label>
        )}
        {!published && canEdit && (
          <button
            type="button"
            onClick={publish}
            disabled={publishing}
            style={{
              marginLeft: "auto",
              padding: "7px 16px",
              borderRadius: "var(--radius)",
              border: "none",
              background: "var(--accent-primary)",
              color: "#fff",
              fontSize: "13px",
              fontWeight: 500,
              cursor: publishing ? "not-allowed" : "pointer",
              opacity: publishing ? 0.7 : 1,
              fontFamily: "inherit",
            }}
          >
            {publishing ? "Publishing…" : "Publish"}
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
          Published on {calendar.publishedAt?.slice(0, 10)} and read-only. These hours have priced
          bills, so changing them would change what those bills should have said. To change the
          hours, create a new version with a later effective date.
        </div>
      )}

      {/*
        Validation is positional and in words (TOU-UI-1a). The strips
        show where; this says what, because "21:00–22:00 is assigned to
        no period" is the sentence somebody can act on and a red cell
        alone is not.
      */}
      {!calendar.validation.ok && (
        <div
          data-testid="calendar-problems"
          style={{
            border: "1px solid var(--danger)",
            borderRadius: "var(--radius)",
            padding: "12px 14px",
            background: "var(--bg-card)",
          }}
        >
          <div style={{ fontWeight: 500, fontSize: "13px", marginBottom: "6px" }}>
            {calendar.validation.problems.length}{" "}
            {calendar.validation.problems.length === 1 ? "problem" : "problems"} to fix before this
            can be published
          </div>
          <ul style={{ margin: 0, paddingLeft: "18px", fontSize: "12px", color: "var(--text-secondary)" }}>
            {calendar.validation.problems.map((problem, i) => (
              <li key={i}>{problem}</li>
            ))}
          </ul>
        </div>
      )}

      {calendar.validation.ok && !published && (
        <div data-testid="calendar-ready" style={{ fontSize: "12px", color: "var(--success)" }}>
          Every hour of every season and day type is priced exactly once.
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

      <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: "16px" }}>
        <PeriodsEditor
          key={`periods-${revision}`}
          periods={calendar.periods}
          readOnly={readOnly}
          onSave={async (rows) =>
            afterSave(
              await apiClient.put<Calendar>(`/api/v1/tou-calendars/${id}/periods`, {
                periods: rows.map((r) => ({ peakCode: r.peakCode, label: r.label })),
              }),
            )
          }
        />

        <DayTypesEditor
          key={`day-types-${revision}`}
          dayTypes={calendar.dayTypes}
          readOnly={readOnly}
          onSave={async (rows) =>
            afterSave(
              await apiClient.put<Calendar>(`/api/v1/tou-calendars/${id}/day-types`, {
                dayTypes: rows.map((r) => ({
                  dayTypeCode: r.dayTypeCode,
                  label: r.label,
                  isHoliday: r.isHoliday,
                  weekdays: r.weekdays,
                })),
              }),
            )
          }
        />
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
        <div style={{ fontWeight: 500, fontSize: "13px" }}>Hours</div>
        <PeriodLegend periods={calendar.periods} />

        {calendar.periods.length === 0 || calendar.dayTypes.length === 0 ? (
          <div data-testid="hours-blocked" style={{ fontSize: "12px", color: "var(--text-muted)" }}>
            Name the periods and the day types first — the hours are assigned to them.
          </div>
        ) : (
          calendar.seasonSet.seasons.map((season) => (
            <div key={season.seasonCode} style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
              <div style={{ fontSize: "12px", color: "var(--text-secondary)", marginTop: "6px" }}>
                {season.label}
              </div>
              {calendar.dayTypes.map((dayType) => {
                const group =
                  calendar.spanGroups.find(
                    (g) =>
                      g.seasonCode === season.seasonCode && g.dayTypeCode === dayType.dayTypeCode,
                  ) ?? {
                    seasonCode: season.seasonCode,
                    dayTypeCode: dayType.dayTypeCode,
                    spans: [],
                  };
                return (
                  <div key={dayType.dayTypeCode}>
                    <div style={{ fontSize: "12px", marginBottom: "4px" }}>{dayType.label}</div>
                    <SpanEditor
                      key={`${season.seasonCode}-${dayType.dayTypeCode}-${revision}`}
                      group={group}
                      periods={calendar.periods}
                      readOnly={readOnly}
                      otherGroups={calendar.spanGroups.filter(
                        (g) =>
                          g.spans.length > 0 &&
                          !(
                            g.seasonCode === season.seasonCode &&
                            g.dayTypeCode === dayType.dayTypeCode
                          ),
                      )}
                      onSave={async (spans) =>
                        afterSave(
                          await apiClient.put<Calendar>(`/api/v1/tou-calendars/${id}/spans`, {
                            seasonCode: season.seasonCode,
                            dayTypeCode: dayType.dayTypeCode,
                            spans,
                          }),
                        )
                      }
                    />
                  </div>
                );
              })}
            </div>
          ))
        )}
      </div>

      {/*
        After the hours, not before them.
        
        This answers "what period would a bill use for Tuesday 3 July at
        5:15 pm, and why" — a check somebody makes *before publishing*,
        which is the last thing they do. At the top of a half-built
        calendar it was the first thing a person met: a date box over a
        calendar with no periods, no day types and no hours, which
        answers nothing and reads as a step they were supposed to
        complete.
      */}
      {calendar.spanGroups.some((group) => group.spans.length > 0) && (
        <SpotCheck calendarId={id} />
      )}

      {!published && canEdit && (
        <div>
          <button
            type="button"
            onClick={async () => {
              setActionError(null);
              try {
                await apiClient.delete(`/api/v1/tou-calendars/${id}`);
                router.push("/tou-calendars");
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
