import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { apiClient } from "@/lib/api-client";
import PlatformQueuesPage from "../page";

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
    counts: { waiting: 0, active: 0, delayed: 0, failed: 0 },
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

describe("the platform queue page", () => {
  it("says everything is clear in a sentence, not a table of zeroes", async () => {
    get.mockResolvedValue(report());

    render(<PlatformQueuesPage />);

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

    render(<PlatformQueuesPage />);

    expect(await screen.findByText(/2 failed/i)).toBeInTheDocument();
    expect(screen.getByText(/1 dead-lettered/i)).toBeInTheDocument();
    // The troubled queue is listed before the quiet one.
    const body = document.body.textContent ?? "";
    expect(body.indexOf("billing-runs")).toBeLessThan(body.indexOf("imports"));
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

    render(<PlatformQueuesPage />);

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

    render(<PlatformQueuesPage />);

    expect(await screen.findByText(/all tenants/i)).toBeInTheDocument();
  });

  it("says the queues could not be read, which is not the same as nothing queued", async () => {
    get.mockResolvedValue(report({ reachable: false, queues: [], totals: { waiting: 0, active: 0, failed: 0, dlq: 0 } }));

    render(<PlatformQueuesPage />);

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

    render(<PlatformQueuesPage />);
    await screen.findByText(/nothing failed or dead-lettered/i);

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

    render(<PlatformQueuesPage />);
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

    render(<PlatformQueuesPage />);
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

    render(<PlatformQueuesPage />);
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

    render(<PlatformQueuesPage />);
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

    render(<PlatformQueuesPage />);
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

    render(<PlatformQueuesPage />);
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

    render(<PlatformQueuesPage />);
    await screen.findByText("billing-runs");
    await userEvent.click(screen.getByRole("button", { name: /1 waiting/i }));
    await screen.findByText(/City of Testville/);

    expect(screen.queryByRole("button", { name: /^retry job /i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^run now job /i })).not.toBeInTheDocument();
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

    render(<PlatformQueuesPage />);

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

    render(<PlatformQueuesPage />);

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

    render(<PlatformQueuesPage />);

    expect(await screen.findByText(/needs attention/i)).toBeInTheDocument();
    expect(screen.getByText(/no worker is attached/i)).toBeInTheDocument();
  });

  it("flags a paused queue, which processes nothing with workers attached", async () => {
    get.mockResolvedValue(report({ queues: [queue({ paused: true })] }));

    render(<PlatformQueuesPage />);

    // Twice over, deliberately: the verdict, and the mark on the queue it
    // applies to.
    expect(await screen.findByText(/a queue is paused/i)).toBeInTheDocument();
    expect(screen.getByText(/^paused$/i)).toBeInTheDocument();
    expect(screen.queryByText(/all clear/i)).not.toBeInTheDocument();
  });

  it("says worker attachment is unknown, which is not the same as none", async () => {
    // A managed Redis refuses CLIENT LIST. "No workers" would send an
    // operator chasing a worker that is running fine.
    get.mockResolvedValue(
      report({ queues: [queue({ workers: null, workerAgeSeconds: null })] }),
    );

    render(<PlatformQueuesPage />);

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

    render(<PlatformQueuesPage />);

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

    render(<PlatformQueuesPage />);
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

    render(<PlatformQueuesPage />);
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

    render(<PlatformQueuesPage />);
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

    render(<PlatformQueuesPage />);
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

    render(<PlatformQueuesPage />);
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

    render(<PlatformQueuesPage />);
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

    render(<PlatformQueuesPage />);
    await screen.findByText("audit-retention");
    await userEvent.click(screen.getByRole("button", { name: /1 delayed/i }));

    expect(await screen.findByText(/all tenants/i)).toBeInTheDocument();
    expect(screen.queryByRole("columnheader", { name: /problem/i })).not.toBeInTheDocument();
  });

  it("offers to start a worker on the node that answered", async () => {
    // Start is node-local: nothing portable spawns a process on another
    // machine, so the control names the node it will act on rather than
    // implying a choice.
    get.mockResolvedValue(report({ queues: [queue({ workers: 0, workerAgeSeconds: null })] }));
    post.mockResolvedValue(workerView({ node: "dev-box" }));

    render(<PlatformQueuesPage />);
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

    render(<PlatformQueuesPage />);

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

    render(<PlatformQueuesPage />);

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

    render(<PlatformQueuesPage />);

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

    render(<PlatformQueuesPage />);

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

    render(<PlatformQueuesPage />);

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

    render(<PlatformQueuesPage />);
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

    render(<PlatformQueuesPage />);
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

    render(<PlatformQueuesPage />);

    expect(await screen.findByText(/not attached/i)).toBeInTheDocument();
  });

  it("says a worker is attached that this console did not start", async () => {
    // Started from a terminal: attached to the same Redis and visible in
    // the queue counts, but with no record, so nothing to stop here.
    get.mockResolvedValue(
      report({ queues: [queue({ workers: 1 })], workers: [] }),
    );

    render(<PlatformQueuesPage />);

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

    render(<PlatformQueuesPage />);
    await screen.findByText(/nothing is running/i);

    expect(screen.queryByRole("button", { name: /start worker/i })).not.toBeInTheDocument();
    expect(screen.getByText(/separate deployment/i)).toBeInTheDocument();
  });

  it("shows the refusal when a worker is already running on this node", async () => {
    get.mockResolvedValue(report({ queues: [queue({ workers: 0, workerAgeSeconds: null })] }));
    post.mockRejectedValue(
      new Error("API error 409: A worker is already running on dev-box as pid 99"),
    );

    render(<PlatformQueuesPage />);
    await userEvent.click(await screen.findByRole("button", { name: /start worker/i }));

    expect(await screen.findByText(/already running on dev-box/i)).toBeInTheDocument();
  });

  it("says the node list is unknown rather than showing none", async () => {
    // Managed Redis refuses CLIENT LIST. "No nodes" is never true of a
    // deployment that is serving this page.
    get.mockResolvedValue(report({ nodes: null }));

    render(<PlatformQueuesPage />);

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

    render(<PlatformQueuesPage />);
    await screen.findByRole("button", { name: /start worker/i });

    expect(screen.getByText(/billing-runs 3/)).toBeInTheDocument();
    expect(screen.getByText(/audit-retention 1/)).toBeInTheDocument();
    // A queue with nothing queued has nothing to warn about.
    expect(screen.queryByText(/imports 0/)).not.toBeInTheDocument();
  });

  it("says nothing about queued work when there is none to run", async () => {
    get.mockResolvedValue(report({ queues: [queue({ workers: 0, workerAgeSeconds: null })] }));

    render(<PlatformQueuesPage />);
    await screen.findByRole("button", { name: /start worker/i });

    expect(screen.queryByText(/already queued/i)).not.toBeInTheDocument();
  });

  it("lists the queues as one table rather than eight cards", async () => {
    // Eight cards repeated the worker fact eight times and pushed the
    // counts off a screen. One row per queue, one statement of workers.
    get.mockResolvedValue(report());

    render(<PlatformQueuesPage />);

    expect(await screen.findByRole("columnheader", { name: /queue/i })).toBeInTheDocument();
    for (const header of [/workers/i, /waiting/i, /failed/i, /dead-lettered/i]) {
      expect(screen.getByRole("columnheader", { name: header })).toBeInTheDocument();
    }
  });

  it("does not make a count of zero clickable", async () => {
    get.mockResolvedValue(report());

    render(<PlatformQueuesPage />);
    await screen.findByText("billing-runs");

    expect(screen.queryByRole("button", { name: /0 waiting/i })).not.toBeInTheDocument();
  });
});
