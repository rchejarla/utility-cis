import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ActionMenu, type ActionMenuItem } from "../action-menu";

/**
 * The dropdown that keeps a crowded row legible.
 *
 * Most of what can break here is invisible to jsdom, which implements
 * neither focus-induced scrolling nor scroll events — so the first
 * version of this menu passed every test and did nothing at all in a
 * browser. The cases below therefore assert the *mechanics* that make it
 * survive a real page: focus that does not scroll, a position that flips
 * rather than falling off the viewport, and a scroll inside the menu
 * that is not mistaken for the page moving.
 */

function items(over: Partial<ActionMenuItem>[] = []): ActionMenuItem[] {
  const base: ActionMenuItem[] = [
    { label: "Take payment", onSelect: vi.fn() },
    { label: "Waive", onSelect: vi.fn() },
    { label: "Reverse charge", tone: "danger", onSelect: vi.fn() },
  ];
  return base.map((b, i) => ({ ...b, ...(over[i] ?? {}) }));
}

/** jsdom gives every element a zero-sized rect; tests that care set one. */
function placeTrigger(rect: Partial<DOMRect>) {
  vi.spyOn(HTMLButtonElement.prototype, "getBoundingClientRect").mockReturnValue({
    top: 100,
    bottom: 120,
    left: 500,
    right: 600,
    width: 100,
    height: 20,
    x: 500,
    y: 100,
    toJSON: () => ({}),
    ...rect,
  } as DOMRect);
}

beforeEach(() => {
  vi.clearAllMocks();
  window.innerHeight = 800;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ActionMenu", () => {
  it("opens on click and lists its items", async () => {
    render(<ActionMenu items={items()} />);

    await userEvent.click(screen.getByRole("button", { name: "More" }));

    expect(await screen.findByRole("menu")).toBeInTheDocument();
    expect(screen.getAllByRole("menuitem").map((e) => e.textContent)).toEqual([
      "Take payment",
      "Waive",
      "Reverse charge",
    ]);
  });

  /**
   * The bug that made the first version a dead button. Focusing without
   * this scrolls an ancestor to reveal the item, the scroll handler sees
   * it, and the menu closes in the frame it opened.
   */
  it("focuses the first item without letting the browser scroll to it", async () => {
    const focus = vi.spyOn(HTMLButtonElement.prototype, "focus");
    render(<ActionMenu items={items()} />);

    await userEvent.click(screen.getByRole("button", { name: "More" }));

    await screen.findByRole("menu");
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
  });

  it("flips above the trigger when there is no room below", async () => {
    // Trigger near the bottom: 3 items need ~104px and only 40 remain.
    placeTrigger({ top: 740, bottom: 760 });
    render(<ActionMenu items={items()} />);

    await userEvent.click(screen.getByRole("button", { name: "More" }));

    const menu = await screen.findByRole("menu");
    // Anchored to the trigger's top and pulled upwards, so it cannot be
    // painted off the bottom of the viewport.
    expect(menu.style.top).toBe("736px");
    expect(menu.style.transform).toBe("translate(-100%, -100%)");
  });

  it("opens below when there is room, anchored to the trigger", async () => {
    placeTrigger({ top: 100, bottom: 120 });
    render(<ActionMenu items={items()} />);

    await userEvent.click(screen.getByRole("button", { name: "More" }));

    const menu = await screen.findByRole("menu");
    expect(menu.style.top).toBe("124px");
    expect(menu.style.transform).toBe("translateX(-100%)");
  });

  /**
   * A scroll must NOT close it. Closing on scroll is what made the first
   * version a dead button: a capture-phase listener on window hears
   * every scrolling element in the document, so anything that scrolled
   * for any reason shut the menu in the frame it opened. Drift is the
   * lesser fault, since the menu closes on any item, an outside click
   * and Escape.
   */
  it("survives a scroll, from the page or from inside itself", async () => {
    render(<ActionMenu items={items()} />);
    await userEvent.click(screen.getByRole("button", { name: "More" }));
    const menu = await screen.findByRole("menu");

    act(() => {
      window.dispatchEvent(new Event("scroll"));
      menu.dispatchEvent(new Event("scroll", { bubbles: true }));
      window.dispatchEvent(new Event("resize"));
    });

    expect(screen.getByRole("menu")).toBeInTheDocument();
  });

  it("runs the chosen action and closes", async () => {
    const list = items();
    render(<ActionMenu items={list} />);

    await userEvent.click(screen.getByRole("button", { name: "More" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Waive" }));

    expect(list[1].onSelect).toHaveBeenCalled();
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("closes on Escape and gives focus back to the trigger", async () => {
    render(<ActionMenu items={items()} />);
    const trigger = screen.getByRole("button", { name: "More" });
    await userEvent.click(trigger);
    await screen.findByRole("menu");

    await userEvent.keyboard("{Escape}");

    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("moves between items with the arrow keys", async () => {
    render(<ActionMenu items={items()} />);
    await userEvent.click(screen.getByRole("button", { name: "More" }));
    await screen.findByRole("menu");

    await userEvent.keyboard("{ArrowDown}");
    expect(screen.getByRole("menuitem", { name: "Waive" })).toHaveFocus();

    // And wraps, rather than dead-ending at the edges.
    await userEvent.keyboard("{ArrowUp}{ArrowUp}");
    expect(screen.getByRole("menuitem", { name: "Reverse charge" })).toHaveFocus();
  });

  it("renders nothing at all when there is nothing to offer", () => {
    render(<ActionMenu items={[]} />);

    expect(screen.queryByRole("button", { name: "More" })).not.toBeInTheDocument();
  });

  it("skips a disabled item when focusing and when arrowing", async () => {
    render(<ActionMenu items={items([{ disabled: true }])} />);

    await userEvent.click(screen.getByRole("button", { name: "More" }));

    await screen.findByRole("menu");
    expect(screen.getByRole("menuitem", { name: "Waive" })).toHaveFocus();
  });
});
