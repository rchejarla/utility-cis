# Notifications

**Module:** 13 — Notifications
**Status:** Phase 3 — design complete, implementation starting
**Entities:** `NotificationTemplate`, `Notification` (send log / outbox)

## Overview

The Notification module provides a template-driven messaging engine for sending email and SMS notifications to customers and staff. It is the delivery backbone for delinquency notices (Module 11), portal communications, meter event alerts, and any other system-generated message.

SaaSLogic handles billing-specific notifications (invoice delivery via `POST /invoices/{id}/send`). CIS handles everything else: delinquency notices, usage alerts, service request updates, portal emails, and operational digests.

The module has three layers:

1. **Template library** — tenant-configurable message templates with `{{variable}}` substitution, per-channel content (email subject + body, SMS body), and a live preview editor.
2. **Notification engine** — resolves template variables from CIS entity data, renders the message, writes an outbox row, and hands off to a provider for delivery.
3. **Provider adapters** — thin wrappers around external services (SendGrid for email, Twilio for SMS, console for dev). Configurable per tenant via the Settings → Notifications page.

Primary users: utility administrators (template management), the system itself (automated sends), CSRs (viewing send history).

## Entities

### NotificationTemplate

One row per business event per tenant. Channel-specific content stored as JSONB so a single template can have both an email and SMS rendering.

| Field | Type | Notes |
|---|---|---|
| id | UUID | PK |
| utility_id | UUID | Tenant scope |
| name | VARCHAR(255) | Human-readable: "Past Due Notice — Tier 1" |
| event_type | VARCHAR(100) | Machine key: `delinquency.tier_1`, `portal.welcome`, `meter.leak_alert` |
| description | TEXT | What this template is for — shown in the admin template editor |
| channels | JSONB | Per-channel content. See shape below. |
| variables | JSONB | Declared variable list with descriptions for the template editor UI |
| is_active | BOOLEAN | Inactive templates are skipped by the engine |
| created_at | TIMESTAMPTZ | |
| updated_at | TIMESTAMPTZ | |

**Unique:** `(utility_id, event_type)`
**RLS:** standard `utility_id` policy.

#### channels JSONB shape

```json
{
  "email": {
    "subject": "Past due notice — Account {{account.accountNumber}}",
    "body": "Dear {{customer.firstName}},\n\nYour account {{account.accountNumber}} has a balance of {{delinquency.balance}} that is {{delinquency.daysPastDue}} days past due.\n\nPlease contact us at {{utility.phone}} or pay online at {{portal.paymentUrl}}.\n\nThank you,\n{{utility.name}}"
  },
  "sms": {
    "body": "{{customer.firstName}}, your utility account {{account.accountNumber}} is {{delinquency.daysPastDue}} days past due. Balance: {{delinquency.balance}}. Pay at {{portal.paymentUrl}}"
  }
}
```

Both `email` and `sms` keys are optional — a template may support only one channel.

#### variables JSONB shape

Declared list of variables this template uses. Powers the template editor's variable picker and the preview panel.

```json
[
  { "key": "customer.firstName", "label": "Customer first name", "sample": "Jane" },
  { "key": "account.accountNumber", "label": "Account number", "sample": "AC-00001" },
  { "key": "delinquency.balance", "label": "Delinquent balance", "sample": "$412.80" },
  { "key": "delinquency.daysPastDue", "label": "Days past due", "sample": "15" }
]
```

### Notification

The send log / outbox. One row per message sent or attempted. Frozen at render time so the exact content delivered is preserved for audit regardless of later template changes.

| Field | Type | Notes |
|---|---|---|
| id | UUID | PK |
| utility_id | UUID | Tenant scope |
| template_id | UUID FK | Which template was used (nullable for ad-hoc sends) |
| event_type | VARCHAR(100) | Denormalized from template for query convenience |
| channel | ENUM | `EMAIL`, `SMS` |
| recipient_email | VARCHAR(255) | For EMAIL channel |
| recipient_phone | VARCHAR(20) | For SMS channel |
| customer_id | UUID FK | Nullable — who this was sent to |
| account_id | UUID FK | Nullable — which account this relates to |
| context | JSONB | The raw context IDs passed by the caller |
| resolved_variables | JSONB | The flat variable map after entity resolution |
| resolved_subject | TEXT | Rendered email subject (null for SMS) |
| resolved_body | TEXT | Rendered body |
| status | ENUM | `PENDING`, `SENDING`, `SENT`, `FAILED` |
| provider | VARCHAR(50) | `sendgrid`, `twilio`, `smtp`, `console` |
| provider_message_id | VARCHAR(255) | External tracking ID from the provider |
| error | TEXT | Populated on FAILED |
| attempts | INT | Number of delivery attempts (for retry tracking) |
| sent_at | TIMESTAMPTZ | When delivery was confirmed |
| created_at | TIMESTAMPTZ | |

