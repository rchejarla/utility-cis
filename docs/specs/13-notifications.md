# Notifications

**Module:** 13 — Notifications
**Status:** Stub (Phase 3)
**Entities:** NotificationTemplate (planned), CommunicationLog (planned), CommunicationPreference (planned)

## Overview

The Notifications module provides a configurable, multi-channel communication engine for all utility-to-customer communications. It handles email, SMS, and physical mail delivery using event-driven triggers from across the CIS domain. Staff can manage templates, configure automatic triggers, send bulk communications to customer segments, and track the full history of every message sent.

Customers (in Phase 4) can manage their own channel preferences and opt-in/opt-out settings through the portal.

Primary users: billing administrators, communications staff, CSRs, utility managers.

## Planned Entities

### NotificationTemplate (planned)

Reusable message templates for each notification type. Supports multi-channel (email, SMS, mail) with variable substitution.

| Field | Type | Notes |
|-------|------|-------|
| id | UUID | PK |
| utility_id | UUID | Tenant scope |
| template_name | VARCHAR(255) | Internal name |
| event_type | VARCHAR(100) | e.g. "BILL_GENERATED", "PAYMENT_RECEIVED", "DELINQUENCY_TIER_1", "SHUTOFF_NOTICE" |
| channel | ENUM | EMAIL, SMS, MAIL |
| subject | VARCHAR(500) | Nullable: used for EMAIL channel |
| body_text | TEXT | Plain text version (used for SMS; fallback for email) |
| body_html | TEXT | Nullable: HTML version for EMAIL |
| body_print | TEXT | Nullable: formatted text for MAIL/print-vendor |
| variables | JSONB | Array of variable names used in template, e.g. `["account_number", "balance_due", "due_date"]` |
| language_code | CHAR(5) | Default "en-US"; for multi-language support |
| is_active | BOOLEAN | |
| is_system | BOOLEAN | True for system-required templates (cannot be deleted) |
| version | INTEGER | Default 1 |
| created_at | TIMESTAMPTZ | |
| updated_at | TIMESTAMPTZ | |

**Unique constraint:** `[utility_id, event_type, channel, language_code]` — one active template per event/channel/language combination.

**Template variable syntax:** `{{account_number}}`, `{{customer_name}}`, `{{balance_due}}`, etc. Variables are resolved at send time from entity data.

---

### CommunicationLog (planned)

Every message sent to a customer, regardless of channel. The permanent communication history.

| Field | Type | Notes |
|-------|------|-------|
| id | UUID | PK |
| utility_id | UUID | Tenant scope |
| account_id | UUID | FK → Account |
| customer_id | UUID | Nullable FK → Customer |
| template_id | UUID | Nullable FK → NotificationTemplate (null for ad hoc messages) |
| event_type | VARCHAR(100) | Copy of template event_type, or "AD_HOC" |
| channel | ENUM | EMAIL, SMS, MAIL, PORTAL |
| recipient_address | VARCHAR(500) | Email, phone, or mailing address used |
| subject | VARCHAR(500) | Nullable |
| body_snapshot | TEXT | Rendered message body at time of send |
| status | ENUM | QUEUED, SENT, DELIVERED, FAILED, BOUNCED, OPTED_OUT |
| sent_at | TIMESTAMPTZ | |
| delivered_at | TIMESTAMPTZ | Nullable |
| failure_reason | VARCHAR(500) | Nullable |
| is_bulk | BOOLEAN | True if part of a bulk send campaign |
| bulk_campaign_id | UUID | Nullable: groups bulk sends |
| related_entity_type | VARCHAR(100) | Nullable: e.g. "BillingRecord", "DelinquencyAction" |
| related_entity_id | UUID | Nullable: FK to the triggering entity |
| created_at | TIMESTAMPTZ | |

**Indexes:** `[utility_id, account_id, sent_at DESC]`, `[utility_id, event_type, sent_at DESC]`, `[utility_id, status]`

---

### CommunicationPreference (planned)

Customer-level opt-in/opt-out settings per channel and notification type. Manages SMS consent and channel preferences.

