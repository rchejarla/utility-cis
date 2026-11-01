import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { apiClient } from "@/lib/api-client";
import ClusterSchedulersPage from "../page";

/**
 * The page that answers "is anything going to fire".
 *
 * Every failure it exists for is silent, and each one looks like a quiet
 * system: a cron nothing armed, a cron nothing promotes, and a cron in
 * Redis that no build recognises. An empty, cheerful table is the wrong
 * answer to all three, so each has to be *said*.
 */

const get = apiClient.get as unknown as ReturnType<typeof vi.fn>;
const del = apiClient.delete as unknown as ReturnType<typeof vi.fn>;

const HOUR = 3_600_000;

function scheduler(over: Record<string, unknown> = {}) {
  return {
    queue: "suspension-transitions",
    schedulerId: "suspension-cron",
    jobName: "transition-suspensions",
    pattern: "0 * * * *",
    everyMs: null,
    timezone: "UTC",
    nextRunAt: new Date(Date.now() + HOUR).toISOString(),
    overdue: false,
    lastRunAt: new Date(Date.now() - HOUR).toISOString(),
    iterations: 412,
    orphan: false,
    workers: 1,
    paused: false,
    ...over,
  };
}

function report(over: Record<string, unknown> = {}) {
  return {
    reachable: true,
    checkedAt: "2026-10-30T10:00:00.000Z",
    schedulers: [scheduler()],
    unarmed: [],
    ...over,
  };
}

beforeEach(() => {
  get.mockReset();
  del.mockReset();
});

/**
 * The verdict, which this page went without for a day.
 *
 * Every row already carried its own reason, so with the worker stopped
 * the page said "no worker attached, so nothing will promote it" nine
 * times under a header that read like a neutral description of the
 * columns. The information was all there and the page still made an
 * operator infer a total outage from repetition. The overview page
 * leads with "Nothing is running"; this one now does the same.
 */
describe("whether anything will fire at all", () => {
  it("says nothing will fire when no queue has a worker, rather than repeating itself", async () => {
    get.mockResolvedValue(
      report({
        schedulers: [
          scheduler({ workers: 0 }),
          scheduler({ queue: "billing-dispatch", schedulerId: "billing-dispatch-cron", workers: 0 }),
        ],
      }),
    );

    render(<ClusterSchedulersPage />);

    expect(await screen.findByText(/nothing will fire/i)).toBeInTheDocument();
    // Said once, about all of them — and it points at the fix.
    expect(screen.getByText(/no worker is attached to any/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /start one/i })).toHaveAttribute(
      "href",
      "/platform/cluster/workers",
    );
  });

  it("names the few that will not fire when the rest are healthy", async () => {
    // A partial outage is a different sentence: naming the queue is what
    // an operator acts on, and "nothing will fire" would be a lie.
    get.mockResolvedValue(
      report({
        schedulers: [
          scheduler(),
          scheduler({ queue: "billing-dispatch", schedulerId: "billing-dispatch-cron", workers: 0 }),
        ],
      }),
    );

    render(<ClusterSchedulersPage />);

    expect(await screen.findByText(/1 of 2/i)).toBeInTheDocument();
    expect(screen.queryByText(/nothing will fire/i)).not.toBeInTheDocument();
  });

  it("says so plainly when every cron is armed and attended", async () => {
    /*
     * The quiet case still gets a sentence. An unlabelled healthy table
     * looks identical to a table whose rows nobody has read, which is
     * the confusion this whole page exists to remove.
     */
    get.mockResolvedValue(report());

    render(<ClusterSchedulersPage />);

    expect(await screen.findByText(/all armed and attended/i)).toBeInTheDocument();
  });

  it("counts a paused queue as something that will not fire", async () => {
    // A paused queue promotes nothing however many workers are attached,
    // so a verdict that only counted workers would call this healthy.
    get.mockResolvedValue(report({ schedulers: [scheduler({ workers: 2, paused: true })] }));

    render(<ClusterSchedulersPage />);

    expect(await screen.findByText(/nothing will fire/i)).toBeInTheDocument();
  });
});

