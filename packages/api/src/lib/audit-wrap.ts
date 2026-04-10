import { domainEvents } from "../events/emitter.js";

/**
 * Shared audit-event emission helpers. Every mutating service used to
 * hand-roll an `emitDomainEvent({...12 fields...})` block after create
 * and update — this wraps that into `auditCreate` / `auditUpdate`
 * closures so services only name the event type and describe the
 * mutation. Consistent `timestamp`, `beforeState`, `afterState`
 * shaping lives in exactly one place.
 */

export interface AuditContext {
  utilityId: string;
  actorId: string;
  actorName?: string;
  entityType: string;
}

type WithId = { id: string };

export async function auditCreate<T extends WithId>(
  ctx: AuditContext,
  eventType: string,
  op: () => Promise<T>
): Promise<T> {
  const entity = await op();
  domainEvents.emitDomainEvent({
    type: eventType,
    entityType: ctx.entityType,
    entityId: entity.id,
    utilityId: ctx.utilityId,
    actorId: ctx.actorId,
    actorName: ctx.actorName,
    beforeState: null,
    afterState: entity as unknown as Record<string, unknown>,
    timestamp: new Date().toISOString(),
  });
  return entity;
}

export async function auditUpdate<T extends WithId>(
  ctx: AuditContext,
  eventType: string,
  before: unknown,
  op: () => Promise<T>
): Promise<T> {
  const entity = await op();
  domainEvents.emitDomainEvent({
    type: eventType,
    entityType: ctx.entityType,
    entityId: entity.id,
    utilityId: ctx.utilityId,
    actorId: ctx.actorId,
    actorName: ctx.actorName,
    beforeState: (before as Record<string, unknown> | null) ?? null,
    afterState: entity as unknown as Record<string, unknown>,
    timestamp: new Date().toISOString(),
  });
  return entity;
}
