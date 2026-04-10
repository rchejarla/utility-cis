import type { DomainEvent } from "@utility-cis/shared";
import { prisma, setTenantContext } from "../lib/prisma.js";
import { domainEvents } from "./emitter.js";

// Prisma's Json column rejects `undefined`; use `null` to mean "no value".
// Casting to `any` to keep the Prisma generated types out of this module's
// emitted declarations (avoids TS2742 portability errors in workspace builds).
/* eslint-disable @typescript-eslint/no-explicit-any */
function toJsonInput(value: Record<string, unknown> | null | undefined): any {
  return value === undefined || value === null ? null : value;
}

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
        actorName: event.actorName ?? undefined,
        beforeState: toJsonInput(event.beforeState),
        afterState: toJsonInput(event.afterState),
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
