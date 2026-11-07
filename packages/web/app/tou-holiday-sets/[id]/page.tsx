"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { PageHeader } from "@/components/ui/page-header";
import { StatusBadge } from "@/components/ui/status-badge";
import { AccessDenied } from "@/components/ui/access-denied";
import { apiClient } from "@/lib/api-client";
import { usePermission } from "@/lib/use-permission";

/**
 * The holiday set editor (spec 26, TOU-CAL-4).
 *
 * A list of dates and what each one is called. The dates are the
 * **observed** days — if the utility takes the Friday because the 4th is
 * a Saturday, the Friday is the row — because a rule like "nearest
 * weekday" is a computation nobody checked, and the whole point of
 * holding dates is that somebody reviewing the tariff can see which day
 * their bill will be cheap.
 *
 * Published is read-only, like a season set and for the same reason:
 * these dates decided what a bill cost.
 */

interface Holiday {
  id?: string;
  /** `YYYY-MM-DD`. Comes back as a timestamp and is cut to the date. */
  date: string;
  name: string;
}

interface CalendarUsingSet {
  id: string;
  name: string;
  effectiveDate: string;
  publishedAt: string | null;
}

interface HolidaySet {
  id: string;
  name: string;
  effectiveDate: string;
  publishedAt: string | null;
  holidays: Array<{ id: string; holidayDate: string; name: string }>;
  calendars: CalendarUsingSet[];
}

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

/** See the periods editor: a blank row's placeholder reads as a value. */
const blankInput = { border: "1px solid var(--danger)" };

const WEEKDAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

/**
 * The weekday a date falls on, beside the date.
 *
 * This is the one piece of arithmetic the operator should not have to do
 * in their head: the whole reason a holiday needs typing out year by
 * year is that it moves, and "Sat" next to 4 July is what prompts
 * somebody to put the Friday in instead.
 */
