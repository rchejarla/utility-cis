"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { PageHeader } from "@/components/ui/page-header";
import { FormField } from "@/components/ui/form-field";
import { AccessDenied } from "@/components/ui/access-denied";
import { apiClient } from "@/lib/api-client";
import { usePermission } from "@/lib/use-permission";

/**
 * Create a TOU calendar — the header only. Its periods, day types and
 * hours are built on the editor, because they are lists with invariants
 * and a create form cannot hold a half-built one.
 */

interface SeasonSet {
  id: string;
  name: string;
  publishedAt: string | null;
  seasons: Array<{ seasonCode: string; label: string }>;
}

interface HolidayList {
  id: string;
  name: string;
  _count?: { rules: number };
}

const inputStyle = {
  padding: "8px 12px",
  borderRadius: "var(--radius)",
  border: "1px solid var(--border)",
  background: "var(--bg-elevated)",
  color: "var(--text-primary)",
  fontSize: "13px",
  fontFamily: "inherit",
  outline: "none",
  width: "100%",
  boxSizing: "border-box" as const,
};

/**
 * A short list of zones rather than every IANA name.
 *
 * The server resolves whatever is sent through `Intl` and refuses a name
 * it does not know, so this is convenience and not validation — a
 * tenant outside these zones types their own. Offering all ~600 names
 * in a select would be worse than typing one.
 */
const COMMON_ZONES = [
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Phoenix",
  "America/Los_Angeles",
  "America/Anchorage",
  "Pacific/Honolulu",
];

export default function NewTouCalendarPage() {
  const router = useRouter();
  const { canCreate } = usePermission("rate_schedules");

  const [seasonSets, setSeasonSets] = useState<SeasonSet[]>([]);
  const [holidayLists, setHolidayLists] = useState<HolidayList[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [form, setForm] = useState({
    name: "",
    effectiveDate: "",
    seasonSetId: "",
    touHolidayListId: "",
    timeZone: "America/Denver",
    clockBasis: "prevailing",
  });

  useEffect(() => {
    Promise.all([
      apiClient.get<{ data: SeasonSet[] }>("/api/v1/season-sets"),
      apiClient.get<{ data: HolidayList[] }>("/api/v1/tou-holiday-lists"),
    ])
      .then(([sets, lists]) => {
        setSeasonSets(sets.data ?? []);
        setHolidayLists(lists.data ?? []);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Could not load season sets"))
      .finally(() => setLoaded(true));
  }, []);

  const set = (key: string, value: unknown) => setForm((prev) => ({ ...prev, [key]: value }));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const created = await apiClient.post<{ id: string }>("/api/v1/tou-calendars", {
        name: form.name,
        effectiveDate: form.effectiveDate,
        seasonSetId: form.seasonSetId,
        ...(form.touHolidayListId ? { touHolidayListId: form.touHolidayListId } : {}),
        timeZone: form.timeZone,
        clockBasis: form.clockBasis,
      });
      router.push(`/tou-calendars/${created.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create this calendar");
    } finally {
      setSubmitting(false);
    }
  };

  if (!canCreate) return <AccessDenied />;

  return (
    <div style={{ maxWidth: "760px" }}>
      <PageHeader title="New TOU Calendar" subtitle="Which hours cost what, from a given date" />

      <form onSubmit={submit}>
        <div
          style={{
            background: "var(--bg-card)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius)",
            padding: "24px",
            display: "flex",
            flexDirection: "column",
            gap: "20px",
          }}
        >
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px" }}>
            <FormField label="Name" required>
              <input
                style={inputStyle}
                value={form.name}
                placeholder="Time of Day 5-8pm"
                onChange={(e) => set("name", e.target.value)}
                required
              />
            </FormField>
            <FormField
              label="In force from"
              required
              tooltip="A calendar is versioned by name and date. A later version of the same name supersedes this one from its own date; this one keeps pricing the bills it already priced."
            >
              <input
                type="date"
                style={inputStyle}
                value={form.effectiveDate}
                onChange={(e) => set("effectiveDate", e.target.value)}
                required
              />
            </FormField>
          </div>

          <FormField
            label="Season set"
            required
            tooltip="The calendar's hours are keyed on this set's season codes. It names a set rather than following whichever is in force, because a published calendar is immutable — if the in-force set changed, its hours would reference codes that no longer exist."
          >
            <select
              style={inputStyle}
              value={form.seasonSetId}
              onChange={(e) => set("seasonSetId", e.target.value)}
              required
            >
              <option value="">Select a season set…</option>
              {seasonSets.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} ({s.seasons.length} season{s.seasons.length === 1 ? "" : "s"})
                  {s.publishedAt ? "" : " — draft"}
                </option>
              ))}
            </select>
          </FormField>

          {loaded && seasonSets.length === 0 && (
            <div data-testid="no-season-sets" style={{ fontSize: "12px", color: "var(--warning)" }}>
              There are no season sets yet, and a calendar cannot be created without one. The
              season editor is not built — a set has to be inserted directly for now.
            </div>
          )}

          <FormField
            label="Holiday list"
            tooltip="Optional. A tariff that does not distinguish holidays names none, and days are then classified by their weekday alone. Lists are shared across calendars, because a utility's holidays do not vary by tariff."
          >
            <select
              style={inputStyle}
              value={form.touHolidayListId}
              onChange={(e) => set("touHolidayListId", e.target.value)}
            >
              <option value="">No holiday list</option>
              {holidayLists.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                  {l._count ? ` (${l._count.rules} rules)` : ""}
                </option>
              ))}
            </select>
          </FormField>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px" }}>
            <FormField
              label="Time zone"
              required
              tooltip="The tariff's zone, not the customer's: where someone lives never changes which hours are on-peak. An IANA name — the server refuses one it does not recognise."
            >
              <input
                style={inputStyle}
                list="tou-zones"
                value={form.timeZone}
                onChange={(e) => set("timeZone", e.target.value)}
                required
              />
              <datalist id="tou-zones">
                {COMMON_ZONES.map((z) => (
                  <option key={z} value={z} />
                ))}
              </datalist>
            </FormField>
            <FormField
              label="Clock"
              required
              tooltip="Prevailing follows daylight saving, which is the common case. Standard means standard time all year, so a 4–9pm peak runs 5–10pm by the summer clock."
            >
              <select
                style={inputStyle}
                value={form.clockBasis}
                onChange={(e) => set("clockBasis", e.target.value)}
              >
                <option value="prevailing">Prevailing — follows daylight saving</option>
                <option value="standard">Standard time all year</option>
              </select>
            </FormField>
          </div>

          {error && (
            <div role="alert" style={{ fontSize: "12px", color: "var(--danger)" }}>
              {error}
            </div>
          )}

          <div style={{ display: "flex", gap: "8px", justifyContent: "flex-end" }}>
            <button
              type="button"
              onClick={() => router.push("/tou-calendars")}
              style={{
                padding: "8px 20px",
                borderRadius: "var(--radius)",
                border: "1px solid var(--border)",
                background: "transparent",
                color: "var(--text-secondary)",
                fontSize: "13px",
                cursor: "pointer",
                fontFamily: "inherit",
              }}
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              style={{
                padding: "8px 20px",
                borderRadius: "var(--radius)",
                border: "none",
                background: "var(--accent-primary)",
                color: "#fff",
                fontSize: "13px",
                fontWeight: 500,
                cursor: submitting ? "not-allowed" : "pointer",
                opacity: submitting ? 0.7 : 1,
                fontFamily: "inherit",
              }}
            >
              {submitting ? "Creating…" : "Create calendar"}
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}
