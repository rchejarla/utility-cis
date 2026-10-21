import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { apiClient } from "@/lib/api-client";
import ClusterJobsPage from "../page";

/**
 * The jobs in one queue and one state.
 *
 * Its own page on the third attempt. It was a table nested inside the
 * queue table — whose header row landed among the queue rows and read as
 * though it described them — then a table directly below, where the only
 * thing tying the two together was a tinted row that scrolls out of
 * view. Queue and state live in the URL now, which is what makes "here
 * are the failed billing runs" a link someone can send.
 *
 * Two things these tests keep honest, both learned from the versions
 * before: the columns are labelled, and the blank tenant on a
 * cross-tenant sweep is told apart from a job that has lost its owner.
 */

const get = apiClient.get as unknown as ReturnType<typeof vi.fn>;
const post = apiClient.post as unknown as ReturnType<typeof vi.fn>;

/** The URL the page reads its filters from. */
let search = new URLSearchParams();
const push = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, replace: vi.fn(), back: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/platform/cluster/jobs",
  useSearchParams: () => search,
}));

function queue(over: Record<string, unknown> = {}) {
  return {
    name: "billing-runs",
    counts: { waiting: 0, active: 0, delayed: 0, failed: 0, completed: 0 },
    dlqDepth: 0,
    workers: 1,
    workerAgeSeconds: 900,
    paused: false,
    recentFailures: [],
    ...over,
  };
}

function report(over: Record<string, unknown> = {}) {
  return {
    reachable: true,
    checkedAt: "2026-10-21T10:00:00.000Z",
    queues: [queue(), queue({ name: "audit-retention" }), queue({ name: "imports" })],
    totals: { waiting: 0, active: 0, failed: 0, dlq: 0 },
    controllable: true,
    thisNode: "dev-box",
    workers: [],
    nodes: [{ host: "dev-box", ageSeconds: 900 }],
    ...over,
  };
}

/** One job in the given state, as the drill-down endpoint returns it. */
function jobsResult(state: string, over: Record<string, unknown> = {}) {
  return {
    queue: "billing-runs",
    state,
    reachable: true,
    hasMore: false,
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
        finishedAt: null,
        durationMs: null,
        result: null,
        ...over,
      },
    ],
  };
}

/**
 * Routes by URL rather than by call order. The page makes two reads —
 * the cluster report for the filter counts, then the jobs — and which
 * resolves first is the effect scheduler's business, not a thing to
 * encode in a chain of `mockResolvedValueOnce`.
 */
function serve(reportPayload: unknown, jobsPayload: unknown) {
  get.mockImplementation(async (url: string) =>
    url.includes("/jobs") ? jobsPayload : reportPayload,
  );
}

/** Arrive at the page with these filters, as a link from Queues would. */
function arriveAt(queueName: string, state: string) {
  search = new URLSearchParams({ queue: queueName, state });
}

beforeEach(() => {
  get.mockReset();
  post.mockReset();
  push.mockReset();
  arriveAt("billing-runs", "waiting");
});

