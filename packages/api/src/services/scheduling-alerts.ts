/**
 * Two conditions nobody is looking at a page to see.
 *
 * Every other thing on `/platform/cluster` answers a question an
 * operator arrived with. These two are the opposite: work that is
 * quietly not happening, where every count on the console looks
 * ordinary. A queue with no worker attached has the same counts as a
 * healthy one, and mail held behind a paused queue looks exactly like
 * mail that has already gone out.
 *
 * - **SCH-NODE-4.** An armed scheduler on a queue with nothing attached,
 *   past due by more than its own interval. "Nobody opened the console"
 *   and "the month did not bill" must not be the same event.
 * - **SCH-PAUSE-6.** `notification-send` paused for longer than the
 *   longest quiet-hours window any tenant has set, since nothing else
 *   reports mail that is queued rather than late.
 *
 * **These are detections, not a delivery channel.** They are computed
 * here and carried on the cluster report, which is what the spec's
 * "raises an alert, not only a row on a page" ultimately needs a channel
 * for — and this codebase has no outbound path for a *platform* alert:
 * every notification template is keyed `(utility_id, event_type)` and
 * addressed to a tenant's customer. Inventing one here would be a
 * delivery mechanism designed around two conditions, which is the wrong
 * order. What this does give is a verdict the overview page states
 * first, and a shape an eventual channel can consume unchanged.
 *
 * The conditions are pure functions over data the console already reads,
 * so the timezone and month-end cases are reachable without a live
 * Redis.
 */
import parser from "cron-parser";
import { logger } from "../lib/logger.js";
import { prisma } from "../lib/prisma.js";
import { runAsPlatform } from "../lib/tenant-context.js";
import { QUEUE_NAMES, type QueueName } from "../lib/queues.js";
import type { PauseRecord } from "../lib/queue-pause.js";
/*
 * Type-only, and that matters at runtime as well as on paper.
 * `scheduler-view.service` reaches `lib/schedulers.ts`, which imports
 * six worker modules for their scheduler-id constants — so a value
 * import here would drag the whole worker layer into everything that
 * touches the cluster console. It did, for one commit: the queue-health
 * unit suite began timing out in its `beforeEach` import, which is how
 * the weight showed up. The schedulers are passed in instead.
 */
import type { SchedulerView } from "./scheduler-view.service.js";

export type AlertKind = "unpromotedScheduler" | "mailHeldPaused";

export interface SchedulingAlert {
  kind: AlertKind;
  queue: QueueName | string;
  /** The scheduler this is about, where it is about one. */
  schedulerId: string | null;
  /** One sentence naming the condition and the action it implies. */
  message: string;
  /**
   * How long the condition has held, in seconds, or null where the
   * duration is not knowable. Reported rather than a timestamp: a bare
   * timestamp makes the reader do the subtraction, which is how a
   * stalled scheduler goes unnoticed in the first place.
   */
  forSeconds: number | null;
}

/**
 * The threshold for a held `notification-send` when no tenant has
 * configured quiet hours.
 *
 * Eight hours, because the span the product already treats as
 * acceptable silence is a night — `notificationQuietStart`/`End` default
 * to a window of about that, and a deployment with no tenant
 * configuration at all is a new one, where a pause outliving a night is
 * still the thing worth saying.
 */
export const QUIET_WINDOW_FALLBACK_MS = 8 * 3_600_000;

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

/**
 * How long this cron waits between fires.
 *
 * Measured as the gap between the next two occurrences rather than
 * declared in a second list beside each worker's own
 * `upsertJobScheduler` call: a threshold that can disagree with the
 * schedule it guards is worth less than no threshold. `cron-parser` is
 * BullMQ's own parser, which is what makes the two agree by
 * construction — including on the six-field every-ten-seconds pattern
 * `notification-send` uses, where reading five fields would give ten
 * minutes instead of ten seconds. (Written out rather than quoted: a
 * cron step inside a block comment ends the comment.)
 *
 * Null for a pattern it cannot read, never zero: zero would alert on
 * every scheduler the moment it went a second past due.
 */
