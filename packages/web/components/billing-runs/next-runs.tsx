import Link from "next/link";

/**
 * What *will* run, above the table of what did (SCH-BILL-12).
 *
 * The runs table is a history. Nothing on this screen said whether the
 * next one is going to happen, which is the question an operator has on
 * the 8th rather than the 11th — and the most useful answer it can give
 * is that nothing will, because billing is the one scheduler that
 * defaults to off.
 *
 * Every time here is printed in the **tenant's** zone, which is the zone
 * the hour was configured in. The reader's own zone would show an hour
 * nobody set.
 */

export type ScheduleReason = "scheduled" | "overdue" | "unsupportedFrequency" | "never";

export interface CycleSchedule {
  billingCycleId: string;
  cycleCode: string;
  cycleName: string;
  nextRunAt: string | null;
  reason: ScheduleReason;
  windowEnd: string | null;
  alreadyRun: boolean;
}

export interface BillingSchedule {
  enabled: boolean;
  timezone: string;
  runHourLocal: number | null;
  cycles: CycleSchedule[];
}

/**
 * The instant in the tenant's zone.
 *
 * `timeZone` is passed to `Intl` rather than the string being sliced:
 * the whole point is the tenant's local hour, and a date arithmetic
 * shortcut would land an hour out across a DST change — on the one
 * screen whose job is to say when something fires.
 */
function inTenantZone(iso: string, timezone: string): string {
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date(iso));
  } catch {
    // An unknown zone must not blank the panel; the instant is still
    // true, and UTC is the honest label for it.
    return `${new Date(iso).toISOString().slice(0, 16).replace("T", " ")} UTC`;
  }
}

const CARD: React.CSSProperties = {
  background: "var(--bg-surface)",
  border: "1px solid var(--border-default)",
  borderRadius: 8,
  marginBottom: 20,
  overflow: "hidden",
};

const HEAD: React.CSSProperties = {
  padding: "8px 14px",
  fontSize: 11,
  fontWeight: 600,
  textTransform: "uppercase",
  letterSpacing: "0.06em",
  color: "var(--text-muted)",
  background: "var(--bg-elevated)",
};

export function NextRuns({ schedule }: { schedule: BillingSchedule }) {
  /*
   * A tenant with no active cycle has nothing to say here, and the
   * empty table below already says it once.
   *
   * `Array.isArray` rather than a length check on a trusted shape: this
   * renders straight from a network payload, and a response that is not
   * the expected object would otherwise throw inside render and take
   * the whole Billing Runs screen down with it — over a panel that is
   * the least important thing on it.
   */
  if (!Array.isArray(schedule?.cycles) || schedule.cycles.length === 0) return null;

  return (
    <div style={CARD}>
      <div style={HEAD}>Next scheduled run</div>

      {!schedule.enabled && (
        <div
          style={{
            padding: "10px 14px",
            fontSize: 13,
            color: "var(--text-secondary)",
            borderBottom: "1px solid var(--border-subtle)",
          }}
        >
          <strong style={{ color: "var(--warning)" }}>
            Nothing will start a billing run.
          </strong>{" "}
          Billing automation is off for this tenant, so somebody has to open each cycle on its
          bill day and press Start.{" "}
          <Link href="/settings/automation" style={{ color: "var(--accent-primary)" }}>
            Automation settings
          </Link>
          .
        </div>
      )}

      {schedule.cycles.map((c) => (
        <div
          key={c.billingCycleId}
          style={{
            padding: "8px 14px",
            borderTop: "1px solid var(--border-subtle)",
            display: "flex",
            gap: 10,
            flexWrap: "wrap",
            alignItems: "baseline",
            fontSize: 13,
          }}
        >
          <span style={{ fontWeight: 600 }}>{c.cycleCode}</span>
          <span style={{ color: "var(--text-muted)" }}>{c.cycleName}</span>

          {c.reason === "unsupportedFrequency" ? (
            /* An active cycle the rate engine cannot bill is worth an
               operator's attention; a blank cell would read as "no date
               yet". */
            <span style={{ color: "var(--danger)" }}>
              Cannot be billed automatically — its frequency is not supported
            </span>
          ) : c.nextRunAt === null ? (
            <span style={{ color: "var(--text-muted)" }}>No run in the next month</span>
          ) : (
            <>
              {c.reason === "overdue" && (
                /* On the 12th, "scheduled for the 10th" is not true.
                   The dispatcher catches up, so this is late and not
                   lost — but it is the distinction the panel exists
                   for. */
                <span style={{ color: "var(--warning)", fontWeight: 600 }}>Overdue —</span>
              )}
              <span>
                {schedule.enabled ? "" : "would run "}
                {inTenantZone(c.nextRunAt, schedule.timezone)}
              </span>
              {c.windowEnd && (
                <span style={{ color: "var(--text-muted)", fontSize: 12 }}>
                  for the window ending {c.windowEnd}
                  {c.alreadyRun ? " (already run)" : ""}
                </span>
              )}
            </>
          )}
        </div>
      ))}
    </div>
  );
}
