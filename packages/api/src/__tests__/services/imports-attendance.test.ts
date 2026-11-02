import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { prisma } from "../../lib/prisma.js";

/**
 * `getImport` tells the operator whether anything is draining the
 * imports queue.
 *
 * A batch over `SYNC_THRESHOLD_ROWS` is enqueued rather than run
 * inline, and in a deployment where no worker is attached it stays
 * PENDING for ever. The detail page polled that status and drew the
 * progress bar only once it reached PROCESSING, so a queued import
 * nothing would ever pick up looked exactly like one about to start —
 * a badge that never changed, with nothing to click.
 *
 * **The person looking at it cannot diagnose it.** Imports are
 * initiated by a utility admin, and worker attachment is on
 * `/platform/cluster/*`, behind the platform actor — a tenant's own
 * System Admin is refused there on purpose. So the one fact that
 * explains the screen was visible only to somebody who was not looking
 * at it, and the admin's remaining move was a support ticket.
 *
 * What travels is a fact about their own job — is anything processing
 * imports, and is the queue paused — and never anything else about the
 * deployment.
 */

const { readQueueAttachment } = vi.hoisted(() => ({
  readQueueAttachment: vi.fn(),
}));

vi.mock("../../services/queue-health.service.js", () => ({
  readQueueAttachment,
}));

const BATCH = {
  id: "11111111-1111-4111-8111-111111111111",
  utilityId: "00000000-0000-4000-8000-0000000000aa",
  status: "PENDING" as string,
  entityKind: "service_agreement",
  recordCount: 4000,
  importedCount: 0,
  errorCount: 0,
};

function arrange(status: string) {
  vi.mocked(prisma.importBatch.findFirstOrThrow).mockResolvedValue({
    ...BATCH,
    status,
  } as never);
  vi.mocked(prisma.attachment.findFirst).mockResolvedValue(null as never);
}

/** Imported late so the module picks up the mock above. */
async function getImport(status: string) {
  arrange(status);
  const svc = await import("../../services/imports.service.js");
  return svc.getImport(BATCH.utilityId, BATCH.id);
}

beforeEach(() => {
  vi.clearAllMocks();
  readQueueAttachment.mockResolvedValue({
    workers: 0,
    workerAgeSeconds: null,
    paused: false,
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("getImport — queue attendance", () => {
  it("reports an unattended queue for a batch still waiting", async () => {
    const result = await getImport("PENDING");
    expect(result.attendance).toEqual({ workers: 0, paused: false });
    expect(readQueueAttachment).toHaveBeenCalledWith("imports");
  });

  it("reports the worker count when one is attached", async () => {
    readQueueAttachment.mockResolvedValue({
      workers: 2,
      workerAgeSeconds: 41,
      paused: false,
    });
    const result = await getImport("PENDING");
    expect(result.attendance).toEqual({ workers: 2, paused: false });
  });

  it("carries the pause, because an attached worker on a paused queue still runs nothing", async () => {
    readQueueAttachment.mockResolvedValue({
      workers: 1,
      workerAgeSeconds: 10,
      paused: true,
    });
    const result = await getImport("PROCESSING");
    expect(result.attendance).toEqual({ workers: 1, paused: true });
  });

  it("does not read Redis for a batch that has finished", async () => {
    for (const status of ["COMPLETE", "PARTIAL", "FAILED", "CANCELLED"]) {
      vi.clearAllMocks();
      const result = await getImport(status);
      expect(result.attendance).toBeNull();
      expect(readQueueAttachment).not.toHaveBeenCalled();
    }
  });

  it("says nothing rather than guessing when the count cannot be determined", async () => {
    // `readQueueAttachment`'s own "not known": a managed Redis that
    // refuses CLIENT LIST answers with an entry carrying no address, and
    // counting it would report a phantom worker.
    readQueueAttachment.mockResolvedValue({
      workers: null,
      workerAgeSeconds: null,
      paused: false,
    });
    const result = await getImport("PENDING");
    expect(result.attendance).toEqual({ workers: null, paused: false });
  });

  it("gives up on a deadline instead of waiting for a Redis that never answers", async () => {
    /*
     * ioredis queues commands while disconnected and retries for ever,
     * so an unreachable cache never rejects — it simply never answers,
     * and a try/catch cannot see that. `readQueueAttachment` has a
     * try/catch and no deadline, which is why the call here is wrapped
     * in one. Without it, one unreachable Redis would hang every
     * request for this page.
     */
    vi.useFakeTimers();
    readQueueAttachment.mockReturnValue(new Promise(() => {}));

    arrange("PENDING");
    const svc = await import("../../services/imports.service.js");
    const pending = svc.getImport(BATCH.utilityId, BATCH.id);

    await vi.advanceTimersByTimeAsync(3_000);

    expect((await pending).attendance).toBeNull();
  });
});
