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
 * in-transaction audit writes).
 *
 * The constants stay because this is the one place every event type an
 * audit row can carry is written down, which is what makes them
 * greppable. `writeAuditRow` takes a bare `string`, so nothing enforces
 * their use — bill production's five were inline literals until a
 * cross-layer audit noticed they were missing here.
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
  BILL_SEGMENT_CREATED: "bill_segment.created",
  BILL_CREATED: "bill.created",
  BILLING_RUN_CREATED: "billing_run.created",
  LEDGER_ENTRY_CREATED: "ledger_entry.created",
  LEDGER_PAYMENT_CREATED: "ledger_payment.created",
  LEDGER_REVERSAL_CREATED: "ledger_reversal.created",
  LEDGER_FEE_CREATED: "ledger_fee.created",
  LEDGER_ADJUSTMENT_CREATED: "ledger_adjustment.created",
  LEDGER_REASON_CREATED: "ledger_reason.created",
  LEDGER_DEPOSIT_RECORDED: "ledger_deposit.recorded",
  LEDGER_REFUND_ISSUED: "ledger_refund.issued",
  CUSTOMER_CREATED: "customer.created",
  CUSTOMER_UPDATED: "customer.updated",
  CONTACT_CREATED: "contact.created",
  CONTACT_UPDATED: "contact.updated",
  // A bill document is audited only once its bytes are stored: a claimed
  // row is not a document. `revised` rather than `updated` because the
  // first store IS the creation even though the SQL is an UPDATE, so the
  // two cases need different names.
  BILL_DOCUMENT_CREATED: "bill_document.created",
  BILL_DOCUMENT_REVISED: "bill_document.revised",
  BILL_MESSAGE_CREATED: "bill_message.created",
  BILL_MESSAGE_UPDATED: "bill_message.updated",
  BILL_MESSAGE_DELETED: "bill_message.deleted",
} as const;

export type EventType = (typeof EVENT_TYPES)[keyof typeof EVENT_TYPES];
