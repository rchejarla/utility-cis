import type { DomainEvent } from "@utility-cis/shared";
import { prisma, setTenantContext } from "../lib/prisma.js";
import { domainEvents } from "./emitter.js";

function mapEventTypeToAction(
  eventType: string
): "CREATE" | "UPDATE" | "DELETE" {
  if (eventType.endsWith(".created")) return "CREATE";
  if (eventType.endsWith(".revised")) return "UPDATE";
  if (eventType.endsWith(".deleted")) return "DELETE";
  return "UPDATE";
}

async function handleDomainEvent(event: DomainEvent): Promise<void> {
  try {
    await setTenantContext(event.utilityId);
    await prisma.auditLog.create({
      data: {
        utilityId: event.utilityId,
        entityType: event.entityType,
        entityId: event.entityId,
        action: mapEventTypeToAction(event.type),
        actorId: event.actorId,
        beforeState: event.beforeState ?? undefined,
        afterState: event.afterState ?? undefined,
      },
    });
  } catch (err) {
    console.error("[audit-writer] Failed to write audit log:", err);
  }
}

export function startAuditWriter(): void {
  domainEvents.on("domain-event", (event: DomainEvent) => {
    void handleDomainEvent(event);
  });
}