export function cronIntervalMs(pattern: string | null, timezone: string | null): number | null {
  if (!pattern) return null;
  try {
    const it = parser.parseExpression(pattern, { tz: timezone ?? "UTC" });
    const first = it.next().getTime();
    const second = it.next().getTime();
    const gap = second - first;
    return gap > 0 ? gap : null;
  } catch (err) {
    logger.warn({ err, component: "scheduling-alerts", pattern }, "Could not read a cron pattern");
    return null;
  }
}

/** Its own interval, however the scheduler declares its cadence. */
function intervalOf(sched: SchedulerView): number | null {
  if (sched.everyMs !== null && sched.everyMs > 0) return sched.everyMs;
  return cronIntervalMs(sched.pattern, sched.timezone);
}

/**
 * Armed schedulers that nothing is promoting (SCH-NODE-4).
 *
 * Four things keep this quiet, and each is a false alarm it would
 * otherwise raise on every deployment:
 *
 * - **A worker is attached.** Late with a worker attached is a different
 *   fault — a slow or wedged handler — and this condition is about
 *   nothing being there at all.
 * - **Attachment is unknown.** `null` means this Redis will not list its
 *   clients (a managed Redis refuses `CLIENT LIST`), not that there are
 *   none.
 * - **The queue is paused.** Deliberate, and already reported by name
 *   with who, when and why.
 * - **Inside one interval.** A worker that restarted a second ago leaves
 *   a scheduler briefly past due with nothing attached. The threshold
 *   being the scheduler's own interval is what stops every deploy
 *   ringing.
 */
export function unpromotedSchedulerAlerts(
  schedulers: readonly SchedulerView[],
  now: Date = new Date(),
): SchedulingAlert[] {
  const alerts: SchedulingAlert[] = [];

  for (const sched of schedulers) {
    if (sched.workers !== 0) continue;
    if (sched.paused) continue;
    if (!sched.nextRunAt) continue;

    const due = Date.parse(sched.nextRunAt);
    if (!Number.isFinite(due)) continue;

    const lateMs = now.getTime() - due;
    const interval = intervalOf(sched);
    if (interval === null || lateMs <= interval) continue;

    const forSeconds = Math.floor(lateMs / 1000);
    alerts.push({
      kind: "unpromotedScheduler",
      queue: sched.queue,
      schedulerId: sched.schedulerId,
      forSeconds,
      /*
       * An orphan with nothing attached is both conditions at once, and
       * the two imply opposite actions — start a worker, or take the
       * cron out. Saying "start a worker" for a cron this build retired
       * would have an operator arm work no handler claims.
       */
      message: sched.orphan
        ? `${sched.schedulerId} is armed on ${sched.queue}, which this build does not know about, ` +
          `and nothing has promoted it for ${describe(forSeconds)}. Remove it rather than ` +
          "attaching a worker to it."
        : `${sched.schedulerId} has had no worker on ${sched.queue} for ${describe(forSeconds)}, ` +
          `so it has missed every fire since. Start a worker for ${sched.queue}.`,
    });
  }

  return alerts;
}

/** A tenant's configured quiet hours, as the two columns hold them. */
export interface QuietWindow {
  notificationQuietStart: string | null;
  notificationQuietEnd: string | null;
}

