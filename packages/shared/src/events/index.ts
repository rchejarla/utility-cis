/**
 * Canonical event-type strings used by the audit-wrap helpers in the
 * API package. The audit_log row's `metadata.eventType` stores one of
 * these values per row. The `<entity>.created` / `<entity>.updated` /
 * `<entity>.deleted` shape is parsed into the audit `action` column
 * (CREATE/UPDATE/DELETE) by the wrapper.
 *
 * The `DomainEvent` interface that previously rode alongside these
 * constants was removed when the EventEmitter audit pipeline was
 * deleted (commit refactor(audit): replace EventEmitter pipeline with
 * in-transaction audit writes). The constants stay because every
 * service still passes one to auditCreate/auditUpdate.
 */
export const EVENT_TYPES = {
  COMMODITY_CREATED: "commodity.created",
  COMMODITY_UPDATED: "commodity.updated",
  UOM_CREATED: "uom.created",
  UOM_UPDATED: "uom.updated",
  PREMISE_CREATED: "premise.created",
  PREMISE_UPDATED: "premise.updated",
  METER_CREATED: "meter.created",
  METER_UPDATED: "meter.updated",
  ACCOUNT_CREATED: "account.created",
  ACCOUNT_UPDATED: "account.updated",
  SERVICE_AGREEMENT_CREATED: "service_agreement.created",
  SERVICE_AGREEMENT_UPDATED: "service_agreement.updated",
  RATE_SCHEDULE_CREATED: "rate_schedule.created",
  RATE_SCHEDULE_REVISED: "rate_schedule.revised",
  RATE_SCHEDULE_PUBLISHED: "rate_schedule.published",
  BILLING_CYCLE_CREATED: "billing_cycle.created",
  BILLING_CYCLE_UPDATED: "billing_cycle.updated",
  CUSTOMER_CREATED: "customer.created",
  CUSTOMER_UPDATED: "customer.updated",
  CONTACT_CREATED: "contact.created",
  CONTACT_UPDATED: "contact.updated",
} as const;

export type EventType = (typeof EVENT_TYPES)[keyof typeof EVENT_TYPES];
