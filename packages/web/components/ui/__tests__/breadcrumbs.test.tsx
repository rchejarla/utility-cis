import { describe, it, expect } from "vitest";
import { getBreadcrumbs } from "../breadcrumbs";

/**
 * The path, as words — and the one segment that is not a word.
 *
 * Every detail page in the app is `/<thing>/[id]`, and the id is a uuid.
 * Title-casing it produced a breadcrumb like
 *
 *     Read Routes / Ef6e9cf6 1ae3 4062 9876 7a0270ff10b6
 *
 * two lines above a heading that correctly read "W-04 — North Willson".
 * Reported 2026-11-17 from a browser, on the read-route detail page, but
 * it was never that page's: there are 18 `[id]` route directories and one
 * `getBreadcrumbs`, so every one of them did it.
 *
 * **A uuid is dropped rather than shortened or looked up.** Shortening it
 * leaves a shorter meaningless string; looking the record up would need
 * every page to feed a label into the chrome, which is machinery across
 * 18 pages to restate what the heading underneath already says. Dropping
 * it leaves the trail that is actually useful — "Read Routes / Entry"
 * says where you are and what contains it.
 *
 * No jsdom test caught it because the component renders in `Topbar`, and
 * a page test renders the page body.
 */

const UUID = "ef6e9cf6-1ae3-4062-9876-7a0270ff10b6";

describe("getBreadcrumbs", () => {
  it("names the section", () => {
    expect(getBreadcrumbs("/read-routes")).toEqual(["Read Routes"]);
  });

  it("drops a uuid segment rather than title-casing it", () => {
    expect(getBreadcrumbs(`/read-routes/${UUID}`)).toEqual(["Read Routes"]);
  });

  it("keeps the segments either side of a dropped id", () => {
    expect(getBreadcrumbs(`/read-routes/${UUID}/entry`)).toEqual(["Read Routes", "Entry"]);
  });

  it("does the same for every other detail page, since they share this", () => {
    expect(getBreadcrumbs(`/customers/${UUID}`)).toEqual(["Customers"]);
    expect(getBreadcrumbs(`/service-agreements/${UUID}`)).toEqual(["Service Agreements"]);
    expect(getBreadcrumbs(`/platform/utilities/${UUID}`)).toEqual(["Platform", "Utilities"]);
  });

  /*
   * The guard has to be narrow. A word is not an id because it sits in
   * the id's position — `/meter-reads/exceptions` and
   * `/meter-reads/progress` are literal segments that a positional rule
   * would have eaten.
   */
  it("keeps a word that merely sits where an id would", () => {
    expect(getBreadcrumbs("/meter-reads/exceptions")).toEqual(["Meter Reads", "Exceptions"]);
    expect(getBreadcrumbs("/meter-reads/progress")).toEqual(["Meter Reads", "Progress"]);
    expect(getBreadcrumbs("/read-routes/new")).toEqual(["Read Routes", "New"]);
  });

  it("keeps a hex-ish word that is not a uuid", () => {
    // `deadbeef` is hex and `cafe` is a word; neither is a uuid.
    expect(getBreadcrumbs("/things/deadbeef")).toEqual(["Things", "Deadbeef"]);
  });

  it("still says Home for the root", () => {
    expect(getBreadcrumbs("/")).toEqual(["Home"]);
  });

  /*
   * A path that is nothing but an id would otherwise render an empty
   * nav — no trail at all, which reads as a broken header rather than as
   * a page with no parent.
   */
  it("says Home rather than nothing when every segment was an id", () => {
    expect(getBreadcrumbs(`/${UUID}`)).toEqual(["Home"]);
  });
});
