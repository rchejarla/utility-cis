import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { apiClient } from "@/lib/api-client";
import ClusterWorkersPage from "../page";

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

/**
 * A worker holding code older than the source on disk.
 *
 * This is the one thing this page could not say, and it cost four
 * billing runs in an evening: the worker is the only process in the
 * stack that does not reload — the API runs `tsx watch`, and a worker
 * deliberately runs as a single `--import tsx` process so the recorded
 * pid is the worker's own and a stop cannot orphan it. So a code change
 * does not reach the next run, the run reports the old behaviour as
 * current, and nothing on screen contradicts it.
 *
 * Reported rather than fixed by reloading: the restart is one click,
 * and `tsx watch` here would put a supervisor between the registry and
 * the process it names.
 */
describe("a worker running older code than the source", () => {
  it("says so, and says what to do about it", async () => {
    get.mockResolvedValue(
      report({
        sourceChangedAt: "2026-10-20T10:30:00.000Z",
        workers: [workerView({ startedAt: "2026-10-20T10:00:00.000Z" })],
      }),
    );
    render(<ClusterWorkersPage />);

    expect(await screen.findByText(/running code from before/i)).toBeInTheDocument();
    expect(screen.getByText(/restart/i)).toBeInTheDocument();
  });

  it("stays quiet when the worker started after the last change", async () => {
    get.mockResolvedValue(
      report({
        sourceChangedAt: "2026-10-20T10:00:00.000Z",
        workers: [workerView({ startedAt: "2026-10-20T10:30:00.000Z" })],
      }),
    );
    render(<ClusterWorkersPage />);

    await screen.findByRole("columnheader", { name: /^worker$/i });
    expect(screen.queryByText(/running code from before/i)).not.toBeInTheDocument();
  });

  it("stays quiet where there is no source to compare against", async () => {
    // Production: the API reports null rather than stat-ing a tree that
    // is not there, and a built worker has no sources to be stale
    // against anyway.
    get.mockResolvedValue(
      report({ sourceChangedAt: null, workers: [workerView()] }),
    );
    render(<ClusterWorkersPage />);

    await screen.findByRole("columnheader", { name: /^worker$/i });
    expect(screen.queryByText(/running code from before/i)).not.toBeInTheDocument();
  });
});

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

