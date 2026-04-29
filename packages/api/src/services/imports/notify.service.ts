import type { ImportBatch } from "@utility-cis/shared/src/generated/prisma";
import { prisma } from "../../lib/prisma.js";
import { sendNotification } from "../notification.service.js";
import { logger } from "../../lib/logger.js";

/**
 * Terminal-state notification fan-out for an import batch:
 *   1. Always: write one InAppNotification row addressed to
 *      batch.createdBy. Bell-icon UI consumes this in slice 4.
 *   2. Email: only when the batch was async (recordCount > sync
 *      threshold) AND the user's UserPreference.preferences
 *      .notifyOnImportComplete is true (defaults to true). The notif
 *      engine handles delivery.
 *
 * Sync batches skip email — the operator was watching the wizard and
 * already saw the result panel.
 */
const SYNC_THRESHOLD = 250; // mirrors imports.service.ts SYNC_THRESHOLD_ROWS

export async function emitImportTerminalNotifications(
  batch: ImportBatch,
): Promise<void> {
  const terminal = ["COMPLETE", "PARTIAL", "FAILED", "CANCELLED"] as const;
  if (!terminal.includes(batch.status as (typeof terminal)[number])) {
    return;
  }

  const kindMap = {
    COMPLETE: { kind: "IMPORT_COMPLETE", severity: "SUCCESS", titleVerb: "complete" },
    PARTIAL: { kind: "IMPORT_PARTIAL", severity: "WARNING", titleVerb: "partial" },
    FAILED: { kind: "IMPORT_FAILED", severity: "ERROR", titleVerb: "failed" },
    CANCELLED: { kind: "IMPORT_CANCELLED", severity: "WARNING", titleVerb: "cancelled" },
  } as const;
  const meta = kindMap[batch.status as keyof typeof kindMap];

  const title = `${labelForKind(batch.entityKind)} import ${meta.titleVerb}`;
  const body = `${batch.recordCount.toLocaleString()} rows · ${batch.importedCount.toLocaleString()} imported · ${batch.errorCount.toLocaleString()} errors`;
  const link = `/imports/${batch.id}`;

  await prisma.inAppNotification.create({
    data: {
      utilityId: batch.utilityId,
      userId: batch.createdBy,
      kind: meta.kind,
      severity: meta.severity,
      title,
      body,
      link,
      metadata: {
        batchId: batch.id,
        entityKind: batch.entityKind,
        recordCount: batch.recordCount,
        importedCount: batch.importedCount,
        errorCount: batch.errorCount,
      },
    },
  });

  // Email gate: skip on sync (operator was watching) and when the user
  // has opted out.
  if (batch.recordCount <= SYNC_THRESHOLD) {
    return;
  }
  const pref = await prisma.userPreference.findUnique({
    where: { utilityId_userId: { utilityId: batch.utilityId, userId: batch.createdBy } },
    select: { preferences: true },
  });
  const prefs = (pref?.preferences as Record<string, unknown>) ?? {};
  const notifyEmail = prefs.notifyOnImportComplete !== false; // default true
  if (!notifyEmail) return;

  const user = await prisma.cisUser.findUnique({
    where: { id: batch.createdBy },
    select: { email: true, name: true },
  });
  if (!user?.email) {
    logger.warn(
      { component: "imports-notify", batchId: batch.id, userId: batch.createdBy },
      "No email on actor — skipping import.complete email",
    );
    return;
  }

  await sendNotification(batch.utilityId, {
    eventType: "import.complete",
    channel: "EMAIL",
    recipientId: batch.createdBy,
    recipientOverride: { email: user.email },
    context: {
      kind: labelForKind(batch.entityKind),
      status: batch.status,
      imported: String(batch.importedCount),
      errored: String(batch.errorCount),
      total: String(batch.recordCount),
      link,
      actorName: user.name ?? "",
      fileName: batch.fileName ?? "(unknown)",
    },
  });
}

function labelForKind(kind: string): string {
  return kind
    .split("_")
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join(" ");
}
