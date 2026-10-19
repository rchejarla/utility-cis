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
export function getBreadcrumbs(pathname: string): string[] {
  const segments = pathname.split("/").filter(Boolean);
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