describe("the cluster schedulers page", () => {
  it("names each cron with its pattern and when it next runs", async () => {
    get.mockResolvedValue(report());

    render(<ClusterSchedulersPage />);

    expect(await screen.findByText("suspension-cron")).toBeInTheDocument();
    expect(screen.getByText("0 * * * *")).toBeInTheDocument();
  });

  it("says the schedulers could not be read, which is not the same as none", async () => {
    // An unreachable Redis and a cluster with nothing scheduled produce
    // the same empty table, and only one of them is good news.
    get.mockResolvedValue(report({ reachable: false, schedulers: [] }));

    render(<ClusterSchedulersPage />);

    expect(await screen.findByText(/could not be read/i)).toBeInTheDocument();
  });

  it("calls out a cron that is overdue", async () => {
    // The strongest signal on the page: audit-retention sat two days
    // overdue because nothing was attached to promote it.
    get.mockResolvedValue(
      report({
        schedulers: [
          scheduler({ overdue: true, nextRunAt: new Date(Date.now() - 2 * 24 * HOUR).toISOString() }),
        ],
      }),
    );

    render(<ClusterSchedulersPage />);

    expect(await screen.findByText(/overdue/i)).toBeInTheDocument();
  });

  it("calls out a cron with no worker to promote it", async () => {
    get.mockResolvedValue(report({ schedulers: [scheduler({ workers: 0 })] }));

    render(<ClusterSchedulersPage />);

    expect(await screen.findByText(/no worker attached/i)).toBeInTheDocument();
  });

  it("names a registered cron that nothing armed, which no row could show", async () => {
    /*
     * The failure the whole spec exists for. Registration happens only
     * at worker boot, so a deployment where none started has crons that
     * were never armed — and an unarmed cron has no row to appear in.
     */
    get.mockResolvedValue(report({ unarmed: ["audit-retention-cron"] }));

    render(<ClusterSchedulersPage />);

    expect(await screen.findByText(/audit-retention-cron/)).toBeInTheDocument();
    expect(screen.getByText(/nothing armed/i)).toBeInTheDocument();
  });

  it("says nothing about unarmed crons when every one is armed", async () => {
    get.mockResolvedValue(report());

    render(<ClusterSchedulersPage />);
    await screen.findByText("suspension-cron");

    expect(screen.queryByText(/nothing armed/i)).not.toBeInTheDocument();
  });

  it("marks an orphan and says it keeps firing until removed", async () => {
    // Worker boot stopped deleting these, so this row is the only place
    // anyone sees one outside a log line.
    get.mockResolvedValue(
      report({ schedulers: [scheduler({ schedulerId: "billing-dispatch-cron", orphan: true })] }),
    );

    render(<ClusterSchedulersPage />);

    expect(await screen.findByText(/orphan/i)).toBeInTheDocument();
    expect(screen.getByText(/keeps firing until removed/i)).toBeInTheDocument();
  });

  it("removes an orphan on request and re-reads", async () => {
    get.mockResolvedValue(
      report({ schedulers: [scheduler({ schedulerId: "billing-dispatch-cron", orphan: true })] }),
    );
    del.mockResolvedValue({ removed: true });

    render(<ClusterSchedulersPage />);
    await userEvent.click(await screen.findByRole("button", { name: /remove billing-dispatch-cron/i }));

    expect(del).toHaveBeenCalledWith(
      "/api/v1/platform/queues/suspension-transitions/schedulers/billing-dispatch-cron",
    );
    expect(get).toHaveBeenCalledTimes(2);
  });

  it("offers no Remove on a cron the build registers", async () => {
    // The API refuses it, and a button whose only outcome is a 409
    // teaches the reader to ignore buttons.
    get.mockResolvedValue(report());

    render(<ClusterSchedulersPage />);
    await screen.findByText("suspension-cron");

    expect(screen.queryByRole("button", { name: /remove/i })).not.toBeInTheDocument();
  });

  it("links a row to the jobs behind it", async () => {
    get.mockResolvedValue(report());

    render(<ClusterSchedulersPage />);

    const link = await screen.findByRole("link", { name: /delayed/i });
    expect(link).toHaveAttribute(
      "href",
      "/platform/cluster/jobs?queue=suspension-transitions&state=delayed",
    );
  });

  it("says a null last run means not lately, rather than never", async () => {
    // Completed jobs are retained 24h, so absence is not evidence.
    get.mockResolvedValue(report({ schedulers: [scheduler({ lastRunAt: null })] }));

    render(<ClusterSchedulersPage />);

    expect(await screen.findByText(/not in the last 24h/i)).toBeInTheDocument();
  });
});
