import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";
import { sendMail, type MailAttachmentRef } from "../lib/apptor-connect/mail-client.js";
import { notificationSettingsSchema } from "@utility-cis/shared";
import { config } from "../config.js";

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
  /**
   * The bill this notification delivers, where it delivers one.
   *
   * Set so the outbox row *is* the delivery record: "was this bill sent,
   * when, to what address, and what did the provider say" is answered by
   * the row itself rather than by a second table restating its columns.
   */
  billId?: string;
}

interface ChannelContent {
  subject?: string;
  body: string;
}

interface NotificationProvider {
  /** Recorded on the row, so "how was this sent" is answerable later. */
  readonly name: string;
  send(
    to: string,
    subject: string | null,
    body: string,
    attachments?: MailAttachmentRef[],
  ): Promise<{ messageId: string | null }>;
}

// ─── Template variable resolution ────────────────────────────────

/**
 * Every id in `context` is caller-supplied — `POST /notifications/send`
 * takes `recipientId` and a free-form `context` map straight from the
 * request body — so each lookup carries `utilityId` and a row belonging
 * to another tenant is simply not found.
 *
 * This function took `utilityId` from the start and spent it on one
 * query (`utilityConfig`, below) while the five entity lookups read by
 * primary key alone. The tenant argument read as scoping and scoped
 * nothing, which is how a customer's name, email, phone, account number,
 * premise address and meter number could be rendered into one tenant's
 * notification from another tenant's rows — and persisted in
 * `resolved_variables` under the caller's `utility_id`.
 *
 * A not-found row leaves its variables unset and the message renders
 * with blanks, which is the behaviour a deleted id already had. The only
 * change here is that another tenant's row now counts as not found.
 *
 * `findFirst` rather than `findUnique` is a readability choice, not a
 * requirement: since Prisma 5 a `findUnique` may carry non-unique
 * predicates alongside the unique one, and `posting.service.ts:167`
 * does exactly that. `findFirst` is used here because the lookup is a
 * filtered read that may legitimately miss, and naming it that way makes
 * the tenant predicate load-bearing rather than incidental.
 */