function minutesOf(hhmm: string | null): number | null {
  if (!hhmm) return null;
  const m = HHMM.exec(hhmm.trim());
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

/**
 * The widest quiet-hours window any tenant has set.
 *
 * The widest rather than the narrowest, because this is a threshold for
 * *not* alerting: a span one tenant already calls acceptable silence is
 * not a span to page somebody over. A window that wraps midnight is the
 * night it is — 21:00..07:00 is ten hours, and subtracting naively
 * would give a negative threshold that alerts the instant a pause
 * starts.
 */
export function longestQuietWindowMs(windows: readonly QuietWindow[]): number {
  let longest = 0;

  for (const w of windows) {
    const start = minutesOf(w.notificationQuietStart);
    const end = minutesOf(w.notificationQuietEnd);
    // A malformed window must not set the threshold — neither to zero,
    // which alerts instantly, nor to a day, which never alerts.
    if (start === null || end === null) continue;
    const span = end > start ? end - start : 24 * 60 - start + end;
    if (span > longest) longest = span;
  }

  return longest > 0 ? longest * 60_000 : QUIET_WINDOW_FALLBACK_MS;
}

/**
 * Mail held behind a paused `notification-send` (SCH-PAUSE-6).
 *
 * Takes `paused` and the record separately because they are separate
 * facts: resume never requires a record to exist, so a record survives
 * the resume and a running queue may still carry one. And a queue paused
 * straight in Redis is paused with no record at all — which is the one
 * case worth saying out loud regardless of duration, since there is
 * nobody to ask and no reason on file.
 *
 * `waiting` is reported but never gates the alert. Nothing queued is not
 * reassurance: the sweep is what moves messages into the queue, so a
 * paused queue with an empty backlog is mail that never got as far as
 * being late.
 */
export function mailHeldAlert(
  paused: boolean,
  record: PauseRecord | null,
  waiting: number,
  quietWindowMs: number,
  now: Date = new Date(),
): SchedulingAlert | null {
  if (!paused) return null;

  const queue = QUEUE_NAMES.notificationSend;
  const behind = `${waiting} ${waiting === 1 ? "message is" : "messages are"} queued behind it`;

  if (!record) {
    return {
      kind: "mailHeldPaused",
      queue,
      schedulerId: null,
      forSeconds: null,
      message:
        `${queue} is paused with no record of who paused it or why, so there is no way to tell ` +
        `how long it has been held — ${behind}. Resume it or record why it is stopped.`,
    };
  }

  const at = Date.parse(record.at);
  if (!Number.isFinite(at)) return null;

  const heldMs = now.getTime() - at;
  if (heldMs <= quietWindowMs) return null;

  const forSeconds = Math.floor(heldMs / 1000);
  return {
    kind: "mailHeldPaused",
    queue,
    schedulerId: null,
    forSeconds,
    message:
      `${queue} has been paused for ${describe(forSeconds)} by ${record.by} ("${record.reason}") — ` +
      `longer than any tenant's quiet hours, and ${behind}. No mail or SMS is going out.`,
  };
}

/** Hours and minutes, since "4500 seconds" is not a duration anyone reads. */
function describe(seconds: number): string {
  if (seconds < 90) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 90) return `${minutes} minutes`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} hours`;
  return `${Math.floor(hours / 24)} days`;
}

/**
 * Both conditions, over data the caller has already read.
 *
 * Composed by the route rather than inside `getQueueHealth`, which is
 * the rule `/api/v1/platform/queues` already states for the worker
 * status beside it: one call answers what is in the queues, another what
 * is armed, and only the page needs both at once.
 *
 * The quiet windows are read as the platform actor: this crosses every
 * tenant by design, and a confined connection would find no windows and
 * fall back to the declared span — reporting a threshold nobody set,
 * with no error to show for it.
 */
export async function getSchedulingAlerts(
  queues: readonly {
    name: string;
    paused: boolean;
    pauseRecord: PauseRecord | null;
    counts: { waiting: number };
  }[],
  /** Null when the schedulers could not be read — not "none armed". */
  schedulers: readonly SchedulerView[] | null,
  now: Date = new Date(),
): Promise<SchedulingAlert[]> {
  const alerts: SchedulingAlert[] = [];

  if (schedulers) alerts.push(...unpromotedSchedulerAlerts(schedulers, now));

  const mail = queues.find((q) => q.name === QUEUE_NAMES.notificationSend);
  if (mail?.paused) {
    const windows = await runAsPlatform(() =>
      prisma.utilityConfig.findMany({
        select: { notificationQuietStart: true, notificationQuietEnd: true },
      }),
    );
    const held = mailHeldAlert(
      true,
      mail.pauseRecord,
      mail.counts.waiting,
      longestQuietWindowMs(windows),
      now,
    );
    if (held) alerts.push(held);
  }

  return alerts;
}
