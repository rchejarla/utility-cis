/**
 * Telling the tenant that billing did not happen (SCH-BILL-11).
 *
 * "A silent failure to bill is the most expensive silence in the
 * product." The dispatcher already names every refusal in its result and
 * logs it, which reaches whoever reads the worker's log — nobody, on the
 * day it matters. This carries the same fact to the tenant.
 *
 * Two conditions, which are one concern:
 *
 * - **A due cycle did not dispatch** (SCH-BILL-5): its reads have not
 *   landed, so billing it would produce a bill for zero usage.
 * - **A window closed with no run** (SCH-BILL-7): the next bill day
 *   arrived and the previous window was never billed. This is the one
 *   nothing could see — once the next bill day passes, the planner's
 *   window moves on and the unbilled one is never looked at again.
 *
 * **Told once per window, not once per tick.** The dispatcher fires
 * hourly; a notice that arrives every hour for a month is one an
 * operator mutes, which leaves exactly the silence this exists to
 * remove. The ledger of what has been said lives in the billing
 * scheduler's own `scheduler_config.settings` jsonb — the storage rule's
 * case for a knob only one scheduler needs (spec 18), and the only home
 * that works whether or not the tenant has a template. Keeping it in the
 * `notification` table would record nothing for a tenant with no active
 * template, and that is precisely the tenant who would then be told
 * hourly forever.
 *
 * **The screen is the floor and the email is the escalation.**
 * `sendNotification` returns null when a tenant has no active template,
 * so email alone would be a silent channel for a silence. The Billing
 * Runs screen shows an unbilled window as overdue whether or not any
 * template exists (SCH-BILL-12); this adds the push for a tenant that
 * has asked for one.
 */
import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";
import { sendNotification } from "./notification.service.js";
import { previewBillingRun } from "./billing-run.service.js";
import { billDayIn } from "./bill.service.js";

/** The event a tenant's template is keyed on, in the existing style. */
export const BILLING_NOTICE_EVENT = "billing.not_dispatched";

/** Where the ledger sits inside the billing scheduler's settings jsonb. */
export const NOTICE_LEDGER_KEY = "noticedWindows";

/**
 * How long a ledger entry is kept.
 *
 * Long enough that a window reported in one month is not re-reported in
 * the next, short enough that the jsonb stays small — one entry per
 * cycle per month, so a tenant with six cycles holds about eighteen.
 */
export const NOTICE_RETENTION_DAYS = 90;

/** What the ledger holds: window key to when it was reported. */
export type NoticeLedger = Record<string, string>;

export interface BillingNotice {
  billingCycleId: string;
  cycleCode: string;
  /** The window that was not billed, as a date. */
  windowEnd: string;
  reason: "readsIncomplete" | "windowClosedUnbilled";
  detail: string;
}

/**
 * The key a notice is remembered under: the cycle and the window.
 *
 * The window and not the cycle alone — a cycle that could not bill in
 * November and cannot bill in December has two things wrong, and
 * remembering only the cycle would say nothing the second time. The date
 * and not the instant, or every hourly tick would be a new key and the
 * ledger would suppress nothing.
 */
export function windowKey(billingCycleId: string, windowEnd: string | Date): string {
  const date =
    windowEnd instanceof Date ? windowEnd.toISOString().slice(0, 10) : windowEnd.slice(0, 10);
  return `${billingCycleId}:${date}`;
}

/** A ledger read defensively — anything unreadable is an empty one. */
function asLedger(value: unknown): NoticeLedger {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as NoticeLedger;
}

/**
 * The refusals this tenant has not been told about yet.
 *
 * An unreadable ledger counts as empty, which notifies again rather than
 * staying silent. That direction is deliberate: the jsonb is
 * hand-editable, and of the two ways to be wrong, a duplicate notice
 * costs an email and silence costs a month's billing.
 */
export function newNotices(
  notices: readonly BillingNotice[],
  ledger: NoticeLedger,
): BillingNotice[] {
  const told = asLedger(ledger);
  return notices.filter((n) => !(windowKey(n.billingCycleId, n.windowEnd) in told));
}

/** The ledger with anything past its retention — or unreadable — removed. */
export function prunedNotices(ledger: NoticeLedger, now: Date = new Date()): NoticeLedger {
  const cutoff = now.getTime() - NOTICE_RETENTION_DAYS * 86_400_000;
  const kept: NoticeLedger = {};

  for (const [key, at] of Object.entries(asLedger(ledger))) {
    const ms = Date.parse(String(at));
    // An unreadable timestamp can never be pruned by age, so it would
    // sit there forever suppressing that window's notice for good.
    if (!Number.isFinite(ms) || ms < cutoff) continue;
    kept[key] = String(at);
  }

  return kept;
}

/**
 * The tenant's own administrators.
 *
 * The System Admin role holders, because "the tenant" in the authority
 * sense is whoever the tenant made responsible — and this needs no new
 * setting, no new screen and no address for an operator to keep up to
 * date. A tenant with no System Admin gets no email, which is logged:
 * inventing a destination would be worse.
 */
export async function billingNoticeRecipients(
  utilityId: string,
): Promise<{ id: string; email: string }[]> {
  const users = await prisma.cisUser.findMany({
    where: {
      utilityId,
      isActive: true,
      userRoles: { some: { role: { name: "System Admin", utilityId } } },
    },
    select: { id: true, email: true },
  });
  return users.filter((u): u is { id: string; email: string } => Boolean(u.email));
}

