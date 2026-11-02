/**
 * Does the **async** import path actually work end to end?
 *
 * Everything above the sync threshold is proven by the test suite and by
 * nothing else, because every integration suite mocks `enqueueSafely`
 * on purpose — a test that enqueued into the developer's Redis would
 * leave jobs behind naming rows from a torn-down container, which is
 * how 102 unrunnable dev jobs once appeared on the platform console. So
 * no test has ever watched a real BullMQ job be picked up by a real
 * worker and drive a batch to a terminal state.
 *
 * That is the one thing this exercises: enqueue → worker → per-row
 * dispatch → terminal status → notification. It drives the service
 * directly rather than over HTTP, because the subject is the queue and
 * the worker, not Fastify's multipart parsing, which the integration
 * tests already cover thoroughly.
 *
 * It prints `attendance` on every status change, which is also the only
 * way that banner gets looked at: run this with no worker attached and
 * it reports `workers: 0` and sits in PENDING, which is exactly the
 * screen a utility admin sees and could not previously explain.
 *
 *   # terminal 1 — the worker, limited to the one queue on purpose:
 *   #   a bare worker runs whatever has accumulated in all nine, and
 *   #   notification-send dispatches outward while audit-retention
 *   #   deletes rows.
 *   WORKER_QUEUES=imports pnpm --filter @utility-cis/api dev:worker
 *
 *   # terminal 2
 *   pnpm --filter @utility-cis/api exec tsx --env-file=.env scripts/smoke-async-import.ts
 *
 * The 300 premises it writes are all keyed `SMOKE-*`. Pass `--cleanup`
 * to delete them and the batch again, which leaves the dev database as
 * it was found.
 */
import { runAsTenant } from "../src/lib/tenant-context.js";
import { prisma } from "../src/lib/prisma.js";

const UTILITY_ID = "00000000-0000-4000-8000-000000000001";
const ACTOR_ID = "00000000-0000-4000-8000-000000000091";
const ROWS = 300;
const KEY_PREFIX = "SMOKE-";

const MAPPING = {
  legacy_id: "legacyKey",
  address1: "addressLine1",
  city: "city",
  state: "state",
  zip: "zip",
  premise_type: "premiseType",
};

function csv(): string {
  const lines = ["legacy_id,address1,city,state,zip,premise_type"];
  for (let i = 1; i <= ROWS; i++) {
    lines.push(
      `${KEY_PREFIX}${String(i).padStart(5, "0")},${i} Smoke Test Way,Testville,MT,59715,RESIDENTIAL`,
    );
  }
  return lines.join("\n") + "\n";
}

async function cleanup(): Promise<void> {
  const removed = await runAsTenant(UTILITY_ID, async () => {
    const premises = await prisma.premise.deleteMany({
      where: { utilityId: UTILITY_ID, legacyKey: { startsWith: KEY_PREFIX } },
    });
    const batches = await prisma.importBatch.findMany({
      where: { utilityId: UTILITY_ID, fileName: "async-smoke-300.csv" },
      select: { id: true },
    });
    const ids = batches.map((b) => b.id);
    if (ids.length > 0) {
      await prisma.importRow.deleteMany({ where: { importBatchId: { in: ids } } });
      await prisma.attachment.deleteMany({
        where: { utilityId: UTILITY_ID, entityType: "ImportBatch", entityId: { in: ids } },
      });
      await prisma.inAppNotification.deleteMany({
        where: { utilityId: UTILITY_ID, link: { in: ids.map((id) => `/imports/${id}`) } },
      });
      await prisma.importBatch.deleteMany({ where: { id: { in: ids } } });
    }
    return { premises: premises.count, batches: ids.length };
  });
  console.log(`cleaned up: ${removed.premises} premises, ${removed.batches} batch(es)`);
}

async function main() {
  if (process.argv.includes("--cleanup")) {
    await cleanup();
    return;
  }

  const { createImport, getImport, SYNC_THRESHOLD_ROWS } = await import(
    "../src/services/imports.service.js"
  );
  // Registration side effect: without it the kind is unknown.
  await import("../src/imports/handlers/index.js");

  console.log(`posting ${ROWS} rows (sync threshold is ${SYNC_THRESHOLD_ROWS})`);
  const started = Date.now();
  const result = await runAsTenant(UTILITY_ID, async () =>
    createImport(UTILITY_ID, ACTOR_ID, "Async smoke test", {
      kind: "premise",
      source: "MANUAL_UPLOAD",
      fileName: "async-smoke-300.csv",
      fileType: "text/csv",
      fileBuffer: Buffer.from(csv(), "utf-8"),
      mapping: MAPPING,
    }),
  );

  if (!("async" in result) || result.async !== true) {
    console.error("FAIL: expected the async path, got the inline one:", result);
    process.exitCode = 1;
    return;
  }
  console.log(`enqueued: batch ${result.batchId}, ${result.recordCount} rows`);
  const batchId = result.batchId;

  // Poll the way the wizard does.
  let last = "";
  for (let i = 0; i < 180; i++) {
    const { batch, attendance } = await runAsTenant(UTILITY_ID, async () =>
      getImport(UTILITY_ID, batchId),
    );
    const line =
      `${batch.status} imported=${batch.importedCount} errors=${batch.errorCount}` +
      ` attendance=${JSON.stringify(attendance)}`;
    if (line !== last) {
      console.log(`[${((Date.now() - started) / 1000).toFixed(1)}s] ${line}`);
      last = line;
    }
    if (["COMPLETE", "PARTIAL", "FAILED", "CANCELLED"].includes(batch.status)) {
      const notices = await runAsTenant(UTILITY_ID, async () =>
        prisma.inAppNotification.count({
          where: { utilityId: UTILITY_ID, link: `/imports/${batchId}` },
        }),
      );
      const rows = await runAsTenant(UTILITY_ID, async () =>
        prisma.importRow.groupBy({
          by: ["status"],
          where: { importBatchId: batchId },
          _count: { _all: true },
        }),
      );
      console.log(
        `\n${batch.status} in ${((Date.now() - started) / 1000).toFixed(1)}s —` +
          ` ${batch.importedCount}/${batch.recordCount} imported, ${batch.errorCount} errors`,
      );
      console.log("import_row by status:", rows.map((r) => `${r.status}=${r._count._all}`).join(" "));
      console.log("in-app notifications for this batch:", notices);
      const landed = await runAsTenant(UTILITY_ID, async () =>
        prisma.premise.count({
          where: { utilityId: UTILITY_ID, legacyKey: { startsWith: KEY_PREFIX } },
        }),
      );
      console.log("premises carrying a SMOKE- legacy key:", landed);
      process.exitCode =
        batch.status === "COMPLETE" && batch.importedCount === ROWS && landed === ROWS ? 0 : 1;
      return;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  console.error("FAIL: not terminal after 180s — is a worker attached to the imports queue?");
  process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect().catch(() => {});
  });
