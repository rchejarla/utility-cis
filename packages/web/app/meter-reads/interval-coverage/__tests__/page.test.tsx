import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ToastProvider } from "@/components/ui/toast";
import { apiClient } from "@/lib/api-client";
import IntervalCoveragePage from "../page";

/**
 * The interval-coverage queue.
 *
 * The sweep has written these rows since cd49543 and nothing could show
 * them, which made the whole chain invisible — and *inert*, because the
 * sweep ships disabled. That is the trap this screen has to avoid being:
 * an empty table reads as "no problems", and if nothing is sweeping, an
 * empty table means nothing at all. So the page asks the automation
 * config whether the sweep is on, and says so when it is not.
 *
 * The one action with consequences is **accept** — the pre-run check
 * stops blocking those minutes, so the month bills with a hole in it.
 * A row offers it only when there is something to decide.
 */

const get = apiClient.get as unknown as ReturnType<typeof vi.fn>;
const post = apiClient.post as unknown as ReturnType<typeof vi.fn>;

function exception(over: Record<string, unknown> = {}) {
  return {
    id: "ex-1",
    meterId: "m-1",
    windowStart: "2026-01-10T00:00:00.000Z",
    windowEnd: "2026-01-11T00:00:00.000Z",
    kind: "gap",
    minutesAffected: 180,
    detail: "2026-01-10T06:00:00.000Z: no interval data for the 180 minutes from here.",
    status: "open",
    detectedAt: "2026-01-11T03:00:00.000Z",
    resolvedAt: null,
    meter: { id: "m-1", meterNumber: "TOU-AMI-001" },
    ...over,
  };
}

/** The queue, plus the automation config the page reads for the banner. */
function answers(
  rows: unknown[],
  sweep: { enabled?: boolean; lastRunAt?: string | null; runHourLocal?: number } = {},
) {
  get.mockImplementation(async (url: string) => {
    if (url.startsWith("/api/v1/settings/automation")) {
      return {
        schedulers: [
          {
            key: "intervalCoverage",
            enabled: sweep.enabled ?? true,
            // A swept queue by default: the states that need saying are
            // the exceptions, and each has its own test below.
            lastRunAt: sweep.lastRunAt === undefined ? "2026-11-07T10:00:00.000Z" : sweep.lastRunAt,
            runHourLocal: sweep.runHourLocal ?? 3,
            settings: {},
          },
        ],
      };
    }
    return { data: rows, meta: { total: rows.length, page: 1, limit: 20, pages: 1 } };
  });
}

function renderPage() {
  return render(
    <ToastProvider>
      <IntervalCoveragePage />
    </ToastProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("the interval-coverage queue", () => {
  it("names the meter, the day and how much of it is missing", async () => {
    answers([exception()]);
    renderPage();

    expect(await screen.findByText("TOU-AMI-001")).toBeInTheDocument();
    // Three hours, not "180" — minutes are how the row is stored, not
    // how a person reads a hole in a day.
    expect(screen.getByText("3h")).toBeInTheDocument();
    expect(screen.getByText(/no interval data/)).toBeInTheDocument();
  });

  it("asks for the open ones first, because that is where the work is", async () => {
    answers([exception()]);
    renderPage();

    await screen.findByText("TOU-AMI-001");
    expect(get).toHaveBeenCalledWith(expect.stringContaining("status=open"));
  });

  it("accepts a row, then asks the server again rather than guessing", async () => {
    answers([exception()]);
    post.mockResolvedValue({ ...exception(), status: "accepted" });
    renderPage();

    await screen.findByText("TOU-AMI-001");
    const before = get.mock.calls.length;
    await userEvent.click(screen.getByRole("button", { name: /accept/i }));

    await waitFor(() =>
      expect(post).toHaveBeenCalledWith("/api/v1/meter-data-exceptions/ex-1/accept", {}),
    );
    await waitFor(() => expect(get.mock.calls.length).toBeGreaterThan(before));
  });

  it("offers to undo an acceptance, and not to accept it twice", async () => {
    answers([exception({ status: "accepted", resolvedAt: "2026-01-12T09:00:00.000Z" })]);
    renderPage();

    await screen.findByText("TOU-AMI-001");
    expect(screen.getByRole("button", { name: /reopen/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /accept/i })).not.toBeInTheDocument();
  });

  it("offers nothing on a resolved row, whose data has arrived", async () => {
    answers([exception({ status: "resolved", resolvedAt: "2026-01-12T09:00:00.000Z" })]);
    renderPage();

    await screen.findByText("TOU-AMI-001");
    expect(screen.queryByRole("button", { name: /accept/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /reopen/i })).not.toBeInTheDocument();
  });

  /*
   * The whole reason this screen exists is that the chain was
   * invisible. An empty queue with the sweep off is the same trap one
   * step along: it looks like good news.
   */
  it("says so when nothing is filling the queue", async () => {
    answers([], { enabled: false });
    renderPage();

    expect(await screen.findByText(/sweep is off/i)).toBeInTheDocument();
  });

  it("does not cry wolf when the sweep is running and found nothing", async () => {
    answers([], { enabled: true });
    renderPage();

    await waitFor(() => expect(get).toHaveBeenCalled());
    expect(screen.queryByText(/sweep is off/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/never run/i)).not.toBeInTheDocument();
  });

  /*
   * Found by opening the screen (2026-11-07): the banner tested the
   * enable flag and nothing else, so a sweep that is **on and has never
   * run** showed a clean queue with no caveat — which is the same trap
   * one level up from the one this screen was built to avoid, and the
   * one `CLAUDE.md` describes for a queue with an armed cron and no
   * worker attached: "zero workers and a healthy-looking set of counts
   * are the same picture otherwise".
   *
   * On the dev stack that is the *ordinary* state: `start_dev.bat`
   * starts no worker, so an enabled sweep sits with `lastRunAt` null
   * for ever and the queue stays empty for a reason that has nothing to
   * do with the data.
   */
  it("says so when the sweep is on but has never run", async () => {
    answers([], { enabled: true, lastRunAt: null });
    renderPage();

    expect(await screen.findByText(/never run/i)).toBeInTheDocument();
    // And not the other message: "off" and "never run" are different
    // things to do something about.
    expect(screen.queryByText(/sweep is off/i)).not.toBeInTheDocument();
  });

  it("names the hour it runs at, so somebody can tell whether it is due", async () => {
    answers([], { enabled: true, lastRunAt: null, runHourLocal: 3 });
    renderPage();

    expect(await screen.findByText(/03:00/)).toBeInTheDocument();
  });

  it("says when it last swept, so an empty list can be read", async () => {
    answers([], { enabled: true, lastRunAt: "2026-11-07T10:00:00.000Z" });
    renderPage();

    // Quietly, not as a warning: this is the state where an empty list
    // genuinely means the data is sound, and it is the only state where
    // it does.
    expect(await screen.findByText(/last swept/i)).toBeInTheDocument();
  });
});
