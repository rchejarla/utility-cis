"use client";

import { useBreakpoint } from "@/lib/use-media-query";
import { AuthPermissionProvider } from "@/lib/auth-context";
import { Sidebar } from "./sidebar";
import { Topbar } from "./topbar";
import { BottomNav } from "./bottom-nav";

export function AppShell({ children }: { children: React.ReactNode }) {
  const { isMobile, isTablet } = useBreakpoint();

  return (
    <AuthPermissionProvider>
    <div style={{ display: "flex", height: "100vh" }}>
      {/* Sidebar: hidden on mobile, icon-only on tablet */}
      {!isMobile && <Sidebar defaultCollapsed={isTablet} />}

      <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
        {/* Topbar: simplified on mobile */}
        <Topbar compact={isMobile} />

        <main
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
    </AuthPermissionProvider>
  );
}
