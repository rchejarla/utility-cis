import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { apiClient } from "@/lib/api-client";
import ClusterOverviewPage from "../page";

/**
 * The page an operator opens to ask "is anything stuck".
 *
 * Which means the all-clear has to be as legible as the alarm: most
 * visits land on nothing wrong, and a wall of zeroes does not answer the
 * question — it makes the reader do the summing. The failure case has to
 * name the tenant, because that is the half Bull Board structurally
 * cannot show: it has no notion of a utility.
 *
 * And "could not read the queues" must never look like "nothing is
 * queued". Those are opposite facts and the second one is reassuring.
 */

const get = apiClient.get as unknown as ReturnType<typeof vi.fn>;
const post = apiClient.post as unknown as ReturnType<typeof vi.fn>;

/** One job in the given state, as the drill-down endpoint returns it. */
function jobsResult(state: string, over: Record<string, unknown> = {}) {
  return {
    queue: "billing-runs",
    state,
    reachable: true,
    jobs: [
      {
        jobId: "7",
        jobName: "process-billing-run",
        utilityId: "u-1",
        utilityName: "City of Testville",
        enqueuedAt: "2026-10-20T09:00:00.000Z",
        runsAt: null,
        repeats: null,
        attemptsMade: 0,
        reason: null,
        tenancy: "per-tenant",
        invalid: null,
        ...over,
      },
    ],
  };
}

function queue(over: Record<string, unknown> = {}) {
  return {
    name: "billing-runs",
    counts: { waiting: 0, active: 0, delayed: 0, failed: 0, completed: 0 },
    dlqDepth: 0,
    // One worker, attached a while ago: the healthy default, so a test
    // that says nothing about workers is not accidentally testing an
    // unattended queue.
    workers: 1,
    workerAgeSeconds: 900,
    paused: false,
    recentFailures: [],
    ...over,
  };
}

/** One worker, as the registry reports it. */
function workerView(over: Record<string, unknown> = {}) {
  return {
    id: "4a1f",
    node: "dev-box",
    pid: 4242,
    queues: [],
    startedAt: "2026-10-20T10:00:00.000Z",
    healthPort: 3002,
    logFile: "C:/dev/worker.log",
    attached: true,
    stoppable: true,
    ...over,
  };
}

function report(over: Record<string, unknown> = {}) {
  return {
    reachable: true,
    checkedAt: "2026-10-20T10:00:00.000Z",
    queues: [queue(), queue({ name: "imports" })],
    totals: { waiting: 0, active: 0, failed: 0, dlq: 0 },
    controllable: true,
    thisNode: "dev-box",
    workers: [],
    nodes: [{ host: "dev-box", ageSeconds: 900 }],
    ...over,
  };
}

beforeEach(() => {
  /*
   * `mockReset`, not `clearAllMocks`: the latter leaves queued
   * `mockResolvedValueOnce` values in place, so a value a failing test
   * never consumed is served to the next one — which renders the
   * drill-down payload where the summary belongs and fails somewhere
   * unrelated.
   */
  get.mockReset();
  post.mockReset();
});

