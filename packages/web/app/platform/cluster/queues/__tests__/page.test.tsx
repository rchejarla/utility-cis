import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { apiClient } from "@/lib/api-client";
import ClusterQueuesPage from "../page";

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

describe("the cluster queues page", () => {
  it("says the queues could not be read, which is not the same as nothing queued", async () => {
    get.mockResolvedValue(report({ reachable: false, queues: [], totals: { waiting: 0, active: 0, failed: 0, dlq: 0 } }));

    render(<ClusterQueuesPage />);

    expect(await screen.findByText(/could not be read/i)).toBeInTheDocument();
    expect(screen.queryByText(/nothing failed or dead-lettered/i)).not.toBeInTheDocument();
  });

  it("does not offer a Bull Board link a browser cannot open", async () => {
    /*
     * `authMiddleware` reads only the `authorization` header, so a tab
     * navigating to /admin/queues sends no token and is refused 401.
     * A button that always fails is worse than none; the page says
     * where Bull Board is and what it needs instead.
     */
    get.mockResolvedValue(report());

    render(<ClusterQueuesPage />);
    await screen.findByText("billing-runs");

    expect(screen.queryByRole("link", { name: /bull board/i })).not.toBeInTheDocument();
    expect(screen.getByText(/needs an operator token/i)).toBeInTheDocument();
  });

  it("opens a count to show the jobs behind it", async () => {
    get.mockResolvedValueOnce(
      report({
        queues: [queue({ counts: { waiting: 2, active: 0, delayed: 0, failed: 0 } })],
        totals: { waiting: 2, active: 0, failed: 0, dlq: 0 },
      }),
    ).mockResolvedValueOnce({
      queue: "billing-runs",
      state: "waiting",
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
        },
      ],
    });

    render(<ClusterQueuesPage />);
    await screen.findByText("billing-runs");

    await userEvent.click(screen.getByRole("button", { name: /2 waiting/i }));

    expect(await screen.findByText("City of Testville")).toBeInTheDocument();
    expect(get).toHaveBeenLastCalledWith("/api/v1/platform/queues/billing-runs/jobs", {
      state: "waiting",
      limit: "20",
    });
  });

  it("says when a delayed job is due, so a repeatable reads as armed", async () => {
    // One delayed job is the normal resting state of the five scheduled
    // queues. "Delayed: 1" alone cannot tell that apart from a retry.
    get.mockResolvedValueOnce(
      report({
        queues: [queue({ name: "audit-retention", counts: { waiting: 0, active: 0, delayed: 1, failed: 0 } })],
        totals: { waiting: 0, active: 0, failed: 0, dlq: 0 },
      }),
    ).mockResolvedValueOnce({
      queue: "audit-retention",
      state: "delayed",
      reachable: true,
      jobs: [
        {
          jobId: "repeat:1",
          jobName: "audit-retention",
          utilityId: null,
          utilityName: null,
          enqueuedAt: "2026-10-20T03:00:00.000Z",
          runsAt: "2026-10-21T03:00:00.000Z",
          repeats: "0 3 * * *",
          attemptsMade: 0,
          reason: null,
        },
      ],
    });

    render(<ClusterQueuesPage />);
    await screen.findByText("audit-retention");

    await userEvent.click(screen.getByRole("button", { name: /1 delayed/i }));

    expect(await screen.findByText(/0 3 \* \* \*/)).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: /^due$/i })).toBeInTheDocument();
  });

  it("calls a delayed job overdue once its due time has passed", async () => {
    /*
     * Verified against the running stack while building this:
     * audit-retention's repeatable was due 2026-10-18 04:00 and the
     * date was the 20th, because no worker process was up to run it and
     * reschedule. "Due two days ago" is the whole signal, and a bare
     * timestamp makes the reader do the subtraction.
     */
    get.mockResolvedValueOnce(
      report({
        queues: [queue({ name: "audit-retention", counts: { waiting: 0, active: 0, delayed: 1, failed: 0 } })],
        totals: { waiting: 0, active: 0, failed: 0, dlq: 0 },
      }),
    ).mockResolvedValueOnce({
      queue: "audit-retention",
      state: "delayed",
      reachable: true,
      jobs: [
        {
          jobId: "repeat:1",
          jobName: "sweep-expired-audits",
          utilityId: null,
          utilityName: null,
          enqueuedAt: "2020-01-01T00:00:00.000Z",
          runsAt: "2020-01-01T04:00:00.000Z",
          repeats: "0 4 * * *",
          attemptsMade: 0,
          reason: null,
        },
      ],
    });

    render(<ClusterQueuesPage />);
    await screen.findByText("audit-retention");
    await userEvent.click(screen.getByRole("button", { name: /1 delayed/i }));

    expect(await screen.findByText(/overdue/i)).toBeInTheDocument();
  });

  it("offers Retry on a failed job, and records what came back", async () => {
    get.mockResolvedValueOnce(
      report({
        queues: [queue({ counts: { waiting: 0, active: 0, delayed: 0, failed: 1 } })],
        totals: { waiting: 0, active: 0, failed: 1, dlq: 0 },
      }),
    ).mockResolvedValueOnce(jobsResult("failed", { jobId: "80" }));
    post.mockResolvedValue({
      queue: "billing-runs",
      jobId: "80",
      action: "retry",
      audited: true,
      auditedAs: { entityType: "BillingRun", entityId: "run-1" },
    });

    render(<ClusterQueuesPage />);
    await screen.findByText("billing-runs");
    await userEvent.click(screen.getByRole("button", { name: /1 failed/i }));
    await userEvent.click(await screen.findByRole("button", { name: /^retry job /i }));

    expect(post).toHaveBeenCalledWith(
      "/api/v1/platform/queues/billing-runs/jobs/80/retry",
      {},
    );
    expect(await screen.findByText(/retried/i)).toBeInTheDocument();
  });

  it("says when an action happened but could not be recorded", async () => {
    // A sweep names no tenant, and `audit_log` needs one. Telling the
    // operator beats implying every action is on the record.
    get.mockResolvedValueOnce(
      report({
        queues: [queue({ name: "audit-retention", counts: { waiting: 0, active: 0, delayed: 1, failed: 0 } })],
        totals: { waiting: 0, active: 0, failed: 0, dlq: 0 },
      }),
    ).mockResolvedValueOnce(jobsResult("delayed", { jobId: "repeat:1", runsAt: "2020-01-01T04:00:00.000Z" }));
    post.mockResolvedValue({
      queue: "audit-retention",
      jobId: "repeat:1",
      action: "promote",
      audited: false,
    });

    render(<ClusterQueuesPage />);
    await screen.findByText("audit-retention");
    await userEvent.click(screen.getByRole("button", { name: /1 delayed/i }));
    await userEvent.click(await screen.findByRole("button", { name: /^run now job /i }));

    expect(await screen.findByText(/not recorded/i)).toBeInTheDocument();
  });

  it("shows the refusal when a job has moved on", async () => {
    get.mockResolvedValueOnce(
      report({
        queues: [queue({ counts: { waiting: 0, active: 0, delayed: 0, failed: 1 } })],
        totals: { waiting: 0, active: 0, failed: 1, dlq: 0 },
      }),
    ).mockResolvedValueOnce(jobsResult("failed", { jobId: "80" }));
    post.mockRejectedValue(new Error("API error 409: Job 80 is waiting; retry applies to a job that is failed"));

    render(<ClusterQueuesPage />);
    await screen.findByText("billing-runs");
    await userEvent.click(screen.getByRole("button", { name: /1 failed/i }));
    await userEvent.click(await screen.findByRole("button", { name: /^retry job /i }));

    expect(await screen.findByText(/retry applies/i)).toBeInTheDocument();
  });

  it("offers no verb on a waiting job, which needs no pushing", async () => {
    get.mockResolvedValueOnce(
      report({
        queues: [queue({ counts: { waiting: 1, active: 0, delayed: 0, failed: 0 } })],
        totals: { waiting: 1, active: 0, failed: 0, dlq: 0 },
      }),
    ).mockResolvedValueOnce(jobsResult("waiting", { jobId: "80" }));

    render(<ClusterQueuesPage />);
    await screen.findByText("billing-runs");
    await userEvent.click(screen.getByRole("button", { name: /1 waiting/i }));
    await screen.findByText(/City of Testville/);

    expect(screen.queryByRole("button", { name: /^retry job /i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^run now job /i })).not.toBeInTheDocument();
  });

  it("says worker attachment is unknown, which is not the same as none", async () => {
    // A managed Redis refuses CLIENT LIST. "No workers" would send an
    // operator chasing a worker that is running fine.
    get.mockResolvedValue(
      report({ queues: [queue({ workers: null, workerAgeSeconds: null })] }),
    );

    render(<ClusterQueuesPage />);

    // Under a Workers column, the cell is the word alone. What matters is
    // that it is not the word for zero. Scoped to the table, because the
    // node list beside it says "no worker" about a node, which is a
    // different statement about a different thing.
    const table = (await screen.findByRole("columnheader", { name: /workers/i })).closest("table")!;
    expect(table.textContent).toContain("unknown");
    expect(table.textContent).not.toContain("none");
  });

  it("shows how long ago a worker attached only when it just did", async () => {
    // A worker that reattaches every few seconds is crash-looping, and
    // reads as "1 worker" otherwise. An hours-old connection's exact age
    // is noise, so it stays out.
    get.mockResolvedValue(
      report({
        queues: [
          queue({ workerAgeSeconds: 12 }),
          queue({ name: "imports", workerAgeSeconds: 9000 }),
        ],
      }),
    );

    render(<ClusterQueuesPage />);

    expect(await screen.findByText(/attached 12s ago/i)).toBeInTheDocument();
    expect(screen.queryByText(/9000/)).not.toBeInTheDocument();
  });

  it("labels the columns of the job list", async () => {
    // Opened as a bare row of values, the drill-down is a bag of
    // timestamps and ids: the first thing asked of it was "what are
    // those columns".
    get.mockResolvedValueOnce(
      report({
        queues: [queue({ counts: { waiting: 0, active: 0, delayed: 0, failed: 1 } })],
        totals: { waiting: 0, active: 0, failed: 1, dlq: 0 },
      }),
    ).mockResolvedValueOnce(jobsResult("failed", { jobId: "80", reason: "boom" }));

    render(<ClusterQueuesPage />);
    await screen.findByText("billing-runs");
    await userEvent.click(screen.getByRole("button", { name: /1 failed/i }));

    expect(await screen.findByRole("columnheader", { name: /tenant/i })).toBeInTheDocument();
    for (const header of [/^job$/i, /queued/i, /attempts/i, /reason/i]) {
      expect(screen.getByRole("columnheader", { name: header })).toBeInTheDocument();
    }
    // Due and Repeats belong to a delayed job; an empty column teaches
    // the reader nothing.
    expect(screen.queryByRole("columnheader", { name: /^due$/i })).not.toBeInTheDocument();
  });

  it("gives a delayed job the columns that apply to it", async () => {
    get.mockResolvedValueOnce(
      report({
        queues: [queue({ name: "audit-retention", counts: { waiting: 0, active: 0, delayed: 1, failed: 0 } })],
      }),
    ).mockResolvedValueOnce(
      jobsResult("delayed", { runsAt: "2026-10-21T04:00:00.000Z", repeats: "0 4 * * *" }),
    );

    render(<ClusterQueuesPage />);
    await screen.findByText("audit-retention");
    await userEvent.click(screen.getByRole("button", { name: /1 delayed/i }));

    expect(await screen.findByRole("columnheader", { name: /^due$/i })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: /repeats/i })).toBeInTheDocument();
    expect(screen.queryByRole("columnheader", { name: /reason/i })).not.toBeInTheDocument();
  });

  it("calls a job's tenant unknown when its id matches no tenant", async () => {
    /*
     * Real case in the dev stack: 22 waiting import jobs carrying
     * `utilityId` 00000000-0000-4000-8000-0000000000aa, a tenant that no
     * longer exists. The page printed the bare uuid, which reads as a
     * tenant name nobody recognises rather than as the finding it is.
     */
    get.mockResolvedValueOnce(
      report({
        queues: [queue({ name: "imports", counts: { waiting: 1, active: 0, delayed: 0, failed: 0 } })],
        totals: { waiting: 1, active: 0, failed: 0, dlq: 0 },
      }),
    ).mockResolvedValueOnce(
      jobsResult("waiting", {
        utilityId: "00000000-0000-4000-8000-0000000000aa",
        utilityName: null,
      }),
    );

    render(<ClusterQueuesPage />);
    await screen.findByText("imports");
    await userEvent.click(screen.getByRole("button", { name: /1 waiting/i }));

    expect(await screen.findByText(/unknown tenant/i)).toBeInTheDocument();
  });

  it("names what is wrong with a job that cannot run", async () => {
    /*
     * The 80 waiting billing-run jobs in the dev stack name runs that do
     * not exist, and the 22 import jobs name a tenant that is not a row
     * in `utility`. The list called all 102 of them "waiting", which is
     * the opposite of true, and the operator cannot check: the payload is
     * deliberately withheld.
     */
    get.mockResolvedValueOnce(
      report({
        queues: [queue({ counts: { waiting: 1, active: 0, delayed: 0, failed: 0 } })],
        totals: { waiting: 1, active: 0, failed: 0, dlq: 0 },
      }),
    ).mockResolvedValueOnce(
      jobsResult("waiting", { invalid: "The billing run it names no longer exists." }),
    );

    render(<ClusterQueuesPage />);
    await screen.findByText("billing-runs");
    await userEvent.click(screen.getByRole("button", { name: /1 waiting/i }));

    expect(await screen.findByRole("columnheader", { name: /problem/i })).toBeInTheDocument();
    expect(screen.getByText(/billing run it names no longer exists/i)).toBeInTheDocument();
  });

  it("keeps the Problem column out of the way when nothing is wrong", async () => {
    // A column of dashes teaches the reader to ignore the column.
    get.mockResolvedValueOnce(
      report({
        queues: [queue({ counts: { waiting: 1, active: 0, delayed: 0, failed: 0 } })],
        totals: { waiting: 1, active: 0, failed: 0, dlq: 0 },
      }),
    ).mockResolvedValueOnce(jobsResult("waiting"));

    render(<ClusterQueuesPage />);
    await screen.findByText("billing-runs");
    await userEvent.click(screen.getByRole("button", { name: /1 waiting/i }));
    await screen.findByText("City of Testville");

    expect(screen.queryByRole("columnheader", { name: /problem/i })).not.toBeInTheDocument();
  });

  it("tells a sweep's blank tenant apart from a job that lost its own", async () => {
    // Identical before — both rendered as no tenant. On audit-retention a
    // blank tenant is correct; on billing-runs it is a broken job.
    get.mockResolvedValueOnce(
      report({
        queues: [queue({ counts: { waiting: 1, active: 0, delayed: 0, failed: 0 } })],
        totals: { waiting: 1, active: 0, failed: 0, dlq: 0 },
      }),
    ).mockResolvedValueOnce(
      jobsResult("waiting", {
        utilityId: null,
        utilityName: null,
        tenancy: "per-tenant",
        invalid: "No tenant named in the payload; a job on this queue must name one.",
      }),
    );

    render(<ClusterQueuesPage />);
    await screen.findByText("billing-runs");
    await userEvent.click(screen.getByRole("button", { name: /1 waiting/i }));

    expect(await screen.findByText(/none named/i)).toBeInTheDocument();
    expect(screen.queryByText(/all tenants/i)).not.toBeInTheDocument();
  });

  it("calls a cross-tenant sweep's job every tenant's", async () => {
    get.mockResolvedValueOnce(
      report({
        queues: [queue({ name: "audit-retention", counts: { waiting: 0, active: 0, delayed: 1, failed: 0 } })],
      }),
    ).mockResolvedValueOnce(
      jobsResult("delayed", {
        utilityId: null,
        utilityName: null,
        tenancy: "all-tenants",
        repeats: "0 4 * * *",
        runsAt: "2026-10-21T04:00:00.000Z",
      }),
    );

    render(<ClusterQueuesPage />);
    await screen.findByText("audit-retention");
    await userEvent.click(screen.getByRole("button", { name: /1 delayed/i }));

    expect(await screen.findByText(/all tenants/i)).toBeInTheDocument();
    expect(screen.queryByRole("columnheader", { name: /problem/i })).not.toBeInTheDocument();
  });

  it("lists the queues as one table rather than eight cards", async () => {
    // Eight cards repeated the worker fact eight times and pushed the
    // counts off a screen. One row per queue, one statement of workers.
    get.mockResolvedValue(report());

    render(<ClusterQueuesPage />);

    expect(await screen.findByRole("columnheader", { name: /queue/i })).toBeInTheDocument();
    for (const header of [/workers/i, /waiting/i, /failed/i, /dead-lettered/i]) {
      expect(screen.getByRole("columnheader", { name: header })).toBeInTheDocument();
    }
  });

  it("puts a troubled queue above a quiet one", async () => {
    // Moved here with the table from the old single page, where it sat
    // beside the verdict.
    get.mockResolvedValue(
      report({
        queues: [
          queue({ name: "imports" }),
          queue({
            name: "billing-runs",
            counts: { waiting: 1, active: 0, delayed: 0, failed: 2, completed: 0 },
            dlqDepth: 1,
          }),
        ],
        totals: { waiting: 1, active: 0, failed: 2, dlq: 1 },
      }),
    );

    render(<ClusterQueuesPage />);
    await screen.findByText("billing-runs");

    const body = document.body.textContent ?? "";
    expect(body.indexOf("billing-runs")).toBeLessThan(body.indexOf("imports"));
  });

  it("marks a paused queue on its own row", async () => {
    get.mockResolvedValue(report({ queues: [queue({ paused: true })] }));

    render(<ClusterQueuesPage />);

    expect(await screen.findByText(/^paused$/i)).toBeInTheDocument();
  });

  it("opens what has already run, with when, how long and what it returned", async () => {
    /*
     * The only evidence a quiet cron queue is working. notification-send
     * had completed 255 jobs while worker.log held not one line about
     * any of them, because the handler logs only a non-empty tick — at
     * 8,640 ticks a day, deliberately. So "is it alive" had no answer
     * except sampling the delayed set twice by hand.
     */
    get.mockResolvedValueOnce(
      report({
        queues: [
          queue({
            name: "notification-send",
            counts: { waiting: 0, active: 0, delayed: 1, failed: 0, completed: 255 },
          }),
        ],
      }),
    ).mockResolvedValueOnce(
      jobsResult("completed", {
        jobName: "process-notification-batch",
        utilityId: null,
        utilityName: null,
        tenancy: "all-tenants",
        enqueuedAt: null,
        finishedAt: "2026-10-21T14:20:30.250Z",
        durationMs: 250,
        result: { attempted: 0, sent: 0, failed: 0, skippedQuietHours: 0 },
      }),
    );

    render(<ClusterQueuesPage />);
    await screen.findByText("notification-send");
    await userEvent.click(screen.getByRole("button", { name: /255 completed/i }));

    for (const header of [/ran at/i, /^took$/i, /^result$/i]) {
      expect(await screen.findByRole("columnheader", { name: header })).toBeInTheDocument();
    }
    expect(screen.getByText("250ms")).toBeInTheDocument();
    expect(screen.getByText(/attempted 0 · sent 0/)).toBeInTheDocument();
  });

  it("offers no verb on a completed job, which is already done", async () => {
    get.mockResolvedValueOnce(
      report({
        queues: [
          queue({ counts: { waiting: 0, active: 0, delayed: 0, failed: 0, completed: 3 } }),
        ],
      }),
    ).mockResolvedValueOnce(
      jobsResult("completed", { finishedAt: "2026-10-21T14:20:30.000Z", durationMs: 40 }),
    );

    render(<ClusterQueuesPage />);
    await screen.findByText("billing-runs");
    await userEvent.click(screen.getByRole("button", { name: /3 completed/i }));
    await screen.findByRole("columnheader", { name: /ran at/i });

    expect(screen.queryByRole("columnheader", { name: /^action$/i })).not.toBeInTheDocument();
  });

  it("does not make a count of zero clickable, in any column", async () => {
    /*
     * Every column, not just the first. `completed` arrived after this
     * test did, and the fixtures did not carry it — so the cell rendered
     * `undefined`, which is not `0`, which made it a clickable button
     * with no number in it. Nothing caught that until the fixture was
     * fixed, so the assertion now covers the whole row.
     */
    get.mockResolvedValue(report());

    render(<ClusterQueuesPage />);
    await screen.findByText("billing-runs");

    for (const state of ["waiting", "active", "delayed", "failed", "dead-lettered", "completed"]) {
      expect(
        screen.queryByRole("button", { name: new RegExp(`0 ${state}`, "i") }),
      ).not.toBeInTheDocument();
    }
    // And nothing clickable that says nothing at all.
    for (const button of screen.queryAllByRole("button")) {
      expect(button.textContent?.trim()).not.toBe("");
    }
  });

});