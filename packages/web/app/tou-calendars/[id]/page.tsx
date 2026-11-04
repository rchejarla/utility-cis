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
import { SeasonChips, TabStrip, seasonDates } from "@/components/tou-calendars/tab-strip";

/**
 * The TOU calendar editor (spec 26, §5).
 *
 * A draft is editable and a published version is read-only, because
 * changing which hours are on-peak changes what a bill costs — so a
 * change is a new version with its own effective date, never an edit to
 * the one that billed.
 *
 * **Three tabs and one season at a time**, because the whole thing at
 * once is a wall: two seasons and three day types is six span editors,
 * each a strip and a table, under two more cards — and three seasons is
 * nine. One tab per collection puts the tab boundary where the save
 * boundary already is (each is its own `PUT`), and the Hours tab shows
 * the day types of one season.
 *
 * It is **not a wizard**, although it walks a new calendar through the
 * same order. The page opens on the first tab with nothing in it and
 * offers "Next", which is what a wizard would buy; a separate create
 * flow would be a second screen over the same data, with its own idea
 * of what makes a calendar valid. Everything here is editable while the
 * calendar is a draft, so nothing needs an order enforced.
 *
 * Every save returns the whole calendar, and the saved section re-keys
 * off its *own* counter rather than a shared one: saving the day types
 * must refresh the verdict without discarding a half-finished edit
 * sitting on the Periods tab.
 */

type TabKey = "periods" | "day-types" | "hours";

const TAB_LABELS: Record<TabKey, string> = {
  periods: "Periods",
  "day-types": "Day Types",
  hours: "Hours",
};

const TAB_ORDER: TabKey[] = ["periods", "day-types", "hours"];

/** Nothing in it yet, which is what the tab's mark means. */
function isTabIncomplete(calendar: Calendar, key: TabKey): boolean {
  if (key === "periods") return calendar.periods.length === 0;
  if (key === "day-types") return calendar.dayTypes.length === 0;
  /*
   * The hours are incomplete while any (season, day type) has none —
   * and while there are no groups at all, which is a new calendar. The
   * server builds a group per (season, day type), so a calendar with no
   * day types has none, and "no group is empty" was true of it.
   *
   * Not the same question as `validation.ok`, which a calendar can fail
   * with hours everywhere — a gap inside one day. The verdict above the
   * tabs keeps saying that.
   */
  return (
    calendar.spanGroups.length === 0 || calendar.spanGroups.some((group) => group.spans.length === 0)
  );
}

/**
 * Where the page opens. The first tab with nothing in it, or the hours
 * when everything has something, since that is the substance of a
 * calendar somebody has come back to read.
 */
function firstIncompleteTab(calendar: Calendar): TabKey {
  return TAB_ORDER.find((key) => isTabIncomplete(calendar, key)) ?? "hours";
}

function firstSeasonNeedingHours(calendar: Calendar): string | null {
  const empty = calendar.seasonSet.seasons.find((s) =>
    calendar.spanGroups.some((g) => g.seasonCode === s.seasonCode && g.spans.length === 0),
  );
  return (empty ?? calendar.seasonSet.seasons[0])?.seasonCode ?? null;
}

const spanKey = (seasonCode: string, dayTypeCode: string) => `${seasonCode}|${dayTypeCode}`;

/**
 * A change to one of the sets the calendar names, picked but not yet
 * applied.
 *
 * These two are the only controls here that are not a list with a Save,
 * and that difference was confusing in the dangerous direction:
 * somebody who had just used the Periods tab looked for a Save, found
 * none, and left assuming their choice was discarded — when picking it
 * had already applied it.
 *
 * So picking is picking, and Apply is the save. It also gives the side
 * effects somewhere to be said *before* they happen: attaching a
 * holiday set adds a day type, detaching removes it, and a season set
 * that does not define a season the hours use is refused. All three
 * were correct and all three arrived as a surprise.
 */
type PendingChange =
  | { field: "seasonSetId"; value: string; toName: string }
  | {
      field: "touHolidaySetId";
      value: string | null;
      toName: string | null;
      /** Whether a set was already named, which decides what changes. */
      hadSet: boolean;
    };

