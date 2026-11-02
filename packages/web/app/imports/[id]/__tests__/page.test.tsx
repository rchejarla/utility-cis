import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { ToastProvider } from "@/components/ui/toast";
import { apiClient } from "@/lib/api-client";
import ImportDetailPage from "../page";

/**
 * One import batch, and the question this page could not answer: why
 * isn't it moving?
 *
 * A batch over 250 rows is enqueued rather than run inline. Where no
 * worker is attached to the imports queue it stays PENDING for ever,
 * and the page polled that status while drawing the progress bar only
 * from PROCESSING — so an import nothing would ever pick up looked
 * exactly like one about to start.
 *
 * **The operator cannot find that out anywhere else.** Imports are
 * initiated by a utility admin; worker attachment lives on
 * `/platform/cluster/*` behind the platform actor, which a tenant's own
 * System Admin is refused. The fact that explains the screen was
 * visible only to somebody not looking at it.
 *
 * Three states have to read differently, which is why they are three
 * cases: nothing attached, attached but paused, and *not known* — a
 * managed Redis that refuses CLIENT LIST, or one that never answers.
 * Saying "nothing is processing imports" when we could not tell would
 * send an operator to chase a worker that is running.
 */

const get = apiClient.get as unknown as ReturnType<typeof vi.fn>;

const params = Promise.resolve({ id: "batch-1" });

function batch(over: Record<string, unknown> = {}) {
  return {
    id: "batch-1aaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    entityKind: "service_agreement",
    source: "MANUAL_UPLOAD",
    fileName: "agreements.csv",
    status: "PENDING",
    recordCount: 4000,
    importedCount: 0,
    errorCount: 0,
    exceptionCount: 0,
    createdAt: "2026-11-01T09:00:00.000Z",
    completedAt: null,
    mapping: null,
    ...over,
  };
}

function routeGets(opts: {
  batch?: Record<string, unknown>;
  attendance?: { workers: number | null; paused: boolean } | null;
}) {
  get.mockImplementation((path: string) => {
    if (path === "/api/v1/imports/batch-1") {
      return Promise.resolve({
        batch: opts.batch ?? batch(),
        attachment: null,
        attendance: opts.attendance ?? null,
      });
    }
    if (path === "/api/v1/imports/batch-1/error-summary") return Promise.resolve([]);
    return Promise.resolve({ data: [] });
  });
}

async function renderPage() {
  await act(async () => {
    render(
      <ToastProvider>
        <ImportDetailPage params={params} />
      </ToastProvider>,
    );
  });
}

/** The batch has arrived once its file name is on the page. */
function loaded() {
  return screen.findByText(/agreements\.csv/, {}, { timeout: 5000 });
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Import detail — why a queued batch is not moving", () => {
  it("says nothing is processing imports when the queue is unattended", async () => {
    routeGets({ attendance: { workers: 0, paused: false } });
    await renderPage();
    await loaded();

    expect(screen.getByText(/nothing is processing imports/i)).toBeInTheDocument();
  });

  it("stays quiet when a worker is attached", async () => {
    routeGets({ attendance: { workers: 2, paused: false } });
    await renderPage();
    await loaded();

    expect(screen.queryByText(/nothing is processing imports/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/paused/i)).not.toBeInTheDocument();
  });

  it("says the queue is paused, because an attached worker still runs nothing", async () => {
    routeGets({ attendance: { workers: 1, paused: true } });
    await renderPage();
    await loaded();

    expect(screen.getByText(/paused/i)).toBeInTheDocument();
    // Not the unattended wording: a worker *is* there.
    expect(screen.queryByText(/nothing is processing imports/i)).not.toBeInTheDocument();
  });

  it("claims nothing when the worker count could not be determined", async () => {
    routeGets({ attendance: { workers: null, paused: false } });
    await renderPage();
    await loaded();

    expect(screen.queryByText(/nothing is processing imports/i)).not.toBeInTheDocument();
  });

  it("says nothing on a batch that has already finished", async () => {
    routeGets({
      batch: batch({ status: "COMPLETE", importedCount: 4000, completedAt: "2026-11-01T09:40:00.000Z" }),
      attendance: null,
    });
    await renderPage();
    await loaded();

    expect(screen.queryByText(/nothing is processing imports/i)).not.toBeInTheDocument();
  });
});
