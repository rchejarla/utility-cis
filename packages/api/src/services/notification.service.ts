import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";

/**
 * Notification engine — resolves templates, renders variables, queues
 * messages for delivery. The send job picks up PENDING rows and
 * delivers via the configured provider (ConsoleProvider in dev).
 *
 * Public API: sendNotification(), used by the delinquency module,
 * portal registration, meter event handlers, and any other caller
 * that needs to notify a customer or staff member.
 */

// ─── Types ───────────────────────────────────────────────────────

export interface SendNotificationInput {
  eventType: string;
  channel: "EMAIL" | "SMS";
  recipientId: string;
  context: Record<string, string>;
  recipientOverride?: { email?: string; phone?: string };
}

interface ChannelContent {
  subject?: string;
  body: string;
}

interface NotificationProvider {
  send(
    to: string,
    subject: string | null,
    body: string,
  ): Promise<{ messageId: string }>;
}

// ─── Template variable resolution ────────────────────────────────

async function resolveVariables(
  utilityId: string,
  context: Record<string, string>,
): Promise<Record<string, string>> {
  const vars: Record<string, string> = {};

  if (context.customerId) {
    const c = await prisma.customer.findUnique({
      where: { id: context.customerId },
      select: {
        firstName: true,
        lastName: true,
        organizationName: true,
        email: true,
        phone: true,
        customerType: true,
      },
    });
    if (c) {
      vars["customer.firstName"] = c.firstName ?? "";
      vars["customer.lastName"] = c.lastName ?? "";
      vars["customer.organizationName"] = c.organizationName ?? "";
      vars["customer.email"] = c.email ?? "";
      vars["customer.phone"] = c.phone ?? "";
      vars["customer.customerType"] = c.customerType;
    }
  }

  if (context.accountId) {
    const a = await prisma.account.findUnique({
      where: { id: context.accountId },
      select: { accountNumber: true, accountType: true, status: true },
    });
    if (a) {
      vars["account.accountNumber"] = a.accountNumber;
      vars["account.accountType"] = a.accountType;
      vars["account.status"] = a.status;
    }
  }

  if (context.premiseId) {
    const p = await prisma.premise.findUnique({
      where: { id: context.premiseId },
      select: {
        addressLine1: true,
        addressLine2: true,
        city: true,
        state: true,
        zip: true,
      },
    });
    if (p) {
      vars["premise.addressLine1"] = p.addressLine1;
      vars["premise.addressLine2"] = p.addressLine2 ?? "";
      vars["premise.city"] = p.city;
      vars["premise.state"] = p.state;
      vars["premise.zip"] = p.zip;
    }
  }

  if (context.agreementId) {
    const sa = await prisma.serviceAgreement.findUnique({
      where: { id: context.agreementId },
      select: {
        agreementNumber: true,
        status: true,
        startDate: true,
        commodity: { select: { name: true } },
      },
    });
    if (sa) {
      vars["agreement.agreementNumber"] = sa.agreementNumber ?? "";
      vars["agreement.status"] = sa.status;
      vars["agreement.startDate"] = sa.startDate?.toISOString().slice(0, 10) ?? "";
      vars["agreement.commodityName"] = sa.commodity?.name ?? "";
    }
  }

  if (context.meterId) {
    const m = await prisma.meter.findUnique({
      where: { id: context.meterId },
      select: {
        meterNumber: true,
        meterType: true,
        uom: { select: { code: true } },
      },
    });
    if (m) {
      vars["meter.meterNumber"] = m.meterNumber;
      vars["meter.meterType"] = m.meterType;
      vars["meter.uomCode"] = m.uom?.code ?? "";
    }
  }

  // Delinquency context — passed directly as string values, not loaded from DB
  if (context.delinquencyBalance) vars["delinquency.balance"] = context.delinquencyBalance;
  if (context.delinquencyDaysPastDue) vars["delinquency.daysPastDue"] = context.delinquencyDaysPastDue;
  if (context.delinquencyTierName) vars["delinquency.tierName"] = context.delinquencyTierName;
  if (context.delinquencyDueDate) vars["delinquency.dueDate"] = context.delinquencyDueDate;
  if (context.delinquencyActionType) vars["delinquency.actionType"] = context.delinquencyActionType;

  // Portal URLs
  const baseUrl = process.env.WEB_URL || "http://localhost:3000";
  vars["portal.loginUrl"] = `${baseUrl}/portal/login`;
  vars["portal.paymentUrl"] = `${baseUrl}/portal/bills`;
  vars["portal.usageUrl"] = `${baseUrl}/portal/usage`;
  vars["portal.profileUrl"] = `${baseUrl}/portal/profile`;

  // Utility info from tenant config
  const cfg = await prisma.tenantConfig.findUnique({ where: { utilityId } });
  const settings = (cfg?.settings as Record<string, unknown>) ?? {};
  const branding = (settings.branding as Record<string, string>) ?? {};
  const notifSettings = (settings.notifications as Record<string, string>) ?? {};
  vars["utility.name"] = "Utility CIS";
  vars["utility.email"] = notifSettings.senderEmail ?? "";
  vars["utility.logoUrl"] = branding.logoUrl ?? "";

  return vars;
}

