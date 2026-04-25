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
