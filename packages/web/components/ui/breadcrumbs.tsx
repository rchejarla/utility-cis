"use client";

import { usePathname } from "next/navigation";

/**
 * The path, as words.
 *
 * It lived inside `Topbar`, which is right for tenant screens: the
 * sidebar pins the page's left edge, so a breadcrumb at the header's
 * left edge lines up with the page heading underneath it.
 *
 * The platform screens have no sidebar and centre their content, so a
 * breadcrumb in the header would sit out at the window's edge with the
 * heading a long way inboard. There it is rendered at the top of the
 * content column instead, which aligns the two by construction rather
 * than by arithmetic — and the logo and the account controls stay at the
 * window's edges where they belong.
 */
/**
 * A record's id, which is a uuid everywhere in this app.
 *
 * Matched exactly rather than by position: `/meter-reads/exceptions` and
 * `/read-routes/new` put a literal word where an id would go, and a rule
 * that dropped "the segment after a section" would eat those.
 */
const IS_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function getBreadcrumbs(pathname: string): string[] {
  /*
   * **An id segment is dropped, not title-cased.** Every detail page in
   * the app is `/<thing>/[id]`, and title-casing a uuid rendered
   * `Read Routes / Ef6e9cf6 1ae3 4062 9876 7a0270ff10b6` two lines above
   * a heading that said "W-04 — North Willson". It was reported against
   * one page and belonged to all 18 of them, since this function is the
   * only breadcrumb there is.
   *
   * Dropping it rather than shortening it, because a shorter uuid is a
   * shorter meaningless string; and rather than looking the record up,
   * because that would mean every page feeding a label into the chrome
   * to restate what its own heading already says. What is left is the
   * trail that helps: "Read Routes / Entry".
   */
  const segments = pathname.split("/").filter(Boolean).filter((seg) => !IS_ID.test(seg));
  if (segments.length === 0) return ["Home"];
  return segments.map((seg) => seg.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()));
}

export function Breadcrumbs({ style }: { style?: React.CSSProperties }) {
  const pathname = usePathname();
  const breadcrumbs = getBreadcrumbs(pathname);

  return (
    <nav style={{ display: "flex", alignItems: "center", gap: "6px", flex: 1, ...style }}>
      {breadcrumbs.map((crumb, index) => (
        <span key={index} style={{ display: "flex", alignItems: "center", gap: "6px" }}>
          {index > 0 && <span style={{ color: "var(--text-muted)", fontSize: "12px" }}>/</span>}
          <span
            style={{
              color:
                index === breadcrumbs.length - 1 ? "var(--text-primary)" : "var(--text-secondary)",
              fontSize: "13px",
              fontWeight: index === breadcrumbs.length - 1 ? "500" : "400",
            }}
          >
            {crumb}
          </span>
        </span>
      ))}
    </nav>
  );
}
