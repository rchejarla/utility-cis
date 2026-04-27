"use client";

import { useMemo } from "react";
import { StatusBadge } from "@/components/ui/status-badge";

export interface HistoryEvent {
  id: string;
  label: string;
  sublabel?: string;
  startDate: string;
  endDate: string | null;
  status: string;
  href?: string;
}

export interface HistoryTimelineProps {
  events: HistoryEvent[];
  /** Optional title rendered above the timeline. */
  title?: string;
  /** Empty-state message when events is empty. */
  emptyMessage?: string;
}

/**
 * Vertical timeline rendering every event as a card with a date-range
 * ribbon. Each card is clickable when `href` is set. Used by both the
 * premise History tab (one timeline per commodity) and the meter
 * History tab (one timeline per assignment chain).
 *
 * Why vertical not horizontal: a horizontal block-strip layout looks
 * nice at desktop widths but degrades poorly on tablet/mobile (Tier 2
 * targets per docs/bozeman/02-mobile-and-responsive-ui.md). Vertical
 * cards reflow naturally at every breakpoint and the date range is
 * still legible at a glance via the ribbon.
 */
export function HistoryTimeline({
  events,
  title,
  emptyMessage = "No history yet.",
}: HistoryTimelineProps) {
  const sorted = useMemo(
    () =>
      [...events].sort((a, b) => {
        // Newest first — operators are usually checking recent state.
        const aStart = new Date(a.startDate).getTime();
        const bStart = new Date(b.startDate).getTime();
        return bStart - aStart;
      }),
    [events],
  );

  // Compute timeline bounds for the ribbon proportions. If everything
  // is open-ended we anchor the right edge to today; otherwise we
  // anchor to the latest known endDate.
  const { minTs, maxTs } = useMemo(() => {
    if (sorted.length === 0) return { minTs: 0, maxTs: 1 };
    const starts = sorted.map((e) => new Date(e.startDate).getTime());
    const ends = sorted.map((e) =>
      e.endDate ? new Date(e.endDate).getTime() : Date.now(),
    );
    return { minTs: Math.min(...starts), maxTs: Math.max(...ends) };
  }, [sorted]);

  if (sorted.length === 0) {
    return (
      <div style={{ color: "var(--text-muted)", fontSize: "13px", padding: "12px 0" }}>
        {emptyMessage}
      </div>
    );
  }

  return (
    <div>
      {title && (
        <h3
          style={{
            fontSize: "13px",
            fontWeight: 600,
            color: "var(--text-muted)",
            margin: "0 0 8px 0",
            textTransform: "uppercase",
            letterSpacing: "0.04em",
          }}
        >
          {title}
        </h3>
      )}
      <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
        {sorted.map((event) => {
          const startTs = new Date(event.startDate).getTime();
          const endTs = event.endDate ? new Date(event.endDate).getTime() : Date.now();
          const range = maxTs - minTs || 1;
          const offsetPct = ((startTs - minTs) / range) * 100;
          const widthPct = Math.max(((endTs - startTs) / range) * 100, 2);

          const card = (
            <div
              style={{
                background: "var(--bg-card)",
                border: "1px solid var(--border)",
                borderRadius: "var(--radius, 10px)",
                padding: "12px 14px",
                display: "flex",
                flexDirection: "column",
                gap: "8px",
                cursor: event.href ? "pointer" : "default",
                transition: "border-color 120ms ease",
              }}
              onMouseEnter={(e) => {
                if (event.href) {
                  (e.currentTarget as HTMLElement).style.borderColor =
                    "var(--accent-primary)";
                }
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLElement).style.borderColor = "var(--border)";
              }}
            >
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  gap: "12px",
                  flexWrap: "wrap",
                }}
              >
                <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
                  <span style={{ fontSize: "14px", fontWeight: 500 }}>{event.label}</span>
                  {event.sublabel && (
                    <span style={{ fontSize: "12px", color: "var(--text-muted)" }}>
                      {event.sublabel}
                    </span>
                  )}
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
                  <span style={{ fontSize: "12px", color: "var(--text-muted)" }}>
                    {event.startDate}
                    {" → "}
                    {event.endDate ?? "ongoing"}
                  </span>
                  <StatusBadge status={event.status} />
                </div>
              </div>

              {/* Date-range ribbon. Position scaled to the timeline bounds. */}
              <div
                style={{
                  position: "relative",
                  height: "4px",
                  background: "var(--bg-deep)",
                  borderRadius: "2px",
                  overflow: "hidden",
                }}
              >
                <div
                  style={{
                    position: "absolute",
                    left: `${offsetPct}%`,
                    width: `${widthPct}%`,
                    top: 0,
                    bottom: 0,
                    background: event.endDate
                      ? "var(--text-muted)"
                      : "var(--accent-primary)",
                    borderRadius: "2px",
                  }}
                />
              </div>
            </div>
          );

          return event.href ? (
            <a
              key={event.id}
              href={event.href}
              style={{ textDecoration: "none", color: "inherit" }}
            >
              {card}
            </a>
          ) : (
            <div key={event.id}>{card}</div>
          );
        })}
      </div>
    </div>
  );
}
