"use client";

import { usePathname } from "next/navigation";
import { useBreakpoint } from "@/lib/use-media-query";
import { AuthPermissionProvider } from "@/lib/auth-context";
import { Sidebar } from "./sidebar";
import { Topbar } from "./topbar";
import { BottomNav } from "./bottom-nav";

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { isMobile, isTablet } = useBreakpoint();

  // Dev pages render without shell (no sidebar/topbar)
  if (pathname.startsWith("/dev")) {
    return <AuthPermissionProvider>{children}</AuthPermissionProvider>;
  }

  return (
    <AuthPermissionProvider>
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
      {/* Sidebar: hidden on mobile, icon-only on tablet */}
      {!isMobile && <Sidebar defaultCollapsed={isTablet} />}

      <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
        {/* Topbar: simplified on mobile */}
        <Topbar compact={isMobile} />

        <main
          id="main-content"
          tabIndex={-1}
          style={{
            flex: 1,
            overflow: "auto",
            padding: isMobile ? "16px" : "24px",
            paddingBottom: isMobile ? "72px" : "24px",
          }}
        >
          {children}
        </main>
      </div>

      {/* Bottom nav: mobile only */}
      {isMobile && <BottomNav />}
    </div>
    </>
    </AuthPermissionProvider>
  );
}