/** What applying it will do, in one sentence. */
function consequenceOf(change: PendingChange): string {
  if (change.field === "seasonSetId") {
    return `The hours stay as they are. If any of them are keyed on a season that "${change.toName}" does not define, the change is refused rather than deleting them.`;
  }
  if (change.value === null) {
    return "Removes the Holiday day type from this calendar, so every day is classified by its weekday alone. Refused if you have given it hours, rather than deleting them.";
  }
  if (!change.hadSet) {
    return `Adds a Holiday day type. You give it hours on the Hours tab, and the dates in "${change.toName}" take them whatever weekday they fall on.`;
  }
  return `The days that take holiday hours become the dates in "${change.toName}". The hours themselves do not move.`;
}

/** What to say once it has been applied, since nothing else would. */
function appliedNote(change: PendingChange): string {
  if (change.field === "seasonSetId") return `Season set changed to "${change.toName}".`;
  if (change.value === null) return "Holiday set removed.";
  return `Holiday set changed to "${change.toName}".`;
}

/**
 * What a wizard's Next button would have been, without the wizard.
 *
 * Building a calendar does have an order — the hours are assigned to
 * periods and day types, so those have to exist first — and this is
 * where that order is stated. It moves nothing and saves nothing: each
 * section's own Save has already done that, or has not.
 */
function NextTab({
  to,
  label,
  onSelect,
}: {
  to: TabKey;
  label: string;
  onSelect: (key: TabKey) => void;
}) {
  return (
    <div style={{ display: "flex", justifyContent: "flex-end", marginTop: "10px" }}>
      <button
        type="button"
        data-testid={`next-to-${to}`}
        onClick={() => onSelect(to)}
        style={{
          padding: "6px 14px",
          borderRadius: "var(--radius)",
          border: "1px solid var(--border)",
          background: "transparent",
          color: "var(--text-secondary)",
          fontSize: "12px",
          cursor: "pointer",
          fontFamily: "inherit",
        }}
      >
        Next: {label} →
      </button>
    </div>
  );
}

