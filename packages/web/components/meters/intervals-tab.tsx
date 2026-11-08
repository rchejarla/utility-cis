"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { MeterIntervalSeries } from "@utility-cis/shared";
import { DatePicker } from "@/components/ui/date-picker";
import { apiClient } from "@/lib/api-client";
import { useToast } from "@/components/ui/toast";

/**
 * What a meter actually reported, interval by interval (spec 26,
 * TOU-INT-9).
 *
 * The question a customer disputing a time-of-use bill is really
 * asking — *what did the meter say at 6pm* — and the only place a hole
 * the coverage queue reports can be seen. Until this, an AMI meter's
 * month existed on screen only as the three `meter_read` buckets the
 * roll-up derived from it.
 *
 * **Bars, not a line.** A line chart joins the point before a gap to
 * the point after it and draws a confident straight line through data
 * that does not exist. The whole value here is that an absent interval
 * is *absent*, so each one is its own bar and a hole is a hole.
 *
 * **Coloured by quality**, because `actual` and `estimated` are
 * different claims about the same hour, and a chart that paints them
 * alike hides the one fact a disputed bill turns on.
 */

const QUALITY_COLOUR: Record<string, string> = {
  actual: "var(--accent-primary)",
  estimated: "var(--warning)",
  missing: "var(--danger)",
  edited: "var(--info)",
};

const DAY_MS = 86_400_000;

/** `YYYY-MM-DD` for a UTC instant. */
const isoDay = (at: Date) => at.toISOString().slice(0, 10);

/** Minutes, as a person reads a hole in a day. */
function duration(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}

/**
 * The time on the tenant's own clock.
 *
 * Not UTC, which is what this drew until somebody looked at the chart:
 * a household's evening peak appeared at midnight, because the hours
 * were UTC hours. A customer disputing a peak charge means *their*
 * five o'clock, and the TOU calendar classifies by the same clock —
 * so a chart in UTC answers a question nobody asked.
 */
const clock = (iso: string, timeZone: string) =>
  new Date(iso).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    timeZone,
  });