function weekdayOf(date: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const parsed = new Date(`${date}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) return null;
  return WEEKDAY_NAMES[parsed.getUTCDay()];
}

export default function TouHolidaySetEditorPage() {
  const params = useParams();
  const router = useRouter();
  const id = String(params.id);
  const { canView, canEdit } = usePermission("rate_schedules");

  const [set, setSet] = useState<HolidaySet | null>(null);
  const [rows, setRows] = useState<Holiday[]>([]);
  const [dirty, setDirty] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const loaded = await apiClient.get<HolidaySet>(`/api/v1/tou-holiday-sets/${id}`);
      setSet(loaded);
      setRows(
        loaded.holidays.map((h) => ({
          id: h.id,
          date: h.holidayDate.slice(0, 10),
          name: h.name,
        })),
      );
      setDirty(false);
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Could not load this holiday set");
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  const change = (next: Holiday[]) => {
    setRows(next);
    setDirty(true);
    setActionError(null);
  };

  const save = async () => {
    setBusy(true);
    setActionError(null);
    try {
      const updated = await apiClient.put<HolidaySet>(
        `/api/v1/tou-holiday-sets/${id}/holidays`,
        { holidays: rows.map((r) => ({ date: r.date, name: r.name })) },
      );
      setSet(updated);
      setRows(
        updated.holidays.map((h) => ({
          id: h.id,
          date: h.holidayDate.slice(0, 10),
          name: h.name,
        })),
      );
      setDirty(false);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Could not save these dates");
    } finally {
      setBusy(false);
    }
  };

  const publish = async () => {
    setBusy(true);
    setActionError(null);
    try {
      await apiClient.post(`/api/v1/tou-holiday-sets/${id}/publish`, {});
      await load();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Could not publish this holiday set");
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

  const incomplete = rows
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => row.date.trim() === "" || row.name.trim() === "");

  /*
   * Two dates on one row-list. The server refuses it too, with the date
   * in the message; held here so the save is not spent finding out.
   */
  const dates = rows.map((r) => r.date);
  const duplicates = [...new Set(dates.filter((d, i) => d !== "" && dates.indexOf(d) !== i))];

  const today = new Date().toISOString().slice(0, 10);
  const lastDate = rows.length === 0 ? null : rows.map((r) => r.date).sort().slice(-1)[0];
  const ahead = rows.filter((r) => r.date >= today).length;

  /**
   * Why Publish cannot be pressed yet, or null.
   *
   * Judged on **what is stored**, never on the rows on screen, because
   * publishing freezes the set the server holds. Both conditions are
   * things publishing would do wrong rather than refuse:
   *
   * - No dates: the server refuses it, so the button could only fail.
   * - Unsaved dates: the server would publish without them, and a
   *   published set is immutable — so they could never be added. That
   *   is worse than a refusal, because it succeeds.
   */
  const publishBlockedBecause: string | null =
    set.holidays.length === 0
      ? "Add at least one date first. A set with none cannot be published."
      : dirty
        ? "Save the dates first. Publishing freezes the set as it is stored, and a published set cannot be changed afterwards — so anything unsaved could never be added."
        : null;

  return (
    <div style={{ maxWidth: "880px", display: "flex", flexDirection: "column", gap: "16px" }}>
      <PageHeader
        title={set.name}
        subtitle={`In force from ${set.effectiveDate.slice(0, 10)} · ${rows.length} ${
          rows.length === 1 ? "date" : "dates"
        }`}
      />

      <div style={{ display: "flex", gap: "12px", alignItems: "center", flexWrap: "wrap" }}>
        <StatusBadge status={published ? "published" : "draft"} />
        {!published && canEdit && (
          <>
            {/*
              Beside the button and not only in its tooltip: a disabled
              control with no stated reason is a dead end, and the one
              thing somebody needs here is which of the two it is.
            */}
            {publishBlockedBecause && (
              <span
                data-testid="publish-blocked"
                style={{ fontSize: "12px", color: "var(--text-muted)", marginLeft: "auto" }}
              >
                {publishBlockedBecause}
              </span>
            )}
            <button
              type="button"
              onClick={publish}
              disabled={busy || publishBlockedBecause !== null}
              title={publishBlockedBecause ?? undefined}
              style={{
                marginLeft: publishBlockedBecause ? undefined : "auto",
                padding: "7px 16px",
                borderRadius: "var(--radius)",
                border: "none",
                background: "var(--accent-primary)",
                color: "#fff",
                fontSize: "13px",
                fontWeight: 500,
                cursor: busy || publishBlockedBecause ? "not-allowed" : "pointer",
                opacity: busy || publishBlockedBecause ? 0.5 : 1,
                fontFamily: "inherit",
              }}
            >
              {busy ? "Working…" : "Publish"}
            </button>
          </>
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
          Published on {set.publishedAt?.slice(0, 10)} and read-only. Calendars naming this set
          priced bills against exactly these days, so a correction is a new set with a later
          effective date — never an edit to this one.
        </div>
      )}

      {/*
        The horizon, which is what explicit dates cost.

        A calendar in force past its set's last date prices every holiday
        after that as an ordinary weekday, with nothing raised. The
        calendar's own validation refuses publishing into that state;
        this is where somebody can see it coming.
      */}
      {ahead === 0 && rows.length > 0 && (
        <div data-testid="set-ran-out" style={{ fontSize: "12px", color: "var(--warning)" }}>
          Every date in this set is in the past — the last is {lastDate}. A calendar naming it
          prices no day as a holiday from now on.
        </div>
      )}
      {ahead > 0 && ahead <= 3 && (
        <div data-testid="set-running-out" style={{ fontSize: "12px", color: "var(--warning)" }}>
          Only {ahead} {ahead === 1 ? "date is" : "dates are"} still ahead, the last on {lastDate}.
          A new set with next year&apos;s dates needs to exist before then, and the calendars below
          need new versions naming it.
        </div>
      )}

      {/*
        Who this reaches. Not a warning about editing — a published set
        cannot be edited at all — but what a new version has to be
        carried into, calendar by calendar.
      */}
      {set.calendars.length > 0 && (
        <div
          data-testid="calendars-using-set"
          style={{
            border: "1px solid var(--border)",
            borderRadius: "var(--radius)",
            padding: "12px 14px",
            background: "var(--bg-card)",
            fontSize: "12px",
          }}
        >
          <div style={{ fontWeight: 500, marginBottom: "6px" }}>
            {set.calendars.length} TOU{" "}
            {set.calendars.length === 1 ? "calendar names" : "calendars name"} this set
          </div>
          <ul style={{ margin: 0, paddingLeft: "18px", color: "var(--text-secondary)" }}>
            {set.calendars.map((calendar) => (
              <li key={calendar.id}>
                <a href={`/tou-calendars/${calendar.id}`} style={{ color: "var(--accent-primary)" }}>
                  {calendar.name}
                </a>{" "}
                (from {calendar.effectiveDate.slice(0, 10)})
                {calendar.publishedAt ? "" : " — draft"}
              </li>
            ))}
          </ul>
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
        {rows.length === 0 ? (
          <div data-testid="no-dates" style={{ fontSize: "12px", color: "var(--text-muted)" }}>
            No dates yet. A set with none cannot be published — a calendar naming it would appear
            to observe holidays while pricing every day by its weekday.
          </div>
        ) : (
          <table style={{ width: "100%", fontSize: "12px", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ textAlign: "left", color: "var(--text-muted)" }}>
                <th style={{ padding: "2px 4px 6px 0", fontWeight: 400, width: "22%" }}>Date</th>
                <th style={{ padding: "2px 4px 6px", fontWeight: 400, width: "14%" }}>Falls on</th>
                <th style={{ padding: "2px 4px 6px", fontWeight: 400 }}>Name</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((row, index) => (
                <tr key={row.id ?? `new-${index}`}>
                  <td style={{ padding: "2px 4px 2px 0" }}>
                    <input
                      type="date"
                      aria-label="Holiday date"
                      disabled={readOnly}
                      style={{
                        ...inputStyle,
                        ...(row.date.trim() === "" || duplicates.includes(row.date)
                          ? blankInput
                          : {}),
                      }}
                      value={row.date}
                      onChange={(e) =>
                        change(rows.map((r, i) => (i === index ? { ...r, date: e.target.value } : r)))
                      }
                    />
                  </td>
                  <td style={{ padding: "2px 4px", color: "var(--text-muted)" }}>
                    {weekdayOf(row.date) ?? "—"}
                  </td>
                  <td style={{ padding: "2px 4px" }}>
                    <input
                      aria-label="Holiday name"
                      disabled={readOnly}
                      style={{
                        ...inputStyle,
                        ...(row.name.trim() === "" ? blankInput : {}),
                      }}
                      value={row.name}
                      placeholder="Independence Day (observed)"
                      onChange={(e) =>
                        change(rows.map((r, i) => (i === index ? { ...r, name: e.target.value } : r)))
                      }
                    />
                  </td>
                  <td style={{ padding: "2px 0 2px 4px", textAlign: "right" }}>
                    {!readOnly && (
                      <button
                        type="button"
                        aria-label="Remove this date"
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
        )}

        <div style={{ fontSize: "11px", color: "var(--text-muted)" }}>
          Put in the day the utility observes, not the date on the wall calendar — if the 4th is a
          Saturday and the Friday is taken, the Friday is the row.
        </div>

        {incomplete.length > 0 && (
          <div data-testid="dates-incomplete" style={{ fontSize: "12px", color: "var(--warning)" }}>
            {incomplete.length === 1 ? "Row" : "Rows"}{" "}
            {incomplete.map(({ index }) => index + 1).join(", ")} still{" "}
            {incomplete.length === 1 ? "needs" : "need"} a date and a name.
          </div>
        )}

        {duplicates.length > 0 && (
          <div data-testid="duplicate-dates" style={{ fontSize: "12px", color: "var(--warning)" }}>
            {duplicates.join(", ")} {duplicates.length === 1 ? "is" : "are"} listed twice. One row
            per date — two names for one day would make &quot;is this a holiday&quot; ambiguous in
            the set that is supposed to answer it.
          </div>
        )}

        {!readOnly && (
          <div style={{ display: "flex", gap: "8px" }}>
            <button
              type="button"
              onClick={() => change([...rows, { date: "", name: "" }])}
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
              Add a date
            </button>
            <button
              type="button"
              onClick={save}
              disabled={!dirty || busy || incomplete.length > 0 || duplicates.length > 0}
              style={{
                marginLeft: "auto",
                padding: "5px 12px",
                borderRadius: "var(--radius)",
                border: "none",
                background: "var(--accent-primary)",
                color: "#fff",
                fontSize: "12px",
                fontWeight: 500,
                cursor:
                  !dirty || busy || incomplete.length > 0 || duplicates.length > 0
                    ? "not-allowed"
                    : "pointer",
                opacity:
                  !dirty || busy || incomplete.length > 0 || duplicates.length > 0 ? 0.6 : 1,
                fontFamily: "inherit",
              }}
            >
              {busy ? "Saving…" : "Save dates"}
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
                await apiClient.delete(`/api/v1/tou-holiday-sets/${id}`);
                router.push("/tou-holiday-sets");
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
