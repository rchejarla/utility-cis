import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { Topbar } from "../topbar";

/**
 * The header stays put while the page scrolls.
 *
 * Both shells already meant to pin it, by shape: a `height: 100vh` flex
 * column whose `<main>` owned the scroll. That cannot work under the
 * `zoom: 1.25` this app sets on `:root` — `100vh` resolves against the
 * unzoomed viewport, so the box renders a quarter taller than the screen,
 * the document itself scrolls, and the header rides up with it. On every
 * page, which is how it was reported.
 *
 * Two things fix it, and both are needed. The shells and the sidebar now
 * measure the screen with `--screen-h`, which divides out the zoom. And
 * the header is pinned with `sticky`, which holds against the viewport
 * whatever a length resolves to — insurance the shells cannot give,
 * since this bug is the proof that a measured height can be wrong.
 *
 * jsdom has no layout engine, so it cannot be asked whether anything
 * actually scrolls. It can be asked whether the header still declares
 * itself pinned, which is the part a refactor would silently drop.
 */

vi.mock("@/lib/api-client", () => ({
  apiClient: { get: vi.fn().mockResolvedValue({}), post: vi.fn() },
  API_URL: "http://localhost:3001",
}));

// The tenant bar's account menu reads the session; there is no provider
// in the test tree and this test is about neither.
vi.mock("next-auth/react", () => ({
  useSession: () => ({ data: { user: { name: "Pat", email: "pat@example.com" } }, status: "authenticated" }),
  signOut: vi.fn(),
}));

describe("the top bar", () => {
  it("is pinned to the top of the viewport", () => {
    render(<Topbar variant="platform" identity={{ name: "Pat", email: "pat@example.com" }} />);

    const header = screen.getByRole("banner");
    expect(header).toHaveStyle({ position: "sticky", top: "0px" });
  });

  it("is pinned on a phone too, where the bar is the compact one", () => {
    // A different element, so it needs its own assertion — the compact
    // variant returns early and would not have inherited the fix.
    render(<Topbar compact variant="tenant" />);

    expect(screen.getByRole("banner")).toHaveStyle({ position: "sticky", top: "0px" });
  });

  it("sits above page content but below the overlays", () => {
    // The Cmd-K search overlay and the modal backdrops are at 9999; a
    // header above those would cover the thing it opened.
    render(<Topbar compact variant="tenant" />);

    const z = Number(screen.getByRole("banner").style.zIndex);
    expect(z).toBeGreaterThan(1);
    expect(z).toBeLessThan(9999);
  });
});