describe("the cluster overview", () => {
  it("says everything is clear in a sentence, not a table of zeroes", async () => {
    get.mockResolvedValue(report());

    render(<ClusterOverviewPage />);

    expect(await screen.findByText(/nothing failed or dead-lettered/i)).toBeInTheDocument();
  });

  it("leads with what failed when something has", async () => {
    get.mockResolvedValue(
      report({
        queues: [
          queue({ name: "imports" }),
          queue({
            name: "billing-runs",
            counts: { waiting: 1, active: 0, delayed: 0, failed: 2 },
            dlqDepth: 1,
          }),
        ],
        totals: { waiting: 1, active: 0, failed: 2, dlq: 1 },
      }),
    );

    render(<ClusterOverviewPage />);

    expect(await screen.findByText(/2 failed/i)).toBeInTheDocument();
    expect(screen.getByText(/1 dead-lettered/i)).toBeInTheDocument();
    // The queue table — and with it the troubled-first ordering — moved
    // to the Queues page, where that assertion now lives.
  });

  it("names the tenant behind a failure", async () => {
    get.mockResolvedValue(
      report({
        queues: [
          queue({
            counts: { waiting: 0, active: 0, delayed: 0, failed: 1 },
            recentFailures: [
              {
                jobId: "42",
                jobName: "process-billing-run",
                failedAt: "2026-10-20T09:30:00.000Z",
                reason: "Bill 7 has no charges",
                utilityId: "u-1",
                utilityName: "City of Testville",
              },
            ],
          }),
        ],
        totals: { waiting: 0, active: 0, failed: 1, dlq: 0 },
      }),
    );

    render(<ClusterOverviewPage />);

    expect(await screen.findByText("City of Testville")).toBeInTheDocument();
    expect(screen.getByText(/Bill 7 has no charges/)).toBeInTheDocument();
  });

  it("calls a sweep's failure what it is rather than inventing an owner", async () => {
    get.mockResolvedValue(
      report({
        queues: [
          queue({
            name: "audit-retention",
            counts: { waiting: 0, active: 0, delayed: 0, failed: 1 },
            recentFailures: [
              {
                jobId: "9",
                jobName: "audit-retention",
                failedAt: "2026-10-20T09:30:00.000Z",
                reason: "deadlock detected",
                utilityId: null,
                utilityName: null,
              },
            ],
          }),
        ],
        totals: { waiting: 0, active: 0, failed: 1, dlq: 0 },
      }),
    );

    render(<ClusterOverviewPage />);

    expect(await screen.findByText(/all tenants/i)).toBeInTheDocument();
  });

  it("refuses to call it all clear when no worker is attached to anything", async () => {
    /*
     * The state of the dev stack while this was written: 102 jobs waiting
     * across two queues, nothing failed, and no worker process running —
     * because workers are a separate process and `start_dev.bat` says so
     * and does not start them. The page said "All clear", which was the
     * most misleading thing it could have said.
     */
    get.mockResolvedValue(
      report({
        queues: [
          queue({ counts: { waiting: 80, active: 0, delayed: 0, failed: 0 }, workers: 0, workerAgeSeconds: null }),
          queue({ name: "imports", counts: { waiting: 22, active: 0, delayed: 0, failed: 0 }, workers: 0, workerAgeSeconds: null }),
        ],
        totals: { waiting: 102, active: 0, failed: 0, dlq: 0 },
      }),
    );

    render(<ClusterOverviewPage />);

    expect(await screen.findByText(/nothing is running/i)).toBeInTheDocument();
    expect(screen.getByText(/102 jobs are waiting/i)).toBeInTheDocument();
    expect(screen.queryByText(/all clear/i)).not.toBeInTheDocument();
  });

  it("says how many queues are unattended when only some are", async () => {
    get.mockResolvedValue(
      report({
        queues: [queue(), queue({ name: "imports", workers: 0, workerAgeSeconds: null })],
      }),
    );

    render(<ClusterOverviewPage />);

    expect(await screen.findByText(/1 of 2 queues has no worker/i)).toBeInTheDocument();
  });

  it("still names the missing workers when something has also failed", async () => {
    // The two facts are independent, and the failure must not bury the
    // reason the retry will not run either.
    get.mockResolvedValue(
      report({
        queues: [
          queue({ counts: { waiting: 0, active: 0, delayed: 0, failed: 2 }, workers: 0, workerAgeSeconds: null }),
        ],
        totals: { waiting: 0, active: 0, failed: 2, dlq: 0 },
      }),
    );

    render(<ClusterOverviewPage />);

    expect(await screen.findByText(/needs attention/i)).toBeInTheDocument();
    expect(screen.getByText(/no worker is attached/i)).toBeInTheDocument();
  });

  it("flags a paused queue, which processes nothing with workers attached", async () => {
    get.mockResolvedValue(report({ queues: [queue({ paused: true })] }));

    render(<ClusterOverviewPage />);

    // The verdict. The per-queue marker is on the Queues page, with the
    // table it marks.
    expect(await screen.findByText(/a queue is paused/i)).toBeInTheDocument();
    expect(screen.queryByText(/all clear/i)).not.toBeInTheDocument();
  });

});