**Indexes:** `(utility_id, status, created_at)`, `(customer_id, created_at DESC)`, `(account_id, created_at DESC)`, `(template_id)`, `(event_type, created_at DESC)`.
**RLS:** standard `utility_id` policy.

## Template Variable System

Simple `{{namespace.field}}` substitution. No conditionals, loops, or logic in v1 — intentionally simple so non-technical utility admins can edit templates. Future versions can add conditionals if needed.

### Standard variable namespaces

| Namespace | Source entity | Variables |
|---|---|---|
| `customer` | Customer | `firstName`, `lastName`, `organizationName`, `email`, `phone`, `customerType` |
| `account` | Account | `accountNumber`, `accountType`, `status` |
| `premise` | Premise | `addressLine1`, `addressLine2`, `city`, `state`, `zip` |
| `agreement` | ServiceAgreement | `agreementNumber`, `commodityName`, `status`, `startDate` |
| `meter` | Meter | `meterNumber`, `meterType`, `uomCode` |
| `delinquency` | DelinquencyAction context | `balance`, `daysPastDue`, `tierName`, `dueDate`, `actionType` |
| `portal` | System URLs | `loginUrl`, `paymentUrl`, `usageUrl`, `profileUrl` |
| `utility` | TenantConfig + branding | `name`, `phone`, `email`, `website`, `logoUrl` |

### Variable resolution

The caller passes a context object with entity IDs:
```json
{ "customerId": "...", "accountId": "...", "premiseId": "...", "delinquencyActionId": "..." }
```

The engine loads each referenced entity from the database and builds a flat `Record<string, string>` variable map. Each `{{key}}` in the template is replaced with the corresponding value. Unresolved variables render as an empty string with a warning logged (not a hard error).

The resolved variable map is stored on `Notification.resolved_variables` as the audit record of exactly what values were substituted.

## Engine

### `sendNotification()` — the public API

```typescript
interface SendNotificationInput {
  eventType: string;
  channel: "EMAIL" | "SMS";
  recipientId: string;        // customerId — engine resolves email/phone
  context: Record<string, string>;
  recipientOverride?: { email?: string; phone?: string };
}

async function sendNotification(
  utilityId: string,
  input: SendNotificationInput,
): Promise<string | null>
// Returns the Notification ID, or null if template not found/inactive
```

### Flow

1. Load `NotificationTemplate` by `(utilityId, eventType)`. If not found or inactive, log warning and return null.
2. Check the template has content for the requested channel. If not, skip with a warning.
3. Load the recipient's contact info from `Customer` (email for EMAIL, phone for SMS). Use `recipientOverride` if provided.
4. Resolve variables: load entities from the context IDs, build the flat variable map.
5. Render: replace `{{key}}` tokens in subject and body.
6. Insert a `Notification` row with `status = PENDING`, the rendered content, and the frozen variable map.
7. Return the Notification ID. Delivery happens asynchronously via the send job.

### Send job (background)

A background job (same `setInterval` pattern as the suspension scheduler) picks up `PENDING` notifications:

1. Query: `WHERE status = 'PENDING' ORDER BY created_at LIMIT 50`
2. For each: set `status = SENDING`, call the provider adapter, update to `SENT` or `FAILED`.
3. On failure: increment `attempts`. If `attempts < 3`, set back to `PENDING` for retry. If `attempts >= 3`, leave as `FAILED`.
4. Tick interval: every 10 seconds (configurable).

### Provider adapters

```typescript
interface NotificationProvider {
  channel: "EMAIL" | "SMS";
  send(to: string, subject: string | null, body: string): Promise<{ messageId: string }>;
}
```

| Provider | Channel | Config source |
|---|---|---|
| `ConsoleProvider` | EMAIL + SMS | Dev mode — logs to stdout. Default when no provider configured. |
| `SendGridProvider` | EMAIL | `settings.notifications.emailApiKey` |
| `TwilioProvider` | SMS | `settings.notifications.smsApiKey` |
| `SmtpProvider` | EMAIL | `settings.notifications.smtpHost/port/user/pass` |

Provider selection reads from `TenantConfig.settings.notifications`. Defaults to `console` in dev.

## API Endpoints