describe("the cluster jobs page", () => {
  it("lists the jobs for the queue and state in the URL", async () => {
    serve(report(), jobsResult("waiting"));

    render(<ClusterJobsPage />);

    expect(await screen.findByText("City of Testville")).toBeInTheDocument();
    expect(get).toHaveBeenCalledWith("/api/v1/platform/queues/billing-runs/jobs", {
      state: "waiting",
      limit: "20",
      offset: "0",
    });
  });

  it("pages forward and back, without pretending to know a total", async () => {
    /*
     * Prev and Next rather than numbered pages. There is no total to
     * number against: these sets move under us, so `hasMore` comes from
     * fetching one job past the page rather than from counting a set that
     * will have changed by the time it is drawn.
     */
    serve(report(), { ...jobsResult("waiting"), hasMore: true });

    render(<ClusterJobsPage />);
    await userEvent.click(await screen.findByRole("button", { name: /next page/i }));

    expect(push).toHaveBeenCalledWith(
      "/platform/cluster/jobs?queue=billing-runs&state=waiting&offset=20",
    );
  });

  it("has nothing to go back to on the first page", async () => {
    serve(report(), { ...jobsResult("waiting"), hasMore: true });

    render(<ClusterJobsPage />);

    expect(await screen.findByRole("button", { name: /previous page/i })).toBeDisabled();
  });

  it("offers no pager at all when one page is the whole of it", async () => {
    serve(report(), jobsResult("waiting"));

    render(<ClusterJobsPage />);
    await screen.findByText("City of Testville");

    expect(screen.queryByRole("button", { name: /next page/i })).not.toBeInTheDocument();
  });

  it("reads every queue at once, and says which one each job is in", async () => {
    /*
     * "Where are all the failures" is a question about the deployment,
     * and trying eight queues in turn is not an answer. The Queue column
     * appears only here: on a single queue every row would say the same
     * thing.
     */
    arriveAt("all", "failed");
    serve(report(), {
      queue: "all",
      state: "failed",
      reachable: true,
      hasMore: false,
      jobs: [
        { ...jobsResult("failed").jobs[0], queue: "imports", jobId: "9" },
        { ...jobsResult("failed").jobs[0], queue: "billing-runs", jobId: "80" },
      ],
    });

    render(<ClusterJobsPage />);

    expect(await screen.findByRole("columnheader", { name: /^queue$/i })).toBeInTheDocument();
    expect(screen.getByText("imports")).toBeInTheDocument();
    expect(get).toHaveBeenCalledWith("/api/v1/platform/queues/all/jobs", {
      state: "failed",
      limit: "20",
      offset: "0",
    });
  });

  it("does not show a Queue column when one queue was asked for", async () => {
    serve(report(), jobsResult("waiting"));

    render(<ClusterJobsPage />);
    await screen.findByText("City of Testville");

    expect(screen.queryByRole("columnheader", { name: /^queue$/i })).not.toBeInTheDocument();
  });

  it("starts over at page one when the filters change", async () => {
    // Page four of the old selection is not page four of the new one.
    search = new URLSearchParams({ queue: "billing-runs", state: "waiting", offset: "60" });
    serve(report(), { ...jobsResult("waiting"), hasMore: true });

    render(<ClusterJobsPage />);
    await userEvent.click(await screen.findByRole("button", { name: /^Status/i }));
    await userEvent.click(await screen.findByText(/^Failed/));

    expect(push).toHaveBeenCalledWith("/platform/cluster/jobs?queue=billing-runs&state=failed");
  });

  it("labels its columns", async () => {
    // The first version was a bare row of values, and the first thing
    // asked of it was what those columns were.
    arriveAt("billing-runs", "failed");
    serve(report(), jobsResult("failed", { jobId: "80", reason: "boom" }));

    render(<ClusterJobsPage />);

    expect(await screen.findByRole("columnheader", { name: /tenant/i })).toBeInTheDocument();
    for (const header of [/^job$/i, /queued/i, /attempts/i, /reason/i]) {
      expect(screen.getByRole("columnheader", { name: header })).toBeInTheDocument();
    }
    // Due and Repeats belong to a delayed job; an empty column teaches
    // the reader nothing.
    expect(screen.queryByRole("columnheader", { name: /^due$/i })).not.toBeInTheDocument();
  });

  it("gives a delayed job the columns that apply to it", async () => {
    arriveAt("audit-retention", "delayed");
    serve(
      report(),
      jobsResult("delayed", { runsAt: "2026-10-21T04:00:00.000Z", repeats: "0 4 * * *" }),
    );

    render(<ClusterJobsPage />);

    expect(await screen.findByRole("columnheader", { name: /^due$/i })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: /repeats/i })).toBeInTheDocument();
    expect(screen.queryByRole("columnheader", { name: /reason/i })).not.toBeInTheDocument();
  });

  it("says when a delayed job is due, so a repeatable reads as armed", async () => {
    // One delayed job is the resting state of the five scheduled queues.
    // "Delayed: 1" alone cannot tell that apart from a retry backing off.
    arriveAt("audit-retention", "delayed");
    serve(
      report(),
      jobsResult("delayed", {
        jobId: "repeat:1",
        utilityId: null,
        utilityName: null,
        tenancy: "all-tenants",
        runsAt: "2026-10-22T03:00:00.000Z",
        repeats: "0 3 * * *",
      }),
    );

    render(<ClusterJobsPage />);

    expect(await screen.findByText(/0 3 \* \* \*/)).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: /^due$/i })).toBeInTheDocument();
  });

  it("calls a delayed job overdue once its due time has passed", async () => {
    /*
     * Verified against the running stack: audit-retention's repeatable
     * was due 2026-10-18 04:00 while the date was the 20th, because no
     * worker was up to run it and re-arm it. "Due two days ago" is the
     * whole signal, and a bare timestamp makes the reader subtract.
     */
    arriveAt("audit-retention", "delayed");
    serve(
      report(),
      jobsResult("delayed", {
        jobName: "sweep-expired-audits",
        utilityId: null,
        utilityName: null,
        tenancy: "all-tenants",
        enqueuedAt: "2020-01-01T00:00:00.000Z",
        runsAt: "2020-01-01T04:00:00.000Z",
        repeats: "0 4 * * *",
      }),
    );

    render(<ClusterJobsPage />);

    expect(await screen.findByText(/overdue/i)).toBeInTheDocument();
  });

  it("shows what has already run, with how long it took and what it returned", async () => {
    /*
     * The only evidence a quiet cron queue is working. notification-send
     * had completed 255 jobs while worker.log held not one line about
     * any of them, because the handler logs only a non-empty tick — at
     * 8,640 ticks a day, deliberately.
     */
    arriveAt("audit-retention", "completed");
    serve(
      report(),
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

    render(<ClusterJobsPage />);

    for (const header of [/ran at/i, /^took$/i, /^result$/i]) {
      expect(await screen.findByRole("columnheader", { name: header })).toBeInTheDocument();
    }
    expect(screen.getByText("250ms")).toBeInTheDocument();
    expect(screen.getByText(/attempted 0 · sent 0/)).toBeInTheDocument();
  });

  it("offers no verb on a completed job, which is already done", async () => {
    arriveAt("billing-runs", "completed");
    serve(
      report(),
      jobsResult("completed", { finishedAt: "2026-10-21T14:20:30.000Z", durationMs: 40 }),
    );

    render(<ClusterJobsPage />);
    await screen.findByRole("columnheader", { name: /ran at/i });

    expect(screen.queryByRole("columnheader", { name: /^action$/i })).not.toBeInTheDocument();
  });

  it("offers no verb on a waiting job, which needs no pushing", async () => {
    serve(report(), jobsResult("waiting", { jobId: "80" }));

    render(<ClusterJobsPage />);
    await screen.findByText("City of Testville");

    expect(screen.queryByRole("button", { name: /^retry job /i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^run now job /i })).not.toBeInTheDocument();
  });

  it("offers Retry on a failed job, and records what came back", async () => {
    arriveAt("billing-runs", "failed");
    serve(report(), jobsResult("failed", { jobId: "80" }));
    post.mockResolvedValue({
      queue: "billing-runs",
      jobId: "80",
      action: "retry",
      audited: true,
      auditedAs: { entityType: "BillingRun", entityId: "run-1" },
    });

    render(<ClusterJobsPage />);
    await userEvent.click(await screen.findByRole("button", { name: /^retry job /i }));

    expect(post).toHaveBeenCalledWith("/api/v1/platform/queues/billing-runs/jobs/80/retry", {});
    expect(await screen.findByText(/retried/i)).toBeInTheDocument();
  });

  it("says when an action happened but could not be recorded", async () => {
    // A sweep names no tenant, and `audit_log` needs one. Telling the
    // operator beats implying every action is on the record.
    arriveAt("audit-retention", "delayed");
    serve(
      report(),
      jobsResult("delayed", { jobId: "repeat:1", runsAt: "2020-01-01T04:00:00.000Z" }),
    );
    post.mockResolvedValue({
      queue: "audit-retention",
      jobId: "repeat:1",
      action: "promote",
      audited: false,
    });

    render(<ClusterJobsPage />);
    await userEvent.click(await screen.findByRole("button", { name: /^run now job /i }));

    expect(await screen.findByText(/not recorded/i)).toBeInTheDocument();
  });

  it("shows the refusal when a job has moved on", async () => {
    arriveAt("billing-runs", "failed");
    serve(report(), jobsResult("failed", { jobId: "80" }));
    post.mockRejectedValue(
      new Error("API error 409: Job 80 is waiting; retry applies to a job that is failed"),
    );

    render(<ClusterJobsPage />);
    await userEvent.click(await screen.findByRole("button", { name: /^retry job /i }));

    expect(await screen.findByText(/retry applies/i)).toBeInTheDocument();
  });

  it("calls a job's tenant unknown when its id matches no tenant", async () => {
    /*
     * Real case in the dev stack: 22 waiting import jobs carrying
     * `utilityId` …0000aa, a tenant that no longer exists. The page
     * printed the bare uuid, which reads as a tenant name nobody
     * recognises rather than as the finding it is.
     */
    arriveAt("imports", "waiting");
    serve(
      report(),
      jobsResult("waiting", {
        utilityId: "00000000-0000-4000-8000-0000000000aa",
        utilityName: null,
      }),
    );

    render(<ClusterJobsPage />);

    expect(await screen.findByText(/unknown tenant/i)).toBeInTheDocument();
  });

  it("tells a sweep's blank tenant apart from a job that lost its own", async () => {
    // Identical before — both rendered as no tenant. On audit-retention a
    // blank tenant is correct; on billing-runs it is a broken job.
    serve(
      report(),
      jobsResult("waiting", {
        utilityId: null,
        utilityName: null,
        tenancy: "per-tenant",
        invalid: "No tenant named in the payload; a job on this queue must name one.",
      }),
    );

    render(<ClusterJobsPage />);

    expect(await screen.findByText(/none named/i)).toBeInTheDocument();
    expect(screen.queryByText(/all tenants/i)).not.toBeInTheDocument();
  });

  it("calls a cross-tenant sweep's job every tenant's", async () => {
    arriveAt("audit-retention", "delayed");
    serve(
      report(),
      jobsResult("delayed", {
        utilityId: null,
        utilityName: null,
        tenancy: "all-tenants",
        repeats: "0 4 * * *",
        runsAt: "2026-10-22T04:00:00.000Z",
      }),
    );

    render(<ClusterJobsPage />);

    expect(await screen.findByText(/all tenants/i)).toBeInTheDocument();
    expect(screen.queryByRole("columnheader", { name: /problem/i })).not.toBeInTheDocument();
  });

  it("names what is wrong with a job that cannot run", async () => {
    /*
     * The 80 waiting billing-run jobs in the dev stack named runs that
     * did not exist, and the 22 import jobs named a torn-down tenant.
     * The list called all 102 of them "waiting", which is the opposite
     * of true, and the operator cannot check: the payload is withheld.
     */
    serve(
      report(),
      jobsResult("waiting", { invalid: "The billing run it names no longer exists." }),
    );

    render(<ClusterJobsPage />);

    expect(await screen.findByRole("columnheader", { name: /problem/i })).toBeInTheDocument();
    expect(screen.getByText(/billing run it names no longer exists/i)).toBeInTheDocument();
  });

  it("keeps the Problem column out of the way when nothing is wrong", async () => {
    // A column of dashes teaches the reader to ignore the column.
    serve(report(), jobsResult("waiting"));

    render(<ClusterJobsPage />);
    await screen.findByText("City of Testville");

    expect(screen.queryByRole("columnheader", { name: /problem/i })).not.toBeInTheDocument();
  });

  it("says Redis did not answer rather than showing an empty list", async () => {
    serve(report(), { queue: "billing-runs", state: "waiting", reachable: false, jobs: [] });

    render(<ClusterJobsPage />);

    expect(await screen.findByText(/could not be read/i)).toBeInTheDocument();
    expect(screen.getByText(/not the same as nothing being there/i)).toBeInTheDocument();
  });

  it("puts the counts in the status filter, so an empty combination is visible", async () => {
    // Otherwise choosing a queue and a state is guesswork, and most
    // combinations are empty.
    serve(
      report({
        queues: [
          queue({ counts: { waiting: 0, active: 0, delayed: 0, failed: 2, completed: 17 } }),
        ],
      }),
      jobsResult("waiting"),
    );

    render(<ClusterJobsPage />);
    await screen.findByText("City of Testville");
    await userEvent.click(screen.getByRole("button", { name: /^Status/i }));

    expect(await screen.findByText(/failed \(2\)/i)).toBeInTheDocument();
    expect(screen.getByText(/completed \(17\)/i)).toBeInTheDocument();
  });

  it("shows All queues on the filter when that is what is selected", async () => {
    /*
     * It was modelled as FilterBar's "clear" for a moment, which reads as
     * no selection: the pill showed the bare label "Queue" while the page
     * was filtering across all eight. A selection the control does not
     * name is worse than one it does.
     */
    arriveAt("all", "failed");
    serve(report(), { ...jobsResult("failed"), queue: "all" });

    render(<ClusterJobsPage />);

    expect(await screen.findByRole("button", { name: /Queue.*All queues/i })).toBeInTheDocument();
  });

  it("offers All queues exactly once", async () => {
    /*
     * It appeared twice: FilterBar renders its own `All {label}` as the
     * way to clear a filter, and this page had added another one of its
     * own. Two items, the same words, one of them doing nothing the
     * other did not.
     */
    serve(report(), jobsResult("waiting"));

    render(<ClusterJobsPage />);
    await screen.findByText("City of Testville");
    await userEvent.click(screen.getByRole("button", { name: /^Queue/i }));

    expect(screen.getAllByText(/all queues/i)).toHaveLength(1);
  });

  it("reads every queue when All queues is chosen", async () => {
    // Clearing the queue filter means all of them, which is a real
    // selection here rather than the absence of one.
    serve(report(), jobsResult("waiting"));

    render(<ClusterJobsPage />);
    await screen.findByText("City of Testville");
    await userEvent.click(screen.getByRole("button", { name: /^Queue/i }));
    await userEvent.click(screen.getByText(/all queues/i));

    expect(push).toHaveBeenCalledWith("/platform/cluster/jobs?queue=all&state=waiting");
  });

  it("gives the status filter no All, because a job is always in one state", async () => {
    /*
     * It had one, and clicking it did nothing: FilterBar's clear calls
     * `onChange(undefined)`, and there is no "all statuses" to ask the
     * API for — the endpoint takes exactly one. An option that cannot be
     * chosen is worse than no option.
     */
    serve(report(), jobsResult("waiting"));

    render(<ClusterJobsPage />);
    await screen.findByText("City of Testville");
    await userEvent.click(screen.getByRole("button", { name: /^Status/i }));

    expect(screen.queryByText(/all status/i)).not.toBeInTheDocument();
    // The states themselves are all still there to choose between.
    expect(screen.getByText(/^Failed/)).toBeInTheDocument();
  });

  it("cuts a long job id rather than wrapping it, and keeps the whole of it", async () => {
    /*
     * A repeatable's id is `repeat:notification-send-cron:1792590070000`
     * — 43 characters, which wrapped to three lines beside rows of one.
     * Cut with an ellipsis, with the full value on hover, because it is
     * the thing an operator reads off to act on the job.
     */
    arriveAt("audit-retention", "delayed");
    serve(
      report(),
      jobsResult("delayed", {
        jobId: "repeat:notification-send-cron:1792590070000",
        jobName: "process-notification-batch",
        runsAt: "2026-10-22T04:00:00.000Z",
      }),
    );

    render(<ClusterJobsPage />);

    const cell = await screen.findByTitle(
      "process-notification-batch #repeat:notification-send-cron:1792590070000",
    );
    expect(cell).toHaveStyle({ textOverflow: "ellipsis", whiteSpace: "nowrap" });
  });

  it("hides a column from a phone on its header and its cells together", async () => {
    /*
     * The one way this can go wrong is hiding a header without its cells
     * or the reverse: globals.css warns that every column after it then
     * shifts left, which reads as wrong data rather than as a narrow
     * table. Both come from one column entry, and this is the assertion
     * that they still agree.
     */
    arriveAt("billing-runs", "failed");
    serve(report(), jobsResult("failed", { jobId: "80", reason: "boom", attemptsMade: 2 }));

    render(<ClusterJobsPage />);
    await screen.findByRole("columnheader", { name: /attempts/i });

    const table = screen.getByRole("columnheader", { name: /attempts/i }).closest("table")!;
    const headers = [...table.querySelectorAll("thead th")];
    const cells = [...table.querySelectorAll("tbody tr:first-child td")];
    expect(headers).toHaveLength(cells.length);

    // The same positions on both halves, for each tier — which is the
    // whole of what keeps a cell from reading under the wrong heading.
    const hiddenAt = (els: Element[], cls: string) =>
      els.map((_, i) => i).filter((i) => els[i].classList.contains(cls));
    for (const cls of ["col-hide-sm", "col-hide-md"]) {
      expect(hiddenAt(cells, cls)).toEqual(hiddenAt(headers, cls));
    }

    const named = (cls: string) => hiddenAt(headers, cls).map((i) => headers[i].textContent);

    /*
     * Every secondary column goes at the narrow tier, not the phone one.
     *
     * They were split across the two, and on a display where a
     * three-quarter-width window is still 1600 CSS pixels that meant one
     * column dropped and the rest waited for a width nobody reaches by
     * dragging. The tenant, the job, the reason and the action stay to
     * the end; the rest are secondary and go together.
     */
    expect(named("col-hide-md")).toContain("Attempts");
    expect(named("col-hide-md")).toContain("Queued");
    const everHidden = [...named("col-hide-md"), ...named("col-hide-sm")];
    expect(everHidden).not.toContain("Tenant");
    expect(everHidden).not.toContain("Job");
    expect(everHidden).not.toContain("Reason");
  });

  it("links back to the queue list", async () => {
    serve(report(), jobsResult("waiting"));

    render(<ClusterJobsPage />);

    const back = await screen.findByRole("link", { name: /^← Queues$/i });
    expect(back).toHaveAttribute("href", "/platform/cluster/queues");
  });
});