| Field | Type | Notes |
|-------|------|-------|
| id | UUID | PK |
| utility_id | UUID | Tenant scope |
| account_id | UUID | FK → Account |
| channel | ENUM | EMAIL, SMS, MAIL |
| category | ENUM | BILLING, PAYMENT, DELINQUENCY, OUTAGE, GENERAL, MARKETING |
| opted_in | BOOLEAN | True = customer wants this channel/category |
| opt_in_date | TIMESTAMPTZ | When opt-in was recorded |
| opt_out_date | TIMESTAMPTZ | Nullable: when opt-out was recorded |
| opt_in_source | ENUM | CUSTOMER_PORTAL, CSR_ENTRY, IMPORT, IVR |
| sms_consent_text | TEXT | Nullable: exact text customer agreed to (SMS TCPA compliance) |
| created_at | TIMESTAMPTZ | |
| updated_at | TIMESTAMPTZ | |

**Unique constraint:** `[utility_id, account_id, channel, category]`

**Note:** Regulatory notices (delinquency, shutoff) must always be delivered via at least one channel, regardless of opt-out. MAIL is used as the fallback for regulatory notices when email and SMS are opted out.

---

## API Endpoints

All endpoints are planned for Phase 3.

### Templates

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/notification-templates` | List templates (filterable by event_type, channel) |
| POST | `/api/v1/notification-templates` | Create template |
| GET | `/api/v1/notification-templates/:id` | Get template with variable list |
| PATCH | `/api/v1/notification-templates/:id` | Update template content |
| DELETE | `/api/v1/notification-templates/:id` | Deactivate (non-system templates only) |
| POST | `/api/v1/notification-templates/:id/preview` | Render template with sample data |

### Sending

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/v1/notifications/send` | Send a notification to one account |
| POST | `/api/v1/notifications/bulk` | Send to a segment (filtered account list) |
| GET | `/api/v1/notifications/bulk/:campaignId` | Get bulk send status and counts |

### Communication Log

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/communication-logs` | List logs (filterable by account, channel, status, date) |
| GET | `/api/v1/communication-logs/:id` | Get log entry with body snapshot |
| GET | `/api/v1/accounts/:id/communications` | Full communication history for an account |

### Communication Preferences

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/accounts/:id/communication-preferences` | Get all preferences for an account |
| PUT | `/api/v1/accounts/:id/communication-preferences` | Set preferences (upsert all) |
| PATCH | `/api/v1/accounts/:id/communication-preferences/:id` | Update one preference |

## Business Rules

1. **Event-driven architecture:** Notification triggers originate from domain events emitted by other modules. Examples:
   - `billing.record.generated` → send BILL_GENERATED email
   - `payment.received` → send PAYMENT_CONFIRMATION SMS or email
   - `delinquency.action.created` → send appropriate tier notice
   - `service_request.completed` → send completion notification
   
   In Phase 1/2, these are internal EventEmitter events. Phase 3+ will use a message queue (Kafka or RabbitMQ) for reliability.

2. **Template resolution:** When a notification is triggered, the system selects the template by matching `[utility_id, event_type, channel, language_code]`. Falls back to "en-US" if customer's language preference has no template. If no template exists for a channel, that channel is skipped.

3. **Channel preference enforcement:** Before sending on any channel, CommunicationPreference is checked. If the customer is opted out of that channel/category, the message is skipped. For regulatory categories (DELINQUENCY, billing notices), MAIL is always used as a fallback channel even if email/SMS are opted out.

4. **SMS consent:** SMS messages are only sent to customers with `opted_in=true` for the SMS channel and a recorded `sms_consent_text` (TCPA compliance). CIS records consent timestamp and text. SMS consent cannot be set by staff without customer confirmation (except for re-enablement flows with audit trail).

5. **Variable substitution:** Template variables are resolved server-side at send time. The rendered body is stored in `CommunicationLog.body_snapshot` so the exact message sent can always be retrieved, even if data changes later.

