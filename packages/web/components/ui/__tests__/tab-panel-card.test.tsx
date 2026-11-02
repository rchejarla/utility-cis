import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { ToastProvider } from "@/components/ui/toast";
import { apiClient } from "@/lib/api-client";
import { NotesTab } from "../notes-tab";
import { HistoryTimeline } from "@/components/effective-dating/history-timeline";

/**
 * Every tab panel sits on a card.
 *
 * The convention in this app is that the panel's own component owns its
 * surface — `AttachmentsTab` and `DataTable` each draw one — and the
 * page wraps only `overview`. Two panels did not: `NotesTab`, which was
 * new, and `HistoryTimeline`, whose root was a bare `div`. So Notes and
 * History read as floating text beside every other tab on the same
 * screen, on all five entity pages at once.
 *
 * Asserted on the rendered background rather than by eye, because
 * "looks like the others" is exactly the kind of claim that drifts the
 * next time somebody adds a tab. The empty state is included: a panel
 * with nothing in it still has to be a panel, or the card appears only
 * once there is content — which is the odd half of the same bug.
 */

const get = apiClient.get as unknown as ReturnType<typeof vi.fn>;

const CARD = "var(--bg-card)";

beforeEach(() => {
  vi.clearAllMocks();
});

/*
 * No `vi.restoreAllMocks()`: it restores the setup file's mocks too,
 * `window.matchMedia` among them.
 */

async function renderNotes() {
  await act(async () => {
    render(
      <ToastProvider>
        <NotesTab subject="meters" entityId="m-1" />
      </ToastProvider>,
    );
  });
}

describe("NotesTab sits on a card", () => {
  it("draws one around the list when there are notes", async () => {
    get.mockResolvedValue([
      {
        id: "n-1",
        body: "Mud on the glass.",
        authorName: "Jane CSR",
        createdAt: "2026-11-02T09:15:00.000Z",
      },
    ]);
    await renderNotes();
    await screen.findByText(/Mud on the glass/);

    expect(screen.getByTestId("notes-panel")).toHaveStyle({ background: CARD });
  });

  it("draws one around the empty state too", async () => {
    // Otherwise the card appears only once somebody adds a note, which
    // is the odd half of the same bug.
    get.mockResolvedValue([]);
    await renderNotes();
    await screen.findByText(/no notes/i);

    expect(screen.getByTestId("notes-panel")).toHaveStyle({ background: CARD });
  });
});

describe("HistoryTimeline sits on a card", () => {
  const events = [
    {
      id: "e-1",
      label: "SA-0001",
      startDate: "2026-01-01",
      endDate: null,
      status: "ACTIVE",
      href: "/service-agreements/sa-1",
    },
  ];

  it("draws one around the timeline", () => {
    render(<HistoryTimeline events={events} />);
    expect(screen.getByTestId("history-panel")).toHaveStyle({ background: CARD });
  });

  it("draws one around its empty message", () => {
    render(<HistoryTimeline events={[]} emptyMessage="Nothing yet." />);
    expect(screen.getByTestId("history-panel")).toHaveStyle({ background: CARD });
    expect(screen.getByText("Nothing yet.")).toBeInTheDocument();
  });
});