async function resolveVariables(
  utilityId: string,
  context: Record<string, string>,
): Promise<Record<string, string>> {
  const vars: Record<string, string> = {};

  if (context.customerId) {
    const c = await prisma.customer.findFirst({
      where: { id: context.customerId, utilityId },
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
    const a = await prisma.account.findFirst({
      where: { id: context.accountId, utilityId },
      select: { accountNumber: true, accountType: true, status: true },
    });
    if (a) {
      vars["account.accountNumber"] = a.accountNumber;
      vars["account.accountType"] = a.accountType;
      vars["account.status"] = a.status;
    }
  }

  if (context.premiseId) {
    const p = await prisma.premise.findFirst({
      where: { id: context.premiseId, utilityId },
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
    const sa = await prisma.serviceAgreement.findFirst({
      where: { id: context.agreementId, utilityId },
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
    const m = await prisma.meter.findFirst({
      where: { id: context.meterId, utilityId },
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
  const baseUrl = config.WEB_URL;
  vars["portal.loginUrl"] = `${baseUrl}/portal/login`;
  vars["portal.paymentUrl"] = `${baseUrl}/portal/bills`;
  vars["portal.usageUrl"] = `${baseUrl}/portal/usage`;
  vars["portal.profileUrl"] = `${baseUrl}/portal/profile`;

  // Utility info from tenant config
  const cfg = await prisma.utilityConfig.findUnique({ where: { utilityId } });
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
  readonly name = "console";

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

/**
 * How a tenant's mail leaves, or that it does not.
 *
 * A tenant with `notifications.mailIntegration` set sends through
 * apptor-connect; one without keeps the console provider, so an
 * unconfigured tenant cannot accidentally mail its customers. The
 * setting holds a name and nothing else — the credential, the sender
 * domain and the choice between SendGrid and that tenant's own SMTP
 * server all live on their side.
 *
 * SMS stays on the console until a tenant's SMS integration exists;
 * there is no `twilio` binding to point at yet.
 */
function getProvider(
  channel: "EMAIL" | "SMS",
  settings: unknown,
): NotificationProvider {
  if (channel !== "EMAIL") return new ConsoleProvider();
  const raw =
    settings && typeof settings === "object" && "notifications" in settings
      ? (settings as { notifications?: unknown }).notifications
      : undefined;
  const parsed = notificationSettingsSchema.safeParse(raw ?? {});
  // Settings that cannot be read are not a reason to mail anyway, nor
  // to fail the drain: fall back and log, the way an absent setting
  // does.
  if (!parsed.success) {
    logger.warn(
      { component: "notification", issues: parsed.error.issues.length },
      "notification settings unreadable; falling back to the console provider",
    );
    return new ConsoleProvider();
  }
  const integration = parsed.data.mailIntegration?.trim();
  if (!integration) return new ConsoleProvider();
  return new ApptorConnectMailProvider(
    integration,
    parsed.data.mailConnection?.trim() || null,
    // The address the customer sees. Left unset, the connection's own
    // `from` is used; with neither, apptor-connect refuses rather than
    // inventing a sender — which is the right failure, and the one this
    // setting exists to prevent.
    parsed.data.senderEmail?.trim() || null,
  );
}

/** Mail through apptor-connect's mail plane. */
class ApptorConnectMailProvider implements NotificationProvider {
  readonly name = "apptor-connect";

  constructor(
    private readonly integration: string,
    private readonly connection: string | null,
    private readonly from: string | null,
  ) {}

  async send(
    to: string,
    subject: string | null,
    body: string,
    attachments?: MailAttachmentRef[],
  ): Promise<{ messageId: string | null }> {
    return sendMail(
      this.integration,
      { from: this.from, to: [to], subject, body, attachments },
      { connection: this.connection },
    );
  }
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

  /*
   * The query that decides where the message goes, so the tenant
   * predicate matters most here: unscoped, naming another tenant's
   * customer id addressed the notification to that customer. Scoped, the
   * lookup misses, no address resolves, and the two guards below refuse
   * the send — `POST /notifications/send` answers 400 rather than
   * mailing a stranger.
   *
   * `recipientOverride` deliberately skips this: it is server-supplied
   * (the import notifier passes the actor's own address) and
   * `manualSendSchema` is `.strict()` with no such field, so a request
   * cannot name its own destination.
   */
  if (!recipientEmail && !recipientPhone && input.recipientId) {
    const customer = await prisma.customer.findFirst({
      where: { id: input.recipientId, utilityId },
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
      billId: input.billId ?? null,
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

/**
 * Renders a template without sending it.
 *
 * Scoped by tenant for the same reason as `sendNotification`: the id is
 * a route parameter, and unscoped this returned any tenant's template
 * subject and body to any caller holding `notifications:VIEW`. The route
 * turns a null into 404, so another tenant's template now reads as
 * absent rather than as text.
 */
export async function previewTemplate(
  utilityId: string,
  templateId: string,
  sampleContext?: Record<string, string>,
): Promise<{ subject: string | null; body: string; variables: Record<string, string> } | null> {
  const template = await prisma.notificationTemplate.findFirst({
    where: { id: templateId, utilityId },
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
  /** The tenant's settings JSON, for choosing a provider per row. */
  settings: unknown;
  /** The bill this delivers, and where its PDF lives — null for the rest. */
  bill_id: string | null;
  bill_number: string | null;
  storage_integration: string | null;
  storage_connection: string | null;
  object_key: string | null;
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
 *   - One query joins notification + utility_config so per-row config
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
      tc.settings,
      n.bill_id,
      b.bill_number,
      d.storage_integration,
      d.storage_connection,
      d.object_key,
      tc.timezone,
      tc.notification_quiet_start,
      tc.notification_quiet_end
    FROM notification n
    INNER JOIN utility_config tc ON tc.utility_id = n.utility_id
    LEFT JOIN bill b ON b.id = n.bill_id
    /*
     * The newest rendered document for the bill, where there is one.
     * LEFT because almost no notification is about a bill, and a bill
     * whose PDF has not been produced still sends — the message says it
     * is ready and the portal has it.
     */
    LEFT JOIN LATERAL (
      SELECT storage_integration, storage_connection, object_key
      FROM bill_document
      WHERE bill_id = n.bill_id
      ORDER BY generated_at DESC
      LIMIT 1
    ) d ON n.bill_id IS NOT NULL
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
    // Conditional claim: only flip PENDING → SENDING. If another worker
    // raced ahead (e.g. two cron ticks overlapped because BullMQ lost a
    // lock and re-dispatched the job), updateMany returns count=0 and
    // we skip — the other worker owns this notification. Without this
    // predicate two workers would both call provider.send for the same
    // notification id and the customer would get a duplicate message.
    const claimed = await prisma.notification.updateMany({
      where: { id: row.id, status: "PENDING" },
      data: { status: "SENDING" },
    });
    if (claimed.count === 0) {
      return "skipped";
    }

    const provider = getProvider(row.channel, row.settings);
    const to = row.channel === "EMAIL" ? row.recipient_email! : row.recipient_phone!;
    /*
     * A bill's PDF goes as a pointer to where it already lives, never
     * as bytes: it is in a connection apptor-connect owns, so naming it
     * keeps the file inside their service instead of streaming it out
     * here and posting it back base64-encoded.
     *
     * A notification that is not about a bill, or a bill with nothing
     * rendered, sends without one — the message still says the bill is
     * ready and the portal still has it.
     */
    const attachments =
      row.bill_id && row.storage_integration && row.object_key
        ? [
            {
              integration: row.storage_integration,
              connection: row.storage_connection,
              path: row.object_key,
              filename: `Bill-${row.bill_number ?? row.bill_id}.pdf`,
              contentType: "application/pdf",
            },
          ]
        : undefined;
    const { messageId } = await provider.send(
      to,
      row.resolved_subject,
      row.resolved_body,
      attachments,
    );

    await prisma.notification.update({
      where: { id: row.id },
      data: {
        status: "SENT",
        // The provider that actually sent it, not a constant. "How did
        // this leave?" is the first question when a customer says a bill
        // never arrived.
        provider: provider.name,
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