describe("the cluster workers page", () => {
  it("offers to start a worker on the node that answered", async () => {
    // Start is node-local: nothing portable spawns a process on another
    // machine, so the control names the node it will act on rather than
    // implying a choice.
    get.mockResolvedValue(report({ queues: [queue({ workers: 0, workerAgeSeconds: null })] }));
    post.mockResolvedValue(workerView({ node: "dev-box" }));

    render(<ClusterWorkersPage />);
    await userEvent.click(
      await screen.findByRole("button", { name: /start worker on dev-box/i }),
    );

    expect(post).toHaveBeenCalledWith("/api/v1/platform/workers/start", { queues: [] });
    expect(await screen.findByText(/started — pid 4242 on dev-box/i)).toBeInTheDocument();
  });

  it("lists every connected node, including ones running no worker", async () => {
    /*
     * "Which nodes have nothing attached" is the useful question, and a
     * node is invisible if it is only learned about through its workers.
     * The node list comes from Redis's client list, so this is correct
     * from whichever node happens to serve the page.
     */
    get.mockResolvedValue(
      report({
        thisNode: "api-7f3c",
        nodes: [
          { host: "api-7f3c", ageSeconds: 3600 },
          { host: "api-9b21", ageSeconds: 120 },
          { host: "api-2d08", ageSeconds: 90 },
        ],
        workers: [
          workerView({ id: "4a1f", node: "api-7f3c", pid: 4242, stoppable: true }),
          workerView({ id: "9c02", node: "api-9b21", pid: 881, stoppable: false }),
        ],
      }),
    );

    render(<ClusterWorkersPage />);

    expect(await screen.findByText("api-2d08")).toBeInTheDocument();
    expect(screen.getByText("api-9b21")).toBeInTheDocument();
    // And says which one you are talking to, since a start lands there.
    expect(screen.getByText(/serving this page/i)).toBeInTheDocument();
  });

  it("labels the columns of the worker table", async () => {
    /*
     * The same fault the job list had: the first version of this panel
     * rendered `pid 4242 attached since 9:02:00 AM` as a bare run of
     * values, under a node name, with the notes for one worker floating
     * below every node at once.
     */
    get.mockResolvedValue(
      report({ workers: [workerView({ node: "dev-box" })] }),
    );

    render(<ClusterWorkersPage />);

    for (const header of [/^node$/i, /^worker$/i, /^state$/i, /^since$/i, /^action$/i]) {
      expect(await screen.findByRole("columnheader", { name: header })).toBeInTheDocument();
    }
  });

  it("counts the nodes and workers above the table", async () => {
    get.mockResolvedValue(
      report({
        nodes: [
          { host: "api-7f3c", ageSeconds: 3600 },
          { host: "api-9b21", ageSeconds: 120 },
          { host: "api-2d08", ageSeconds: 90 },
        ],
        workers: [workerView({ node: "api-7f3c" })],
      }),
    );

    render(<ClusterWorkersPage />);

    expect(await screen.findByText(/3 nodes/i)).toBeInTheDocument();
    expect(screen.getByText(/1 worker/i)).toBeInTheDocument();
    expect(screen.getByText(/2 with none/i)).toBeInTheDocument();
  });

  it("keeps a worker whose node has dropped off the client list", async () => {
    // Its record is all that is left of it, and that is exactly when it
    // must not vanish from the table.
    get.mockResolvedValue(
      report({
        thisNode: "api-7f3c",
        nodes: [{ host: "api-7f3c", ageSeconds: 3600 }],
        workers: [workerView({ id: "9c02", node: "api-gone", stoppable: false })],
      }),
    );

    render(<ClusterWorkersPage />);

    expect(await screen.findByText("api-gone")).toBeInTheDocument();
    expect(screen.getByText(/not connected/i)).toBeInTheDocument();
  });

  it("offers Stop only for a worker this node can actually signal", async () => {
    // A pid means nothing on another host. Offering a button that can
    // only answer 409 is worse than offering none.
    get.mockResolvedValue(
      report({
        thisNode: "api-7f3c",
        nodes: [
          { host: "api-7f3c", ageSeconds: 3600 },
          { host: "api-9b21", ageSeconds: 120 },
        ],
        workers: [
          workerView({ id: "4a1f", node: "api-7f3c", pid: 4242, stoppable: true }),
          workerView({ id: "9c02", node: "api-9b21", pid: 881, stoppable: false }),
        ],
      }),
    );

    render(<ClusterWorkersPage />);

    expect(await screen.findAllByRole("button", { name: /^stop worker on /i })).toHaveLength(1);
    expect(screen.getByText(/stop it from api-9b21/i)).toBeInTheDocument();
  });

  it("stops a worker by its own id", async () => {
    get.mockResolvedValue(
      report({
        thisNode: "dev-box",
        workers: [workerView({ id: "4a1f", node: "dev-box", stoppable: true })],
      }),
    );
    post.mockResolvedValue({
      id: "4a1f",
      node: "dev-box",
      pid: 4242,
      stopping: true,
      method: "drain",
      drained: true,
    });

    render(<ClusterWorkersPage />);
    await userEvent.click(await screen.findByRole("button", { name: /stop worker on dev-box/i }));

    expect(post).toHaveBeenCalledWith("/api/v1/platform/workers/4a1f/stop", {});
    expect(await screen.findByText(/draining/i)).toBeInTheDocument();
  });

  it("says plainly when a worker had to be cut off instead of drained", async () => {
    // The fallback: a wedged worker that no longer answers its own HTTP
    // server gets a signal, which on Windows is abrupt.
    get.mockResolvedValue(
      report({
        thisNode: "dev-box",
        workers: [workerView({ id: "4a1f", node: "dev-box", stoppable: true })],
      }),
    );
    post.mockResolvedValue({
      id: "4a1f",
      node: "dev-box",
      pid: null,
      stopping: false,
      method: "signal",
      drained: false,
    });

    render(<ClusterWorkersPage />);
    await userEvent.click(await screen.findByRole("button", { name: /stop worker on dev-box/i }));

    expect(await screen.findByText(/could not be reached/i)).toBeInTheDocument();
  });

  it("shows a worker as not attached, which is not the same as absent", async () => {
    // Either still booting, or dead on a node whose pid this one cannot
    // check. Both are worth seeing; neither is "running".
    get.mockResolvedValue(
      report({
        thisNode: "api-7f3c",
        workers: [workerView({ id: "9c02", node: "api-9b21", attached: false, stoppable: false })],
      }),
    );

    render(<ClusterWorkersPage />);

    expect(await screen.findByText(/not attached/i)).toBeInTheDocument();
  });

  it("says a worker is attached that this console did not start", async () => {
    // Started from a terminal: attached to the same Redis and visible in
    // the queue counts, but with no record, so nothing to stop here.
    get.mockResolvedValue(
      report({ queues: [queue({ workers: 1 })], workers: [] }),
    );

    render(<ClusterWorkersPage />);

    expect(await screen.findByText(/not started from here/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^stop worker on /i })).not.toBeInTheDocument();
  });

  it("offers no worker controls on a node that does not allow them", async () => {
    get.mockResolvedValue(
      report({
        queues: [queue({ workers: 0, workerAgeSeconds: null })],
        controllable: false,
      }),
    );

    render(<ClusterWorkersPage />);
    await screen.findByRole("columnheader", { name: /^node$/i });

    expect(screen.queryByRole("button", { name: /start worker/i })).not.toBeInTheDocument();
    expect(screen.getByText(/separate deployment/i)).toBeInTheDocument();
  });

  it("shows the refusal when a worker is already running on this node", async () => {
    get.mockResolvedValue(report({ queues: [queue({ workers: 0, workerAgeSeconds: null })] }));
    post.mockRejectedValue(
      new Error("API error 409: A worker is already running on dev-box as pid 99"),
    );

    render(<ClusterWorkersPage />);
    await userEvent.click(await screen.findByRole("button", { name: /start worker/i }));

    expect(await screen.findByText(/already running on dev-box/i)).toBeInTheDocument();
  });

  it("says the node list is unknown rather than showing none", async () => {
    // Managed Redis refuses CLIENT LIST. "No nodes" is never true of a
    // deployment that is serving this page.
    get.mockResolvedValue(report({ nodes: null }));

    render(<ClusterWorkersPage />);

    expect(await screen.findByText(/could not be listed/i)).toBeInTheDocument();
  });

  it("names the queues whose jobs a start would run, not just how many", async () => {
    /*
     * Starting a worker on a stack that has been idle runs whatever has
     * piled up, at once. The first version of this said "5 queued jobs
     * will start running immediately, overdue scheduled sweeps included.
     * Open a count first" — which names no queue, and asks the reader to
     * know what a sweep is and that a count is a thing you can open.
     */
    get.mockResolvedValue(
      report({
        queues: [
          queue({ counts: { waiting: 3, active: 0, delayed: 0, failed: 0 }, workers: 0, workerAgeSeconds: null }),
          queue({ name: "audit-retention", counts: { waiting: 0, active: 0, delayed: 1, failed: 0 }, workers: 0, workerAgeSeconds: null }),
          queue({ name: "imports", workers: 0, workerAgeSeconds: null }),
        ],
        totals: { waiting: 3, active: 0, failed: 0, dlq: 0 },
      }),
    );

    render(<ClusterWorkersPage />);
    await screen.findByRole("button", { name: /start worker/i });

    expect(screen.getByText(/billing-runs 3/)).toBeInTheDocument();
    expect(screen.getByText(/audit-retention 1/)).toBeInTheDocument();
    // A queue with nothing queued has nothing to warn about.
    expect(screen.queryByText(/imports 0/)).not.toBeInTheDocument();
  });

  it("says nothing about queued work when there is none to run", async () => {
    get.mockResolvedValue(report({ queues: [queue({ workers: 0, workerAgeSeconds: null })] }));

    render(<ClusterWorkersPage />);
    await screen.findByRole("button", { name: /start worker/i });

    expect(screen.queryByText(/already queued/i)).not.toBeInTheDocument();
  });

});