| Method | Path | Module | Description |
|---|---|---|---|
| GET | `/api/v1/notification-templates` | settings | List templates (filterable by event_type, is_active) |
| POST | `/api/v1/notification-templates` | settings | Create template |
| GET | `/api/v1/notification-templates/:id` | settings | Get template detail |
| PATCH | `/api/v1/notification-templates/:id` | settings | Update template |
| DELETE | `/api/v1/notification-templates/:id` | settings | Deactivate (soft delete) |
| POST | `/api/v1/notification-templates/:id/preview` | settings | Render with sample data, return rendered content without sending |
| GET | `/api/v1/notifications` | settings | Send log (filterable by status, channel, customer_id, event_type, date range) |
| GET | `/api/v1/notifications/:id` | settings | Single notification detail |
| POST | `/api/v1/notifications/send` | settings | Manual one-off send (admin-triggered) |

## UI Pages

### Settings → Notification Templates (`/settings/notification-templates`)

- Template list: name, event type, channel badges (email/sms), active toggle
- Template editor: name, event type, description, per-channel content tabs (email subject + body, SMS body), variables list, live preview panel with sample data rendering

### Settings → Notifications (`/settings/notifications`) — already stubbed

Wire the existing page to manage: sender email, email/SMS provider selection, API keys (masked), daily digest toggle.

### Notification Send Log (`/notifications`)

- Searchable table: date, event type, channel, recipient, status badge, template name
- Click to view: full rendered content, variable values, provider response, error
- Filter by: status, channel, date range, customer

### Account / Customer Detail — Notifications Tab

- Notification history scoped to the entity
- Same table as the main send log, filtered by customer_id or account_id

## Seed Templates

| Event type | Name | Channels |
|---|---|---|
| `delinquency.tier_1` | Past Due Reminder | email, sms |
| `delinquency.tier_2` | Formal Past Due Notice | email |
| `delinquency.tier_3` | Shut-Off Warning — 48 Hours | email, sms |
| `delinquency.tier_4` | Service Disconnection Notice | email, sms |
| `portal.welcome` | Portal Welcome | email |
| `portal.password_reset` | Password Reset | email |
| `meter.high_usage` | High Usage Alert | email, sms |
| `meter.leak_detected` | Possible Leak Detected | email, sms |
| `service.move_in_confirmation` | Move-In Confirmation | email |
| `service.move_out_confirmation` | Move-Out Confirmation | email |

## Integration Points

### Module 11 — Delinquency (primary consumer)

When the delinquency evaluation job creates a notice-type `DelinquencyAction`, it calls `sendNotification` with `eventType: delinquency.tier_N`. The returned notification ID is stored on the action row. When the notification reaches `SENT`, the delinquency action transitions to `COMPLETED`.

### Customer Portal

`portal.welcome` sent on registration. `portal.password_reset` when real auth is wired.

### Meter Events

`meter.high_usage` and `meter.leak_detected` sent when the meter event handler creates a relevant event.

### Operations Digest

The daily digest is a special template (`operations.daily_digest`) sent to a staff email list. Rendered by a daily job that aggregates overdue accounts, failed reads, and exception queue counts.

## Business Rules

1. **Template uniqueness:** One template per `(utility_id, event_type)`.
2. **Missing template = skip, not crash:** `sendNotification` returns null if the template is missing or inactive.
3. **Missing variable = empty, not crash:** Unresolved `{{variable}}` renders as empty string with a warning.
4. **Frozen content:** Rendered subject, body, and variables on the Notification row are immutable after render.
5. **Retry with backoff:** Failed sends retry up to 3 times. After 3 failures, status stays FAILED.
6. **Rate limiting:** Send job processes 50 per tick (10-second interval). Configurable per tenant.
7. **Dev mode:** `ConsoleProvider` logs rendered messages to stdout. Notification rows are created with `status = SENT` so the rest of the system works identically.

## Phase Roadmap

### Phase 3.1 (Building now)
- NotificationTemplate + Notification entities (Prisma)
- Template CRUD API + Zod validators
- Template variable resolution engine
- ConsoleProvider (dev mode)
- Background send job
- Send log API
- Template editor UI with live preview
- Wire Settings → Notifications page
- Seed starter templates

### Phase 3.2 (After Module 11)
- Wire delinquency integration
- Wire portal welcome email
- Customer/account detail Notifications tab

### Phase 3.3 (When provider accounts are set up)
- SendGridProvider, TwilioProvider, SmtpProvider
- Encrypted API key storage
- Delivery status webhooks from providers

### Phase 3.4 (Future)
- Customer notification preferences (opt-in/opt-out per event per channel)
- Template versioning
- Rich HTML email layout builder
- Operations daily digest job
- Email attachment support
