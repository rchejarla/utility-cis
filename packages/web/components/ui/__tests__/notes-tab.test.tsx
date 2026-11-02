import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ToastProvider } from "@/components/ui/toast";
import { apiClient } from "@/lib/api-client";
import { NotesTab } from "../notes-tab";

/**
 * Notes on a record, as a staff member sees them.
 *
 * The API shipped without a screen, which made the whole thing
 * theoretical: spec 28's OVL-T-3 makes a mirrored record read-only, and
 * the refusal message tells a CSR to "add a note here" — which was a
 * lie while there was nowhere to add one.
 *
 * Three properties the panel has to get right, all of them consequences
 * of the table being append-only:
 *
 *   - **No edit and no delete controls.** A note records that somebody
 *     observed something at a time. Offering a pencil would promise
 *     something the API refuses.
 *   - **Newest first**, because the latest remark is the one that
 *     changes what the reader does next.
 *   - **The author and the time are the note**, as much as the body is.
 *     An unattributed remark is gossip.
 */

const get = apiClient.get as unknown as ReturnType<typeof vi.fn>;
const post = apiClient.post as unknown as ReturnType<typeof vi.fn>;

function note(over: Record<string, unknown> = {}) {
  return {
    id: "n-1",
    entityType: "Meter",
    entityId: "m-1",
    body: "Dial was unreadable — mud on the glass, cleaned it.",
    authorId: "u-1",
    authorName: "Jane CSR",
    createdAt: "2026-11-02T09:15:00.000Z",
    ...over,
  };
}

function routeGets(notes: unknown[]) {
  get.mockImplementation((path: string) => {
    if (path === "/api/v1/meters/m-1/notes") return Promise.resolve(notes);
    return Promise.resolve([]);
  });
}

async function renderPanel() {
  await act(async () => {
    render(
      <ToastProvider>
        <NotesTab subject="meters" entityId="m-1" />
      </ToastProvider>,
    );
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

/*
 * No `vi.restoreAllMocks()`: it restores the setup file's mocks too,
 * `window.matchMedia` among them, and every case after the first then
 * dies inside an unrelated component.
 */

describe("NotesTab", () => {
  it("shows a note with who wrote it and when", async () => {
    routeGets([note()]);
    await renderPanel();

    expect(await screen.findByText(/mud on the glass/)).toBeInTheDocument();
    expect(screen.getByText(/Jane CSR/)).toBeInTheDocument();
  });

  it("offers no way to edit one, but does offer to remove it", async () => {
    /*
     * The body is never edited — a note records what somebody said at a
     * time, so a pencil would promise something the API refuses. It can
     * be withdrawn, which is soft on the server: the row keeps
     * `deletedAt` and `deletedBy`, so the fact that a note was written
     * and withdrawn survives.
     */
    routeGets([note()]);
    await renderPanel();
    await screen.findByText(/mud on the glass/);

    expect(screen.queryByRole("button", { name: /edit/i })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /remove note/i })).toBeInTheDocument();
  });

  it("withdraws a note and refreshes the list", async () => {
    routeGets([note()]);
    const del = apiClient.delete as unknown as ReturnType<typeof vi.fn>;
    del.mockResolvedValue(undefined);
    await renderPanel();
    await screen.findByText(/mud on the glass/);

    routeGets([]);
    await userEvent.click(screen.getByRole("button", { name: /remove note/i }));

    expect(del).toHaveBeenCalledWith("/api/v1/meters/m-1/notes/n-1");
    expect(await screen.findByText(/no notes/i)).toBeInTheDocument();
  });

  it("keeps the compose box closed until asked", async () => {
    // The common act on this tab is reading. Writing is occasional, so
    // it is a button first — as AttachmentsTab is.
    routeGets([note()]);
    await renderPanel();
    await screen.findByText(/mud on the glass/);

    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /add note/i }));
    expect(screen.getByRole("textbox")).toBeInTheDocument();
  });

  it("keeps the order the API returned, newest first", async () => {
    routeGets([
      note({ id: "n-2", body: "Second visit", createdAt: "2026-11-02T11:00:00.000Z" }),
      note({ id: "n-1", body: "First visit", createdAt: "2026-11-01T11:00:00.000Z" }),
    ]);
    await renderPanel();

    const bodies = (await screen.findAllByTestId("note-body")).map((n) => n.textContent);
    expect(bodies).toEqual(["Second visit", "First visit"]);
  });

  it("says so plainly when there are none", async () => {
    routeGets([]);
    await renderPanel();
    expect(await screen.findByText(/no notes/i)).toBeInTheDocument();
  });

  it("posts a new note and shows it without a reload", async () => {
    routeGets([]);
    post.mockResolvedValue(note({ body: "Spoke to the owner." }));
    await renderPanel();
    await screen.findByText(/no notes/i);

    await userEvent.click(screen.getByRole("button", { name: /add note/i }));
    await userEvent.type(screen.getByRole("textbox"), "Spoke to the owner.");
    // The list is refetched after a successful post.
    routeGets([note({ body: "Spoke to the owner." })]);
    await userEvent.click(screen.getByRole("button", { name: /save note/i }));

    expect(post).toHaveBeenCalledWith("/api/v1/meters/m-1/notes", {
      body: "Spoke to the owner.",
    });
    expect(await screen.findByText(/Spoke to the owner\./)).toBeInTheDocument();
  });

  it("will not post an empty note", async () => {
    routeGets([]);
    await renderPanel();
    await screen.findByText(/no notes/i);

    // Whitespace is not a note — the API and the database both refuse
    // it, so the button should not fire at all.
    await userEvent.click(screen.getByRole("button", { name: /add note/i }));
    await userEvent.type(screen.getByRole("textbox"), "   ");
    await userEvent.click(screen.getByRole("button", { name: /save note/i }));

    expect(post).not.toHaveBeenCalled();
  });
});
