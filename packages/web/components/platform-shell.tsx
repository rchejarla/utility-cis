"use client";

import { useEffect, useState } from "react";
import {
  faBuildingColumns,
  faUserShield,
  faLayerGroup,
  faListCheck,
  faServer,
  faGaugeHigh,
  faMicrochip,
  faRectangleList,
} from "@fortawesome/pro-solid-svg-icons";
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
  {
    /*
     * The deployment itself, rather than any tenant in it.
     *
     * One page held all of this — the verdict, the nodes, the worker
     * processes, the eight queues and the jobs behind one count — and
     * each thing added made the others harder to find. Three pages,
     * because they answer three questions: is anything wrong, who is
     * doing the work, and what is the work.
     *
     * Bull Board, the only queue surface before these existed, is
     * reachable only by typing /admin/queues on the API host. It is not
     * a nav target: a separate origin with its own chrome and no way
     * back makes a fine escape hatch from inside a page and a poor menu
     * entry, so the Queues page names it instead.
     */
    title: "Cluster",
    icon: faServer,
    items: [
      {
        href: "/platform/cluster",
        label: "Overview",
        icon: faGaugeHigh,
        module: "platform",
        tooltip: "Whether anything is stuck, and what has failed recently",
      },
      {
        href: "/platform/cluster/workers",
        label: "Workers",
        icon: faMicrochip,
        module: "platform",
        tooltip: "The API nodes, and the worker process on each",
      },
      {
        href: "/platform/cluster/queues",
        label: "Queues",
        icon: faListCheck,
        module: "platform",
        tooltip: "What is waiting, running, scheduled, failed and done",
      },
      {
        /*
         * In the menu as well as behind a count, because a page with a
         * queue filter and a status filter is somewhere to go, not only
         * somewhere you land. A bare visit picks the first queue and
         * waiting; the counts in the filters say where the jobs are.
         */
        href: "/platform/cluster/jobs",
        label: "Jobs",
        icon: faRectangleList,
        module: "platform",
        tooltip: "The jobs in one queue and one state, with retry and replay",
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