function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{([^}]+)\}\}/g, (match, key: string) => {
    const trimmed = key.trim();
    if (trimmed in vars) return vars[trimmed];
    return "";
  });
}

// ─── Providers ───────────────────────────────────────────────────

class ConsoleProvider implements NotificationProvider {
  async send(
    to: string,
    subject: string | null,
    body: string,
  ): Promise<{ messageId: string }> {
    const id = `console-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    logger.info(
      {
        component: "notification",
        provider: "console",
        to,
        subject: subject ?? null,
        bodyPreview: body.slice(0, 200) + (body.length > 200 ? "..." : ""),
      },
      "Delivered notification",
    );
    return { messageId: id };
  }
}

function getProvider(_channel: "EMAIL" | "SMS"): NotificationProvider {
  return new ConsoleProvider();
}

// ─── Public API ──────────────────────────────────────────────────

export async function sendNotification(
  utilityId: string,
  input: SendNotificationInput,
): Promise<string | null> {
  const template = await prisma.notificationTemplate.findUnique({
    where: { utilityId_eventType: { utilityId, eventType: input.eventType } },
  });

  if (!template || !template.isActive) {
    logger.warn(
      { component: "notification", utilityId, eventType: input.eventType },
      "No active template for event",
    );
    return null;
  }

  const channels = template.channels as unknown as Record<string, ChannelContent>;
  const channelKey = input.channel.toLowerCase();
  const content = channels[channelKey];

  if (!content?.body) {
    logger.warn(
      { component: "notification", eventType: input.eventType, channel: input.channel },
      "Template has no channel content",
    );
    return null;
  }

  // Resolve recipient
  let recipientEmail = input.recipientOverride?.email ?? null;
  let recipientPhone = input.recipientOverride?.phone ?? null;

  if (!recipientEmail && !recipientPhone && input.recipientId) {
    const customer = await prisma.customer.findUnique({
      where: { id: input.recipientId },
      select: { email: true, phone: true },
    });
    if (customer) {
      recipientEmail = customer.email ?? null;
      recipientPhone = customer.phone ?? null;
    }
  }

  if (input.channel === "EMAIL" && !recipientEmail) {
    logger.warn(
      { component: "notification", recipientId: input.recipientId },
      "No email address for recipient",
    );
    return null;
  }
  if (input.channel === "SMS" && !recipientPhone) {
    logger.warn(
      { component: "notification", recipientId: input.recipientId },
      "No phone number for recipient",
    );
    return null;
  }

  // Resolve variables and render
  const vars = await resolveVariables(utilityId, {
    customerId: input.recipientId,
    ...input.context,
  });

  const resolvedSubject = content.subject ? renderTemplate(content.subject, vars) : null;
  const resolvedBody = renderTemplate(content.body, vars);

  // Insert outbox row
  const notification = await prisma.notification.create({
    data: {
      utilityId,
      templateId: template.id,
      eventType: input.eventType,
      channel: input.channel,
      recipientEmail,
      recipientPhone,
      customerId: input.recipientId || null,
      accountId: input.context.accountId || null,
      context: input.context as object,
      resolvedVariables: vars as object,
      resolvedSubject,
      resolvedBody,
      status: "PENDING",
      attempts: 0,
    },
  });

  return notification.id;
}

// ─── Preview (renders without sending) ──────────────────────────

export async function previewTemplate(
  utilityId: string,
  templateId: string,
  sampleContext?: Record<string, string>,
): Promise<{ subject: string | null; body: string; variables: Record<string, string> } | null> {
  const template = await prisma.notificationTemplate.findUnique({
    where: { id: templateId },
  });
  if (!template) return null;

  const channels = template.channels as unknown as Record<string, ChannelContent>;
  const declaredVars = template.variables as Array<{ key: string; sample: string }>;

  // Build sample variable map from declared variables
  const vars: Record<string, string> = {};
  for (const v of declaredVars) {
    vars[v.key] = sampleContext?.[v.key] ?? v.sample ?? `{{${v.key}}}`;
  }

  const emailContent = channels.email;
  const smsContent = channels.sms;
  const content = emailContent ?? smsContent;
  if (!content) return null;

  return {
    subject: emailContent?.subject ? renderTemplate(emailContent.subject, vars) : null,
    body: renderTemplate(content.body, vars),
    variables: vars,
  };
}

// ─── Background send job ─────────────────────────────────────────

const BATCH_SIZE = 50;
const MAX_ATTEMPTS = 3;

interface PendingWithTenantCfg {
  id: string;
  utility_id: string;
  channel: "EMAIL" | "SMS";
  recipient_email: string | null;
  recipient_phone: string | null;
  resolved_subject: string | null;
  resolved_body: string;
  attempts: number;
  created_at: Date;
  notification_send_enabled: boolean;
  timezone: string;
  notification_quiet_start: string;
  notification_quiet_end: string;
}

/**
 * BullMQ-worker entry point for notification-send. Replaces the
 * legacy in-process drain loop. Two added behaviors over the legacy:
 *
 *   1. Tenant gating: tenants with `notification_send_enabled = false`
 *      have their notifications skipped (status stays PENDING). When
 *      they re-enable the toggle, the next tick picks the rows up.
 *   2. Quiet hours: for SMS rows only, if the tenant's local time
 *      falls within [quietStart, quietEnd), the row is skipped this
 *      tick. Email is always eligible.
 *
 * Implementation:
 *   - One query joins notification + tenant_config so per-row config
 *     is in hand without N+1 lookups.
 *   - Quiet-hours math runs in Node (Postgres timezone math is gnarly
 *     and involves DST handling we'd have to verify per-deploy).
 *   - Disabled tenants are filtered in SQL so we don't drag their
 *     rows into Node only to skip them.
 *
 * Returns counts so the worker can log meaningful per-tick output.
 */
export async function processPendingNotificationsWithQuietHours(
  now: Date = new Date(),
): Promise<{ attempted: number; sent: number; failed: number; skippedQuietHours: number }> {
  const candidates = await prisma.$queryRaw<PendingWithTenantCfg[]>`
    SELECT
      n.id, n.utility_id, n.channel, n.recipient_email, n.recipient_phone,
      n.resolved_subject, n.resolved_body, n.attempts, n.created_at,
      tc.notification_send_enabled,
      tc.timezone,
      tc.notification_quiet_start,
      tc.notification_quiet_end
    FROM notification n
    INNER JOIN tenant_config tc ON tc.utility_id = n.utility_id
    WHERE n.status = 'PENDING'
      AND tc.notification_send_enabled = true
    ORDER BY n.created_at ASC
    LIMIT ${BATCH_SIZE}
  `;

  let sent = 0;
  let failed = 0;
  let skippedQuietHours = 0;

  for (const row of candidates) {
    if (row.channel === "SMS" && isInSmsQuietHours(now, row)) {
      skippedQuietHours++;
      continue;
    }
    const attempted = await trySendOne(row);
    if (attempted === "sent") sent++;
    else if (attempted === "failed") failed++;
  }

  return {
    attempted: sent + failed,
    sent,
    failed,
    skippedQuietHours,
  };
}

function isInSmsQuietHours(utcNow: Date, row: PendingWithTenantCfg): boolean {
  if (row.notification_quiet_start === row.notification_quiet_end) return false;
  const startMin = parseHHMM(row.notification_quiet_start);
  const endMin = parseHHMM(row.notification_quiet_end);
  const nowMin = localMinutes(utcNow, row.timezone);
  if (startMin < endMin) return nowMin >= startMin && nowMin < endMin;
  return nowMin >= startMin || nowMin < endMin;
}

function parseHHMM(hhmm: string): number {
  const [h, m] = hhmm.split(":").map((s) => Number.parseInt(s, 10));
  return h * 60 + m;
}

function localMinutes(utc: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(utc);
  const lookup: Record<string, string> = {};
  for (const p of parts) lookup[p.type] = p.value;
  let h = parseInt(lookup.hour ?? "0", 10);
  if (h === 24) h = 0;
  const m = parseInt(lookup.minute ?? "0", 10);
  return h * 60 + m;
}

async function trySendOne(row: PendingWithTenantCfg): Promise<"sent" | "failed" | "skipped"> {
  try {
    await prisma.notification.update({
      where: { id: row.id },
      data: { status: "SENDING" },
    });

    const provider = getProvider(row.channel);
    const to = row.channel === "EMAIL" ? row.recipient_email! : row.recipient_phone!;
    const { messageId } = await provider.send(to, row.resolved_subject, row.resolved_body);

    await prisma.notification.update({
      where: { id: row.id },
      data: {
        status: "SENT",
        provider: "console",
        providerMessageId: messageId,
        sentAt: new Date(),
        attempts: row.attempts + 1,
      },
    });
    return "sent";
  } catch (err) {
    const attempts = row.attempts + 1;
    await prisma.notification.update({
      where: { id: row.id },
      data: {
        status: attempts >= MAX_ATTEMPTS ? "FAILED" : "PENDING",
        error: err instanceof Error ? err.message : String(err),
        attempts,
      },
    });
    return "failed";
  }
}

async function processPendingNotifications(): Promise<void> {
  const pending = await prisma.notification.findMany({
    where: { status: "PENDING" },
    orderBy: { createdAt: "asc" },
    take: BATCH_SIZE,
  });

  for (const n of pending) {
    try {
      await prisma.notification.update({
        where: { id: n.id },
        data: { status: "SENDING" },
      });

      const provider = getProvider(n.channel);
      const to = n.channel === "EMAIL" ? n.recipientEmail! : n.recipientPhone!;
      const { messageId } = await provider.send(to, n.resolvedSubject, n.resolvedBody);

      await prisma.notification.update({
        where: { id: n.id },
        data: {
          status: "SENT",
          provider: "console",
          providerMessageId: messageId,
          sentAt: new Date(),
          attempts: n.attempts + 1,
        },
      });
    } catch (err) {
      const attempts = n.attempts + 1;
      await prisma.notification.update({
        where: { id: n.id },
        data: {
          status: attempts >= MAX_ATTEMPTS ? "FAILED" : "PENDING",
          error: err instanceof Error ? err.message : String(err),
          attempts,
        },
      });
    }
  }
}

let sendJobRunning = false;

export function startNotificationSendJob(log: { info: (msg: string) => void }): void {
  const intervalMs = 10_000;
  log.info(`notification-send-job: starting (every ${intervalMs / 1000}s)`);

  setInterval(() => {
    // Skip tick if a prior run is still in flight. Prevents overlapping
    // ticks from piling on during DB contention and starving the pool.
    if (sendJobRunning) return;
    sendJobRunning = true;
    processPendingNotifications()
      .catch((err) => {
        logger.error({ err, component: "notification-send-job" }, "Tick failed");
      })
      .finally(() => {
        sendJobRunning = false;
      });
  }, intervalMs);
}
