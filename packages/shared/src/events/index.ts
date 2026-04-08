export interface DomainEvent {
  type: string;
  entityType: string;
  entityId: string;
  utilityId: string;
  actorId: string;
  beforeState: Record<string, unknown> | null;
  afterState: Record<string, unknown> | null;
  timestamp: string;
}

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
  BILLING_CYCLE_CREATED: "billing_cycle.created",
  BILLING_CYCLE_UPDATED: "billing_cycle.updated",
} as const;

export type EventType = (typeof EVENT_TYPES)[keyof typeof EVENT_TYPES];
