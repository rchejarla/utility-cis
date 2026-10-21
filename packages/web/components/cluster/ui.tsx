"use client";

import type { QueueHealth } from "./types";

/**
 * The pieces every Cluster page draws with.
 *
 * Here rather than in one of the pages, because Overview, Workers and
 * Queues all render tables of the same shape and a tenant can appear on
 * any of them — and a second copy of the tenant rules is how "All
 * tenants" came to mean two different things in the first place.
 */

export const card: React.CSSProperties = {
  background: "var(--bg-card)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius)",
  overflow: "hidden",
};

export const cellStyle: React.CSSProperties = {
  padding: "8px 14px",
  fontSize: 12,
  borderTop: "1px solid var(--border-subtle)",
  verticalAlign: "top",
};

export const DASH = <span style={{ color: "var(--text-muted)" }}>—</span>;

/**
 * A long value cut with an ellipsis, with the whole of it on hover.
 *
 * A `max-width` on a `<td>` is ignored under `table-layout: auto`, so the
 * clipping has to happen on a block inside the cell. Used for a BullMQ
 * job id, which runs to `repeat:notification-send-cron:1792590070000` and
 * wrapped to three lines in a column where every other row was one.
 */
export function Clipped({ text, width }: { text: string; width: number }) {
  return (
    <span
      title={text}
      style={{
        display: "block",
        maxWidth: width,
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
      }}
    >
      {text}
    </span>
  );
}

export function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

export function shortAge(seconds: number): string {
  return seconds < 120 ? `${seconds}s` : `${Math.round(seconds / 60)}m`;
}

/**
 * A due time in the past.
 *
 * The whole signal is "due two days ago", and a bare timestamp makes the
 * reader do the subtraction — which is how a stalled scheduler goes
 * unnoticed. Seen while building this: audit-retention's repeatable sat
 * due 2026-10-18 while the date was the 20th, because no worker was up to
 * run it and re-arm it.
 */
export function isOverdue(runsAt: string): boolean {
  return new Date(runsAt).getTime() < Date.now();
}

/** Trouble first; the rest keep the registry's order. */
export function troubledFirst(queues: QueueHealth[]): QueueHealth[] {
  const score = (q: QueueHealth) =>
    q.counts.failed > 0 || q.dlqDepth > 0 || q.paused ? 0 : 1;
  return [...queues].sort((a, b) => score(a) - score(b));
}

export function Th({
  children,
  align,
  className,
}: {
  children?: React.ReactNode;
  align?: "right";
  /** `col-hide-sm` / `col-hide-md`; see the note in globals.css. */
  className?: string;
}) {
  return (
    <th
      scope="col"
      className={className}
      style={{
        padding: "8px 14px",
        textAlign: align ?? "left",
        fontSize: 11,
        fontWeight: 600,
        textTransform: "uppercase",
        letterSpacing: "0.06em",
        color: "var(--text-muted)",
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </th>
  );
}

/** A section heading above a table, with a count or state on the right. */
export function CardHead({ left, right }: { left: React.ReactNode; right?: React.ReactNode }) {
  return (
    <div
      style={{
        display: "flex",
        gap: 12,
        alignItems: "baseline",
        justifyContent: "space-between",
        flexWrap: "wrap",
        padding: "10px 14px",
        background: "var(--bg-elevated)",
        borderBottom: "1px solid var(--border-subtle)",
      }}
    >
      <span
        style={{
          fontSize: 11,
          fontWeight: 600,
          textTransform: "uppercase",
          letterSpacing: "0.06em",
          color: "var(--text-muted)",
        }}
      >
        {left}
      </span>
      {right && <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>{right}</span>}
    </div>
  );
}

/** One action: a job verb, or a worker's start and stop. */
export function Verb({
  label,
  busy,
  onClick,
  loud,
  ariaLabel,
}: {
  label: string;
  busy: boolean;
  onClick: () => void;
  loud?: boolean;
  /**
   * What the button is called when its row cannot say so. Several rows
   * each hold a "Stop", and "Stop" alone does not tell a screen reader
   * which node or job it belongs to.
   */
  ariaLabel?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={ariaLabel}
      disabled={busy}
      style={{
        padding: "4px 12px",
        borderRadius: "var(--radius)",
        border: `1px solid ${loud ? "var(--danger)" : "var(--border)"}`,
        background: "transparent",
        color: loud ? "var(--danger)" : "var(--text-primary)",
        fontFamily: "inherit",
        fontSize: 12,
        fontWeight: 500,
        cursor: busy ? "not-allowed" : "pointer",
        whiteSpace: "nowrap",
        opacity: busy ? 0.6 : 1,
      }}
    >
      {busy ? "…" : label}
    </button>
  );
}

/**
 * The tenant a job or failure belongs to.
 *
 * Four different facts, and three of them used to render the same way. A
 * bare uuid is indistinguishable from a tenant name nobody recognises;
 * and a blank tenant means "every tenant" on one of the five cron sweeps
 * and "this job has lost its owner" on `billing-runs`, which read
 * identically as an empty cell. `tenancy` tells those two apart, and the
 * failure rows do not carry it — they fall back to the sweep reading,
 * which is what a cross-tenant failure is.
 */
export function Tenant({
  utilityId,
  utilityName,
  tenancy,
}: {
  utilityId: string | null;
  utilityName: string | null;
  tenancy?: "all-tenants" | "per-tenant";
}) {
  if (utilityName) {
    return <strong style={{ color: "var(--text-primary)" }}>{utilityName}</strong>;
  }
  if (utilityId) {
    return (
      <span style={{ color: "var(--warning)" }} title={utilityId}>
        {/* Both ends, because the seeded and test tenants differ only in
            their last few characters — the leading eight are zeroes on
            every one of them, so a head-only truncation told them apart
            not at all. */}
        {`Unknown tenant ${utilityId.slice(0, 8)}…${utilityId.slice(-4)}`}
      </span>
    );
  }
  if (tenancy === "per-tenant") {
    // Every job on this queue names a tenant. This one does not, so it
    // is malformed rather than shared.
    return <span style={{ color: "var(--danger)" }}>None named</span>;
  }
  return (
    <span
      style={{ color: "var(--text-muted)" }}
      title="A scheduled sweep: one job, running across every tenant"
    >
      All tenants
    </span>
  );
}
