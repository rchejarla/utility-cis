import type { ImportBatch } from "@utility-cis/shared/src/generated/prisma";

/**
 * Stub for slice 2 task 3. Filled in by task 8 (in-app + email
 * notification fan-out on terminal transitions). Defined as a module
 * so the import-worker can wire its call site without a circular dep.
 */
export async function emitImportTerminalNotifications(
  _batch: ImportBatch,
): Promise<void> {
  // TODO(slice-2-task-8): in-app + email fan-out
}
