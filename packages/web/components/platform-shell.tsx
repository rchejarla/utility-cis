"use client";

import { useEffect, useState } from "react";
import { faBuildingColumns, faUserShield, faLayerGroup } from "@fortawesome/pro-solid-svg-icons";
import { apiClient } from "@/lib/api-client";
import { useBreakpoint } from "@/lib/use-media-query";
import { Topbar } from "./topbar";
import { Sidebar, type NavSection } from "./sidebar";

/**
 * Chrome for the platform operator's screens.
 *
 * It is the admin shell with a different nav: the same `Sidebar`, the
 * same `Topbar`, assembled the same way. Two earlier versions of this
 * file were worse — one hand-built its own header bar, the next its own
 * side nav — and each drifted from the original it was imitating within
 * the hour. The sidebar now takes its sections as a prop, so there is
 * one sidebar in the product rather than one per surface, and the brand,
 * the breadcrumb, the theme toggle and the account menu all sit where
 * they do on every other screen.
 *
 * Permission filtering is off for these sections. Platform authority is
 * not a permission matrix — being the platform actor is the whole of it
 * — and these screens mount no `AuthPermissionProvider`, which is
 * deliberate: it fetches `/api/v1/auth/me`, which answers 403 for a
 * platform token and then falls back to granting every permission, so
 * any gating it provided here would be fabricated. The real gate is
 * `{ platform: true }`, server-side.
 */

const PLATFORM_SECTIONS: NavSection[] = [
  {
    title: "Platform",
    icon: faLayerGroup,
    items: [
      // `module` is required by the shape and unread here, since these
      // sections are not permission-filtered. "platform" is the honest
      // value: it names the authority these screens actually need.
      {
        href: "/platform/utilities",
        label: "Utilities",
        icon: faBuildingColumns,
        module: "platform",
        tooltip: "Create, suspend and inspect the utilities on this deployment",
      },
      {
        href: "/platform/users",
        label: "Operators",
        icon: faUserShield,
        module: "platform",
        tooltip: "The people who may do the above",
      },
    ],
  },
];

export function PlatformShell({ children }: { children: React.ReactNode }) {
  const [actor, setActor] = useState<{ name: string; email: string } | null>(null);
  // The same breakpoints the admin shell uses: no sidebar on a phone, an
  // icon rail on a tablet.
  const { isMobile, isTablet } = useBreakpoint();

  useEffect(() => {
    // Identity belongs to the chrome, not to a page: it is a property of
    // the session rather than of what is being shown. Without it the
    // account menu reads the NextAuth session and falls back to
    // "admin@utility.com", which on these screens is a lie.
    apiClient
      .get<{ actor: { name: string; email: string } | null }>("/api/v1/platform/me")
      .then((res) => setActor(res.actor ?? null))
      .catch(() => setActor(null));
  }, []);

  return (
    <>
      {/* WCAG 2.4.1 Bypass Blocks — skip link, visible on focus */}
      <a
        href="#main-content"
        style={{
          position: "absolute",
          left: "-9999px",
          top: "8px",
          zIndex: 9999,
          padding: "8px 16px",
          background: "var(--accent-primary, #2563eb)",
          color: "#fff",
          textDecoration: "none",
          borderRadius: "6px",
          fontSize: "13px",
          fontWeight: 500,
        }}
        onFocus={(e) => {
          e.currentTarget.style.left = "8px";
        }}
        onBlur={(e) => {
          e.currentTarget.style.left = "-9999px";
        }}
      >
        Skip to main content
      </a>

      <div style={{ display: "flex", height: "100vh" }}>
        {!isMobile && (
          <Sidebar
            sections={PLATFORM_SECTIONS}
            filterByPermissions={false}
            brandSubtitle="Platform"
            defaultCollapsed={isTablet}
          />
        )}

        <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
          <Topbar variant="platform" identity={actor} compact={isMobile} />

          <main
            id="main-content"
            tabIndex={-1}
            style={{ flex: 1, overflow: "auto", padding: "24px" }}
          >
            {children}
          </main>
        </div>
      </div>
    </>
  );
}
