import { Prisma } from "@utility-cis/shared/src/generated/prisma";
import { prisma } from "./prisma.js";

type TxClient = Omit<typeof prisma, "$connect" | "$disconnect" | "$on" | "$transaction" | "$use" | "$extends">;

/**
 * Audit-row emission helpers. Every mutating service uses these to wrap
 * its create/update/delete: the wrapper opens a `prisma.$transaction`
 * (or joins the caller's existing one), runs the mutation, then writes
 * the audit row in the same transaction. Atomicity guarantee: the
 * mutation and its audit row commit together or not at all.
 *
 * Replaces the prior EventEmitter pipeline (`events/emitter.ts` +
 * `events/audit-writer.ts`) which split the mutation and audit writes
 * across two separate transactions and lost atomicity if the process
 * crashed between them. See `docs/superpowers/specs/2026-04-27-event-
 * emitter-audit-refactor-design.md` for the rationale.
 *
 * Three public functions:
 *   - `auditCreate(ctx, eventType, (tx) => tx.foo.create(...))` —
 *     wraps an entity creation; writes audit with beforeState=null.
 *   - `auditUpdate(ctx, eventType, before, (tx) => tx.foo.update(...))` —
 *     wraps an entity mutation; writes audit with beforeState=before.
 *   - `writeAuditRow(tx, ctx, eventType, entityId, before, after)` —
 *     low-level, for callers already inside a transaction that need to
 *     emit a standalone audit row (e.g., meter-read.service emits one
 *     audit row per row in a multi-register read event).
 *
 * All three accept an optional `existingTx` parameter (or in the case
 * of `writeAuditRow`, the tx is required) so multi-step service flows
 * can keep everything in one transaction.
 */

export interface AuditContext {
  utilityId: string;
  actorId: string;
  actorName?: string;
  entityType: string;
}

type WithId = { id: string };

// Prisma's Json column rejects `undefined`; use `null` to mean "no value".
// Casting to keep Prisma's generated types out of this module's emitted
// declarations (avoids TS2742 portability errors in workspace builds).
function toJsonInput(value: unknown): Prisma.InputJsonValue | typeof Prisma.JsonNull {
  if (value === undefined || value === null) return Prisma.JsonNull;
  return value as Prisma.InputJsonValue;
}

function mapEventTypeToAction(eventType: string): "CREATE" | "UPDATE" | "DELETE" {
  if (eventType.endsWith(".created")) return "CREATE";
  if (eventType.endsWith(".revised")) return "UPDATE";
  if (eventType.endsWith(".deleted")) return "DELETE";
  return "UPDATE";
}

export async function writeAuditRow(
  tx: TxClient,
  ctx: AuditContext,
  eventType: string,
  entityId: string,
  before: unknown,
  after: unknown,
): Promise<void> {
  // Transactional set_config — the third arg `true` scopes the SET to
  // this transaction; the value does NOT leak onto the connection after
  // commit/rollback. Required so the audit insert respects the tenant
  // RLS policy without contaminating subsequent queries on the same
  // pooled connection.
  await tx.$executeRaw`SELECT set_config('app.current_utility_id', ${ctx.utilityId}, true)`;
  await tx.auditLog.create({
    data: {
      utilityId: ctx.utilityId,
      entityType: ctx.entityType,
      entityId,
      action: mapEventTypeToAction(eventType),
      actorId: ctx.actorId,
      actorName: ctx.actorName ?? undefined,
      beforeState: toJsonInput(before),
      afterState: toJsonInput(after),
      metadata: { eventType } satisfies Prisma.InputJsonValue,
    },
  });
}

export async function auditCreate<T extends WithId>(
  ctx: AuditContext,
  eventType: string,
  op: (tx: TxClient) => Promise<T>,
  existingTx?: TxClient,
): Promise<T> {
  const run = async (tx: TxClient): Promise<T> => {
    const entity = await op(tx);
    await writeAuditRow(tx, ctx, eventType, entity.id, null, entity);
    return entity;
  };
  if (existingTx) return run(existingTx);
  return prisma.$transaction(run);
}

export async function auditUpdate<T extends WithId>(
  ctx: AuditContext,
  eventType: string,
  before: unknown,
  op: (tx: TxClient) => Promise<T>,
  existingTx?: TxClient,
): Promise<T> {
  const run = async (tx: TxClient): Promise<T> => {
    const entity = await op(tx);
    await writeAuditRow(tx, ctx, eventType, entity.id, before, entity);
    return entity;
  };
  if (existingTx) return run(existingTx);
  return prisma.$transaction(run);
}
