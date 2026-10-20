import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
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
  vi.clearAllMocks();
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

  it("offers Bull Board for the things it deliberately cannot do", async () => {
    get.mockResolvedValue(report());

    render(<PlatformQueuesPage />);

    await waitFor(() =>
      expect(screen.getByRole("link", { name: /bull board/i })).toHaveAttribute(
        "href",
        expect.stringContaining("/admin/queues"),
      ),
    );
  });
});
