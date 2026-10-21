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


  it("links a count to the jobs behind it", async () => {
    // The whole point of the Jobs page being a route: the link carries
    // the queue and the state, so it can be sent to someone.
    get.mockResolvedValue(
      report({
        queues: [
          queue({ counts: { waiting: 0, active: 0, delayed: 0, failed: 2, completed: 17 } }),
        ],
      }),
    );

    render(<ClusterQueuesPage />);

    expect(await screen.findByRole("link", { name: /2 failed/i })).toHaveAttribute(
      "href",
      "/platform/cluster/jobs?queue=billing-runs&state=failed",
    );
    expect(screen.getByRole("link", { name: /17 completed/i })).toHaveAttribute(
      "href",
      "/platform/cluster/jobs?queue=billing-runs&state=completed",
    );
  });

  it("does not make a count of zero clickable, in any column", async () => {
    /*
     * Every column, not just the first. `completed` arrived after this
     * test did, and the fixtures did not carry it — so the cell rendered
     * `undefined`, which is not `0`, which made it clickable with no
     * number in it. Nothing caught that until the fixture was fixed.
     *
     * Asserted on links, not buttons: the counts became links when the
     * Jobs page became a route, and a `queryByRole("button")` assertion
     * would now pass without testing anything at all.
     */
    get.mockResolvedValue(report());

    render(<ClusterQueuesPage />);
    await screen.findByText("billing-runs");

    for (const state of ["waiting", "active", "delayed", "failed", "dead-lettered", "completed"]) {
      expect(
        screen.queryByRole("link", { name: new RegExp(`0 ${state}`, "i") }),
      ).not.toBeInTheDocument();
    }
    // And nothing clickable that says nothing at all.
    for (const link of screen.queryAllByRole("link")) {
      expect(link.textContent?.trim()).not.toBe("");
    }
  });


  it("hides the same count columns from a phone on headers and cells alike", async () => {
    /*
     * Eight numeric columns, and all eight showed on a phone — the
     * classes went on the Jobs table and never on this one, which is the
     * widest table in the console. The one way the fix breaks is hiding
     * a header without its cells, which globals.css warns shifts every
     * column after it: a silent misread rather than a narrow table.
     */
    get.mockResolvedValue(report());

    render(<ClusterQueuesPage />);
    const table = (await screen.findByRole("columnheader", { name: /^queue$/i })).closest(
      "table",
    )!;
    const headers = [...table.querySelectorAll("thead th")];
    const cells = [...table.querySelectorAll("tbody tr:first-child td")];
    expect(headers).toHaveLength(cells.length);

    // The same positions on both halves — which is the whole of what
    // keeps a cell from reading under the wrong heading.
    const hiddenAt = (els: Element[]) =>
      els.map((e, i) => i).filter((i) => els[i].classList.contains("col-hide-sm"));
    expect(hiddenAt(cells)).toEqual(hiddenAt(headers));

    const names = hiddenAt(headers).map((i) => headers[i].textContent);
    expect(names).toEqual(["Active", "Delayed", "Completed"]);
    // What a phone must keep: whose queue, who is working it, what broke.
    expect(names).not.toContain("Queue");
    expect(names).not.toContain("Failed");
    expect(names).not.toContain("Dead-lettered");
  });
});