6. **Delivery provider abstraction:** CIS sends through a configurable delivery layer:
   - **Email:** SendGrid, AWS SES, or Postmark (configured per tenant)
   - **SMS:** Twilio or AWS SNS
   - **Mail:** Print vendor export file (same mechanism as bill documents in Module 09)
   
   Delivery status callbacks (bounces, delivery confirmations) update the CommunicationLog.status.

7. **Bulk communications:** Bulk sends accept a filter criteria (account type, commodity, billing cycle, geographic area, balance threshold, etc.) and a template. A preview step shows recipient count before confirmation. Bulk sends are rate-limited to avoid delivery provider throttling.

8. **Opt-out processing:** Customer opt-out requests (received via unsubscribe link, STOP SMS reply, or CSR entry) are recorded immediately in CommunicationPreference. Subsequent sends for that channel/category are blocked. Opt-out events are logged in AuditLog.

9. **Communication history retention:** CommunicationLog records are retained indefinitely (or per tenant's data retention policy). body_snapshot ensures regulatory notices can be retrieved years later.

10. **Delinquency notice integration:** When a DelinquencyAction is created (Module 11), if the action_type is NOTICE_EMAIL or NOTICE_SMS, the notifications module is called with the action's `notice_template_id`. The resulting CommunicationLog.id is stored back on the DelinquencyAction.

## UI Pages

All pages are planned for Phase 3.

### Notification Templates (`/notifications/templates`)

- Table: template_name, event_type, channel, language, status
- Filter by event_type, channel
- "New Template" → form with body editor (with variable helper), preview button
- Edit: update template content with version tracking

### Template Preview (`/notifications/templates/:id/preview`)

- Renders template with sample data for the tenant (actual account values for realism)
- Shows resolved variables
- Toggle between HTML/text/print views

### Communication History (`/notifications/history`)

- Global log across all accounts
- Filters: channel, status, event_type, date range, account search
- Per-row: account, customer, channel, subject, status, sent date
- Click through to message body snapshot

### Account Communications (within Account Detail)

- Tab showing all communications for the account
- Filter by channel and category
- Preference management: per-channel opt-in/opt-out toggles

### Bulk Send (`/notifications/bulk`)

- Step 1: Select template (event_type/channel)
- Step 2: Define recipient filter (account type, status, geography, etc.)
- Step 3: Preview (recipient count, sample rendered message)
- Step 4: Confirm and queue
- Status dashboard showing active/completed bulk campaigns

## Phase Roadmap

- **Phase 1 (Complete):** Account.paperless_billing and Account.language_pref fields. AuditLog captures all state changes.

- **Phase 3 (Planned):**
  - NotificationTemplate entity + CRUD + preview UI
  - CommunicationLog entity
  - CommunicationPreference entity + opt-in/opt-out management
  - Email delivery integration (SendGrid/SES/Postmark)
  - SMS delivery integration (Twilio/SNS)
  - Event-driven triggers from billing, payment, delinquency events
  - Bulk send capability with segmentation
  - Mail/print vendor export for physical notices
  - Delinquency notice integration (Module 11)
  - Bill notification on generation (Module 09)
  - Payment confirmation notifications (Module 10)

- **Phase 4 (Planned):** Customer portal self-service preference management. Portal notification inbox. Outage/service status notifications.

## Bozeman RFP Coverage

| Req | Requirement | Coverage |
|-----|-------------|----------|
| 27 | Automated notifications (email, SMS, mail) | Phase 3: multi-channel notification engine |
| 28 | Configurable notification triggers | Phase 3: event-driven trigger configuration |
| 29 | Staff-managed communication templates | Phase 3: NotificationTemplate entity + editor |
| 30 | Bulk/mass communications to segments | Phase 3: bulk send with segmentation filters |
| 31 | Opt-in/opt-out management, SMS consent | Phase 3: CommunicationPreference + TCPA compliance |
| 32 | Customer communication preferences | Phase 3: per-channel/category preferences |
| 33 | Communication history per customer | Phase 3: CommunicationLog with body snapshots |