const selectStyle = {
  padding: "3px 6px",
  borderRadius: "var(--radius)",
  border: "1px solid var(--border)",
  background: "var(--bg-elevated)",
  color: "var(--text-primary)",
  fontSize: "12px",
  fontFamily: "inherit",
};

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
    /**
     * The month/day bounds come with them, and the Hours tab prints
     * them beside each season: a season code is the tenant's word and
     * says nothing about which months it covers — least of all when it
     * wraps the year end.
     */
    seasons: Array<{
      seasonCode: string;
      label: string;
      startMonth: number;
      startDay: number;
      endMonth: number;
      endDay: number;
    }>;
  };
  touHolidaySetId: string | null;
  /**
   * The set itself, when one is named. Its date count is the thing worth
   * seeing from here: a set that has run out prices no holidays at all,
   * and the calendar's own validation says so in words.
   */
  holidaySet: {
    id: string;
    name: string;
    publishedAt: string | null;
    _count: { holidays: number };
  } | null;
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
  /**
   * One counter per section, bumped when that section saves, so its
   * editor remounts with the server's rows. Separate counters because a
   * single one remounted *every* editor on every save — which with
   * tabs means saving the day types silently discards a half-typed
   * period on the tab next door.
   */
  const [revision, setRevision] = useState({ periods: 0, dayTypes: 0, spans: 0 });
  /** Which tab is showing, decided once the calendar has loaded. */
  const [tab, setTab] = useState<TabKey | null>(null);
  /** Which season the Hours tab is showing. */
  const [season, setSeason] = useState<string | null>(null);
  /**
   * Sections holding edits nobody has saved, for the mark on the tab.
   * Spans are keyed by `season|dayType`, so a season's chip can carry
   * the same mark.
   */
  const [dirty, setDirty] = useState<{
    periods: boolean;
    dayTypes: boolean;
    spans: Record<string, boolean>;
  }>({ periods: false, dayTypes: false, spans: {} });
  /** A set picked but not applied — see `PendingChange`. */
  const [pending, setPending] = useState<PendingChange | null>(null);
  const [applying, setApplying] = useState(false);
  /** What the last applied change did, because nothing else would say. */
  const [applied, setApplied] = useState<string | null>(null);
  /** Offered only while the calendar is a draft, so loaded lazily. */
  const [seasonSets, setSeasonSets] = useState<
    Array<{ id: string; name: string; publishedAt: string | null }>
  >([]);
  const [holidaySets, setHolidaySets] = useState<
    Array<{ id: string; name: string; publishedAt: string | null; lastDate: string | null }>
  >([]);

  const load = useCallback(async () => {
    try {
      const loaded = await apiClient.get<Calendar>(`/api/v1/tou-calendars/${id}`);
      setCalendar(loaded);
      /*
       * The opening tab is the first one with nothing in it, which is
       * what makes a new calendar walk itself without a wizard. Decided
       * once: recomputing it on every load would move the tab under
       * somebody the moment they filled the one they were on.
       */
      setTab((current) => current ?? firstIncompleteTab(loaded));
      setSeason((current) => current ?? firstSeasonNeedingHours(loaded));
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
    apiClient
      .get<{
        data: Array<{
          id: string;
          name: string;
          publishedAt: string | null;
          lastDate: string | null;
        }>;
      }>("/api/v1/tou-holiday-sets")
      .then((res) => setHolidaySets(res.data ?? []))
      .catch(() => setHolidaySets([]));
  }, [calendar?.publishedAt]);

  /**
   * PATCH one field of the header and reload. The two selects share it.
   *
   * Everything remounts here, unlike a section save: changing the
   * season set changes which seasons the hours are keyed on, and
   * attaching a holiday set adds a day type.
   */
  const patch = async (body: Record<string, unknown>, whenItFails: string): Promise<boolean> => {
    setActionError(null);
    try {
      await apiClient.patch(`/api/v1/tou-calendars/${id}`, body);
      await load();
      setRevision((r) => ({ periods: r.periods + 1, dayTypes: r.dayTypes + 1, spans: r.spans + 1 }));
      setDirty({ periods: false, dayTypes: false, spans: {} });
      return true;
    } catch (err) {
      setActionError(err instanceof Error ? err.message : whenItFails);
      return false;
    }
  };

  /**
   * Apply the picked set. On a refusal the choice is kept in the select
   * and the server's sentence appears below, so the operator can read
   * why and either fix it or cancel — rather than finding their
   * selection silently snapped back.
   */
  const applyPending = async () => {
    if (!pending) return;
    setApplying(true);
    const ok = await patch(
      pending.field === "seasonSetId"
        ? { seasonSetId: pending.value }
        : { touHolidaySetId: pending.value },
      pending.field === "seasonSetId"
        ? "Could not change the season set"
        : "Could not change the holiday set",
    );
    setApplying(false);
    if (ok) {
      setApplied(appliedNote(pending));
      setPending(null);
    }
  };

  /** Picking something. The same value as now is not a change. */
  const pick = (next: PendingChange, unchanged: boolean) => {
    setApplied(null);
    setActionError(null);
    setPending(unchanged ? null : next);
  };

  /**
   * One section saved. Its own editor remounts on the server's rows;
   * the others keep whatever is being typed in them.
   */
  const afterSave = (section: "periods" | "dayTypes" | "spans", updated: Calendar) => {
    setCalendar(updated);
    setRevision((r) => ({ ...r, [section]: r[section] + 1 }));
    if (section === "spans") {
      // Every span editor remounted, so none of them holds an edit.
      setDirty((d) => ({ ...d, spans: {} }));
    } else {
      setDirty((d) => ({ ...d, [section]: false }));
    }
  };

  const markSpanDirty = (seasonCode: string, dayTypeCode: string, isDirty: boolean) =>
    setDirty((d) => ({
      ...d,
      spans: { ...d.spans, [spanKey(seasonCode, dayTypeCode)]: isDirty },
    }));

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
  /*
   * `tab` and `season` are null until the calendar has loaded, which it
   * now has. Falling back rather than asserting, because a season set
   * whose seasons changed under a draft could leave `season` naming one
   * that is gone.
   */
  const showing: TabKey = tab ?? firstIncompleteTab(calendar);
  const showingSeason =
    calendar.seasonSet.seasons.find((s) => s.seasonCode === season)?.seasonCode ??
    calendar.seasonSet.seasons[0]?.seasonCode ??
    null;

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
          <>
            <span style={{ fontSize: "12px", color: "var(--text-muted)" }}>
              Seasons: {calendar.seasonSet.name}
              {calendar.seasonSet.publishedAt === null && " (still a draft)"}
            </span>
            <span data-testid="holiday-set" style={{ fontSize: "12px", color: "var(--text-muted)" }}>
              Holidays:{" "}
              {calendar.holidaySet
                ? `${calendar.holidaySet.name} (${calendar.holidaySet._count.holidays} dates)`
                : "none — days are classified by weekday alone"}
            </span>
          </>
        ) : (
          /*
           * Changeable while the calendar is a draft, which is what a
           * draft is for. The server refuses a set that does not define
           * a season the hours are already keyed on, rather than
           * deleting those hours to make the change succeed.
           */
          <>
            <label style={{ fontSize: "12px", color: "var(--text-muted)" }}>
              Seasons:{" "}
              <select
                aria-label="Season set"
                /*
                 * Shows what has been picked, not what is stored, so a
                 * pending choice stays visible while its consequence is
                 * being read.
                 */
                value={pending?.field === "seasonSetId" ? pending.value : calendar.seasonSet.id}
                disabled={applying || pending?.field === "touHolidaySetId"}
                onChange={(e) =>
                  pick(
                    {
                      field: "seasonSetId",
                      value: e.target.value,
                      toName:
                        seasonSets.find((s) => s.id === e.target.value)?.name ?? e.target.value,
                    },
                    e.target.value === calendar.seasonSet.id,
                  )
                }
                style={selectStyle}
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
            {/*
              Changeable while the calendar is a draft, like the season
              set. Attaching one creates the reserved `holiday` day type
              with it, so the hours for those dates are prompted without
              a setup step; detaching removes it again, and is refused
              if it has hours, since deleting what somebody typed is not
              a trade a dropdown may make.
            */}
            <label style={{ fontSize: "12px", color: "var(--text-muted)" }}>
              Holidays:{" "}
              <select
                aria-label="Holiday set"
                value={
                  pending?.field === "touHolidaySetId"
                    ? (pending.value ?? "")
                    : (calendar.touHolidaySetId ?? "")
                }
                disabled={applying || pending?.field === "seasonSetId"}
                onChange={(e) => {
                  const value = e.target.value === "" ? null : e.target.value;
                  pick(
                    {
                      field: "touHolidaySetId",
                      value,
                      toName:
                        value === null
                          ? null
                          : (holidaySets.find((s) => s.id === value)?.name ?? value),
                      hadSet: calendar.touHolidaySetId !== null,
                    },
                    value === (calendar.touHolidaySetId ?? null),
                  );
                }}
                style={selectStyle}
              >
                <option value="">None — weekday alone</option>
                {holidaySets.length === 0 && calendar.holidaySet && (
                  <option value={calendar.holidaySet.id}>{calendar.holidaySet.name}</option>
                )}
                {holidaySets.map((set) => (
                  <option key={set.id} value={set.id}>
                    {set.name}
                    {set.publishedAt === null
                      ? " (draft)"
                      : set.lastDate
                        ? ` (through ${set.lastDate.slice(0, 10)})`
                        : " (no dates)"}
                  </option>
                ))}
              </select>
              {calendar.holidaySet?.publishedAt === null && " (still a draft)"}
            </label>
          </>
        )}
        {/*
          Through to the sets themselves, which is a different job from
          picking one: the boundary between summer and winter, or the
          date a holiday is observed on, lives in the set and reaches
          every calendar naming it. Shown whatever the calendar's state,
          since a published calendar's set is still worth reading.
        */}
        <span style={{ display: "flex", gap: "10px", fontSize: "12px" }}>
          <a
            href={`/season-sets/${calendar.seasonSet.id}`}
            style={{ color: "var(--accent-primary)" }}
          >
            Edit seasons
          </a>
          {calendar.holidaySet && (
            <a
              href={`/tou-holiday-sets/${calendar.holidaySet.id}`}
              style={{ color: "var(--accent-primary)" }}
            >
              Edit holidays
            </a>
          )}
        </span>
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

      {/*
        Picked, not yet applied. Apply is the save these two controls
        were missing, and it sits where the change was made rather than
        at the bottom of a form — the consequence above it is the part
        that was arriving afterwards, as a refusal or a day type nobody
        asked for.
      */}
      {pending && (
        <div
          data-testid="pending-change"
          style={{
            border: "1px solid var(--warning)",
            borderRadius: "var(--radius)",
            padding: "10px 12px",
            background: "var(--bg-card)",
            display: "flex",
            gap: "12px",
            alignItems: "center",
            flexWrap: "wrap",
            fontSize: "12px",
          }}
        >
          <span style={{ color: "var(--text-secondary)" }}>{consequenceOf(pending)}</span>
          <span style={{ display: "flex", gap: "8px", marginLeft: "auto" }}>
            <button
              type="button"
              onClick={() => setPending(null)}
              disabled={applying}
              style={{
                padding: "5px 12px",
                borderRadius: "var(--radius)",
                border: "1px solid var(--border)",
                background: "transparent",
                color: "var(--text-secondary)",
                fontSize: "12px",
                cursor: applying ? "not-allowed" : "pointer",
                fontFamily: "inherit",
              }}
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={applyPending}
              disabled={applying}
              style={{
                padding: "5px 12px",
                borderRadius: "var(--radius)",
                border: "none",
                background: "var(--accent-primary)",
                color: "#fff",
                fontSize: "12px",
                fontWeight: 500,
                cursor: applying ? "not-allowed" : "pointer",
                opacity: applying ? 0.7 : 1,
                fontFamily: "inherit",
              }}
            >
              {applying ? "Applying…" : "Apply"}
            </button>
          </span>
        </div>
      )}

      {/*
        Said because nothing else would. Switching between two holiday
        sets with the same day types changes nothing visible, so without
        this the page looked exactly as it had and the only way to know
        was to reload.
      */}
      {applied && !pending && (
        <div data-testid="change-applied" style={{ fontSize: "12px", color: "var(--success)" }}>
          {applied}
        </div>
      )}

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

      <TabStrip
        tabs={TAB_ORDER.map((key) => ({
          key,
          label: TAB_LABELS[key],
          incomplete: isTabIncomplete(calendar, key),
          dirty:
            key === "periods"
              ? dirty.periods
              : key === "day-types"
                ? dirty.dayTypes
                : Object.values(dirty.spans).some(Boolean),
        }))}
        active={showing}
        onSelect={setTab}
      />

      {/*
        Every tab stays mounted and the inactive ones are hidden, so
        switching away from a half-typed list does not throw it away.
        That is the whole reason this is tabs rather than a wizard:
        there is no step to be "on", only a section to be looking at.
      */}
      <div style={{ display: showing === "periods" ? "block" : "none" }}>
        <PeriodsEditor
          key={`periods-${revision.periods}`}
          periods={calendar.periods}
          readOnly={readOnly}
          onDirtyChange={(isDirty) => setDirty((d) => ({ ...d, periods: isDirty }))}
          onSave={async (rows) =>
            afterSave(
              "periods",
              await apiClient.put<Calendar>(`/api/v1/tou-calendars/${id}/periods`, {
                periods: rows.map((r) => ({ peakCode: r.peakCode, label: r.label })),
              }),
            )
          }
        />
        <NextTab to="day-types" label={TAB_LABELS["day-types"]} onSelect={setTab} />
      </div>

      <div style={{ display: showing === "day-types" ? "block" : "none" }}>
        <DayTypesEditor
          key={`day-types-${revision.dayTypes}`}
          dayTypes={calendar.dayTypes}
          readOnly={readOnly}
          holidaySetName={calendar.holidaySet?.name ?? null}
          onDirtyChange={(isDirty) => setDirty((d) => ({ ...d, dayTypes: isDirty }))}
          onSave={async (rows) =>
            afterSave(
              "dayTypes",
              await apiClient.put<Calendar>(`/api/v1/tou-calendars/${id}/day-types`, {
                dayTypes: rows.map((r) => ({
                  dayTypeCode: r.dayTypeCode,
                  label: r.label,
                  weekdays: r.weekdays,
                })),
              }),
            )
          }
        />
        <NextTab to="hours" label={TAB_LABELS.hours} onSelect={setTab} />
      </div>

      <div
        style={{
          display: showing === "hours" ? "flex" : "none",
          flexDirection: "column",
          gap: "10px",
        }}
      >
        {calendar.periods.length === 0 || calendar.dayTypes.length === 0 ? (
          <div data-testid="hours-blocked" style={{ fontSize: "12px", color: "var(--text-muted)" }}>
            Name the periods and the day types first — the hours are assigned to them.
          </div>
        ) : (
          <>
            {/*
              One season at a time. Chips rather than a dropdown
              because publishing needs every (season, day type) covered
              and a dropdown can only say which season is empty once
              somebody has opened it and gone looking.
            */}
            <SeasonChips
              seasons={calendar.seasonSet.seasons.map((s) => ({
                seasonCode: s.seasonCode,
                label: s.label,
                complete: !calendar.spanGroups.some(
                  (g) => g.seasonCode === s.seasonCode && g.spans.length === 0,
                ),
                dirty: calendar.dayTypes.some(
                  (d) => dirty.spans[spanKey(s.seasonCode, d.dayTypeCode)],
                ),
              }))}
              active={showingSeason ?? ""}
              onSelect={setSeason}
            />
            <PeriodLegend periods={calendar.periods} />

            {calendar.seasonSet.seasons.map((s) => (
              <div
                key={s.seasonCode}
                data-testid={`season-hours-${s.seasonCode}`}
                style={{
                  display: s.seasonCode === showingSeason ? "flex" : "none",
                  flexDirection: "column",
                  gap: "8px",
                }}
              >
                <div style={{ fontSize: "12px", color: "var(--text-secondary)", marginTop: "6px" }}>
                  {s.label} · {seasonDates(s)}
                </div>
                {calendar.dayTypes.map((dayType) => {
                  const group =
                    calendar.spanGroups.find(
                      (g) => g.seasonCode === s.seasonCode && g.dayTypeCode === dayType.dayTypeCode,
                    ) ?? {
                      seasonCode: s.seasonCode,
                      dayTypeCode: dayType.dayTypeCode,
                      spans: [],
                    };
                  return (
                    <div key={dayType.dayTypeCode}>
                      <div style={{ fontSize: "12px", marginBottom: "4px" }}>{dayType.label}</div>
                      <SpanEditor
                        key={`${s.seasonCode}-${dayType.dayTypeCode}-${revision.spans}`}
                        group={group}
                        periods={calendar.periods}
                        readOnly={readOnly}
                        /*
                         * Still every other group, including the other
                         * seasons' — "winter is summer with a shorter
                         * peak" is the common edit, and it is the one
                         * reason to reach across the chips.
                         */
                        otherGroups={calendar.spanGroups.filter(
                          (g) =>
                            g.spans.length > 0 &&
                            !(
                              g.seasonCode === s.seasonCode &&
                              g.dayTypeCode === dayType.dayTypeCode
                            ),
                        )}
                        onDirtyChange={(isDirty) =>
                          markSpanDirty(s.seasonCode, dayType.dayTypeCode, isDirty)
                        }
                        onSave={async (spans) =>
                          afterSave(
                            "spans",
                            await apiClient.put<Calendar>(`/api/v1/tou-calendars/${id}/spans`, {
                              seasonCode: s.seasonCode,
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
            ))}

            {/*
              After the hours, not before them.

              This answers "what period would a bill use for Friday 3
              July at 5:15 pm, and why" — a check somebody makes
              *before publishing*, which is the last thing they do. At
              the top of a half-built calendar it was the first thing a
              person met: a date box over a calendar with no periods,
              no day types and no hours, which answers nothing and
              reads as a step they were supposed to complete.
            */}
            {calendar.spanGroups.some((group) => group.spans.length > 0) && (
              <SpotCheck calendarId={id} />
            )}
          </>
        )}
      </div>

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