/**
 * Windows that closed without being billed (SCH-BILL-7).
 *
 * The condition nothing else could see. While a bill day is the most
 * recent one, the dispatcher keeps retrying and reports the refusal
 * every tick; the moment the *next* bill day arrives, the planner's
 * window moves on and the unbilled window stops being considered at all.
 *
 * Asked per cycle against the window the planner would have computed on
 * the day before this bill day — so the question is exactly "was the
 * previous window billed", in the planner's own terms rather than in a
 * second definition of a month.
 */
export async function findClosedUnbilledWindows(
  utilityId: string,
  now: Date = new Date(),
): Promise<BillingNotice[]> {
  const cycles = await prisma.billingCycle.findMany({
    where: { utilityId, active: true },
    select: { id: true, cycleCode: true, billDayOfMonth: true, frequency: true },
  });

  const notices: BillingNotice[] = [];

  for (const cycle of cycles) {
    if (cycle.frequency !== "MONTHLY") continue;

    /*
     * A day before this month's bill day, which is inside the previous
     * window whatever the clamp did — so the planner answers with the
     * window that has just closed rather than the one now open.
     */
    const y = now.getUTCFullYear();
    const m = now.getUTCMonth();
    const billDay = billDayIn(y, m, cycle.billDayOfMonth);
    const asOf = new Date(Date.UTC(y, m, billDay - 1));
    if (asOf >= now) continue; // this month's bill day has not arrived

    try {
      const plan = await previewBillingRun(utilityId, {
        billingCycleId: cycle.id,
        windowEnd: asOf,
      });
      if (plan.existingRun) continue;

      notices.push({
        billingCycleId: cycle.id,
        cycleCode: cycle.cycleCode,
        windowEnd: plan.windowEnd.toISOString().slice(0, 10),
        reason: "windowClosedUnbilled",
        detail:
          `The window ending ${plan.windowEnd.toISOString().slice(0, 10)} closed with no ` +
          "billing run, so nothing was billed for that period.",
      });
    } catch (err) {
      // A cycle the planner refuses is reported by the dispatcher's own
      // `unsupportedFrequency` path; it is not a missed window.
      logger.debug(
        { err, component: "billing-notice", utilityId, cycleCode: cycle.cycleCode },
        "Could not plan the previous window for this cycle",
      );
    }
  }

  return notices;
}

/**
 * Tell the tenant, once per window.
 *
 * The ledger is written whether or not an email went out, which is what
 * makes "once" true for a tenant with no active template: without it the
 * send would be attempted, log a warning and record nothing, every hour
 * for as long as the condition lasts.
 */
export async function reportBillingNotices(
  utilityId: string,
  notices: readonly BillingNotice[],
  now: Date = new Date(),
): Promise<BillingNotice[]> {
  if (notices.length === 0) return [];

  const row = await prisma.schedulerConfig.findFirst({
    where: { utilityId, schedulerKey: "billing" },
    select: { settings: true },
  });
  const settings = (row?.settings ?? {}) as Record<string, unknown>;
  const ledger = asLedger(settings[NOTICE_LEDGER_KEY]);

  const fresh = newNotices(notices, ledger);
  if (fresh.length === 0) return [];

  const recipients = await billingNoticeRecipients(utilityId);
  if (recipients.length === 0) {
    logger.warn(
      { component: "billing-notice", utilityId, count: fresh.length },
      "Billing did not run and this tenant has no active System Admin to tell",
    );
  }

  for (const notice of fresh) {
    for (const to of recipients) {
      try {
        await sendNotification(utilityId, {
          eventType: BILLING_NOTICE_EVENT,
          channel: "EMAIL",
          recipientId: to.id,
          recipientOverride: { email: to.email },
          context: {
            cycleCode: notice.cycleCode,
            windowEnd: notice.windowEnd,
            reason: notice.reason,
            detail: notice.detail,
          },
        });
      } catch (err) {
        /*
         * One recipient's failure must not stop the others, and must
         * not stop the ledger being written: a send that throws every
         * hour would otherwise retry every hour, which is the flood
         * this is built to avoid.
         */
        logger.error(
          { err, component: "billing-notice", utilityId, cycleCode: notice.cycleCode },
          "Could not send a billing notice",
        );
      }
    }

    logger.warn(
      {
        component: "billing-notice",
        utilityId,
        cycleCode: notice.cycleCode,
        windowEnd: notice.windowEnd,
        reason: notice.reason,
        told: recipients.length,
      },
      "Billing did not happen for a window; the tenant has been told",
    );
  }

  const stamped: NoticeLedger = { ...prunedNotices(ledger, now) };
  for (const notice of fresh) {
    stamped[windowKey(notice.billingCycleId, notice.windowEnd)] = now.toISOString();
  }

  /*
   * `updateMany`, so a tenant with no scheduler row is a no-op rather
   * than a created row: a missing row means the declared default
   * (billing off), and materialising one here would silently switch
   * automation on for a tenant that never asked.
   */
  await prisma.schedulerConfig.updateMany({
    where: { utilityId, schedulerKey: "billing" },
    data: { settings: { ...settings, [NOTICE_LEDGER_KEY]: stamped } },
  });

  return fresh;
}