export function IntervalsTab({
  meterId,
  initialDay,
}: {
  meterId: string;
  /**
   * The day to open on, when something sent the reader here to look at
   * one — the coverage queue does, naming a meter and a day it lost
   * data on. Without it the service answers with the meter's most
   * recent day.
   */
  initialDay?: string | null;
}) {
  const { toast } = useToast();
  const [day, setDay] = useState<string | null>(initialDay ?? null);
  const [series, setSeries] = useState<MeterIntervalSeries | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      // No day on the first load: the service answers with the meter's
      // most recent one, so the tab says something without being asked
      // a question first.
      const query = day ? `?from=${day}&to=${day}` : "";
      const next = await apiClient.get<MeterIntervalSeries>(
        `/api/v1/meters/${meterId}/intervals${query}`,
      );
      setSeries(next);
      if (!day) setDay(next.from.slice(0, 10));
    } catch (err) {
      toast(err instanceof Error ? err.message : "Could not load intervals", "error");
    } finally {
      setLoading(false);
    }
  }, [meterId, day, toast]);

  useEffect(() => {
    load();
  }, [load]);

  const step = (days: number) => {
    const base = day ? new Date(`${day}T00:00:00.000Z`) : new Date();
    setDay(isoDay(new Date(base.getTime() + days * DAY_MS)));
  };

  if (loading && !series) {
    return <div style={{ color: "var(--text-muted)", padding: "28px 0" }}>Loading intervals…</div>;
  }

  if (series && !series.reportsIntervals) {
    return (
      <div style={{ color: "var(--text-muted)", padding: "28px 0", fontSize: 13 }}>
        {/*
         * Not "no data": a meter that has never reported an interval
         * is a different fact from a day with none, and saying the
         * same thing for both would make the second invisible.
         */}
        This meter does not report interval data. Register reads are under History.
      </div>
    );
  }

  const zone = series?.timeZone ?? "UTC";

  const data = (series?.intervals ?? []).map((i) => ({
    at: i.intervalStart,
    label: clock(i.intervalStart, zone),
    quantity: Number(i.quantity),
    quality: i.quality,
    minutes: i.lengthMinutes,
  }));

  const gaps = series?.summary.gaps ?? [];
  const estimated = series?.summary.byQuality.estimated ?? 0;

  return (
    <div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          marginBottom: 14,
          flexWrap: "wrap",
        }}
      >
        <button onClick={() => step(-1)} style={navButton} aria-label="Previous day">
          ←
        </button>
        {/*
          * A picker as well as the arrows. Stepping is right for "what
          * about the day before", which is the common follow-up; it is
          * absurd for "the 3rd of last month", and a meter's data goes
          * back as far as the head-end has sent it.
          */}
        <DatePicker
          value={day ?? ""}
          onChange={(next) => next && setDay(next)}
          placeholder="Pick a day"
          /*
           * `--bg-card`, so the trigger matches the surfaces around it
           * rather than the picker's default `--bg-deep`, which is the
           * page tint and reads as a coloured box in this row. A token
           * rather than white, so dark mode stays dark.
           */
          triggerStyle={{ background: "var(--bg-card)", border: "1px solid var(--border)" }}
        />
        <button onClick={() => step(1)} style={navButton} aria-label="Next day">
          →
        </button>
        <span style={{ marginLeft: "auto", fontSize: 12, color: "var(--text-muted)" }}>
          Times in {zone} — the clock this tenant's TOU periods are set by
        </span>
      </div>

      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 14 }}>
        <Stat label="Total" value={`${Number(series?.summary.total ?? 0).toFixed(2)} ${series?.uomCode ?? ""}`} />
        <Stat label="Reported" value={`${series?.summary.count ?? 0} intervals`} />
        <Stat
          label="Coverage"
          value={
            gaps.length === 0
              ? "covers the whole range"
              : `${gaps.length} ${gaps.length === 1 ? "hole" : "holes"}`
          }
          tone={gaps.length === 0 ? "ok" : "warn"}
        />
        {estimated > 0 && <Stat label="Quality" value={`${estimated} estimated`} tone="warn" />}
      </div>

      {gaps.length > 0 && (
        <div
          style={{
            background: "var(--warning-subtle)",
            border: "1px solid var(--warning)",
            borderRadius: "var(--radius)",
            padding: "10px 14px",
            marginBottom: 14,
            fontSize: 12,
          }}
        >
          <b>Missing data.</b>{" "}
          {gaps
            .map((g) => `${duration(g.minutes)} from ${clock(g.startsAt, zone)}`)
            .join(", ")}
          . A billing run refuses a period it cannot cover, so these are what it would refuse on.
        </div>
      )}

      {data.length === 0 ? (
        <div style={{ color: "var(--text-muted)", padding: "28px 0", fontSize: 13 }}>
          This meter reported nothing on this day. It reports intervals on other days, so this is a
          hole rather than a meter that never sends any.
        </div>
      ) : (
        <div
          style={{
            background: "var(--bg-card)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius)",
            padding: "14px 10px 4px",
            height: 300,
          }}
        >
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data} margin={{ top: 4, right: 8, bottom: 4, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border-subtle)" vertical={false} />
              <XAxis
                dataKey="label"
                tick={{ fontSize: 10, fill: "var(--text-muted)" }}
                interval="preserveStartEnd"
                minTickGap={24}
              />
              <YAxis
                tick={{ fontSize: 10, fill: "var(--text-muted)" }}
                width={44}
                label={undefined}
              />
              <Tooltip
                contentStyle={{
                  background: "var(--bg-card)",
                  border: "1px solid var(--border)",
                  borderRadius: 8,
                  fontSize: 12,
                }}
                /*
                 * Typed loosely on purpose: Recharts 3's `Formatter`
                 * describes a value that may be a number, a string or
                 * an array, and narrowing it here would be a lie about
                 * what the library can hand over. The payload is this
                 * chart's own row, which is why its shape is asserted
                 * rather than inferred.
                 */
                formatter={((value: unknown, _name: unknown, item: unknown) => {
                  const quality = (item as { payload?: { quality?: string } })?.payload?.quality;
                  return [`${String(value)} ${series?.uomCode ?? ""}${quality ? ` · ${quality}` : ""}`, "Interval"];
                }) as never}
              />
              <Bar dataKey="quantity" isAnimationActive={false}>
                {data.map((d) => (
                  <Cell
                    key={d.at}
                    fill={QUALITY_COLOUR[d.quality] ?? "var(--text-muted)"}
                  />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "ok" | "warn";
}) {
  const colour =
    tone === "warn" ? "var(--warning)" : tone === "ok" ? "var(--success)" : "var(--text-primary)";
  return (
    <div
      style={{
        background: "var(--bg-card)",
        border: "1px solid var(--border)",
        borderRadius: "var(--radius)",
        padding: "8px 14px",
        minWidth: 140,
      }}
    >
      <div
        style={{
          fontSize: 10,
          textTransform: "uppercase",
          letterSpacing: "0.06em",
          color: "var(--text-muted)",
          marginBottom: 4,
        }}
      >
        {label}
      </div>
      <div style={{ fontSize: 14, fontWeight: 600, color: colour }}>{value}</div>
    </div>
  );
}

const navButton: React.CSSProperties = {
  padding: "5px 12px",
  fontSize: 12,
  fontWeight: 500,
  background: "var(--bg-card)",
  color: "var(--text-secondary)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius)",
  cursor: "pointer",
  fontFamily: "inherit",
};
