"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, useEffect, useRef } from "react";
import type { ReactNode } from "react";
import { logout, getStoredUser } from "@/lib/api-client";

const NAV_ITEMS = [
  { href: "/portal/dashboard", label: "Dashboard" },
  { href: "/portal/bills", label: "Bills" },
  { href: "/portal/usage", label: "Usage" },
];

export default function PortalLayout({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const isAuthPage = pathname?.startsWith("/portal/login") || pathname?.startsWith("/portal/register");

  if (isAuthPage) {
    return <>{children}</>;
  }

  return (
    <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column" }}>
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
        {/* Brand */}
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
          <span style={{ color: "var(--text-primary)", fontWeight: 600, fontSize: 15 }}>
            My Utility
          </span>
        </Link>

        {/* Desktop nav */}
        <nav style={{ display: "flex", gap: 2 }}>
          {NAV_ITEMS.map((item) => {
            const isActive = pathname === item.href || pathname?.startsWith(item.href + "/");
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

        {/* User name + avatar dropdown */}
        <AvatarMenu />
      </header>

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

      <style>{`
        @media (max-width: 767px) {
          .portal-bottom-nav { display: flex !important; }
        }
      `}</style>
    </div>
  );
}

function AvatarMenu() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const user = getStoredUser();
  const initial = (user?.name as string)?.[0]?.toUpperCase() ?? "?";
  const displayName = (user?.name as string) ?? "Customer";
  const displayEmail = (user?.email as string) ?? "";

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    if (open) document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [open]);

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button
        onClick={() => setOpen((v) => !v)}
        title="Account menu"
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          background: "none",
          border: "none",
          cursor: "pointer",
          padding: 0,
          fontFamily: "inherit",
        }}
      >
        <span style={{ fontSize: 13, color: "var(--text-secondary)", fontWeight: 500 }}>
          {displayName}
        </span>
        <div
          style={{
            width: 32,
            height: 32,
            borderRadius: "50%",
            background: "var(--bg-elevated)",
            border: "1px solid var(--border)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "var(--text-secondary)",
            fontSize: 13,
            fontWeight: 600,
            flexShrink: 0,
            transition: "background 0.12s",
          }}
        >
          {initial}
        </div>
      </button>

      {open && (
        <div
          style={{
            position: "absolute",
            top: "calc(100% + 8px)",
            right: 0,
            width: 240,
            background: "var(--bg-card)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius)",
            boxShadow: "0 8px 24px rgba(0,0,0,0.4)",
            zIndex: 200,
            overflow: "hidden",
          }}
        >
          {/* User info */}
          <div style={{ padding: "14px 16px", borderBottom: "1px solid var(--border-subtle)" }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-primary)" }}>
              {displayName}
            </div>
            <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 2 }}>
              {displayEmail}
            </div>
          </div>

          {/* Menu items */}
          <div style={{ padding: "6px 0" }}>
            <Link
              href="/portal/profile"
              onClick={() => setOpen(false)}
              style={{
                display: "block",
                padding: "10px 16px",
                fontSize: 13,
                color: "var(--text-secondary)",
                textDecoration: "none",
                transition: "background 0.1s",
              }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = "var(--bg-hover)"; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = "transparent"; }}
            >
              Profile
            </Link>
            <button
              onClick={logout}
              style={{
                display: "block",
                width: "100%",
                padding: "10px 16px",
                fontSize: 13,
                color: "var(--danger)",
                background: "none",
                border: "none",
                textAlign: "left",
                cursor: "pointer",
                fontFamily: "inherit",
                transition: "background 0.1s",
              }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = "var(--bg-hover)"; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = "transparent"; }}
            >
              Sign out
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
