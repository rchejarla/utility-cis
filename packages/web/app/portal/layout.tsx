"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { logout } from "@/lib/api-client";

const NAV_ITEMS = [
  { href: "/portal/dashboard", label: "Dashboard" },
  { href: "/portal/bills", label: "Bills" },
  { href: "/portal/usage", label: "Usage" },
  { href: "/portal/profile", label: "Profile" },
];

/**
 * Portal layout — customer-facing. No admin sidebar, no admin topbar.
 * Responsive mobile-first with a sticky header bar and a bottom nav on
 * small screens.
 */
export default function PortalLayout({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const isAuthPage = pathname?.startsWith("/portal/login") || pathname?.startsWith("/portal/register");

  if (isAuthPage) {
    return <>{children}</>;
  }

  return (
    <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column" }}>
      {/* Top header */}
      <header
        style={{
          height: 56,
          background: "var(--bg-surface)",
          borderBottom: "1px solid var(--border)",
          display: "flex",
          alignItems: "center",
          padding: "0 24px",
          gap: 24,
          flexShrink: 0,
        }}
      >
        <Link
          href="/portal/dashboard"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            textDecoration: "none",
            marginRight: "auto",
          }}
        >
          <div
            style={{
              width: 28,
              height: 28,
              borderRadius: 7,
              background: "var(--accent-primary)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "#fff",
              fontWeight: 700,
              fontSize: 13,
            }}
          >
            U
          </div>
          <span
            style={{
              color: "var(--text-primary)",
              fontWeight: 600,
              fontSize: 15,
            }}
          >
            My Utility
          </span>
        </Link>

        {/* Desktop nav */}
        <nav
          style={{
            display: "flex",
            gap: 2,
          }}
        >
          {NAV_ITEMS.map((item) => {
            const isActive =
              pathname === item.href || pathname?.startsWith(item.href + "/");
            return (
              <Link
                key={item.href}
                href={item.href}
                style={{
                  padding: "8px 14px",
                  borderRadius: "var(--radius)",
                  fontSize: 13,
                  fontWeight: isActive ? 600 : 500,
                  color: isActive ? "var(--accent-primary-hover)" : "var(--text-secondary)",
                  background: isActive ? "var(--accent-primary-subtle)" : "transparent",
                  textDecoration: "none",
                  transition: "background 0.12s, color 0.12s",
                }}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>

        {/* Logout */}
        <button
          onClick={logout}
          style={{
            fontSize: 12,
            color: "var(--text-muted)",
            background: "none",
            border: "none",
            cursor: "pointer",
            fontFamily: "inherit",
          }}
        >
          Sign out
        </button>
      </header>

      {/* Main content */}
      <main
        style={{
          flex: 1,
          maxWidth: 1024,
          width: "100%",
          margin: "0 auto",
          padding: "24px 24px 80px",
        }}
      >
        {children}
      </main>

      {/* Mobile bottom nav */}
      <nav
        style={{
          position: "fixed",
          bottom: 0,
          left: 0,
          right: 0,
          height: 56,
          background: "var(--bg-surface)",
          borderTop: "1px solid var(--border)",
          display: "none",
          alignItems: "stretch",
          zIndex: 100,
        }}
        className="portal-bottom-nav"
      >
        {NAV_ITEMS.map((item) => {
          const isActive = pathname === item.href || pathname?.startsWith(item.href + "/");
          return (
            <Link
              key={item.href}
              href={item.href}
              style={{
                flex: 1,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 11,
                fontWeight: isActive ? 600 : 400,
                color: isActive ? "var(--accent-primary)" : "var(--text-muted)",
                textDecoration: "none",
              }}
            >
              {item.label}
            </Link>
          );
        })}
      </nav>

      {/* Show bottom nav on mobile only */}
      <style>{`
        @media (max-width: 767px) {
          .portal-bottom-nav { display: flex !important; }
        }
      `}</style>
    </div>
  );
}
