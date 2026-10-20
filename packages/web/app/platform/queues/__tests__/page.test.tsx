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

function queue(over: Record<string, unknown> = {}) {
  return {
    name: "billing-runs",
    counts: { waiting: 0, active: 0, delayed: 0, failed: 0 },
    dlqDepth: 0,
    recentFailures: [],
    ...over,
  };
}

function report(over: Record<string, unknown> = {}) {
  return {
    reachable: true,
    checkedAt: "2026-10-20T10:00:00.000Z",
    queues: [queue(), queue({ name: "imports" })],
    totals: { waiting: 0, active: 0, failed: 0, dlq: 0 },
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
    expect(screen.getByText(/due/i)).toBeInTheDocument();
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

  it("does not make a count of zero clickable", async () => {
    get.mockResolvedValue(report());

    render(<PlatformQueuesPage />);
    await screen.findByText("billing-runs");

    expect(screen.queryByRole("button", { name: /0 waiting/i })).not.toBeInTheDocument();
  });
});
