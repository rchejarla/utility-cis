"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { useSession } from "next-auth/react";
import { GlobalSearch } from "./ui/global-search";
import { NotificationBell } from "./notifications/notification-bell";
import { logout } from "@/lib/api-client";
import { ThemeToggle } from "@/components/ui/theme-toggle";
import { BrandMark } from "@/components/ui/brand-mark";

function getBreadcrumbs(pathname: string): string[] {
  const segments = pathname.split("/").filter(Boolean);
  if (segments.length === 0) return ["Home"];
  return segments.map((seg) =>
    seg
      .replace(/-/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase())
  );
}

interface TopbarProps {
  compact?: boolean;
  /**
   * Which chrome this is. "platform" drops the controls that only mean
   * something inside a tenant — global search queries that tenant's
   * data, the notification bell its notifications, and Settings is its
   * settings page — and keeps everything else in the same order, so the
   * platform screens are not a second header that drifts from this one.
   */
  variant?: "tenant" | "platform";
  /**
   * Identity to show, when it does not come from the NextAuth session.
   * The platform actor authenticates with its own token, and the
   * session read below would otherwise fall back to "admin@utility.com".
   */
  identity?: { name: string; email: string } | null;
}

export function Topbar({ compact = false, variant = "tenant", identity }: TopbarProps) {
  const isPlatform = variant === "platform";
  const pathname = usePathname();

  const breadcrumbs = getBreadcrumbs(pathname);

  if (compact) {
    return (
      <header
        style={{
          height: "56px",
          background: "var(--header-bg)",
          borderBottom: "1px solid var(--border)",
          display: "flex",
          alignItems: "center",
          padding: "0 16px",
          gap: "12px",
          flexShrink: 0,
        }}
      >
        {/* App title on mobile */}
        <div style={{ flex: 1, display: "flex", alignItems: "center", gap: "10px" }}>
          <div
            style={{
              width: 28,
              height: 28,
              borderRadius: 7,
              background: "var(--accent-primary)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "white",
              fontWeight: "bold",
              fontSize: 13,
              flexShrink: 0,
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
            Utility CIS
          </span>
        </div>

        <ThemeToggle />
      </header>
    );
  }

  return (
    <header
      style={{
        height: "56px",
        background: "var(--header-bg)",
        borderBottom: "1px solid var(--border)",
        display: "flex",
        alignItems: "center",
        padding: "0 24px",
        gap: "16px",
        flexShrink: 0,
      }}
    >
      {/* The mark lives in the sidebar on tenant screens. The platform
          screens have no sidebar, so it belongs here instead. */}
      {isPlatform && <BrandMark subtitle="Platform" />}

      {/* Breadcrumb */}
      <nav style={{ display: "flex", alignItems: "center", gap: "6px", flex: 1 }}>
        {breadcrumbs.map((crumb, index) => (
          <span key={index} style={{ display: "flex", alignItems: "center", gap: "6px" }}>
            {index > 0 && (
              <span style={{ color: "var(--text-muted)", fontSize: "12px" }}>
                /
              </span>
            )}
            <span
              style={{
                color:
                  index === breadcrumbs.length - 1
                    ? "var(--text-primary)"
                    : "var(--text-secondary)",
                fontSize: "13px",
                fontWeight: index === breadcrumbs.length - 1 ? "500" : "400",
              }}
            >
              {crumb}
            </span>
          </span>
        ))}
      </nav>

      {/* Global search — opens a Cmd/Ctrl+K overlay that queries the
          full-text search endpoint across customers, premises, accounts,
          and meters. The overlay itself is inside GlobalSearch. */}
      {!isPlatform && <GlobalSearch />}

      <ThemeToggle />

      {!isPlatform && <NotificationBell />}

      <UserMenu identity={identity} showSettings={!isPlatform} />
    </header>
  );
}

/**
 * Top-right user chip: session user's name to the left of a circular
 * avatar initial. Clicking either opens a dropdown with the account's
 * email (for confirmation), a Settings link, and Sign out. Replaces
 * the old placeholder avatar in the topbar and the full user panel
 * that used to live at the bottom of the sidebar — consolidating the
 * account controls in one place.
 */
function UserMenu({
  identity,
  showSettings = true,
}: {
  identity?: { name: string; email: string } | null;
  showSettings?: boolean;
}) {
  const { data: session } = useSession();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const name = identity?.name ?? session?.user?.name ?? "Admin User";
  const email = identity?.email ?? session?.user?.email ?? "admin@utility.com";
  const initial = name[0]?.toUpperCase() ?? "A";

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    if (open) document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [open]);

  return (
    <div ref={ref} style={{ position: "relative", flexShrink: 0 }}>
      <button
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        title={`${name} — account menu`}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "4px 6px 4px 10px",
          background: "transparent",
          border: "1px solid transparent",
          borderRadius: "999px",
          cursor: "pointer",
          fontFamily: "inherit",
        }}
        onMouseEnter={(e) => {
          (e.currentTarget as HTMLElement).style.background = "var(--bg-hover)";
          (e.currentTarget as HTMLElement).style.borderColor = "var(--border)";
        }}
        onMouseLeave={(e) => {
          (e.currentTarget as HTMLElement).style.background = "transparent";
          (e.currentTarget as HTMLElement).style.borderColor = "transparent";
        }}
      >
        <span
          style={{
            color: "var(--text-primary)",
            fontSize: 13,
            fontWeight: 500,
            whiteSpace: "nowrap",
            maxWidth: 180,
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {name}
        </span>
        <span
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
          }}
        >
          {initial}
        </span>
      </button>

      {open && (
        <div
          role="menu"
          style={{
            position: "absolute",
            top: "calc(100% + 6px)",
            right: 0,
            minWidth: 220,
            background: "var(--bg-card)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius)",
            boxShadow: "0 8px 24px rgba(0,0,0,0.4)",
            zIndex: 200,
            overflow: "hidden",
          }}
        >
          <div style={{ padding: "10px 14px", borderBottom: "1px solid var(--border-subtle)" }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-primary)" }}>{name}</div>
            <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 2 }}>{email}</div>
          </div>
          <div style={{ padding: "4px 0" }}>
            {showSettings && (
              <Link
                href="/settings/general"
                onClick={() => setOpen(false)}
                role="menuitem"
                style={{
                  display: "block",
                  padding: "8px 14px",
                  fontSize: 13,
                  color: "var(--text-secondary)",
                  textDecoration: "none",
                }}
                onMouseEnter={(e) => {
                  (e.currentTarget as HTMLElement).style.background = "var(--bg-hover)";
                }}
                onMouseLeave={(e) => {
                  (e.currentTarget as HTMLElement).style.background = "transparent";
                }}
              >
                Settings
              </Link>
            )}
            <button
              onClick={logout}
              role="menuitem"
              style={{
                display: "block",
                width: "100%",
                padding: "8px 14px",
                fontSize: 13,
                color: "var(--danger)",
                background: "none",
                border: "none",
                textAlign: "left",
                cursor: "pointer",
                fontFamily: "inherit",
              }}
              onMouseEnter={(e) => {
                (e.currentTarget as HTMLElement).style.background = "var(--bg-hover)";
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLElement).style.background = "transparent";
              }}
            >
              Sign out
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
