import type { DomainEvent } from "@utility-cis/shared";
import { prisma } from "../lib/prisma.js";
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

// Serial queue — a single in-flight writer at a time. A burst of events
// from one workflow (e.g., moveIn emits customer.created + account.created
// + agreement.created + meter_read.created together) used to spawn N
// concurrent fire-and-forget handlers, each demanding two connections
// from the shared Prisma pool. Serializing here bounds audit-writer's
// footprint on the pool to one connection at a time.
const queue: DomainEvent[] = [];
let draining = false;

async function writeAuditRow(event: DomainEvent): Promise<void> {
  // Interactive transaction scopes set_config to the transaction (third
  // arg `true`), so the tenant context does not leak onto the pooled
  // connection after release. It also keeps the SET and the INSERT on
  // one connection — half the pool demand of the previous two-call path.
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.current_utility_id', ${event.utilityId}, true)`;
    await tx.auditLog.create({
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
  });
}

async function drain(): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    while (queue.length > 0) {
      const event = queue.shift()!;
      try {
        await writeAuditRow(event);
      } catch (err) {
        console.error("[audit-writer] Failed to write audit log:", err);
      }
    }
  } finally {
    draining = false;
  }
}

export function startAuditWriter(): void {
  domainEvents.on("domain-event", (event: DomainEvent) => {
    queue.push(event);
    void drain();
  });
}
