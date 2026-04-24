"use client";

export interface SlaCountdownProps {
  slaDueAt: string | null;
  slaBreached: boolean;
  status: string;
}

const TERMINAL = new Set(["COMPLETED", "CANCELLED", "FAILED"]);

/**
 * Tight, data-dense SLA countdown pill used by the SR queue + detail
 * pages. Terminal statuses suppress the countdown entirely (an em-dash
 * is rendered instead). Breach state uses --danger; within 8h uses
 * --warning; otherwise --success. Colors are theme-aware.
 */
export function SlaCountdown({ slaDueAt, slaBreached, status }: SlaCountdownProps) {
  if (TERMINAL.has(status) || !slaDueAt) {
    return <span style={{ color: "var(--text-muted)" }}>—</span>;
  }
  const due = new Date(slaDueAt).getTime();
  const ms = due - Date.now();
  if (slaBreached || ms < 0) {
    const hoursOver = Math.round(-ms / 3_600_000);
    return (
      <span style={{ color: "var(--danger)", fontWeight: 600, fontSize: 12 }}>
        BREACHED · {hoursOver}h over
      </span>
    );
  }
  const hoursLeft = Math.floor(ms / 3_600_000);
  const minutesLeft = Math.floor((ms % 3_600_000) / 60_000);
  const warn = ms < 8 * 3_600_000;
  return (
    <span
      style={{
        color: warn ? "var(--warning)" : "var(--success)",
        fontWeight: 600,
        fontSize: 12,
      }}
    >
      {hoursLeft >= 24
        ? `${Math.floor(hoursLeft / 24)}d ${hoursLeft % 24}h left`
        : `${hoursLeft}h ${minutesLeft}m left`}
    </span>
  );
}
