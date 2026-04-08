"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { useSession } from "next-auth/react";

interface NavItem {
  href: string;
  label: string;
  icon: string;
}

interface NavSection {
  title: string;
  items: NavItem[];
}

const navSections: NavSection[] = [
  {
    title: "Operations",
    items: [
      { href: "/premises", label: "Premises", icon: "🏠" },
      { href: "/meters", label: "Meters", icon: "📊" },
      { href: "/accounts", label: "Accounts", icon: "👤" },
      { href: "/agreements", label: "Agreements", icon: "📄" },
    ],
  },
  {
    title: "Configuration",
    items: [
      { href: "/rate-schedules", label: "Rate Schedules", icon: "💰" },
      { href: "/billing-cycles", label: "Billing Cycles", icon: "🗓" },
    ],
  },
  {
    title: "System",
    items: [
      { href: "/audit-log", label: "Audit Log", icon: "📋" },
      { href: "/theme-editor", label: "Theme Editor", icon: "🎨" },
      { href: "/settings", label: "Settings", icon: "⚙️" },
    ],
  },
];

export function Sidebar() {
  const pathname = usePathname();
  const { data: session } = useSession();
  const [collapsed, setCollapsed] = useState(false);

  const sidebarWidth = collapsed ? "64px" : "240px";

  return (
    <aside
      style={{
        width: sidebarWidth,
        minWidth: sidebarWidth,
        background: "var(--bg-surface)",
        borderRight: "1px solid var(--border)",
        display: "flex",
        flexDirection: "column",
        transition: "width 0.2s ease, min-width 0.2s ease",
        overflow: "hidden",
        height: "100vh",
      }}
    >
      {/* Brand */}
      <div
        style={{
          padding: collapsed ? "16px 12px" : "16px 20px",
          borderBottom: "1px solid var(--border)",
          display: "flex",
          alignItems: "center",
          gap: "10px",
          minHeight: "64px",
        }}
      >
        <div
          style={{
            width: "32px",
            height: "32px",
            borderRadius: "8px",
            background: "var(--accent-primary)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            flexShrink: 0,
            color: "white",
            fontWeight: "bold",
            fontSize: "14px",
          }}
        >
          U
        </div>
        {!collapsed && (
          <div>
            <div
              style={{
                color: "var(--text-primary)",
                fontWeight: "600",
                fontSize: "14px",
                lineHeight: "1.2",
              }}
            >
              Utility CIS
            </div>
            <div
              style={{
                color: "var(--text-muted)",
                fontSize: "11px",
              }}
            >
              Admin Portal
            </div>
          </div>
        )}
      </div>

      {/* Toggle button */}
      <button
        onClick={() => setCollapsed(!collapsed)}
        style={{
          position: "absolute",
          top: "72px",
          right: collapsed ? "8px" : "-1px",
          transform: collapsed ? "none" : "translateX(50%)",
          width: "24px",
          height: "24px",
          borderRadius: "50%",
          background: "var(--bg-elevated)",
          border: "1px solid var(--border)",
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: "10px",
          color: "var(--text-secondary)",
          zIndex: 10,
          transition: "all 0.2s ease",
        }}
        aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
      >
        {collapsed ? "›" : "‹"}
      </button>

      {/* Nav */}
      <nav
        style={{
          flex: 1,
          overflowY: "auto",
          overflowX: "hidden",
          padding: "12px 0",
        }}
      >
        {navSections.map((section) => (
          <div key={section.title} style={{ marginBottom: "8px" }}>
            {!collapsed && (
              <div
                style={{
                  padding: "6px 20px 4px",
                  color: "var(--text-muted)",
                  fontSize: "10px",
                  fontWeight: "600",
                  textTransform: "uppercase",
                  letterSpacing: "0.08em",
                }}
              >
                {section.title}
              </div>
            )}
            {section.items.map((item) => {
              const isActive =
                pathname === item.href ||
                (item.href !== "/" && pathname.startsWith(item.href));
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "10px",
                    padding: collapsed ? "10px 16px" : "8px 20px",
                    margin: "1px 8px",
                    borderRadius: "var(--radius)",
                    background: isActive ? "var(--bg-hover)" : "transparent",
                    color: isActive
                      ? "var(--text-primary)"
                      : "var(--text-secondary)",
                    textDecoration: "none",
                    fontSize: "13px",
                    fontWeight: isActive ? "500" : "400",
                    transition: "all 0.15s ease",
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    justifyContent: collapsed ? "center" : "flex-start",
                  }}
                  title={collapsed ? item.label : undefined}
                >
                  <span style={{ fontSize: "15px", flexShrink: 0 }}>
                    {item.icon}
                  </span>
                  {!collapsed && <span>{item.label}</span>}
                </Link>
              );
            })}
          </div>
        ))}
      </nav>

      {/* User info at bottom */}
      <div
        style={{
          padding: collapsed ? "12px 8px" : "12px 16px",
          borderTop: "1px solid var(--border)",
          display: "flex",
          alignItems: "center",
          gap: "10px",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            width: "32px",
            height: "32px",
            borderRadius: "50%",
            background: "var(--bg-elevated)",
            border: "1px solid var(--border)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            flexShrink: 0,
            color: "var(--text-secondary)",
            fontSize: "13px",
            fontWeight: "600",
          }}
        >
          {session?.user?.name?.[0] ?? "A"}
        </div>
        {!collapsed && (
          <div style={{ overflow: "hidden" }}>
            <div
              style={{
                color: "var(--text-primary)",
                fontSize: "13px",
                fontWeight: "500",
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
              }}
            >
              {session?.user?.name ?? "Admin User"}
            </div>
            <div
              style={{
                color: "var(--text-muted)",
                fontSize: "11px",
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
              }}
            >
              {session?.user?.email ?? "admin@utility.com"}
            </div>
          </div>
        )}
      </div>
    </aside>
  );
}
